"""Persisted, fail-closed SKHY/SKHYNIXUSD Lighter pair bot."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .lighter_client import LighterClient

logger = logging.getLogger("skhynix-daemon")


def _book_summary(book: Dict[str, Any]) -> Dict[str, Any]:
    asks = book.get("asks") or []
    bids = book.get("bids") or []
    best_ask = min((float(row["price"]) for row in asks), default=0.0)
    best_bid = max((float(row["price"]) for row in bids), default=0.0)
    mid = (best_ask + best_bid) / 2 if best_ask and best_bid else best_ask or best_bid
    return {"bid": best_bid, "ask": best_ask, "mid": mid,
            "spread_bps": (best_ask - best_bid) / mid * 10_000 if mid else None}


def _trend_score(window: List[float]) -> float:
    """Continuous causal score combining normalized slope, MA separation and efficiency."""
    logs = [math.log(max(value, 1e-12)) for value in window]
    returns = [logs[index] - logs[index - 1] for index in range(1, len(logs))]
    mean_return = sum(returns) / len(returns)
    return_std = math.sqrt(sum((value - mean_return) ** 2 for value in returns) / len(returns))
    x_mean = (len(logs) - 1) / 2
    y_mean = sum(logs) / len(logs)
    denominator = sum((index - x_mean) ** 2 for index in range(len(logs)))
    slope = sum((index - x_mean) * (logs[index] - y_mean) for index in range(len(logs))) / denominator
    slope_score = math.tanh(2.0 * slope / max(return_std, 1e-9))

    ma7 = sum(window[-7:]) / 7
    ma24 = sum(window) / len(window)
    price_std = math.sqrt(sum((value - ma24) ** 2 for value in window) / len(window))
    ma_score = math.tanh((ma7 - ma24) / max(price_std, 1e-9))

    travel = sum(abs(window[index] - window[index - 1]) for index in range(1, len(window)))
    efficiency = (window[-1] - window[0]) / travel if travel > 1e-12 else 0.0
    return max(-1.0, min(1.0, 0.45 * slope_score + 0.35 * ma_score + 0.20 * efficiency))


def trend_path(values: List[float]) -> List[Dict[str, Any]]:
    """Return causal scores plus a three-bar-confirmed hysteretic regime path."""
    clean = [float(value) for value in values if math.isfinite(float(value))]
    points: List[Dict[str, Any]] = []
    state = "SIDEWAYS"
    pending: Optional[str] = None
    pending_count = 0
    for index in range(23, len(clean)):
        score = _trend_score(clean[index - 23:index + 1])
        if state == "UPTREND":
            target = "DOWNTREND" if score <= -0.35 else ("SIDEWAYS" if score < 0.15 else "UPTREND")
        elif state == "DOWNTREND":
            target = "UPTREND" if score >= 0.35 else ("SIDEWAYS" if score > -0.15 else "DOWNTREND")
        else:
            target = "UPTREND" if score >= 0.35 else ("DOWNTREND" if score <= -0.35 else "SIDEWAYS")
        if target == state:
            pending, pending_count = None, 0
        else:
            if target == pending:
                pending_count += 1
            else:
                pending, pending_count = target, 1
            if pending_count >= 3:
                state, pending, pending_count = target, None, 0
        points.append({"index": index, "score": score, "direction": state})
    return points


def classify_trend(values: List[float]) -> Dict[str, Any]:
    """Classify the latest point without lookahead using a continuous stabilized score."""
    clean = [float(value) for value in values if math.isfinite(float(value))]
    points = trend_path(clean)
    if not points:
        return {"direction": "UNKNOWN", "score": 0.0, "strength": 0.0,
                "last": clean[-1] if clean else None}
    point = points[-1]
    window = clean[-24:]
    ma7 = sum(window[-7:]) / 7
    ma24 = sum(window) / 24
    score = float(point["score"])
    return {
        "direction": point["direction"], "score": round(score, 4),
        "strength": round(abs(score) * 100, 1), "last": round(clean[-1], 4),
        "ma7": round(ma7, 4), "ma24": round(ma24, 4),
        "method": "continuous_slope_ma_efficiency_hysteresis",
    }


class LighterPairBot:
    TAB2_GROSS_LEVERAGE_CAP = 8.0
    TAB2_MARGIN_LEVERAGE = 10.0
    TAB2_MARGIN_BUFFER_MULTIPLIER = 1.25

    STRATEGY_NAMES: Dict[str, str] = {
        "grid": "Dynamic Grid",
        "ou_quant": "Ornstein-Uhlenbeck SDE",
        "ma_stack": "Trend MA Stack",
        "multi_factor": "Multi-Factor Gate",
        "trend_pullback": "Macro Trend Reversion",
        "custom": "Rule Composer",
    }

    DEFAULTS: Dict[str, Any] = {
        "enabled": False,
        "symbol_pair": ["SKHY", "SKHYNIXUSD"],
        "strategy_mode": "grid",
        "strategy_interval": "5m",
        "entry_z": 1.5,
        "exit_z": 0.25,
        "ou_halflife_max": 8.0,
        "ou_stop_z": 3.5,
        "ma_stretch_min": 0.30,
        "ma_trailing_stop": 0.15,
        "min_consensus_votes": 3,
        "trend_macro_window": 24,
        "trend_pullback_dist": 0.15,
        "trend_tp_dist": 0.05,
        "trend_slope_min": 0.002,
        "notional_usd": 25.0,
        "capacity_mode": "DYNAMIC_SAFE_LEVERAGE",
        "max_tranches": None,
        "gross_leverage_cap": TAB2_GROSS_LEVERAGE_CAP,
        "risk_capacity": None,
        "max_book_spread_bps": 45.0,
        "max_slippage": 0.006,
        "min_seconds_between_orders": 300,
        "tranches": [],
        "pending_execution": None,
        "last_action": "DISABLED",
        "last_action_time": 0,
        "last_evaluation": None,
        "last_error": None,
        "transient_error_count": 0,
        "last_transient_error_time": 0,
    }

    def __init__(self, client: LighterClient, state_file: Optional[Path] = None):
        self.client = client
        self.state_file = state_file or Path(__file__).with_name("lighter_bot_state.json")
        self.lock = asyncio.Lock()
        self.state = self._load()

    def _load(self) -> Dict[str, Any]:
        state = dict(self.DEFAULTS)
        state["symbol_pair"] = list(self.DEFAULTS["symbol_pair"])
        state["tranches"] = []
        try:
            if self.state_file.exists():
                raw = json.loads(self.state_file.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    state.update(raw)
                    # Migrate legacy fixed-limit states (e.g. 3, 12, 20) to pure dynamic capacity matching Tab 2.
                    if "capacity_mode" not in raw:
                        state["capacity_mode"] = "DYNAMIC_SAFE_LEVERAGE"
                    if raw.get("max_tranches") in (3, 12, 20):
                        state["max_tranches"] = None
                    state["gross_leverage_cap"] = self.TAB2_GROSS_LEVERAGE_CAP
        except Exception as error:
            state["enabled"] = False
            state["last_error"] = f"State recovery failed: {error}"
        if state.get("pending_execution"):
            state["enabled"] = False
            state["last_error"] = "Unresolved paired execution; manual reconciliation required"
        return state

    def save(self) -> None:
        temporary = self.state_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.state, indent=2), encoding="utf-8")
        temporary.replace(self.state_file)

    def public_state(self) -> Dict[str, Any]:
        capacity = self.state.get("risk_capacity") or {}
        public_max = int(capacity.get("max_tranches", len(self.state.get("tranches") or [])))
        configured_max = self.state.get("max_tranches")
        strat_mode = self.state.get("strategy_mode", "grid")
        return {key: value for key, value in self.state.items() if key != "pending_execution"} | {
            "recovery_required": bool(self.state.get("pending_execution")),
            "mode": "LIVE" if self.state.get("enabled") else "PAUSED",
            "max_tranches": public_max,
            "hard_max_tranches": int(configured_max) if configured_max is not None else None,
            "strategy_mode": strat_mode,
            "strategy_name": self.STRATEGY_NAMES.get(strat_mode, "Dynamic Grid"),
            "strategy_interval": self.state.get("strategy_interval", "5m"),
            "strategy_params": {
                "entry_z": self.state.get("entry_z", 1.5),
                "exit_z": self.state.get("exit_z", 0.25),
                "ou_halflife_max": self.state.get("ou_halflife_max", 8.0),
                "ou_stop_z": self.state.get("ou_stop_z", 3.5),
                "ma_stretch_min": self.state.get("ma_stretch_min", 0.30),
                "ma_trailing_stop": self.state.get("ma_trailing_stop", 0.15),
                "min_consensus_votes": self.state.get("min_consensus_votes", 3),
                "trend_macro_window": self.state.get("trend_macro_window", 24),
                "trend_pullback_dist": self.state.get("trend_pullback_dist", 0.15),
                "trend_tp_dist": self.state.get("trend_tp_dist", 0.05),
                "trend_slope_min": self.state.get("trend_slope_min", 0.002),
            },
            "execution_history": self._execution_history(),
        }

    def _execution_history(self) -> List[Dict[str, Any]]:
        """Normalize legacy event records into display-ready entry and exit rows."""
        normalized: List[Dict[str, Any]] = []
        open_entries: Dict[int, List[Dict[str, Any]]] = {1: [], -1: []}
        for index, raw in enumerate(self.state.get("history") or []):
            event = dict(raw)
            side = int(event.get("side", -1))
            notional = float(event.get("notional_usd", 25.0) or 25.0)
            fee_usd = float(event.get("fee_usd", 0.0) or 0.0)
            exposure = self._event_exposure(event)
            margin_usd = float(exposure.get("margin_usd", 0.0) or 0.0)
            fee_bps = fee_usd / margin_usd * 10_000 if margin_usd else 0.0
            if not event.get("is_exit"):
                row = {
                    **event,
                    **exposure,
                    "event": "ENTRY",
                    "is_entry": True,
                    "entry_ratio": float(event.get("entry_ratio", event.get("ratio", 0.0)) or 0.0),
                    "exit_ratio": None,
                    "fee_usd": fee_usd,
                    "fee_bps": fee_bps,
                    "gross_pnl_usd": None,
                    "net_pnl_usd": None,
                    "pnl_pct": None,
                    "status": "OPEN",
                    "history_index": index,
                }
                open_entries.setdefault(side, []).append(row)
                normalized.append(row)
                continue

            original_side = -side
            candidates = open_entries.setdefault(original_side, [])
            matched = None
            if candidates:
                adr_qty = float(event.get("adr_qty", 0.0) or 0.0)
                matched = min(candidates, key=lambda row: abs(float(row.get("adr_qty", 0.0) or 0.0) - adr_qty))
                candidates.remove(matched)
                matched["status"] = "CLOSED"

            entry_ratio = float((matched or {}).get("entry_ratio", event.get("original_entry_ratio", 0.0)) or 0.0)
            exit_ratio = float(event.get("exit_ratio", event.get("ratio", event.get("entry_ratio", 0.0))) or 0.0)
            gross_pnl = event.get("gross_pnl_usd", event.get("pnl"))
            if gross_pnl is None and entry_ratio > 0 and exit_ratio > 0:
                pnl_fraction = ((exit_ratio - entry_ratio) / entry_ratio if original_side > 0
                                else (entry_ratio - exit_ratio) / entry_ratio)
                gross_pnl = pnl_fraction * notional
            gross_pnl = float(gross_pnl or 0.0)
            entry_fee = float((matched or {}).get("fee_usd", event.get("entry_fee_usd", 0.0)) or 0.0)
            exit_fee = float(event.get("exit_fee_usd", fee_usd) or 0.0)
            total_fee = entry_fee + exit_fee
            net_pnl = float(event.get("net_pnl_usd", gross_pnl - total_fee) or 0.0)
            authoritative = event.get("pnl_source") == "LIGHTER_REALIZED_PNL"
            normalized.append({
                **event,
                **exposure,
                "event": "EXIT",
                "is_entry": False,
                "original_side": original_side,
                "entry_ratio": entry_ratio,
                "exit_ratio": exit_ratio,
                "entry_time": (matched or {}).get("time"),
                "fee_usd": total_fee,
                "fee_bps": total_fee / margin_usd * 10_000 if margin_usd else 0.0,
                "gross_pnl_usd": gross_pnl,
                "net_pnl_usd": net_pnl,
                "pnl_pct": net_pnl / margin_usd * 100 if margin_usd else 0.0,
                "pnl_authoritative": authoritative,
                "status": ("CLOSED" if authoritative and matched else
                           "UNMATCHED EXIT" if authoritative else "LEGACY — ESTIMATED P&L"),
                "history_index": index,
            })
        active_tranches = list(self.state.get("tranches") or [])
        for unmatched_entries in open_entries.values():
            for row in unmatched_entries:
                is_active = any(
                    int(active.get("side", 0)) == int(row.get("side", 0))
                    and abs(float(active.get("adr_qty", 0.0) or 0.0) - float(row.get("adr_qty", 0.0) or 0.0)) < 1e-6
                    and abs(int(active.get("time", 0) or 0) - int(row.get("time", 0) or 0)) <= 1
                    for active in active_tranches
                )
                row["status"] = "OPEN" if is_active else "LEGACY — EXIT NOT RECORDED"
        return normalized

    @staticmethod
    def _order_legs(event: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any]]:
        """Return both execution legs from current and legacy persisted shapes."""
        orders = event.get("orders") or {}
        if isinstance(orders, dict):
            first = orders.get("first_leg") or {}
            second = orders.get("second_leg") or {}
        elif isinstance(orders, list):
            first = orders[0] if len(orders) > 0 else {}
            second = orders[1] if len(orders) > 1 else {}
        else:
            first = second = {}
        return (
            first if isinstance(first, dict) else {},
            second if isinstance(second, dict) else {},
        )

    @staticmethod
    def _event_exposure(event: Dict[str, Any]) -> Dict[str, float]:
        """Return per-leg USDT size and estimated 1x margin for one pair action."""
        first, second = LighterPairBot._order_legs(event)
        adr_qty = abs(float(event.get("adr_qty", 0.0) or first.get("base_amount", 0.0) or 0.0))
        domestic_qty = abs(float(event.get("domestic_qty", 0.0) or second.get("base_amount", 0.0) or 0.0))
        adr_price = float(event.get("adr_price", 0.0) or first.get("reference_price", 0.0) or 0.0)
        domestic_price = float(event.get("domestic_price", 0.0) or second.get("reference_price", 0.0) or 0.0)
        configured_notional = abs(float(event.get("notional_usd", 0.0) or 0.0))
        ratio = abs(float(event.get("exit_ratio", 0.0) or event.get("entry_ratio", 0.0)
                          or event.get("ratio", 0.0) or 0.0))
        adr_notional = adr_qty * adr_price if adr_qty and adr_price else configured_notional
        domestic_notional = domestic_qty * domestic_price if domestic_qty and domestic_price else 0.0
        if domestic_notional <= 0 and adr_notional > 0 and ratio > 0:
            domestic_notional = adr_notional * 100.0 / ratio
        gross_notional = adr_notional + domestic_notional
        return {
            "adr_notional_usd": round(adr_notional, 6),
            "domestic_notional_usd": round(domestic_notional, 6),
            "gross_notional_usd": round(gross_notional, 6),
            "margin_usd": round(gross_notional, 6),
        }

    @staticmethod
    def _execution_fees(execution: Dict[str, Any]) -> float:
        return sum(float((execution.get(leg) or {}).get("fee_usd", 0.0) or 0.0)
                   for leg in ("first_leg", "second_leg"))

    @staticmethod
    def _execution_realized_pnl(execution: Dict[str, Any]) -> float:
        return sum(float((execution.get(leg) or {}).get("realized_pnl_usd", 0.0) or 0.0)
                   for leg in ("first_leg", "second_leg"))

    @staticmethod
    def _execution_ratio(execution: Dict[str, Any], fallback: float) -> float:
        adr_price = float((execution.get("first_leg") or {}).get("fill_price", 0.0) or 0.0)
        domestic_price = float((execution.get("second_leg") or {}).get("fill_price", 0.0) or 0.0)
        return adr_price / (domestic_price / 10.0) * 100 if adr_price > 0 and domestic_price > 0 else fallback

    def _risk_capacity(
        self, account: Dict[str, Any], positions: List[Dict[str, Any]],
        adr_quote: Dict[str, Any], domestic_quote: Dict[str, Any],
        notional_usd: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Tab-2-style capacity from live equity, gross exposure, and next-unit headroom."""
        collateral = max(0.0, float(account.get("collateral", 0.0) or 0.0))
        leverage_cap = self.TAB2_GROSS_LEVERAGE_CAP
        configured_cap = self.state.get("max_tranches")
        user_hard_cap = int(configured_cap) if configured_cap is not None and int(configured_cap) > 0 else None
        active = len(self.state.get("tranches") or [])
        quote_by_market = {216: adr_quote, 161: domestic_quote}
        current_gross = 0.0
        allocated_margin = 0.0
        for position in positions:
            market_id = int(position.get("market_id", 0) or 0)
            raw_size = abs(float(position.get("position", 0.0) or position.get("size", 0.0) or 0.0))
            position_value = abs(float(position.get("position_value", 0.0) or 0.0))
            mark = float(position.get("mark_price", 0.0) or position.get("avg_entry_price", 0.0)
                         or (quote_by_market.get(market_id) or {}).get("mid", 0.0) or 0.0)
            current_gross += position_value if position_value > 0 else raw_size * mark
            allocated_margin += abs(float(position.get("allocated_margin", 0.0) or 0.0))

        target_notional = float(notional_usd if notional_usd is not None else self.state.get("notional_usd", 25.0))
        adr_mid = float(adr_quote.get("mid", 0.0) or 0.0)
        domestic_mid = float(domestic_quote.get("mid", 0.0) or 0.0)
        adr_qty = max(0.04, math.floor(target_notional / adr_mid * 10_000) / 10_000) if adr_mid > 0 else 0.0
        domestic_qty = math.floor((adr_qty / 10.0) * 1_000) / 1_000 if adr_qty > 0 else 0.0
        if adr_qty > 0 and domestic_qty < 0.004:
            domestic_qty, adr_qty = 0.004, 0.04
        next_gross = adr_qty * adr_mid + domestic_qty * domestic_mid

        gross_capacity = collateral * leverage_cap
        gross_headroom = max(0.0, gross_capacity - current_gross)
        available_margin = max(0.0, collateral - allocated_margin)
        required_buffer = max(
            2.50,
            (next_gross / self.TAB2_MARGIN_LEVERAGE) * self.TAB2_MARGIN_BUFFER_MULTIPLIER,
        )
        leverage_remaining = math.floor(gross_headroom / next_gross) if next_gross > 0 else 0
        projected_leverage = ((current_gross + next_gross) / collateral
                              if collateral > 0 and next_gross > 0 else float("inf"))
        has_margin = available_margin >= required_buffer
        has_leverage = projected_leverage <= leverage_cap
        remaining = leverage_remaining if has_margin and has_leverage else 0
        if user_hard_cap is not None:
            remaining = max(0, min(user_hard_cap - active, remaining))

        total_max = active + remaining
        result = {
            "mode": "DYNAMIC_SAFE_LEVERAGE",
            "active_tranches": active,
            "remaining_tranches": remaining,
            "max_tranches": total_max,
            "hard_max_tranches": user_hard_cap,
            "collateral_usd": round(collateral, 6),
            "current_gross_usd": round(current_gross, 6),
            "next_tranche_gross_usd": round(next_gross, 6),
            "gross_capacity_usd": round(gross_capacity, 6),
            "gross_headroom_usd": round(gross_headroom, 6),
            "allocated_margin_usd": round(allocated_margin, 6),
            "available_margin_usd": round(available_margin, 6),
            "required_margin_buffer_usd": round(required_buffer, 6),
            "gross_leverage": round(current_gross / collateral, 6) if collateral > 0 else None,
            "projected_gross_leverage": round(projected_leverage, 6) if math.isfinite(projected_leverage) else None,
            "gross_leverage_cap": leverage_cap,
            "margin_leverage_assumption": self.TAB2_MARGIN_LEVERAGE,
            "margin_buffer_multiplier": self.TAB2_MARGIN_BUFFER_MULTIPLIER,
            "can_add_tranche": remaining > 0,
            "blocked_reason": (
                None if remaining > 0 else
                "INSUFFICIENT_MARGIN" if not has_margin else
                "GROSS_LEVERAGE_CAP" if not has_leverage else
                "CAMPAIGN_CAPACITY" if user_hard_cap is not None and active >= user_hard_cap else
                "POSITION_CAPACITY"
            ),
        }
        self.state["risk_capacity"] = result
        return result

    def _reconcile_open_pair(self, positions: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Adopt only a complete, directionally valid SKHY/SKHYNIXUSD hedge."""
        signed_sizes: Dict[int, float] = {}
        entry_prices: Dict[int, float] = {}
        for position in positions:
            market_id = int(position.get("market_id", 0))
            if market_id not in {216, 161}:
                continue
            raw_size = float(position.get("position", 0.0) or position.get("size", 0.0))
            sign = int(position.get("sign", 1 if raw_size >= 0 else -1))
            signed_sizes[market_id] = abs(raw_size) * (1 if sign > 0 else -1)
            entry_prices[market_id] = abs(float(position.get("avg_entry_price", 0.0) or 0.0))

        adr_size = signed_sizes.get(216, 0.0)
        domestic_size = signed_sizes.get(161, 0.0)
        if abs(adr_size) <= 1e-6 and abs(domestic_size) <= 1e-6:
            return None
        if abs(adr_size) <= 1e-6 or abs(domestic_size) <= 1e-6:
            raise RuntimeError("Unreconciled single-leg Lighter exposure detected")
        if adr_size * domestic_size >= 0:
            raise RuntimeError("Unreconciled Lighter positions are not an opposing pair")

        expected_domestic = abs(adr_size) / 10.0
        tolerance = max(0.0011, expected_domestic * 0.20)
        if abs(abs(domestic_size) - expected_domestic) > tolerance:
            raise RuntimeError("Unreconciled Lighter positions do not match the 10:1 hedge ratio")

        adr_entry = entry_prices.get(216, 0.0)
        domestic_entry = entry_prices.get(161, 0.0)
        last_evaluation = self.state.get("last_evaluation") or {}
        entry_ratio = (adr_entry / (domestic_entry / 10.0) * 100
                       if adr_entry > 0 and domestic_entry > 0
                       else float(last_evaluation.get("ratio") or 141.0))
        return {
            "side": 1 if adr_size > 0 else -1,
            "adr_qty": abs(adr_size),
            "domestic_qty": abs(domestic_size),
            "entry_ratio": round(entry_ratio, 4),
            "adr_price": adr_entry,
            "domestic_price": domestic_entry,
            "notional_usd": abs(adr_size) * adr_entry if adr_entry > 0 else 0.0,
            "fee_usd": 0.0,
            "time": int(time.time()),
            "reconciled": True,
        }

    def _reconcile_mixed_campaign(self, positions: List[Dict[str, Any]]) -> bool:
        """Collapse offsetting tracked entries to the exchange's actual net pair without trading."""
        tranches = list(self.state.get("tranches") or [])
        sides = {int(tranche.get("side", 0) or 0) for tranche in tranches}
        sides.discard(0)
        if len(sides) <= 1:
            return False
        net_pair = self._reconcile_open_pair(positions)
        if not net_pair:
            net_side = 0
            target_adr = 0.0
            target_domestic = 0.0
            selected: List[Dict[str, Any]] = []
        else:
            net_side = int(net_pair["side"])
            target_adr = float(net_pair["adr_qty"])
            target_domestic = float(net_pair["domestic_qty"])
            selected = [net_pair]
        removed = len(tranches)
        self.state["tranches"] = selected
        self.state["last_reconciliation"] = {
            "time": int(time.time()),
            "reason": "NETTED_OPPOSING_ENTRIES",
            "net_side": net_side,
            "removed_offset_records": removed,
            "remaining_tranches": len(selected),
            "adr_qty": target_adr,
            "domestic_qty": target_domestic,
        }
        self.state["last_action"] = "RECONCILED_NETTED_CAMPAIGN"
        self.state["last_action_time"] = int(time.time())
        logger.warning(
            "Reconciled mixed Lighter campaign to %s exchange-derived net tranche; archived %s offset records",
            len(selected), removed,
        )
        return True

    def _campaign_allows_side(self, side: int) -> bool:
        tracked_sides = {int(tranche.get("side", 0) or 0) for tranche in self.state.get("tranches") or []}
        tracked_sides.discard(0)
        return not tracked_sides or tracked_sides == {int(side)}

    async def _hydrate_active_tranche_fills(self) -> bool:
        """Upgrade legacy active tranches from submitted quotes to exchange fills."""
        changed = False
        for tranche in self.state.get("tranches") or []:
            if tranche.get("execution_source") == "LIGHTER_FILLS":
                continue
            first, second = self._order_legs(tranche)
            orders = {"first_leg": first, "second_leg": second}
            if not first.get("fill_confirmed") and first.get("client_order_index"):
                first = {**first, **await self.client.execution_fill(
                    int(first["client_order_index"]), 216, float(first.get("base_amount", tranche.get("adr_qty", 0.0)) or 0.0)
                )}
            if not second.get("fill_confirmed") and second.get("client_order_index"):
                second = {**second, **await self.client.execution_fill(
                    int(second["client_order_index"]), 161,
                    float(second.get("base_amount", tranche.get("domestic_qty", 0.0)) or 0.0)
                )}
            if not first.get("fill_confirmed") or not second.get("fill_confirmed"):
                continue
            orders["first_leg"] = first
            orders["second_leg"] = second
            tranche["orders"] = orders
            tranche["adr_qty"] = float(first["filled_size"])
            tranche["domestic_qty"] = float(second["filled_size"])
            tranche["adr_price"] = float(first["fill_price"])
            tranche["domestic_price"] = float(second["fill_price"])
            tranche["entry_ratio"] = self._execution_ratio(orders, float(tranche.get("entry_ratio", 0.0) or 0.0))
            tranche["fee_usd"] = round(self._execution_fees(orders), 8)
            notional = float(tranche.get("notional_usd", 0.0) or 0.0)
            tranche["fee_bps"] = round(tranche["fee_usd"] / notional * 10_000, 4) if notional else 0.0
            tranche["execution_source"] = "LIGHTER_FILLS"
            first_client_id = str(first.get("client_order_index") or "")
            for event in reversed(self.state.get("history") or []):
                event_first, _ = self._order_legs(event)
                if first_client_id and str(event_first.get("client_order_index") or "") == first_client_id:
                    event.update(dict(tranche))
                    break
            changed = True
        return changed

    async def configure(self, values: Dict[str, Any]) -> Dict[str, Any]:
        bounds = {
            "entry_z": (0.75, 4.0), "exit_z": (0.0, 1.0), "notional_usd": (10.0, 500.0),
            "max_book_spread_bps": (1.0, 100.0),
            "max_slippage": (0.001, 0.02), "min_seconds_between_orders": (6, 86400),
            "ou_halflife_max": (1.0, 50.0), "ou_stop_z": (1.5, 6.0),
            "ma_stretch_min": (0.05, 2.0), "ma_trailing_stop": (0.01, 1.0),
            "min_consensus_votes": (1, 4), "trend_macro_window": (6, 120),
            "trend_pullback_dist": (0.01, 2.0), "trend_tp_dist": (0.01, 1.0),
            "trend_slope_min": (0.0001, 0.05),
        }
        async with self.lock:
            updated = dict(self.state)
            if "strategy_mode" in values:
                mode = str(values["strategy_mode"]).strip().lower()
                if mode not in self.STRATEGY_NAMES:
                    raise ValueError(f"Unknown strategy_mode: {mode}. Must be one of: {list(self.STRATEGY_NAMES.keys())}")
                updated["strategy_mode"] = mode
            if "strategy_interval" in values:
                interval = str(values["strategy_interval"]).strip().lower()
                if interval not in {"1m", "5m", "15m", "1h"}:
                    raise ValueError(f"Invalid strategy_interval: {interval}")
                updated["strategy_interval"] = interval
            for key, (low, high) in bounds.items():
                if key not in values:
                    continue
                value = int(values[key]) if key in {"max_tranches", "min_seconds_between_orders", "min_consensus_votes", "trend_macro_window"} else float(values[key])
                if not low <= value <= high:
                    raise ValueError(f"{key} must be between {low} and {high}")
                updated[key] = value
            if updated["exit_z"] >= updated["entry_z"]:
                raise ValueError("exit_z must be lower than entry_z")
            self.state = updated
            self.save()
            return self.public_state()

    async def set_enabled(self, enabled: bool) -> Dict[str, Any]:
        async with self.lock:
            if enabled:
                account = await self.client.account_status()
                if not account.get("authenticated") or not account.get("execution_enabled"):
                    raise RuntimeError("Funded authenticated Lighter account is required")
                signer = self.client.get_signer()
                if signer is None or signer.check_client():
                    raise RuntimeError("Lighter signer validation failed")
                if self.state.get("pending_execution"):
                    raise RuntimeError("Resolve the pending paired execution before enabling")
                open_positions = await self.client.positions()
                if open_positions and not self.state.get("tranches"):
                    reconciled_tranche = self._reconcile_open_pair(open_positions)
                    if reconciled_tranche:
                        self.state["tranches"] = [reconciled_tranche]
                        self.state.setdefault("history", []).append(dict(reconciled_tranche))
            self.state["enabled"] = bool(enabled)
            self.state["last_action"] = "ENABLED" if enabled else "PAUSED"
            self.state["last_action_time"] = int(time.time())
            self.state["last_error"] = None
            self.save()
            return self.public_state()

    @staticmethod
    def _aligned_ratio(adr: List[Dict[str, Any]], domestic: List[Dict[str, Any]]) -> List[float]:
        domestic_close = {int(row["t"]): float(row["c"]) for row in domestic if float(row.get("c", 0)) > 0}
        return [float(row["c"]) / (domestic_close[int(row["t"])] / 10.0) * 100
                for row in adr if int(row["t"]) in domestic_close and float(row.get("c", 0)) > 0]

    INTERVAL_MS = {
        "1m": 60_000, "5m": 300_000, "15m": 900_000,
        "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
    }

    async def trends(self, small: str = "5m", big: str = "1h") -> Dict[str, Any]:
        small_res = small if small in self.INTERVAL_MS else "5m"
        big_res = big if big in self.INTERVAL_MS else "1h"
        target_intervals = list(dict.fromkeys([small_res, big_res]))

        result: Dict[str, Any] = {
            "small_interval": small_res,
            "big_interval": big_res,
        }
        for interval in target_intervals:
            interval_ms = self.INTERVAL_MS[interval]
            adr, domestic = await asyncio.gather(
                self.client.candles(216, interval, 90), self.client.candles(161, interval, 90)
            )
            now_ms = int(time.time() * 1000)
            adr = [row for row in adr if int(row["t"]) + interval_ms <= now_ms]
            domestic = [row for row in domestic if int(row["t"]) + interval_ms <= now_ms]
            result[interval] = classify_trend(self._aligned_ratio(adr, domestic))

        result["small"] = result[small_res]
        result["big"] = result[big_res]
        return result

    async def run_once(self) -> None:
        if not self.state.get("enabled"):
            return
        async with self.lock:
            try:
                await self._evaluate()
                self.state["last_error"] = None
                self.state["transient_error_count"] = 0
            except Exception as error:
                self.state["last_error"] = str(error)[:500]
                if self._is_transient_read_error(error) and not self.state.get("pending_execution"):
                    self.state["transient_error_count"] = int(self.state.get("transient_error_count", 0) or 0) + 1
                    self.state["last_transient_error_time"] = int(time.time())
                    self.state["last_action"] = "RETRYING_TRANSIENT_ERROR"
                    logger.warning("Lighter pair bot will retry transient read error: %s", error)
                else:
                    self.state["enabled"] = False
                    self.state["last_action"] = "FAIL_CLOSED"
                    logger.exception("Lighter pair bot paused: %s", error)
            finally:
                self.save()

    @staticmethod
    def _is_transient_read_error(error: Exception) -> bool:
        message = str(error).lower()
        return any(token in message for token in (
            "api error (429)", "api error (500)", "api error (502)",
            "api error (503)", "api error (504)", "timed out",
            "timeout", "temporarily unavailable", "connection reset",
            "connection refused", "server disconnected",
        ))

    def _evaluate_strategy_signals(self, ratios: List[float], side_if_open: Optional[int] = None) -> tuple[bool, int, bool, Dict[str, Any]]:
        mode = self.state.get("strategy_mode", "grid")
        entry_z = float(self.state.get("entry_z", 1.5))
        exit_z = float(self.state.get("exit_z", 0.25))

        if mode == "ou_quant":
            window = min(24, len(ratios) - 1)
            sample = ratios[-window:]
            mean = sum(sample) / len(sample)
            x_prev = sample[:-1]
            x_curr = sample[1:]
            n = len(x_prev)
            mean_prev = sum(x_prev) / n
            mean_curr = sum(x_curr) / n
            var_prev = sum((x - mean_prev)**2 for x in x_prev)
            cov = sum((x_prev[i] - mean_prev) * (x_curr[i] - mean_curr) for i in range(n))
            a = cov / var_prev if var_prev > 1e-12 else 0.95
            a = max(0.01, min(0.999, a))
            b = mean_curr - a * mean_prev
            mu_ou = b / (1.0 - a) if abs(1.0 - a) > 1e-6 else mean
            theta = -math.log(a)
            half_life_bars = math.log(2.0) / theta if theta > 1e-6 else 24.0
            residuals = [(x_curr[i] - (a * x_prev[i] + b)) for i in range(n)]
            sigma_ou = math.sqrt(sum(r**2 for r in residuals) / n) if n else 0.05
            denom = (sigma_ou / math.sqrt(2 * theta)) if theta > 0 and sigma_ou > 0 else 0.1
            z_ou = (ratios[-1] - mu_ou) / denom if denom > 1e-6 else 0.0
            candidate_side = -1 if z_ou > 0 else 1
            max_hl = float(self.state.get("ou_halflife_max", 8.0)) * 4
            entry_signal = bool(abs(z_ou) >= entry_z and half_life_bars <= max_hl)
            stop_z = float(self.state.get("ou_stop_z", 3.5))
            exit_signal = bool(abs(z_ou) <= exit_z or abs(z_ou) >= stop_z)
            eval_info = {
                "time": int(time.time()), "ratio": round(ratios[-1], 4), "mean": round(mu_ou, 4),
                "z": round(z_ou, 3), "strategy": "ou_quant", "theta": round(theta, 4),
                "half_life_bars": round(half_life_bars, 1), "stop_z": stop_z,
            }
            return entry_signal, candidate_side, exit_signal, eval_info

        elif mode == "ma_stack":
            ma7 = sum(ratios[-7:]) / 7
            ma24 = sum(ratios[-24:]) / 24
            ma60 = sum(ratios[-60:]) / 60 if len(ratios) >= 60 else ma24
            stretch_pct = abs(ratios[-1] - ma60) / ma60 * 100 if ma60 else 0.0
            bearish_stack = ratios[-1] < ma7 < ma24 < ma60
            bullish_stack = ratios[-1] > ma7 > ma24 > ma60
            min_stretch = float(self.state.get("ma_stretch_min", 0.30))
            trailing_stop = float(self.state.get("ma_trailing_stop", 0.15))
            entry_signal = bool((bearish_stack or bullish_stack) and stretch_pct >= min_stretch)
            candidate_side = 1 if bearish_stack else -1
            if side_if_open is not None:
                exit_signal = bool((side_if_open > 0 and ma7 >= ma24) or (side_if_open < 0 and ma7 <= ma24) or stretch_pct <= trailing_stop)
            else:
                exit_signal = bool(stretch_pct <= trailing_stop)
            sample = ratios[-24:]
            mean = sum(sample) / len(sample)
            variance = sum((v - mean) ** 2 for v in sample) / len(sample)
            zscore = (ratios[-1] - mean) / math.sqrt(variance) if variance > 1e-12 else 0.0
            eval_info = {
                "time": int(time.time()), "ratio": round(ratios[-1], 4), "mean": round(ma24, 4),
                "z": round(zscore, 3), "strategy": "ma_stack", "stretch_pct": round(stretch_pct, 3),
                "trailing_stop": trailing_stop,
            }
            return entry_signal, candidate_side, exit_signal, eval_info

        elif mode == "multi_factor":
            sample = ratios[-24:]
            mean = sum(sample) / len(sample)
            variance = sum((v - mean) ** 2 for v in sample) / len(sample)
            zscore = (ratios[-1] - mean) / math.sqrt(variance) if variance > 1e-12 else 0.0
            f1 = abs(zscore) >= entry_z
            v_curr = abs(ratios[-1] - ratios[-2])
            v_prev = abs(ratios[-2] - ratios[-3]) if len(ratios) >= 3 else 0.01
            f2 = v_curr >= v_prev
            ma7 = sum(ratios[-7:]) / 7
            f3 = abs(ratios[-1] - ma7) >= 0.08
            local_12 = ratios[-12:]
            f4 = (ratios[-1] >= max(local_12) * 0.9995) or (ratios[-1] <= min(local_12) * 1.0005)
            votes = sum([f1, f2, f3, f4])
            quorum = int(self.state.get("min_consensus_votes", 3))
            candidate_side = -1 if zscore > 0 else 1
            entry_signal = bool(votes >= quorum and abs(zscore) >= 0.8)
            exit_signal = bool(abs(zscore) <= exit_z or votes < 2)
            eval_info = {
                "time": int(time.time()), "ratio": round(ratios[-1], 4), "mean": round(mean, 4),
                "z": round(zscore, 3), "strategy": "multi_factor", "votes": votes,
            }
            return entry_signal, candidate_side, exit_signal, eval_info

        elif mode == "trend_pullback":
            trend_window = max(12, min(60, int(self.state.get("trend_macro_window", 24))))
            sample = ratios[-trend_window:]
            n = len(sample)
            x_bar = (n - 1) / 2.0
            y_bar = sum(sample) / n
            var_x = sum((k - x_bar) ** 2 for k in range(n))
            cov_xy = sum((k - x_bar) * (sample[k] - y_bar) for k in range(n))
            beta = cov_xy / var_x if var_x > 1e-12 else 0.0
            alpha = y_bar - beta * x_bar
            trendline_val = alpha + beta * (n - 1)
            slope_min = float(self.state.get("trend_slope_min", 0.002))
            pullback_dist = float(self.state.get("trend_pullback_dist", 0.15))
            tp_dist = float(self.state.get("trend_tp_dist", 0.05))

            is_uptrend = beta >= slope_min
            is_downtrend = beta <= -slope_min
            prev_val = ratios[-2]
            prev_prev_val = ratios[-3] if len(ratios) >= 3 else prev_val
            micro_up = (ratios[-1] > prev_val) and (prev_val <= prev_prev_val)
            micro_down = (ratios[-1] < prev_val) and (prev_val >= prev_prev_val)

            buy_signal = is_uptrend and (trendline_val - ratios[-1] >= pullback_dist) and micro_up
            short_signal = is_downtrend and (ratios[-1] - trendline_val >= pullback_dist) and micro_down
            entry_signal = bool(buy_signal or short_signal)
            candidate_side = 1 if buy_signal else -1

            if side_if_open is not None:
                if side_if_open > 0:
                    exit_signal = bool(ratios[-1] >= (trendline_val + tp_dist) or beta < -slope_min)
                else:
                    exit_signal = bool(ratios[-1] <= (trendline_val - tp_dist) or beta > slope_min)
            else:
                exit_signal = bool(abs(ratios[-1] - trendline_val) <= tp_dist)

            eval_info = {
                "time": int(time.time()), "ratio": round(ratios[-1], 4), "mean": round(trendline_val, 4),
                "z": round((ratios[-1] - trendline_val) / 0.1, 3), "strategy": "trend_pullback",
                "slope": round(beta, 5), "trendline": round(trendline_val, 4),
            }
            return entry_signal, candidate_side, exit_signal, eval_info

        else:
            # Default "grid" and "custom"
            sample = ratios[-25:-1]
            mean = sum(sample) / len(sample)
            variance = sum((value - mean) ** 2 for value in sample) / len(sample)
            zscore = (ratios[-1] - mean) / math.sqrt(variance) if variance > 1e-12 else 0.0
            candidate_side = -1 if zscore > 0 else 1
            entry_signal = bool(abs(zscore) >= entry_z)
            exit_signal = bool(abs(zscore) <= exit_z)
            eval_info = {
                "time": int(time.time()), "ratio": round(ratios[-1], 4), "mean": round(mean, 4),
                "z": round(zscore, 3), "strategy": "grid",
            }
            return entry_signal, candidate_side, exit_signal, eval_info

    async def _evaluate(self) -> None:
        if self.state.get("pending_execution"):
            raise RuntimeError("Pending execution requires reconciliation")
        status = await self.client.account_status()
        if not status.get("execution_enabled"):
            if status.get("error"):
                raise RuntimeError(str(status["error"]))
            raise RuntimeError("Lighter account is no longer execution-ready")
        open_pos = await self.client.positions()
        if self._reconcile_mixed_campaign(open_pos):
            self.save()
        if not self.state.get("tranches") and open_pos:
            reconciled_tranche = self._reconcile_open_pair(open_pos)
            if reconciled_tranche:
                self.state["tranches"] = [reconciled_tranche]
                self.state.setdefault("history", []).append(dict(reconciled_tranche))
                self.save()
        if await self._hydrate_active_tranche_fills():
            self.save()

        interval = self.state.get("strategy_interval", "5m")
        interval_ms = 300_000 if interval == "5m" else (60_000 if interval == "1m" else (900_000 if interval == "15m" else 3_600_000))
        adr_candles, domestic_candles, adr_book, domestic_book = await asyncio.gather(
            self.client.candles(216, interval, 80), self.client.candles(161, interval, 80),
            self.client.order_book(216, 20), self.client.order_book(161, 20),
        )
        now_ms = int(time.time() * 1000)
        adr_candles = [row for row in adr_candles if int(row["t"]) + interval_ms <= now_ms]
        domestic_candles = [row for row in domestic_candles if int(row["t"]) + interval_ms <= now_ms]
        ratios = self._aligned_ratio(adr_candles, domestic_candles)
        if len(ratios) < 25:
            raise RuntimeError("Insufficient aligned Lighter candles")

        tranches = self.state["tranches"]
        campaign_side = int(tranches[0]["side"]) if tranches else None
        entry_signal, candidate_side, exit_signal, evaluation = self._evaluate_strategy_signals(ratios, campaign_side)
        self.state["last_evaluation"] = evaluation

        adr_quote = _book_summary(adr_book)
        domestic_quote = _book_summary(domestic_book)
        risk = self._risk_capacity(status, open_pos, adr_quote, domestic_quote)

        if any((quote.get("spread_bps") or 1e9) > self.state["max_book_spread_bps"] for quote in (adr_quote, domestic_quote)):
            return
        elapsed = time.time() - float(self.state.get("last_action_time") or 0)
        if elapsed < self.state["min_seconds_between_orders"]:
            return

        if tranches and exit_signal:
            exit_ratio = ratios[-1]
            for tranche in list(tranches):
                execution = await self._trade_pair(-int(tranche["side"]), float(tranche["adr_qty"]), float(tranche["domestic_qty"]), adr_quote, domestic_quote, reduce_only=True)
                exit_ratio = self._execution_ratio(execution, ratios[-1])
                tranches.remove(tranche)
                entry_ratio = float(tranche.get("entry_ratio", exit_ratio))
                side = int(tranche.get("side", -1))
                pnl_pct = (exit_ratio - entry_ratio) / entry_ratio if side > 0 else (entry_ratio - exit_ratio) / entry_ratio
                notional = float(tranche.get("notional_usd", 25.0))
                gross_pnl = self._execution_realized_pnl(execution)
                entry_fee = float(tranche.get("fee_usd", 0.0) or 0.0)
                exit_fee = self._execution_fees(execution)
                net_pnl = gross_pnl - entry_fee - exit_fee
                self.state.setdefault("history", []).append({
                    "side": -side,
                    "adr_qty": tranche["adr_qty"],
                    "domestic_qty": tranche["domestic_qty"],
                    "entry_ratio": round(entry_ratio, 4),
                    "exit_ratio": round(exit_ratio, 4),
                    "ratio": round(exit_ratio, 4),
                    "time": int(time.time()),
                    "is_exit": True,
                    "pnl": round(net_pnl, 6),
                    "gross_pnl_usd": round(gross_pnl, 6),
                    "net_pnl_usd": round(net_pnl, 6),
                    "entry_fee_usd": round(entry_fee, 8),
                    "exit_fee_usd": round(exit_fee, 8),
                    "fee_usd": round(exit_fee, 8),
                    "fee_bps": round((entry_fee + exit_fee) / notional * 10_000, 4) if notional else 0.0,
                    "pnl_pct": round(net_pnl / notional * 100, 6) if notional else 0.0,
                    "notional_usd": notional,
                    "adr_price": execution["first_leg"]["fill_price"],
                    "domestic_price": execution["second_leg"]["fill_price"],
                    "pnl_source": "LIGHTER_REALIZED_PNL",
                    "orders": execution,
                })
                self.state["pending_execution"] = None
                self.save()
            strat_name = evaluation.get("strategy", "grid").upper()
            self.state["last_action"] = f"EXITED_{strat_name}"
            self.state["last_action_time"] = int(time.time())
        elif entry_signal and risk["can_add_tranche"]:
            side = candidate_side
            if not self._campaign_allows_side(side):
                self.state["last_action"] = "WAITING_FOR_EXISTING_CAMPAIGN_EXIT"
                return
            adr_qty = max(0.04, math.floor(self.state["notional_usd"] / adr_quote["mid"] * 10_000) / 10_000)
            domestic_qty = math.floor((adr_qty / 10.0) * 1_000) / 1_000
            if domestic_qty < 0.004:
                domestic_qty, adr_qty = 0.004, 0.04
            execution = await self._trade_pair(side, adr_qty, domestic_qty, adr_quote, domestic_quote, reduce_only=False)
            entry_fee = self._execution_fees(execution)
            entry_ratio = self._execution_ratio(execution, ratios[-1])
            actual_adr_qty = float(execution["first_leg"].get("filled_size", adr_qty))
            actual_domestic_qty = float(execution["second_leg"].get("filled_size", domestic_qty))
            new_tranche = {"side": side, "adr_qty": actual_adr_qty, "domestic_qty": actual_domestic_qty,
                           "entry_ratio": entry_ratio, "entry_z": float(evaluation.get("z", 0.0)),
                           "entry_strategy": evaluation.get("strategy", self.state.get("strategy_mode", "grid")),
                           "time": int(time.time()),
                           "notional_usd": self.state["notional_usd"], "is_entry": True,
                           "fee_usd": round(entry_fee, 8),
                           "fee_bps": round(entry_fee / self.state["notional_usd"] * 10_000, 4),
                           "adr_price": execution["first_leg"]["fill_price"],
                           "domestic_price": execution["second_leg"]["fill_price"],
                           "execution_source": "LIGHTER_FILLS",
                           "orders": execution}
            tranches.append(new_tranche)
            self.state.setdefault("history", []).append(dict(new_tranche))
            self.state["pending_execution"] = None
            self.state["last_action"] = "ENTERED_LONG_RATIO" if side > 0 else "ENTERED_SHORT_RATIO"
            self.state["last_action_time"] = int(time.time())

    async def _trade_pair(self, side: int, adr_qty: float, domestic_qty: float,
                          adr_quote: Dict[str, Any], domestic_quote: Dict[str, Any], *, reduce_only: bool) -> Dict[str, Any]:
        # Persist intent before leg one. Any interruption leaves the bot disabled on restart.
        intent = {"side": side, "adr_qty": adr_qty, "domestic_qty": domestic_qty,
                  "reduce_only": reduce_only, "first_leg": None, "time": int(time.time())}
        self.state["pending_execution"] = intent
        self.save()
        adr_is_ask = side < 0
        try:
            first = await self.client.create_market_order(216, adr_qty, adr_quote["mid"], adr_is_ask,
                                                          reduce_only=reduce_only, max_slippage=self.state["max_slippage"])
        except RuntimeError as error:
            if str(error).startswith("Lighter order rejected:"):
                self.state["pending_execution"] = None
                self.save()
            raise
        intent["first_leg"] = first
        self.save()
        second = await self.client.create_market_order(161, domestic_qty, domestic_quote["mid"], not adr_is_ask,
                                                       reduce_only=reduce_only, max_slippage=self.state["max_slippage"])
        intent["second_leg"] = second
        intent["completed"] = True
        self.save()
        if not first.get("fill_confirmed") or not second.get("fill_confirmed"):
            raise RuntimeError("Paired execution accepted but authoritative fills are not yet confirmed")
        return {"first_leg": first, "second_leg": second}

    async def execute_manual_tranche(self, side: int, notional_usd: float) -> Dict[str, Any]:
        async with self.lock:
            if side not in {-1, 1}:
                raise ValueError("side must be -1 or 1")
            if not math.isfinite(notional_usd) or not 10.0 <= notional_usd <= 500.0:
                raise ValueError("notional_usd must be between 10 and 500")
            if self.state.get("pending_execution"):
                raise RuntimeError("Resolve the pending paired execution before placing another order")
            status = await self.client.account_status()
            if not status.get("authenticated") or not status.get("execution_enabled"):
                raise RuntimeError("Funded authenticated Lighter account is required")
            adr_book, domestic_book, open_positions = await asyncio.gather(
                self.client.order_book(216, 20), self.client.order_book(161, 20),
                self.client.positions(),
            )
            adr_quote = _book_summary(adr_book)
            domestic_quote = _book_summary(domestic_book)
            if not adr_quote["mid"] or not domestic_quote["mid"]:
                raise RuntimeError("Lighter book quotes unavailable")
            risk = self._risk_capacity(status, open_positions, adr_quote, domestic_quote, notional_usd)
            if not risk["can_add_tranche"]:
                raise RuntimeError(
                    f"Safe dynamic capacity reached: {risk['active_tranches']}/{risk['max_tranches']} "
                    f"tranches at {risk['gross_leverage'] or 0:.2f}x gross leverage"
                )
            if not self._campaign_allows_side(side):
                raise RuntimeError("Requested side conflicts with the existing Lighter campaign")
            adr_qty = max(0.04, math.floor(notional_usd / adr_quote["mid"] * 10_000) / 10_000)
            domestic_qty = math.floor((adr_qty / 10.0) * 1_000) / 1_000
            if domestic_qty < 0.004:
                domestic_qty, adr_qty = 0.004, 0.04
            execution = await self._trade_pair(side, adr_qty, domestic_qty, adr_quote, domestic_quote, reduce_only=False)
            entry_fee = self._execution_fees(execution)
            midpoint_ratio = (adr_quote["mid"] / (domestic_quote["mid"] / 10.0)) * 100
            entry_ratio = self._execution_ratio(execution, midpoint_ratio)
            actual_adr_qty = float(execution["first_leg"].get("filled_size", adr_qty))
            actual_domestic_qty = float(execution["second_leg"].get("filled_size", domestic_qty))
            tranche = {
                "side": side, "adr_qty": actual_adr_qty, "domestic_qty": actual_domestic_qty,
                "entry_ratio": round(entry_ratio, 4), "time": int(time.time()),
                "notional_usd": notional_usd, "is_entry": True,
                "fee_usd": round(entry_fee, 8),
                "fee_bps": round(entry_fee / notional_usd * 10_000, 4),
                "adr_price": execution["first_leg"]["fill_price"],
                "domestic_price": execution["second_leg"]["fill_price"],
                "execution_source": "LIGHTER_FILLS",
                "orders": execution,
            }
            self.state.setdefault("tranches", []).append(tranche)
            self.state.setdefault("history", []).append(dict(tranche))
            self.state["pending_execution"] = None
            self.state["last_action"] = "MANUAL_SCALE_IN_SHORT" if side < 0 else "MANUAL_SCALE_IN_LONG"
            self.state["last_action_time"] = int(time.time())
            self.state["last_error"] = None
            self.save()
            return tranche

    async def execute_manual_reduce(self) -> Dict[str, Any]:
        async with self.lock:
            tranches = self.state.get("tranches") or []
            if not tranches:
                positions = await self.client.positions()
                if not positions:
                    raise RuntimeError("No active tranches or positions to reduce")
                return await self._flatten_all_locked()
            tranche = tranches[-1]
            adr_book, domestic_book = await asyncio.gather(
                self.client.order_book(216, 20), self.client.order_book(161, 20)
            )
            adr_quote = _book_summary(adr_book)
            domestic_quote = _book_summary(domestic_book)
            execution = await self._trade_pair(-int(tranche["side"]), float(tranche["adr_qty"]), float(tranche["domestic_qty"]),
                                               adr_quote, domestic_quote, reduce_only=True)
            tranches.pop()
            midpoint_ratio = (adr_quote["mid"] / (domestic_quote["mid"] / 10.0)) * 100
            exit_ratio = self._execution_ratio(execution, midpoint_ratio)
            entry_ratio = float(tranche.get("entry_ratio", exit_ratio))
            side = int(tranche.get("side", -1))
            pnl_pct = (exit_ratio - entry_ratio) / entry_ratio if side > 0 else (entry_ratio - exit_ratio) / entry_ratio
            notional = float(tranche.get("notional_usd", 25.0))
            gross_pnl = self._execution_realized_pnl(execution)
            entry_fee = float(tranche.get("fee_usd", 0.0) or 0.0)
            exit_fee = self._execution_fees(execution)
            net_pnl = gross_pnl - entry_fee - exit_fee
            self.state.setdefault("history", []).append({
                "side": -int(tranche["side"]),
                "adr_qty": tranche["adr_qty"],
                "domestic_qty": tranche["domestic_qty"],
                "entry_ratio": round(entry_ratio, 4),
                "exit_ratio": round(exit_ratio, 4),
                "ratio": round(exit_ratio, 4),
                "time": int(time.time()),
                "is_exit": True,
                "pnl": round(net_pnl, 6),
                "gross_pnl_usd": round(gross_pnl, 6),
                "net_pnl_usd": round(net_pnl, 6),
                "entry_fee_usd": round(entry_fee, 8),
                "exit_fee_usd": round(exit_fee, 8),
                "fee_usd": round(exit_fee, 8),
                "fee_bps": round((entry_fee + exit_fee) / notional * 10_000, 4) if notional else 0.0,
                "pnl_pct": round(net_pnl / notional * 100, 6) if notional else 0.0,
                "notional_usd": notional,
                "adr_price": execution["first_leg"]["fill_price"],
                "domestic_price": execution["second_leg"]["fill_price"],
                "pnl_source": "LIGHTER_REALIZED_PNL",
                "orders": execution,
            })
            self.state["pending_execution"] = None
            self.state["last_action"] = "MANUAL_REDUCE"
            self.state["last_action_time"] = int(time.time())
            self.state["last_error"] = None
            self.save()
            return tranche

    async def flatten_all(self) -> Dict[str, Any]:
        async with self.lock:
            return await self._flatten_all_locked()

    async def _flatten_all_locked(self) -> Dict[str, Any]:
        self.state["enabled"] = False
        self.state["last_action"] = "FLATTENING"
        self.state["last_action_time"] = int(time.time())
        self.save()
        positions = await self.client.positions()
        closed = []
        adr_book, domestic_book = await asyncio.gather(
            self.client.order_book(216, 20), self.client.order_book(161, 20)
        )
        adr_quote = _book_summary(adr_book)
        domestic_quote = _book_summary(domestic_book)
        for pos in positions:
            market_id = int(pos.get("market_id", 0))
            if market_id not in {216, 161}:
                continue
            raw_size = float(pos.get("position", 0.0) or pos.get("size", 0.0))
            if raw_size == 0:
                continue
            sign = int(pos.get("sign", 1 if raw_size > 0 else -1))
            abs_size = abs(raw_size)
            is_ask = (sign == 1)
            ref = adr_quote["mid"] if market_id == 216 else domestic_quote["mid"]
            if ref > 0:
                res = await self.client.create_market_order(market_id, abs_size, ref, is_ask, reduce_only=True)
                closed.append(res)
        adr_fill = next((float(order.get("fill_price", 0.0) or 0.0) for order in closed
                         if int(order.get("market_id", 0) or 0) == 216), 0.0)
        domestic_fill = next((float(order.get("fill_price", 0.0) or 0.0) for order in closed
                              if int(order.get("market_id", 0) or 0) == 161), 0.0)
        midpoint_ratio = (adr_quote["mid"] / (domestic_quote["mid"] / 10.0)) * 100 if domestic_quote.get("mid") else 141.0
        exit_ratio = adr_fill / (domestic_fill / 10.0) * 100 if adr_fill > 0 and domestic_fill > 0 else midpoint_ratio
        total_exit_fee = sum(float(order.get("fee_usd", 0.0) or 0.0) for order in closed)
        total_realized_pnl = sum(float(order.get("realized_pnl_usd", 0.0) or 0.0) for order in closed)
        total_notional = sum(float(t.get("notional_usd", 25.0) or 25.0) for t in self.state.get("tranches", []))
        for t in list(self.state.get("tranches", [])):
            entry_ratio = float(t.get("entry_ratio", exit_ratio))
            side = int(t.get("side", -1))
            pnl_pct = (exit_ratio - entry_ratio) / entry_ratio if side > 0 else (entry_ratio - exit_ratio) / entry_ratio
            notional = float(t.get("notional_usd", 25.0) or 25.0)
            gross_pnl = total_realized_pnl * notional / total_notional if total_notional else 0.0
            entry_fee = float(t.get("fee_usd", 0.0) or 0.0)
            exit_fee = total_exit_fee * notional / total_notional if total_notional else 0.0
            net_pnl = gross_pnl - entry_fee - exit_fee
            self.state.setdefault("history", []).append({
                "side": -side,
                "adr_qty": t.get("adr_qty", 0.0),
                "domestic_qty": t.get("domestic_qty", 0.0),
                "entry_ratio": round(entry_ratio, 4),
                "exit_ratio": round(exit_ratio, 4),
                "ratio": round(exit_ratio, 4),
                "time": int(time.time()),
                "is_exit": True,
                "pnl": round(net_pnl, 6),
                "gross_pnl_usd": round(gross_pnl, 6),
                "net_pnl_usd": round(net_pnl, 6),
                "entry_fee_usd": round(entry_fee, 8),
                "exit_fee_usd": round(exit_fee, 8),
                "fee_usd": round(exit_fee, 8),
                "fee_bps": round((entry_fee + exit_fee) / notional * 10_000, 4) if notional else 0.0,
                "pnl_pct": round(net_pnl / notional * 100, 6) if notional else 0.0,
                "notional_usd": notional,
                "adr_price": adr_fill,
                "domestic_price": domestic_fill,
                "pnl_source": "LIGHTER_REALIZED_PNL",
                "orders": closed,
            })
        self.state["tranches"] = []
        self.state["enabled"] = False
        self.state["pending_execution"] = None
        self.state["last_action"] = "FLATTENED"
        self.state["last_action_time"] = int(time.time())
        self.state["last_error"] = None
        self.save()
        return {"closed": closed}
