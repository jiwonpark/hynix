"""Persisted, fail-closed autonomous executor for Tab 11 causal Ridge trading."""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import math
import os
import secrets
import time
import uuid
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .causal_ridge import (
    DEFAULT_SETTINGS,
    FEATURE_GROUPS,
    INTERVAL_SECONDS,
    evaluate_live_signal,
    normalize_settings,
    parse_binance_klines,
    parse_lighter_candles,
)
from .single_leg_direction import parse_entry_direction_mode

logger = logging.getLogger(__name__)

BINANCE_SUPPORTED = {"BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "XRPUSDT"}
LIGHTER_MARKETS = {"BTC": 1, "ETH": 0, "SOL": 2, "DOGE": 3, "XRP": 7}


def to_binance_symbol(symbol: str) -> str:
    clean = "".join(ch for ch in str(symbol or "ETHUSDT").upper() if ch.isalnum())
    if clean in BINANCE_SUPPORTED:
        return clean
    if clean in LIGHTER_MARKETS:
        return f"{clean}USDT"
    return "ETHUSDT"


def to_lighter_symbol(symbol: str) -> str:
    clean = "".join(ch for ch in str(symbol or "ETH").upper() if ch.isalnum())
    if clean.endswith("USDT") and clean[:-4] in LIGHTER_MARKETS:
        return clean[:-4]
    if clean in LIGHTER_MARKETS:
        return clean
    return "ETH"


def canonical_symbol(venue: str, symbol: str) -> str:
    return to_lighter_symbol(symbol) if venue == "lighter" else to_binance_symbol(symbol)


class ForecastTraderBot:
    """Autonomous single-leg trader executing causal Ridge plus a completed-daily trend gate."""

    GROSS_LEVERAGE_CAP = 2.0
    MARGIN_BUFFER_MULTIPLIER = 1.25
    MIN_MARGIN_BUFFER_USD = 10.0

    DEFAULT_STATE: Dict[str, Any] = {
        "enabled": False,
        "venue": "binance_futures",
        "selected_symbol": "ETHUSDT",
        "strategy_mode": "causal_ridge_daily",
        "strategy_interval": "4h",
        "horizon_bars": 1,
        "min_hold_bars": 1,
        "neutral_bps": 8.0,
        "confidence_pct": 49.0,
        "use_confidence_gate": True,
        "use_expected_edge_gate": False,
        "min_expected_bps": 8.0,
        "ridge_lambda": 400.0,
        "train_window": 1000,
        "min_train_samples": 180,
        "cost_bps": 10.0,
        "use_daily_trend_filter": True,
        "daily_ma_period": 20,
        "hold_same_direction": True,
        "entry_direction_mode": "two_way",
        "use_stop_loss": False,
        "stop_loss_pct": 3.0,
        "momentum_lookback": 6,
        "macd_fast": 12,
        "macd_slow": 26,
        "macd_signal": 9,
        "rsi_period": 14,
        "ma_fast": 20,
        "ma_slow": 50,
        "ma_slope_lookback": 3,
        "atr_period": 14,
        "use_momentum": True,
        "use_macd": True,
        "use_rsi": True,
        "use_ma": True,
        "use_volatility": True,
        "notional_usd": 200.0,
        "leverage": 1.0,
        "gross_leverage_cap": 2.0,
        "max_book_spread_bps": 15.0,
        "min_seconds_between_orders": 60,
        "last_evaluated_candle": 0,
        "last_order_time": 0,
        "pending_order": None,
        "recovery_required": False,
        "execution_blocked": False,
        "blocked_reason": None,
        "last_error": None,
        "last_action": None,
        "last_evaluation": None,
        "tranches": [],
        "execution_history": [],
    }

    def __init__(
        self,
        binance_client: Any,
        lighter_client: Any = None,
        state_path: Optional[Path] = None,
        conflict_checker: Optional[Callable[[str, str], Optional[str]]] = None,
    ):
        self.binance_client = binance_client
        self.lighter_client = lighter_client
        self.state_path = state_path or Path(__file__).resolve().parent / "forecast_bot_state.json"
        self.conflict_checker = conflict_checker
        self.lock = asyncio.Lock()
        self._pnl_lock = asyncio.Lock()
        self._pnl_cache: Optional[Tuple[Any, float, float, Dict[str, Any], Optional[str]]] = None
        self._last_paused_refresh_at = 0.0
        self.state: Dict[str, Any] = copy.deepcopy(self.DEFAULT_STATE)
        self._load()

    def _load(self) -> None:
        if not self.state_path.exists():
            return
        try:
            saved = json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.exception("Failed loading forecast_bot state; blocking fail-closed: %s", exc)
            self.state.update(enabled=False, execution_blocked=True, blocked_reason=f"Corrupt state file: {exc}")
            return
        merged = copy.deepcopy(self.DEFAULT_STATE)
        for key, value in saved.items():
            if key in merged:
                merged[key] = value
        merged["venue"] = "lighter" if str(merged.get("venue")).lower() == "lighter" else "binance_futures"
        merged["selected_symbol"] = canonical_symbol(merged["venue"], merged.get("selected_symbol", "ETHUSDT"))
        merged["tranches"] = list(saved.get("tranches") or [])
        merged["execution_history"] = list(saved.get("execution_history") or [])[-500:]
        self.state = merged

    def _save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2), encoding="utf-8")
        os.replace(tmp, self.state_path)

    def public_state(self) -> Dict[str, Any]:
        snap = copy.deepcopy(self.state)
        blocked = bool(snap.get("execution_blocked") or snap.get("recovery_required") or snap.get("pending_order"))
        snap["execution_blocked"] = blocked
        snap["blocked_reason"] = (snap.get("blocked_reason") or snap.get("last_error")) if blocked else None
        snap["can_execute_entry"] = bool(snap.get("enabled") and not blocked)
        snap["can_execute_exit"] = bool(snap.get("enabled") and not snap.get("recovery_required") and not snap.get("pending_order"))
        snap["history_event_count"] = len(snap["execution_history"])
        snap["effective_order_usd"] = round(float(snap.get("notional_usd", 200.0)) * float(snap.get("leverage", 1.0)), 2)
        return snap

    def _check_bot_conflict(self, venue: str, symbol: str) -> Optional[str]:
        if self.conflict_checker is None:
            return None
        return self.conflict_checker(venue, symbol)

    async def configure(self, values: Dict[str, Any]) -> Dict[str, Any]:
        permitted = {
            "venue", "selected_symbol", "strategy_interval", "horizon_bars", "min_hold_bars",
            "neutral_bps", "confidence_pct", "use_confidence_gate",
            "use_expected_edge_gate", "min_expected_bps", "ridge_lambda", "train_window",
            "min_train_samples", "cost_bps", "use_daily_trend_filter", "daily_ma_period",
            "hold_same_direction", "entry_direction_mode", "use_stop_loss", "stop_loss_pct",
            "momentum_lookback", "macd_fast", "macd_slow", "macd_signal", "rsi_period",
            "ma_fast", "ma_slow", "ma_slope_lookback", "atr_period",
            "use_momentum", "use_macd", "use_rsi", "use_ma", "use_volatility",
            "notional_usd", "leverage", "gross_leverage_cap", "max_book_spread_bps",
            "min_seconds_between_orders",
        }
        unknown = set(values) - permitted
        if unknown:
            raise ValueError(f"Unsupported setting: {', '.join(sorted(unknown))}")

        raw_candidate = {**self.state, **values}
        norm = normalize_settings(
            {
                **raw_candidate,
                "symbol": raw_candidate.get("selected_symbol"),
                "interval": raw_candidate.get("strategy_interval"),
            }
        )
        candidate = dict(self.state)
        candidate.update(
            venue=norm["venue"],
            selected_symbol=canonical_symbol(norm["venue"], raw_candidate.get("selected_symbol", norm["symbol"])),
            strategy_interval=norm["interval"],
            horizon_bars=norm["horizon_bars"],
            min_hold_bars=norm["min_hold_bars"],
            neutral_bps=norm["neutral_bps"],
            confidence_pct=norm["confidence_pct"],
            use_confidence_gate=norm["use_confidence_gate"],
            use_expected_edge_gate=norm["use_expected_edge_gate"],
            min_expected_bps=norm["min_expected_bps"],
            ridge_lambda=norm["ridge_lambda"],
            train_window=norm["train_window"],
            min_train_samples=norm["min_train_samples"],
            cost_bps=(0.0 if ("venue" in values and norm["venue"] == "lighter" and "cost_bps" not in values) else norm["cost_bps"]),
            use_daily_trend_filter=norm["use_daily_trend_filter"],
            daily_ma_period=norm["daily_ma_period"],
            hold_same_direction=norm["hold_same_direction"],
            entry_direction_mode=parse_entry_direction_mode(norm["entry_direction_mode"]),
            use_stop_loss=norm["use_stop_loss"],
            stop_loss_pct=norm["stop_loss_pct"],
            momentum_lookback=norm["momentum_lookback"],
            macd_fast=norm["macd_fast"],
            macd_slow=norm["macd_slow"],
            macd_signal=norm["macd_signal"],
            rsi_period=norm["rsi_period"],
            ma_fast=norm["ma_fast"],
            ma_slow=norm["ma_slow"],
            ma_slope_lookback=norm["ma_slope_lookback"],
            atr_period=norm["atr_period"],
            notional_usd=float(raw_candidate.get("notional_usd", 200.0)),
            leverage=float(raw_candidate.get("leverage", 1.0)),
            gross_leverage_cap=float(raw_candidate.get("gross_leverage_cap", 2.0)),
            max_book_spread_bps=float(raw_candidate.get("max_book_spread_bps", 15.0)),
            min_seconds_between_orders=int(raw_candidate.get("min_seconds_between_orders", 60)),
        )
        for grp in FEATURE_GROUPS:
            candidate[f"use_{grp}"] = bool(norm[f"use_{grp}"])
        if not any(candidate[f"use_{grp}"] for grp in FEATURE_GROUPS):
            raise ValueError("At least one model input group must remain enabled")
        if not (10.0 <= candidate["notional_usd"] <= 5000.0):
            raise ValueError("notional_usd must be between 10 and 5000")
        if not (1.0 <= candidate["leverage"] <= 10.0):
            raise ValueError("leverage must be between 1.0 and 10.0")
        if not (1.0 <= candidate["gross_leverage_cap"] <= 8.0):
            raise ValueError("gross_leverage_cap must be between 1.0 and 8.0")
        if not (1.0 <= candidate["max_book_spread_bps"] <= 100.0):
            raise ValueError("max_book_spread_bps must be between 1 and 100")
        if not (6 <= candidate["min_seconds_between_orders"] <= 86400):
            raise ValueError("min_seconds_between_orders must be between 6 and 86400")

        async with self.lock:
            if self.state["enabled"] and (
                candidate["venue"] != self.state["venue"]
                or candidate["selected_symbol"] != self.state["selected_symbol"]
                or candidate["strategy_interval"] != self.state["strategy_interval"]
                or any(key in values for key in values)
            ):
                raise ValueError("Pause the live bot before changing strategy, venue, symbol, or sizing")
            if self.state["tranches"] and (
                candidate["selected_symbol"] != self.state["selected_symbol"]
                or candidate["venue"] != self.state["venue"]
            ):
                raise ValueError("Close tracked inventory before changing venue or symbol")
            conflict = self._check_bot_conflict(candidate["venue"], candidate["selected_symbol"])
            if conflict and (candidate["selected_symbol"] != self.state["selected_symbol"] or candidate["venue"] != self.state["venue"]):
                raise ValueError(conflict)
            self.state = candidate
            self.state["last_error"] = None
            self._save()
            await self._refresh_paused_evaluation(force=True)
            return self.public_state()

    async def _fetch_candles_for_venue(
        self,
        venue: str,
        symbol: str,
        interval: str,
        limit_main: int = 1350,
        limit_daily: int = 120,
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        now_sec = time.time()
        if venue == "lighter":
            if self.lighter_client is None:
                raise ValueError("Lighter client unavailable")
            lt_sym = to_lighter_symbol(symbol)
            market_id = LIGHTER_MARKETS[lt_sym]
            interval_sec = INTERVAL_SECONDS[interval]
            # Paginate up to 3 calls (~500 each) for >=1250 completed bars
            raw_main: List[Dict[str, Any]] = []
            end_ms: Optional[int] = None
            for _ in range(3):
                chunk = await self.lighter_client.candles(
                    market_id, interval, 500, end_timestamp=end_ms, fresh=True
                )
                if not chunk:
                    break
                raw_main = chunk + raw_main
                first_t = int(chunk[0]["t"])
                first_ms = first_t if first_t > 10_000_000_000 else first_t * 1000
                end_ms = first_ms - 1
                if len(parse_lighter_candles(raw_main, interval, now_sec)) >= limit_main:
                    break
            raw_daily = await self.lighter_client.candles(market_id, "1d", max(60, limit_daily), fresh=True)
            bars = parse_lighter_candles(raw_main, interval, now_sec)[-limit_main:]
            d_bars = parse_lighter_candles(raw_daily, "1d", now_sec)[-limit_daily:]
            return bars, d_bars

        bin_sym = to_binance_symbol(symbol)
        raw_main, raw_daily = await asyncio.gather(
            self.binance_client.request(
                "GET", "/fapi/v1/klines", {"symbol": bin_sym, "interval": interval, "limit": min(1500, limit_main)}
            ),
            self.binance_client.request(
                "GET", "/fapi/v1/klines", {"symbol": bin_sym, "interval": "1d", "limit": min(500, max(60, limit_daily))}
            ),
        )
        bars = parse_binance_klines(raw_main, interval, now_sec)
        d_bars = parse_binance_klines(raw_daily, "1d", now_sec)
        return bars, d_bars

    async def _binance_account_and_position(self, symbol: str) -> Tuple[Dict[str, Any], float, float]:
        account = await self.binance_client.get_detailed_account_overview()
        if not account.get("authenticated"):
            raise ValueError(account.get("error") or "Binance Futures account unavailable")
        if not account.get("can_trade", True):
            raise ValueError("Binance Futures account is not permitted to trade")
        dual = await self.binance_client.request("GET", "/fapi/v1/positionSide/dual", signed=True)
        if dual.get("dualSidePosition") is not False:
            raise ValueError("Single-leg execution requires Binance one-way position mode")
        positions = await self.binance_client.request("GET", "/fapi/v2/positionRisk", signed=True)
        total_gross = 0.0
        selected_amt = 0.0
        for row in positions:
            amt = float(row.get("positionAmt", 0) or 0.0)
            mark = float(row.get("markPrice", 0) or row.get("entryPrice", 0) or 0.0)
            total_gross += abs(amt) * mark
            if row.get("symbol") == symbol:
                if row.get("positionSide", "BOTH") != "BOTH":
                    raise ValueError("Unexpected Binance hedge position side")
                selected_amt += amt
        return account, selected_amt, total_gross

    async def _lighter_account_and_position(self, symbol: str) -> Tuple[Dict[str, Any], float, float]:
        if self.lighter_client is None:
            raise ValueError("Lighter client unavailable")
        lt_sym = to_lighter_symbol(symbol)
        market_id = LIGHTER_MARKETS[lt_sym]
        account = dict(await self.lighter_client.account_status(fresh=True))
        if not account.get("authenticated") or not account.get("execution_enabled"):
            raise ValueError(account.get("message") or "Lighter execution signer unavailable")
        positions = account.get("positions") or []
        if isinstance(positions, dict):
            positions = list(positions.values())
        total_gross = 0.0
        selected_amt = 0.0
        allocated = 0.0
        for pos in positions:
            raw_val = pos.get("position") if pos.get("position") not in (None, "") else pos.get("size")
            qty = abs(float(raw_val or 0.0))
            sign = int(pos.get("sign") or 1)
            val = abs(float(pos.get("position_value") or 0.0))
            if not val and qty:
                mark = float(pos.get("mark_price") or pos.get("avg_entry_price") or 0.0)
                val = qty * mark
            total_gross += val
            allocated += abs(float(pos.get("allocated_margin") or 0.0))
            if int(pos.get("market_id", -1)) == market_id:
                selected_amt += qty if sign > 0 else -qty
        collateral = float(account.get("collateral", 0.0) or 0.0)
        account["available_margin"] = max(0.0, collateral - allocated)
        return account, selected_amt, total_gross

    def _check_position(self, exchange_amount: float) -> None:
        tranches = self.state["tranches"]
        expected = sum(int(t["side"]) * float(t["qty"]) for t in tranches)
        tolerance = max(1e-6, abs(expected) * 0.002)
        if not tranches and abs(exchange_amount) > 1e-6:
            raise ValueError(f"Exchange holds unmanaged {self.state['selected_symbol']} position ({exchange_amount:+.6f}); reconcile before trading")
        if tranches and abs(exchange_amount - expected) > tolerance:
            raise ValueError(
                f"Exchange position {exchange_amount:+.6f} differs from Forecast Bot inventory {expected:+.6f}"
            )

    async def _exchange_rules_binance(self, symbol: str) -> Tuple[Decimal, Decimal, Decimal]:
        data = await self.binance_client.request("GET", "/fapi/v1/exchangeInfo")
        details = next((row for row in data.get("symbols", []) if row.get("symbol") == symbol), None)
        if not details or details.get("status") != "TRADING":
            raise ValueError(f"{symbol} is not trading on Binance Futures")
        filters = {row["filterType"]: row for row in details.get("filters", [])}
        lot = filters.get("MARKET_LOT_SIZE") or {}
        if Decimal(str(lot.get("stepSize", "0"))) <= 0:
            lot = filters.get("LOT_SIZE") or {}
        step = Decimal(str(lot.get("stepSize", "0")))
        minimum = Decimal(str(lot.get("minQty", "0")))
        min_notional = Decimal(str((filters.get("MIN_NOTIONAL") or {}).get("notional", "0")))
        if step <= 0:
            raise ValueError("Binance Futures stepSize unavailable")
        return step, minimum, min_notional

    async def _book_binance(self, symbol: str, *, enforce_spread: bool = True) -> Tuple[float, float]:
        quote = await self.binance_client.request("GET", "/fapi/v1/ticker/bookTicker", {"symbol": symbol})
        bid, ask = float(quote["bidPrice"]), float(quote["askPrice"])
        if not (0 < bid <= ask):
            raise ValueError("Invalid Binance book quote")
        spread_bps = (ask - bid) / ((ask + bid) / 2.0) * 10000.0
        if enforce_spread and spread_bps > float(self.state["max_book_spread_bps"]):
            raise ValueError(f"Book spread {spread_bps:.2f}bp exceeds max {self.state['max_book_spread_bps']}bp")
        return bid, ask

    @staticmethod
    def _quantize_entry_qty(
        target_usd: float,
        price: float,
        step: Decimal,
        minimum: Decimal,
        min_notional: Decimal,
    ) -> Decimal:
        target = Decimal(str(target_usd))
        px = Decimal(str(price))
        down = (target / px / step).to_integral_value(rounding=ROUND_DOWN) * step
        up = down + step
        candidates = [q for q in (down, up) if q >= minimum and q * px >= min_notional]
        if not candidates:
            raise ValueError("Target notional is below exchange lot or minimum notional")
        chosen = min(candidates, key=lambda q: abs(q * px - target))
        if chosen * px > target * Decimal("1.25"):
            raise ValueError("Coarse step size would oversize order above 125% of target")
        return chosen

    async def toggle(self, enabled: bool) -> Dict[str, Any]:
        async with self.lock:
            if not enabled:
                self.state["enabled"] = False
                self.state["execution_blocked"] = False
                self.state["blocked_reason"] = None
                self._save()
                return self.public_state()
            if self.state["recovery_required"] or self.state["pending_order"]:
                raise ValueError("Resolve execution recovery / pending order before enabling")
            venue = self.state["venue"]
            symbol = self.state["selected_symbol"]
            conflict = self._check_bot_conflict(venue, symbol)
            if conflict:
                raise ValueError(conflict)

            if venue == "lighter":
                account, amount, total_gross = await self._lighter_account_and_position(symbol)
                collateral = float(account.get("collateral", 0.0) or 0.0)
                if collateral <= 1.0:
                    raise ValueError(f"Insufficient Lighter collateral (${collateral:.2f} USDC) for live execution")
                available = float(account.get("available_margin", collateral) or 0.0)
            else:
                account, amount, total_gross = await self._binance_account_and_position(symbol)
                summary = account.get("summary") or {}
                collateral = float(summary.get("total_equity_usd", 0.0) or 0.0)
                available = float(summary.get("available_margin_usd", 0.0) or 0.0)

            self._check_position(amount)
            target_order_usd = float(self.state["notional_usd"]) * float(self.state["leverage"])
            if target_order_usd > available / self.MARGIN_BUFFER_MULTIPLIER or total_gross + target_order_usd > collateral * float(self.state["gross_leverage_cap"]):
                raise ValueError(
                    f"Order ${target_order_usd:.2f} exceeds safe margin (${available:.2f} free) or {self.state['gross_leverage_cap']}x account gross cap"
                )
            if venue == "binance_futures":
                step, minimum, min_notional = await self._exchange_rules_binance(symbol)
                _, ask = await self._book_binance(symbol, enforce_spread=False)
                self._quantize_entry_qty(target_order_usd, ask, step, minimum, min_notional)

            seconds = INTERVAL_SECONDS[self.state["strategy_interval"]]
            self.state["last_evaluated_candle"] = int(time.time()) // seconds * seconds - seconds
            self.state.update(enabled=True, execution_blocked=False, blocked_reason=None, last_error=None)
            self._save()
            await self._refresh_paused_evaluation(force=True)
            return self.public_state()

    def _record_fill(self, order: Dict[str, Any], pending: Dict[str, Any]) -> Dict[str, Any]:
        venue = pending["venue"]
        reduce_only = bool(pending["reduce_only"])
        side = int(pending["side"])
        if venue == "binance_futures":
            filled = float(order.get("executedQty", 0.0) or 0.0)
            fill_price = float(order.get("avgPrice", 0.0) or 0.0)
            expected_qty = float(pending["qty"])
            if order.get("status") != "FILLED" or filled <= 0 or fill_price <= 0 or abs(filled - expected_qty) > max(1e-8, expected_qty * 0.0001):
                raise ValueError("Binance order did not confirm complete fill")
            order_id = str(order.get("orderId", ""))
            fee_usd = None
        else:
            filled = float(order.get("filled_qty") or pending["qty"])
            fill_price = float(order.get("avg_price") or pending["price"])
            order_id = str(order.get("order_index") or pending.get("client_order_index") or "")
            fee_usd = 0.0

        now_sec = int(time.time())
        event = {
            "event": "EXIT" if reduce_only else "ENTRY",
            "venue": venue,
            "symbol": pending["symbol"],
            "side": side,
            "qty": filled,
            "price": fill_price,
            "notional_usd": filled * fill_price,
            "order_id": order_id,
            "client_order_id": pending.get("client_order_id") or pending.get("client_order_index"),
            "reason": pending["reason"],
            "bar_time": pending.get("bar_time"),
            "time": now_sec,
            "pnl_authoritative": False,
        }
        if fee_usd is not None:
            event["fee_usd"] = fee_usd

        if reduce_only:
            closed = self.state["tranches"].pop()
            gross_pnl = int(closed["side"]) * filled * (fill_price - float(closed["price"]))
            event.update(
                entry_price=float(closed["price"]),
                entry_order_id=str(closed["order_id"]),
                original_side=int(closed["side"]),
                gross_pnl_usd=gross_pnl,
            )
            if venue == "lighter":
                event.update(
                    net_pnl_usd=gross_pnl,
                    entry_fee_usd=0.0,
                    exit_fee_usd=0.0,
                    round_trip_fee_usd=0.0,
                    pnl_pct=(gross_pnl / (filled * float(closed["price"])) * 100.0) if filled * float(closed["price"]) > 0 else 0.0,
                    pnl_authoritative=True,
                    pnl_source="LIGHTER_ZERO_FEE",
                )
        else:
            self.state["tranches"].append(
                {
                    "side": side,
                    "qty": filled,
                    "price": fill_price,
                    "order_id": order_id,
                    "bar_time": pending.get("bar_time") or (now_sec // INTERVAL_SECONDS[self.state["strategy_interval"]] * INTERVAL_SECONDS[self.state["strategy_interval"]]),
                    "time": now_sec,
                }
            )
        self.state["execution_history"].append(event)
        self.state["execution_history"] = self.state["execution_history"][-500:]
        self.state.update(
            pending_order=None,
            last_order_time=now_sec,
            last_error=None,
            last_action=f"{event['event']} {pending['symbol']} {'LONG' if (side > 0) == (not reduce_only) else 'SHORT'} @ {fill_price:.4f} ({pending['reason']})",
        )
        self._save()
        return event

    async def _submit_binance(
        self,
        side: int,
        notional_usd: float,
        *,
        reduce_only: bool,
        reason: str,
        bar_time: Optional[int] = None,
    ) -> Dict[str, Any]:
        symbol = self.state["selected_symbol"]
        account, amount, total_gross = await self._binance_account_and_position(symbol)
        self._check_position(amount)
        if not reduce_only and not self.state["tranches"]:
            await self.binance_client.set_margin_type(symbol, "CROSSED")
            req_lev = max(1, min(10, int(math.ceil(float(self.state["leverage"])))))
            await self.binance_client.set_leverage(symbol, req_lev)
        bid, ask = await self._book_binance(symbol, enforce_spread=not reduce_only)
        price = ask if side > 0 else bid
        step, minimum, min_notional = await self._exchange_rules_binance(symbol)

        if reduce_only:
            if not self.state["tranches"]:
                raise ValueError("No open tranche to close")
            qty = Decimal(str(self.state["tranches"][-1]["qty"]))
            if amount * side >= 0:
                raise ValueError("Exit side would increase position")
        else:
            if self.state["pending_order"] or self.state["recovery_required"]:
                raise ValueError("Resolve pending recovery first")
            if self.state["tranches"]:
                raise ValueError("Tranche already open")
            summary = account.get("summary") or {}
            equity = float(summary.get("total_equity_usd", 0.0) or 0.0)
            available = float(summary.get("available_margin_usd", 0.0) or 0.0)
            qty = self._quantize_entry_qty(notional_usd, price, step, minimum, min_notional)
            actual_usd = float(qty) * price
            if (
                actual_usd > available / self.MARGIN_BUFFER_MULTIPLIER
                or total_gross + actual_usd > equity * float(self.state["gross_leverage_cap"])
            ):
                raise ValueError("Account gross cap or buffered margin limit reached")

        qty_text = format(qty, "f")
        client_id = "hxfc" + uuid.uuid4().hex[:24]
        self.state["pending_order"] = {
            "venue": "binance_futures",
            "client_order_id": client_id,
            "symbol": symbol,
            "side": side,
            "qty": qty_text,
            "reduce_only": reduce_only,
            "reason": reason,
            "bar_time": bar_time,
            "created_at": int(time.time()),
        }
        self._save()
        try:
            order = await self.binance_client.create_order(
                symbol, "BUY" if side > 0 else "SELL", qty_text, "MARKET", reduce_only=reduce_only, client_order_id=client_id
            )
            status = order.get("status")
            fill_px = float(order.get("avgPrice", 0.0) or 0.0)
            if status != "FILLED" or fill_px <= 0:
                for _ in range(4):
                    await asyncio.sleep(0.25)
                    polled = await self.binance_client.request(
                        "GET", "/fapi/v1/order", {"symbol": symbol, "origClientOrderId": client_id}, signed=True
                    )
                    if polled.get("status") == "FILLED" and float(polled.get("avgPrice", 0.0) or 0.0) > 0:
                        order = polled
                        break
                    if polled.get("status") in {"CANCELED", "EXPIRED", "REJECTED"}:
                        order = polled
                        break
            return self._record_fill(order, self.state["pending_order"])
        except Exception as exc:
            self.state.update(
                recovery_required=True,
                execution_blocked=True,
                blocked_reason=f"Order outcome uncertain ({client_id}): {exc}",
                last_error=f"Order outcome uncertain ({client_id}): {exc}",
            )
            self._save()
            raise

    async def _submit_lighter(
        self,
        side: int,
        notional_usd: float,
        *,
        reduce_only: bool,
        reason: str,
        bar_time: Optional[int] = None,
    ) -> Dict[str, Any]:
        if self.lighter_client is None:
            raise ValueError("Lighter client unavailable")
        lt_sym = to_lighter_symbol(self.state["selected_symbol"])
        market_id = LIGHTER_MARKETS[lt_sym]
        async with self.lighter_client.execution_lock:
            account, amount, total_gross = await self._lighter_account_and_position(lt_sym)
            self._check_position(amount)
            detail = await self.lighter_client.market_detail(market_id, fresh=True)
            book = await self.lighter_client.order_book(market_id, 5)
            bids = book.get("bids") or []
            asks = book.get("asks") or []
            best_bid = max((float(b["price"]) for b in bids), default=0.0)
            best_ask = min((float(a["price"]) for a in asks), default=0.0)
            if not (0 < best_bid <= best_ask):
                raise ValueError("Invalid Lighter book quote")
            price = best_ask if side > 0 else best_bid
            spread_bps = (best_ask - best_bid) / ((best_ask + best_bid) / 2.0) * 10000.0
            if not reduce_only and spread_bps > float(self.state["max_book_spread_bps"]):
                raise ValueError(f"Lighter spread {spread_bps:.2f}bp exceeds max")
            dec = int(detail.get("supported_size_decimals", 5))
            step = 10.0 ** (-dec)
            min_base = float(detail.get("min_base_amount", 0.0) or 0.0)
            if reduce_only:
                if not self.state["tranches"] or amount * side >= 0:
                    raise ValueError("No open Lighter tranche to close")
                qty = float(self.state["tranches"][-1]["qty"])
            else:
                collateral = float(account.get("collateral", 0.0) or 0.0)
                available = float(account.get("available_margin", 0.0) or 0.0)
                raw_qty = math.floor((notional_usd / price) / step) * step
                qty = round(raw_qty, dec)
                if qty <= 0 or (min_base > 0 and qty < min_base) or qty * price > notional_usd * 1.25:
                    raise ValueError(f"Lighter target ${notional_usd:.2f} below minimum lot ({min_base}) or oversize")
                if qty * price > available / self.MARGIN_BUFFER_MULTIPLIER or total_gross + qty * price > collateral * float(self.state["gross_leverage_cap"]):
                    raise ValueError("Lighter margin or leverage cap reached")
            client_idx = secrets.randbelow(self.lighter_client.MAX_CLIENT_ORDER_INDEX - 1) + 1
            pending = {
                "venue": "lighter",
                "client_order_index": client_idx,
                "symbol": lt_sym,
                "market_id": market_id,
                "side": side,
                "qty": qty,
                "price": price,
                "reduce_only": reduce_only,
                "reason": reason,
                "bar_time": bar_time,
                "created_at": int(time.time()),
            }
            self.state["pending_order"] = pending
            self._save()
            try:
                res = await self.lighter_client.create_market_order(
                    market_id, qty, price, is_ask=side < 0, reduce_only=reduce_only, client_order_index=client_idx
                )
                return self._record_fill(res, pending)
            except Exception as exc:
                self.state.update(
                    recovery_required=True,
                    execution_blocked=True,
                    blocked_reason=f"Lighter order outcome uncertain ({client_idx}): {exc}",
                    last_error=str(exc),
                )
                self._save()
                raise

    async def _submit(
        self,
        side: int,
        notional_usd: float,
        *,
        reduce_only: bool,
        reason: str,
        bar_time: Optional[int] = None,
    ) -> Dict[str, Any]:
        if self.state["venue"] == "lighter":
            return await self._submit_lighter(side, notional_usd, reduce_only=reduce_only, reason=reason, bar_time=bar_time)
        return await self._submit_binance(side, notional_usd, reduce_only=reduce_only, reason=reason, bar_time=bar_time)

    async def reconcile(self) -> Dict[str, Any]:
        async with self.lock:
            venue = self.state["venue"]
            symbol = self.state["selected_symbol"]
            pending = self.state.get("pending_order")
            if pending and venue == "binance_futures":
                try:
                    order = await self.binance_client.request(
                        "GET", "/fapi/v1/order", {"symbol": pending["symbol"], "origClientOrderId": pending["client_order_id"]}, signed=True
                    )
                    if order.get("status") == "FILLED":
                        self._record_fill(order, pending)
                    elif order.get("status") in {"CANCELED", "EXPIRED", "REJECTED"}:
                        self.state["pending_order"] = None
                        self._save()
                except Exception as exc:
                    if "-2013" in str(exc):
                        self.state["pending_order"] = None
                        self._save()
                    else:
                        raise
            if venue == "lighter":
                account, amount, _ = await self._lighter_account_and_position(symbol)
            else:
                account, amount, _ = await self._binance_account_and_position(symbol)
            if abs(amount) <= 1e-6:
                self.state["tranches"] = []
                self.state["pending_order"] = None
            elif not self.state["tranches"]:
                # Adopt orphan position only cleanly via explicit flatten or manual align check
                raise ValueError(f"Exchange still holds open {symbol} position ({amount:+.6f}); use Flatten or align manually")
            self.state.update(recovery_required=False, execution_blocked=False, blocked_reason=None, last_error=None)
            self._save()
            return self.public_state()

    async def flatten(self) -> Dict[str, Any]:
        async with self.lock:
            self.state["enabled"] = False
            venue = self.state["venue"]
            symbol = self.state["selected_symbol"]
            if venue == "lighter":
                _, amount, _ = await self._lighter_account_and_position(symbol)
            else:
                _, amount, _ = await self._binance_account_and_position(symbol)
            if abs(amount) > 1e-6:
                close_side = -1 if amount > 0 else 1
                if not self.state["tranches"]:
                    self.state["tranches"] = [{"side": 1 if amount > 0 else -1, "qty": abs(amount), "price": 0.0, "order_id": "adopted", "time": int(time.time())}]
                await self._submit(close_side, 0.0, reduce_only=True, reason="emergency_flatten")
            else:
                self.state["tranches"] = []
            self.state.update(recovery_required=False, execution_blocked=False, blocked_reason=None, last_error=None)
            self._save()
            return self.public_state()

    async def reconciled_public_state(self) -> Dict[str, Any]:
        result = self.public_state()
        if result["venue"] != "binance_futures":
            verified = [row for row in result["execution_history"] if row.get("event") == "EXIT" and row.get("pnl_authoritative")]
            result["verified_exit_count"] = len(verified)
            result["verified_realized_pnl_usd"] = sum(float(row.get("net_pnl_usd", 0.0)) for row in verified)
            return result

        exits = [row for row in result["execution_history"] if row.get("event") == "EXIT"]
        result["verified_exit_count"] = 0
        result["verified_realized_pnl_usd"] = 0.0
        if not exits:
            return result
        signature = tuple((row.get("symbol"), row.get("order_id"), row.get("entry_order_id")) for row in exits)
        async with self._pnl_lock:
            now = time.monotonic()
            cached = self._pnl_cache
            if cached and cached[0] == signature and now - cached[1] < cached[2]:
                reconciled, error = cached[3], cached[4]
            else:
                reconciled, error = {}, None
                try:
                    by_order: Dict[str, List[Dict[str, Any]]] = {}
                    for symbol in {row["symbol"] for row in exits}:
                        fills = await self.binance_client.request(
                            "GET", "/fapi/v1/userTrades", {"symbol": symbol, "limit": 200}, signed=True
                        )
                        for fill in fills or []:
                            by_order.setdefault(str(fill.get("orderId")), []).append(fill)
                    for row in exits:
                        entry = by_order.get(str(row.get("entry_order_id")))
                        exit_fills = by_order.get(str(row.get("order_id")))
                        if not entry or not exit_fills:
                            continue
                        entry_fee = sum((Decimal(str(f["commission"])) for f in entry), Decimal(0))
                        exit_fee = sum((Decimal(str(f["commission"])) for f in exit_fills), Decimal(0))
                        gross = sum((Decimal(str(f["realizedPnl"])) for f in exit_fills), Decimal(0))
                        net = gross - entry_fee - exit_fee
                        basis = Decimal(str(row["qty"])) * Decimal(str(row["entry_price"]))
                        reconciled[str(row["order_id"])] = {
                            "gross_pnl_usd": float(gross),
                            "net_pnl_usd": float(net),
                            "entry_fee_usd": float(entry_fee),
                            "exit_fee_usd": float(exit_fee),
                            "round_trip_fee_usd": float(entry_fee + exit_fee),
                            "pnl_pct": float(net / basis * 100) if basis > 0 else 0.0,
                            "pnl_authoritative": True,
                            "pnl_source": "BINANCE_USER_TRADES",
                        }
                except Exception as exc:
                    error = str(exc)
                    reconciled = {}
                self._pnl_cache = (signature, now, 10.0 if error else 60.0, reconciled, error)

        for row in result["execution_history"]:
            oid = str(row.get("order_id"))
            if row.get("event") == "EXIT" and oid in reconciled:
                row.update(reconciled[oid])
        verified = [row for row in result["execution_history"] if row.get("event") == "EXIT" and row.get("pnl_authoritative")]
        result["verified_exit_count"] = len(verified)
        result["verified_realized_pnl_usd"] = sum(float(row["net_pnl_usd"]) for row in verified)
        return result

    async def _refresh_paused_evaluation(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_paused_refresh_at < 30.0:
            return
        self._last_paused_refresh_at = now
        try:
            bars, d_bars = await self._fetch_candles_for_venue(
                self.state["venue"], self.state["selected_symbol"], self.state["strategy_interval"]
            )
            if not bars:
                return
            last_candle = int(bars[-1]["time"])
            prev = self.state.get("last_evaluation") or {}
            if not force and prev.get("time") == last_candle and prev.get("daily_ma_period") == self.state.get("daily_ma_period"):
                return
            _, _, _, eval_dict = await asyncio.to_thread(
                evaluate_live_signal,
                bars,
                d_bars,
                {**self.state, "symbol": self.state["selected_symbol"], "interval": self.state["strategy_interval"]},
            )
            self.state["last_evaluation"] = eval_dict
            self._save()
        except Exception as exc:
            logger.debug("Paused evaluation refresh skipped: %s", exc)

    async def verify_startup(self) -> None:
        if not self.state["enabled"] and not self.state["tranches"]:
            await self._refresh_paused_evaluation(force=True)
            return
        async with self.lock:
            try:
                if self.state["venue"] == "lighter":
                    _, amount, _ = await self._lighter_account_and_position(self.state["selected_symbol"])
                else:
                    _, amount, _ = await self._binance_account_and_position(self.state["selected_symbol"])
                self._check_position(amount)
            except Exception as exc:
                self.state.update(
                    enabled=False,
                    recovery_required=True,
                    execution_blocked=True,
                    blocked_reason=str(exc),
                    last_error=str(exc),
                )
                self._save()

    async def _check_intrabar_stop(self) -> bool:
        if not self.state.get("use_stop_loss") or not self.state["tranches"]:
            return False
        tranche = self.state["tranches"][-1]
        entry_px = float(tranche.get("price", 0.0) or 0.0)
        if not (entry_px > 0):
            return False
        side = int(tranche["side"])
        sl_frac = float(self.state.get("stop_loss_pct", 3.0)) / 100.0
        symbol = self.state["selected_symbol"]
        if self.state["venue"] == "binance_futures":
            bid, ask = await self._book_binance(symbol, enforce_spread=False)
        else:
            market_id = LIGHTER_MARKETS[to_lighter_symbol(symbol)]
            book = await self.lighter_client.order_book(market_id, 5)
            bid = max((float(b["price"]) for b in (book.get("bids") or [])), default=0.0)
            ask = min((float(a["price"]) for a in (book.get("asks") or [])), default=0.0)
        mark_exit = bid if side > 0 else ask
        if not (mark_exit > 0):
            return False
        ret = side * (mark_exit / entry_px - 1.0)
        if ret <= -sl_frac:
            await self._submit(-side, 0.0, reduce_only=True, reason="intrabar_stop_loss")
            return True
        return False

    async def run_once(self) -> None:
        if not self.state["enabled"]:
            await self._refresh_paused_evaluation()
            return
        async with self.lock:
            if not self.state["enabled"] or self.state["pending_order"] or self.state["recovery_required"]:
                return
            venue = self.state["venue"]
            symbol = self.state["selected_symbol"]
            interval = self.state["strategy_interval"]
            seconds = INTERVAL_SECONDS[interval]
            conflict = self._check_bot_conflict(venue, symbol)
            if conflict:
                self.state.update(enabled=False, execution_blocked=True, blocked_reason=conflict, last_error=conflict)
                self._save()
                return
            try:
                if await self._check_intrabar_stop():
                    return
                bars, d_bars = await self._fetch_candles_for_venue(venue, symbol, interval)
                if not bars:
                    raise ValueError("No completed candles returned")
                last_candle = int(bars[-1]["time"])
                if last_candle <= int(self.state.get("last_evaluated_candle", 0)):
                    return
                grace = 90.0 if seconds >= 14400 else 35.0
                if time.time() - (last_candle + seconds) > grace:
                    self.state["last_evaluated_candle"] = last_candle
                    self._save()
                    return

                if venue == "lighter":
                    account, amount, total_gross = await self._lighter_account_and_position(symbol)
                else:
                    account, amount, total_gross = await self._binance_account_and_position(symbol)
                self._check_position(amount)

                entry_allowed, signal_side, _, eval_dict = await asyncio.to_thread(
                    evaluate_live_signal,
                    bars,
                    d_bars,
                    {**self.state, "symbol": symbol, "interval": interval},
                )
                self.state["last_evaluation"] = eval_dict
                self.state["last_evaluated_candle"] = last_candle
                self._save()

                open_tranche = self.state["tranches"][-1] if self.state["tranches"] else None
                order_usd = float(self.state["notional_usd"]) * float(self.state["leverage"])

                if open_tranche is not None:
                    open_side = int(open_tranche["side"])
                    entry_bar_time = int(open_tranche.get("bar_time") or (int(open_tranche["time"]) // seconds * seconds))
                    held_bars = max(1, (last_candle - entry_bar_time) // seconds) if last_candle > entry_bar_time else 0
                    min_hold = int(self.state.get("min_hold_bars", 1))
                    if held_bars >= min_hold:
                        if bool(self.state.get("hold_same_direction", True)) and entry_allowed and signal_side == open_side:
                            self.state["last_action"] = f"HOLD {symbol} {'LONG' if open_side > 0 else 'SHORT'} · consecutive signal match @ {last_candle}"
                            self._save()
                            return
                        reversing = bool(entry_allowed and signal_side == -open_side)
                        await self._submit(
                            -open_side,
                            0.0,
                            reduce_only=True,
                            reason="opposite_signal_reversal" if reversing else "horizon_exit",
                            bar_time=last_candle,
                        )
                        if reversing and not self.state["tranches"]:
                            await self._submit(signal_side, order_usd, reduce_only=False, reason="reversal_entry", bar_time=last_candle)
                        return
                elif entry_allowed and signal_side != 0:
                    if time.time() - int(self.state.get("last_order_time", 0)) < int(self.state.get("min_seconds_between_orders", 60)):
                        return
                    await self._submit(signal_side, order_usd, reduce_only=False, reason="closed_bar_signal", bar_time=last_candle)
            except Exception as exc:
                self.state["last_error"] = str(exc)
                if "differs from" in str(exc) or "unmanaged" in str(exc):
                    self.state.update(recovery_required=True, execution_blocked=True, blocked_reason=str(exc))
                self._save()
