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
    DEFAULTS: Dict[str, Any] = {
        "enabled": False,
        "symbol_pair": ["SKHY", "SKHYNIXUSD"],
        "entry_z": 1.5,
        "exit_z": 0.25,
        "notional_usd": 25.0,
        "max_tranches": 3,
        "max_book_spread_bps": 45.0,
        "max_slippage": 0.006,
        "min_seconds_between_orders": 300,
        "tranches": [],
        "pending_execution": None,
        "last_action": "DISABLED",
        "last_action_time": 0,
        "last_evaluation": None,
        "last_error": None,
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
        return {key: value for key, value in self.state.items() if key != "pending_execution"} | {
            "recovery_required": bool(self.state.get("pending_execution")),
            "mode": "LIVE" if self.state.get("enabled") else "PAUSED",
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
                "status": "CLOSED" if matched else "UNMATCHED EXIT",
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
    def _event_exposure(event: Dict[str, Any]) -> Dict[str, float]:
        """Return per-leg USDT size and estimated 1x margin for one pair action."""
        orders = event.get("orders") or {}
        first = orders.get("first_leg") or {}
        second = orders.get("second_leg") or {}
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

    def _reconcile_open_pair(self, positions: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Adopt only a complete, directionally valid SKHY/SKHYNIXUSD hedge."""
        signed_sizes: Dict[int, float] = {}
        for position in positions:
            market_id = int(position.get("market_id", 0))
            if market_id not in {216, 161}:
                continue
            raw_size = float(position.get("position", 0.0) or position.get("size", 0.0))
            sign = int(position.get("sign", 1 if raw_size >= 0 else -1))
            signed_sizes[market_id] = abs(raw_size) * (1 if sign > 0 else -1)

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

        last_evaluation = self.state.get("last_evaluation") or {}
        entry_ratio = float(last_evaluation.get("ratio") or 141.0)
        return {
            "side": 1 if adr_size > 0 else -1,
            "adr_qty": abs(adr_size),
            "domestic_qty": abs(domestic_size),
            "entry_ratio": round(entry_ratio, 4),
            "time": int(time.time()),
            "reconciled": True,
        }

    async def configure(self, values: Dict[str, Any]) -> Dict[str, Any]:
        bounds = {
            "entry_z": (0.75, 4.0), "exit_z": (0.0, 1.0), "notional_usd": (10.0, 500.0),
            "max_tranches": (1, 8), "max_book_spread_bps": (1.0, 100.0),
            "max_slippage": (0.001, 0.02), "min_seconds_between_orders": (6, 86400),
        }
        async with self.lock:
            updated = dict(self.state)
            for key, (low, high) in bounds.items():
                if key not in values:
                    continue
                value = int(values[key]) if key in {"max_tranches", "min_seconds_between_orders"} else float(values[key])
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
            except Exception as error:
                self.state["enabled"] = False
                self.state["last_action"] = "FAIL_CLOSED"
                self.state["last_error"] = str(error)[:500]
                logger.exception("Lighter pair bot paused: %s", error)
            finally:
                self.save()

    async def _evaluate(self) -> None:
        if self.state.get("pending_execution"):
            raise RuntimeError("Pending execution requires reconciliation")
        status = await self.client.account_status()
        if not status.get("execution_enabled"):
            raise RuntimeError("Lighter account is no longer execution-ready")
        open_pos = await self.client.positions()
        if not self.state.get("tranches") and open_pos:
            reconciled_tranche = self._reconcile_open_pair(open_pos)
            if reconciled_tranche:
                self.state["tranches"] = [reconciled_tranche]
                self.state.setdefault("history", []).append(dict(reconciled_tranche))
                self.save()
        adr_candles, domestic_candles, adr_book, domestic_book = await asyncio.gather(
            self.client.candles(216, "5m", 80), self.client.candles(161, "5m", 80),
            self.client.order_book(216, 20), self.client.order_book(161, 20),
        )
        now_ms = int(time.time() * 1000)
        adr_candles = [row for row in adr_candles if int(row["t"]) + 300_000 <= now_ms]
        domestic_candles = [row for row in domestic_candles if int(row["t"]) + 300_000 <= now_ms]
        ratios = self._aligned_ratio(adr_candles, domestic_candles)
        if len(ratios) < 25:
            raise RuntimeError("Insufficient aligned Lighter candles")
        sample = ratios[-25:-1]
        mean = sum(sample) / len(sample)
        variance = sum((value - mean) ** 2 for value in sample) / len(sample)
        zscore = (ratios[-1] - mean) / math.sqrt(variance) if variance > 1e-12 else 0.0
        adr_quote = _book_summary(adr_book)
        domestic_quote = _book_summary(domestic_book)
        evaluation = {"time": int(time.time()), "ratio": round(ratios[-1], 4), "mean": round(mean, 4), "z": round(zscore, 3)}
        self.state["last_evaluation"] = evaluation
        if any((quote.get("spread_bps") or 1e9) > self.state["max_book_spread_bps"] for quote in (adr_quote, domestic_quote)):
            return
        elapsed = time.time() - float(self.state.get("last_action_time") or 0)
        if elapsed < self.state["min_seconds_between_orders"]:
            return
        tranches = self.state["tranches"]
        if tranches and abs(zscore) <= self.state["exit_z"]:
            exit_ratio = ratios[-1]
            for tranche in list(tranches):
                execution = await self._trade_pair(-int(tranche["side"]), float(tranche["adr_qty"]), float(tranche["domestic_qty"]), adr_quote, domestic_quote, reduce_only=True)
                tranches.remove(tranche)
                entry_ratio = float(tranche.get("entry_ratio", exit_ratio))
                side = int(tranche.get("side", -1))
                pnl_pct = (exit_ratio - entry_ratio) / entry_ratio if side > 0 else (entry_ratio - exit_ratio) / entry_ratio
                notional = float(tranche.get("notional_usd", 25.0))
                gross_pnl = pnl_pct * notional
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
                    "orders": execution,
                })
                self.state["pending_execution"] = None
                self.save()
            self.state["last_action"] = "EXITED_TO_MEAN"
            self.state["last_action_time"] = int(time.time())
        elif abs(zscore) >= self.state["entry_z"] and len(tranches) < self.state["max_tranches"]:
            side = -1 if zscore > 0 else 1  # +1 long ratio, -1 short ratio
            adr_qty = max(0.04, math.floor(self.state["notional_usd"] / adr_quote["mid"] * 10_000) / 10_000)
            domestic_qty = math.floor((adr_qty / 10.0) * 1_000) / 1_000
            if domestic_qty < 0.004:
                domestic_qty, adr_qty = 0.004, 0.04
            execution = await self._trade_pair(side, adr_qty, domestic_qty, adr_quote, domestic_quote, reduce_only=False)
            entry_fee = self._execution_fees(execution)
            new_tranche = {"side": side, "adr_qty": adr_qty, "domestic_qty": domestic_qty,
                           "entry_ratio": ratios[-1], "entry_z": zscore, "time": int(time.time()),
                           "notional_usd": self.state["notional_usd"], "is_entry": True,
                           "fee_usd": round(entry_fee, 8),
                           "fee_bps": round(entry_fee / self.state["notional_usd"] * 10_000, 4),
                           "adr_price": adr_quote["mid"], "domestic_price": domestic_quote["mid"],
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
        return {"first_leg": first, "second_leg": second}

    async def execute_manual_tranche(self, side: int, notional_usd: float) -> Dict[str, Any]:
        async with self.lock:
            if side not in {-1, 1}:
                raise ValueError("side must be -1 or 1")
            if not math.isfinite(notional_usd) or not 10.0 <= notional_usd <= 500.0:
                raise ValueError("notional_usd must be between 10 and 500")
            if self.state.get("pending_execution"):
                raise RuntimeError("Resolve the pending paired execution before placing another order")
            if len(self.state.get("tranches") or []) >= int(self.state.get("max_tranches", 3)):
                raise RuntimeError("Maximum live tranche count reached")
            status = await self.client.account_status()
            if not status.get("authenticated") or not status.get("execution_enabled"):
                raise RuntimeError("Funded authenticated Lighter account is required")
            adr_book, domestic_book = await asyncio.gather(
                self.client.order_book(216, 20), self.client.order_book(161, 20)
            )
            adr_quote = _book_summary(adr_book)
            domestic_quote = _book_summary(domestic_book)
            if not adr_quote["mid"] or not domestic_quote["mid"]:
                raise RuntimeError("Lighter book quotes unavailable")
            adr_qty = max(0.04, math.floor(notional_usd / adr_quote["mid"] * 10_000) / 10_000)
            domestic_qty = math.floor((adr_qty / 10.0) * 1_000) / 1_000
            if domestic_qty < 0.004:
                domestic_qty, adr_qty = 0.004, 0.04
            execution = await self._trade_pair(side, adr_qty, domestic_qty, adr_quote, domestic_quote, reduce_only=False)
            entry_fee = self._execution_fees(execution)
            entry_ratio = (adr_quote["mid"] / (domestic_quote["mid"] / 10.0)) * 100
            tranche = {
                "side": side, "adr_qty": adr_qty, "domestic_qty": domestic_qty,
                "entry_ratio": round(entry_ratio, 4), "time": int(time.time()),
                "notional_usd": notional_usd, "is_entry": True,
                "fee_usd": round(entry_fee, 8),
                "fee_bps": round(entry_fee / notional_usd * 10_000, 4),
                "adr_price": adr_quote["mid"], "domestic_price": domestic_quote["mid"],
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
            exit_ratio = (adr_quote["mid"] / (domestic_quote["mid"] / 10.0)) * 100
            entry_ratio = float(tranche.get("entry_ratio", exit_ratio))
            side = int(tranche.get("side", -1))
            pnl_pct = (exit_ratio - entry_ratio) / entry_ratio if side > 0 else (entry_ratio - exit_ratio) / entry_ratio
            notional = float(tranche.get("notional_usd", 25.0))
            gross_pnl = pnl_pct * notional
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
        exit_ratio = (adr_quote["mid"] / (domestic_quote["mid"] / 10.0)) * 100 if domestic_quote.get("mid") else 141.0
        total_exit_fee = sum(float(order.get("fee_usd", 0.0) or 0.0) for order in closed)
        total_notional = sum(float(t.get("notional_usd", 25.0) or 25.0) for t in self.state.get("tranches", []))
        for t in list(self.state.get("tranches", [])):
            entry_ratio = float(t.get("entry_ratio", exit_ratio))
            side = int(t.get("side", -1))
            pnl_pct = (exit_ratio - entry_ratio) / entry_ratio if side > 0 else (entry_ratio - exit_ratio) / entry_ratio
            notional = float(t.get("notional_usd", 25.0) or 25.0)
            gross_pnl = pnl_pct * notional
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
