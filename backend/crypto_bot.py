"""Persisted, fail-closed Binance Futures single-leg executor for Tab 4.

Supports live execution for all testable quantitative single-leg strategies:
grid, ou_quant, ma_stack, multi_factor, trend_pullback, custom.
"""

import asyncio
import copy
import json
import math
import os
import time
import uuid
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from typing import Any, Dict, Optional

from .lighter_strategy import (
    evaluate_strategy_signal,
    evaluate_grid_signals,
    LIVE_STRATEGIES,
    OU_MIN_ABS_DEVIATION_PP,
    OU_MACRO_EMA_SPAN,
    OU_MACRO_SLOPE_BARS,
)


SUPPORTED = {"BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "XRPUSDT"}
INTERVAL_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
DEFAULT_STATE = {
    "enabled": False, "selected_symbol": "BTCUSDT", "strategy_mode": "grid",
    "strategy_interval": "5m", "entry_z": 1.5, "exit_z": 0.25,
    "notional_usd": 150.0, "max_tranches": 5,
    "min_seconds_between_orders": 300, "max_book_spread_bps": 45.0,
    "ou_halflife_max": 8.0, "ou_stop_z": 3.5, "ou_min_abs_deviation_pp": 0.25,
    "ou_macro_ema_span": 60, "ou_macro_slope_bars": 12,
    "ou_use_entry_z": True, "ou_use_halflife": True, "ou_use_min_abs_deviation": True,
    "ou_use_macro_trend": True, "ou_use_stop_zone": True, "ou_use_exit_z": True,
    "ma_stretch_min": 0.30, "ma_trailing_stop": 0.15, "min_consensus_votes": 3,
    "trend_macro_window": 24, "trend_pullback_dist": 0.15, "trend_tp_dist": 0.05, "trend_slope_min": 0.002,
    "use_ma_stretch": True, "use_base_spacing": True, "use_peak": True, "use_ma_stack": False,
    "use_ma_stack_1h": True,
    "use_convergence": True, "use_dwell": True, "use_bottoming": False, "base_spacing_pct": 0.2, "min_dwell_bars": 4,
    "tranches": [], "execution_history": [], "pending_order": None,
    "last_evaluated_candle": 0, "last_order_time": 0,
    "last_evaluation": None, "last_error": None, "recovery_required": False,
}


class CryptoBot:
    def __init__(self, client: Any, state_path: Optional[Path] = None):
        self.client = client
        self.state_path = state_path or Path(__file__).with_name("crypto_bot_state.json")
        self.lock = asyncio.Lock()
        self.state = copy.deepcopy(DEFAULT_STATE)
        self._load()

    def _load(self) -> None:
        if not self.state_path.exists():
            return
        try:
            saved = json.loads(self.state_path.read_text(encoding="utf-8"))
            if not isinstance(saved, dict):
                raise ValueError("Crypto state must be an object")
            self.state.update({key: saved[key] for key in DEFAULT_STATE if key in saved})
            if (self.state["selected_symbol"] not in SUPPORTED or
                self.state["strategy_mode"] not in LIVE_STRATEGIES or
                self.state["strategy_interval"] not in INTERVAL_SECONDS or
                not isinstance(self.state["tranches"], list)):
                raise ValueError("Unsupported persisted crypto configuration")
            if self.state["pending_order"]:
                self.state.update(enabled=False, recovery_required=True,
                                  last_error="An order was pending during restart; reconcile its client order ID on Binance")
        except Exception as exc:
            self.state.update(enabled=False, recovery_required=True,
                              last_error=f"Cannot load crypto execution state: {exc}")

    def _save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".tmp")
        with open(temporary, "w", encoding="utf-8") as stream:
            json.dump(self.state, stream, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(self.state_path)

    def public_state(self) -> Dict[str, Any]:
        result = copy.deepcopy(self.state)
        result["live_strategies"] = sorted(LIVE_STRATEGIES)
        result["execution_implemented"] = True
        result["risk_capacity"] = {
            "active_tranches": len(result["tranches"]),
            "max_tranches": result["max_tranches"], "gross_leverage_cap": 1.0,
        }
        result["strategy_params"] = {
            "entry_z": float(self.state.get("entry_z", 1.5)),
            "exit_z": float(self.state.get("exit_z", 0.25)),
            "use_ma_stretch": bool(self.state.get("use_ma_stretch", True)),
            "use_base_spacing": bool(self.state.get("use_base_spacing", True)),
            "use_peak": bool(self.state.get("use_peak", True)),
            "use_ma_stack": bool(self.state.get("use_ma_stack", False)),
            "use_ma_stack_1h": bool(self.state.get("use_ma_stack_1h", True)),
            "use_convergence": bool(self.state.get("use_convergence", True)),
            "use_dwell": bool(self.state.get("use_dwell", True)),
            "use_bottoming": bool(self.state.get("use_bottoming", False)),
            "base_spacing_pct": float(self.state.get("base_spacing_pct", 0.2)),
            "min_dwell_bars": int(self.state.get("min_dwell_bars", 4)),
            "ou_halflife_max": float(self.state.get("ou_halflife_max", 8.0)),
            "ou_stop_z": float(self.state.get("ou_stop_z", 3.5)),
            "ou_min_abs_deviation_pp": float(self.state.get("ou_min_abs_deviation_pp", 0.25)),
            "ou_macro_ema_span": int(self.state.get("ou_macro_ema_span", 60)),
            "ou_macro_slope_bars": int(self.state.get("ou_macro_slope_bars", 12)),
            "ou_use_entry_z": bool(self.state.get("ou_use_entry_z", True)),
            "ou_use_halflife": bool(self.state.get("ou_use_halflife", True)),
            "ou_use_min_abs_deviation": bool(self.state.get("ou_use_min_abs_deviation", True)),
            "ou_use_macro_trend": bool(self.state.get("ou_use_macro_trend", True)),
            "ou_use_stop_zone": bool(self.state.get("ou_use_stop_zone", True)),
            "ou_use_exit_z": bool(self.state.get("ou_use_exit_z", True)),
            "ma_stretch_min": float(self.state.get("ma_stretch_min", 0.30)),
            "ma_trailing_stop": float(self.state.get("ma_trailing_stop", 0.15)),
            "min_consensus_votes": int(self.state.get("min_consensus_votes", 3)),
            "trend_macro_window": int(self.state.get("trend_macro_window", 24)),
            "trend_pullback_dist": float(self.state.get("trend_pullback_dist", 0.15)),
            "trend_tp_dist": float(self.state.get("trend_tp_dist", 0.05)),
            "trend_slope_min": float(self.state.get("trend_slope_min", 0.002)),
        }
        result["history_event_count"] = len(result["execution_history"])
        return result

    async def configure(self, values: Dict[str, Any]) -> Dict[str, Any]:
        permitted = {
            "selected_symbol", "strategy_mode", "strategy_interval", "entry_z", "exit_z",
            "notional_usd", "max_tranches", "min_seconds_between_orders", "max_book_spread_bps",
            "ou_halflife_max", "ou_stop_z", "ou_min_abs_deviation_pp",
            "ou_macro_ema_span", "ou_macro_slope_bars",
            "ou_use_entry_z", "ou_use_halflife", "ou_use_min_abs_deviation",
            "ou_use_macro_trend", "ou_use_stop_zone", "ou_use_exit_z",
            "ma_stretch_min", "ma_trailing_stop", "min_consensus_votes",
            "trend_macro_window", "trend_pullback_dist", "trend_tp_dist", "trend_slope_min",
            "use_ma_stretch", "use_base_spacing", "use_peak", "use_ma_stack",
            "use_ma_stack_1h", "use_convergence", "use_dwell", "use_bottoming", "base_spacing_pct", "min_dwell_bars",
        }
        unknown = set(values) - permitted
        if unknown:
            raise ValueError(f"Unsupported live setting: {', '.join(sorted(unknown))}")
        candidate = dict(self.state)
        for key, value in values.items():
            if key in {"selected_symbol", "strategy_mode", "strategy_interval"}:
                candidate[key] = str(value)
            elif key in {"max_tranches", "min_seconds_between_orders", "ou_macro_ema_span",
                        "ou_macro_slope_bars", "min_consensus_votes", "trend_macro_window", "min_dwell_bars"}:
                candidate[key] = int(value)
            elif key in {"ou_use_entry_z", "ou_use_halflife", "ou_use_min_abs_deviation",
                        "ou_use_macro_trend", "ou_use_stop_zone", "ou_use_exit_z",
                        "use_ma_stretch", "use_base_spacing", "use_peak", "use_ma_stack",
                        "use_ma_stack_1h", "use_convergence", "use_dwell", "use_bottoming"}:
                candidate[key] = bool(value)
            else:
                candidate[key] = float(value)
        if candidate["selected_symbol"] not in SUPPORTED:
            raise ValueError("Unsupported Futures symbol")
        if candidate["strategy_mode"] not in LIVE_STRATEGIES:
            raise ValueError(f"Unsupported live strategy: {candidate['strategy_mode']}")
        if candidate["strategy_interval"] not in INTERVAL_SECONDS:
            raise ValueError("Unsupported candle interval")
        bounds = {
            "entry_z": (0.1, 10.0), "exit_z": (0.0, 5.0),
            "notional_usd": (10.0, 500.0), "max_tranches": (1, 5),
            "min_seconds_between_orders": (6, 86400), "max_book_spread_bps": (1, 100),
            "ou_halflife_max": (0.5, 50.0), "ou_stop_z": (1.0, 10.0),
            "ou_min_abs_deviation_pp": (0.01, 10.0),
            "ma_stretch_min": (0.01, 10.0), "ma_trailing_stop": (0.01, 10.0),
            "min_consensus_votes": (1, 4),
            "trend_macro_window": (12, 100), "trend_pullback_dist": (0.01, 10.0),
            "trend_tp_dist": (0.01, 10.0), "trend_slope_min": (0.0001, 1.0),
        }
        for key, (low, high) in bounds.items():
            if key in candidate:
                value = candidate[key]
                if not math.isfinite(value) or not low <= value <= high:
                    raise ValueError(f"{key} must be between {low} and {high}")
        if candidate["strategy_mode"] in {"grid", "custom", "ou_quant"}:
            if candidate["exit_z"] >= candidate["entry_z"]:
                raise ValueError("Exit Z must be below Entry Z")
        async with self.lock:
            if self.state["enabled"] and any(candidate[key] != self.state[key] for key in
                ("selected_symbol", "strategy_mode", "strategy_interval", "entry_z", "exit_z",
                 "notional_usd", "max_tranches", "ma_stretch_min", "min_consensus_votes", "trend_macro_window")):
                raise ValueError("Pause the live bot before changing strategy or sizing")
            if self.state["tranches"] and candidate["selected_symbol"] != self.state["selected_symbol"]:
                raise ValueError("Close tracked inventory before changing symbol")
            self.state.update({key: candidate[key] for key in values})
            self._save()
            return self.public_state()

    async def _account_position(self, symbol: str) -> tuple[Dict[str, Any], float]:
        account = await self.client.get_detailed_account_overview()
        if not account.get("authenticated"):
            raise ValueError(account.get("error") or "Binance Futures account unavailable")
        if not account.get("can_trade", True):
            raise ValueError("Binance Futures account is not permitted to trade")
        position_mode = await self.client.request("GET", "/fapi/v1/positionSide/dual", signed=True)
        if position_mode.get("dualSidePosition") is not False:
            raise ValueError("Single-leg execution requires Binance one-way position mode")
        positions = await self.client.request("GET", "/fapi/v2/positionRisk", {"symbol": symbol}, signed=True)
        selected = [row for row in positions if row.get("symbol") == symbol]
        if len(selected) > 1 or (selected and selected[0].get("positionSide", "BOTH") != "BOTH"):
            raise ValueError("Unexpected Binance position layout")
        return account, float(selected[0].get("positionAmt", 0)) if selected else 0.0

    def _check_position(self, amount: float) -> None:
        tranches = self.state["tranches"]
        expected = sum(float(item["qty"]) * int(item["side"]) for item in tranches)
        tolerance = max(1e-8, abs(expected) * 0.00001)
        if abs(amount - expected) > tolerance:
            raise ValueError("Exchange position differs from the bot's persisted fills; manual reconciliation required")

    def _record_fill(self, order: Dict[str, Any], pending: Dict[str, Any]) -> Dict[str, Any]:
        filled = float(order.get("executedQty", 0))
        fill_price = float(order.get("avgPrice", 0))
        expected_qty = float(pending["qty"])
        if (order.get("status") != "FILLED" or filled <= 0 or fill_price <= 0 or
            abs(filled - expected_qty) > max(1e-8, expected_qty * 0.00001)):
            raise ValueError("Order response did not confirm a complete fill")
        reduce_only = bool(pending["reduce_only"])
        side = int(pending["side"])
        event = {"event": "EXIT" if reduce_only else "ENTRY", "symbol": pending["symbol"],
                 "side": side, "qty": filled, "price": fill_price,
                 "notional_usd": filled * fill_price, "order_id": str(order.get("orderId", "")),
                 "client_order_id": pending["client_order_id"], "reason": pending["reason"],
                 "time": int(time.time()), "pnl_authoritative": False}
        if reduce_only:
            closed = self.state["tranches"].pop()
            event.update(entry_price=closed["price"], entry_order_id=closed["order_id"],
                         original_side=closed["side"])
        else:
            self.state["tranches"].append({"side": side, "qty": filled, "price": fill_price,
                                            "order_id": event["order_id"], "time": event["time"]})
        self.state["execution_history"].append(event)
        self.state["execution_history"] = self.state["execution_history"][-500:]
        self.state.update(pending_order=None, last_order_time=event["time"], last_error=None)
        self._save()
        return event

    async def _exchange_rules(self, symbol: str) -> tuple[Decimal, Decimal, Decimal]:
        data = await self.client.request("GET", "/fapi/v1/exchangeInfo")
        details = next((row for row in data.get("symbols", []) if row.get("symbol") == symbol), None)
        if not details or details.get("status") != "TRADING":
            raise ValueError("Selected Futures symbol is not trading")
        filters = {row["filterType"]: row for row in details.get("filters", [])}
        lot = filters.get("MARKET_LOT_SIZE") or {}
        if Decimal(str(lot.get("stepSize", "0"))) <= 0:
            lot = filters.get("LOT_SIZE") or {}
        step = Decimal(str(lot.get("stepSize", "0")))
        minimum = Decimal(str(lot.get("minQty", "0")))
        if step <= 0:
            raise ValueError("Exchange quantity filter unavailable")
        notional = filters.get("MIN_NOTIONAL", {})
        min_notional = Decimal(str(notional.get("notional", "0")))
        return step, minimum, min_notional

    async def _book(self, symbol: str, *, enforce_spread: bool = True) -> tuple[float, float]:
        quote = await self.client.request("GET", "/fapi/v1/ticker/bookTicker", {"symbol": symbol})
        bid, ask = float(quote["bidPrice"]), float(quote["askPrice"])
        if not 0 < bid <= ask or (enforce_spread and (ask - bid) / ((ask + bid) / 2) * 10000 > self.state["max_book_spread_bps"]):
            raise ValueError("Executable book quote is invalid or too wide")
        return bid, ask

    @staticmethod
    def _entry_quantity(target_usd: float, price: float, step: Decimal,
                        minimum: Decimal, min_notional: Decimal) -> Decimal:
        target = Decimal(str(target_usd))
        price_decimal = Decimal(str(price))
        rounded_down = (target / price_decimal / step).to_integral_value(rounding=ROUND_DOWN) * step
        rounded_up = rounded_down + step
        candidates = [qty for qty in (rounded_down, rounded_up)
                      if qty >= minimum and qty * price_decimal >= min_notional]
        if not candidates:
            raise ValueError("Configured order is below the current Binance lot/notional minimum")
        chosen = min(candidates, key=lambda qty: abs(qty * price_decimal - target))
        actual_usd = chosen * price_decimal
        if actual_usd < target * Decimal("0.75") or actual_usd > target * Decimal("1.25"):
            raise ValueError(f"Exchange lot size makes the nearest order ${actual_usd:.2f}; adjust the target")
        return chosen

    async def toggle(self, enabled: bool) -> Dict[str, Any]:
        async with self.lock:
            if not enabled:
                self.state["enabled"] = False
                self._save()
                return self.public_state()
            if self.state["recovery_required"] or self.state["pending_order"]:
                raise ValueError("Resolve execution recovery before enabling")
            if self.state["strategy_mode"] not in LIVE_STRATEGIES:
                raise ValueError("Selected strategy is replay-only")
            symbol = self.state["selected_symbol"]
            account, amount = await self._account_position(symbol)
            self._check_position(amount)
            if float(account.get("summary", {}).get("available_margin_usd", 0)) <= 0:
                raise ValueError("No available Futures margin")
            step, minimum, min_notional = await self._exchange_rules(symbol)
            _, ask = await self._book(symbol)
            self._entry_quantity(self.state["notional_usd"], ask, step, minimum, min_notional)
            # Arming never executes a historical signal; wait for the next completed bar.
            self.state["last_evaluated_candle"] = int(time.time()) // INTERVAL_SECONDS[self.state["strategy_interval"]] * INTERVAL_SECONDS[self.state["strategy_interval"]] - INTERVAL_SECONDS[self.state["strategy_interval"]]
            self.state.update(enabled=True, last_error=None)
            self._save()
            return self.public_state()

    async def _submit(self, side: int, notional: float, *, reduce_only: bool, reason: str,
                      signal_values: Optional[list[float]] = None) -> Dict[str, Any]:
        symbol = self.state["selected_symbol"]
        account, amount = await self._account_position(symbol)
        self._check_position(amount)
        if not reduce_only and not self.state["tranches"]:
            await self.client.set_margin_type(symbol, "CROSSED")
            await self.client.set_leverage(symbol, 1)
        bid, ask = await self._book(symbol, enforce_spread=not reduce_only)
        price = ask if side > 0 else bid
        if signal_values is not None and not reduce_only:
            executable_values = signal_values[:-1] + [price]
            valid, quote_side, _, _ = evaluate_strategy_signal(
                self.state["strategy_mode"],
                executable_values,
                self.state,
                evaluation_time=int(time.time()),
                position_side=0,
                entry_price=0.0,
                held_bars=0,
            )
            if not valid or quote_side != side:
                raise ValueError("Current executable quote no longer supports the candle entry signal")
        step, minimum, min_notional = await self._exchange_rules(symbol)
        if reduce_only:
            if not self.state["tranches"]:
                raise ValueError("No bot-owned tranche to close")
            qty = Decimal(str(self.state["tranches"][-1]["qty"]))
            if amount * side >= 0:
                raise ValueError("Exit side would increase exposure")
        else:
            if self.state["pending_order"] or self.state["recovery_required"]:
                raise ValueError("Execution recovery required")
            if len(self.state["tranches"]) >= self.state["max_tranches"]:
                raise ValueError("Tranche capacity reached")
            if amount and amount * side < 0:
                raise ValueError("Cannot reverse an active campaign")
            equity = float(account.get("summary", {}).get("total_equity_usd", 0))
            available = float(account.get("summary", {}).get("available_margin_usd", 0))
            selected_gross = abs(amount) * price
            qty = self._entry_quantity(notional, price, step, minimum, min_notional)
            actual_notional = float(qty) * price
            if actual_notional > available / 1.25 or selected_gross + actual_notional > equity:
                raise ValueError("Selected-contract 1x equity cap or 125% available-margin reserve would be exceeded")
        if qty < minimum or qty * Decimal(str(price)) < min_notional:
            raise ValueError("Order falls below current Binance market lot or notional minimum")
        qty_text = format(qty, "f")
        client_id = "hxcrypto" + uuid.uuid4().hex[:24]
        self.state["pending_order"] = {"client_order_id": client_id, "symbol": symbol,
                                       "side": side, "qty": qty_text, "reduce_only": reduce_only,
                                       "reason": reason, "created_at": int(time.time())}
        self._save()
        try:
            order = await self.client.create_order(symbol, "BUY" if side > 0 else "SELL", qty_text,
                                                   "MARKET", reduce_only=reduce_only, client_order_id=client_id)
            # Binance Futures market orders may return status="NEW" or avgPrice="0.00" initially
            # while matching engine processes the fill. Poll GET /fapi/v1/order briefly if needed.
            status = order.get("status")
            fill_price = float(order.get("avgPrice", 0))
            if status != "FILLED" or fill_price <= 0:
                for _ in range(4):
                    await asyncio.sleep(0.25)
                    try:
                        polled = await self.client.request(
                            "GET", "/fapi/v1/order",
                            {"symbol": symbol, "origClientOrderId": client_id},
                            signed=True,
                        )
                        if polled.get("status") == "FILLED" and float(polled.get("avgPrice", 0)) > 0:
                            order = polled
                            break
                        if polled.get("status") in {"CANCELED", "EXPIRED", "REJECTED"}:
                            order = polled
                            break
                    except Exception:
                        pass
            return self._record_fill(order, self.state["pending_order"])
        except Exception as exc:
            # Binance may have filled an order even if its response timed out.
            # Never retry or trade again until the client ID is reconciled.
            self.state.update(enabled=False, recovery_required=True,
                              last_error=f"Order outcome uncertain; check {client_id} on Binance: {exc}")
            self._save()
            raise

    async def reconcile(self) -> Dict[str, Any]:
        """Read exchange order/position history to resolve a stopped executor."""
        async with self.lock:
            if self.state["enabled"]:
                raise ValueError("Pause the bot before reconciliation")
            pending = self.state["pending_order"]
            event = None
            if pending:
                order = await self.client.request("GET", "/fapi/v1/order",
                                                  {"symbol": pending["symbol"],
                                                   "origClientOrderId": pending["client_order_id"]}, signed=True)
                if order.get("status") == "FILLED":
                    event = self._record_fill(order, pending)
                elif order.get("status") in {"CANCELED", "EXPIRED", "REJECTED"} and float(order.get("executedQty", 0)) == 0:
                    self.state["pending_order"] = None
                    self._save()
                else:
                    raise ValueError("Order is still open, partially filled, or not conclusively canceled")
            account, amount = await self._account_position(self.state["selected_symbol"])
            self._check_position(amount)
            self.state.update(recovery_required=False, last_error=None)
            self._save()
            return {"event": event, "bot": self.public_state()}

    async def verify_startup(self) -> None:
        """Never resume persisted live mode before checking actual exchange inventory."""
        if not self.state["enabled"] and not self.state["tranches"]:
            return
        async with self.lock:
            try:
                if self.state["pending_order"]:
                    raise ValueError("Pending order from previous process requires reconciliation")
                _, amount = await self._account_position(self.state["selected_symbol"])
                self._check_position(amount)
            except Exception as exc:
                self.state.update(enabled=False, recovery_required=True,
                                  last_error=f"Startup reconciliation failed: {exc}")
                self._save()

    async def manual_entry(self, side: int, notional: float) -> Dict[str, Any]:
        if side not in (-1, 1) or not math.isfinite(notional) or not 10 <= notional <= 500:
            raise ValueError("Side must be long/short and notional $10–$500")
        async with self.lock:
            if self.state["enabled"]:
                raise ValueError("Pause the auto bot before manual entry")
            return await self._submit(side, notional, reduce_only=False, reason="manual")

    async def manual_reduce(self) -> Dict[str, Any]:
        async with self.lock:
            if self.state["enabled"]:
                raise ValueError("Pause the auto bot before manual reduction")
            if self.state["recovery_required"] or self.state["pending_order"]:
                raise ValueError("Reconcile uncertain order before reduction")
            if not self.state["tranches"]:
                raise ValueError("No bot-owned tranche to reduce")
            return await self._submit(-int(self.state["tranches"][-1]["side"]), 0,
                                      reduce_only=True, reason="manual")

    async def flatten(self) -> Dict[str, Any]:
        async with self.lock:
            self.state["enabled"] = False
            self._save()
            if self.state["recovery_required"] or self.state["pending_order"]:
                raise ValueError("Bot paused; reconcile uncertain order before flattening")
            events = []
            while self.state["tranches"]:
                events.append(await self._submit(-int(self.state["tranches"][-1]["side"]), 0,
                                                 reduce_only=True, reason="emergency_flatten"))
            return {"events": events, "bot": self.public_state()}

    async def run_once(self) -> None:
        if not self.state["enabled"]:
            return
        async with self.lock:
            if not self.state["enabled"] or self.state["pending_order"] or self.state["recovery_required"]:
                return
            interval = self.state["strategy_interval"]
            seconds = INTERVAL_SECONDS[interval]
            symbol = self.state["selected_symbol"]
            try:
                raw = await self.client.request("GET", "/fapi/v1/klines",
                                                {"symbol": symbol, "interval": interval, "limit": 125})
                now_ms = int(time.time() * 1000)
                closed = [row for row in raw if int(row[6]) < now_ms]
                min_bars = 65 if self.state["strategy_mode"] in {"ma_stack", "ou_quant"} else 25
                if len(closed) < min_bars:
                    raise ValueError("Insufficient completed Binance candles")
                last_candle = int(closed[-1][0]) // 1000
                if last_candle <= self.state["last_evaluated_candle"]:
                    return
                # A missed signal is safer than a delayed order based on stale data.
                if time.time() - (last_candle + seconds) > 30:
                    self.state["last_evaluated_candle"] = last_candle
                    self._save()
                    return
                values = [float(row[4]) for row in closed]
                account, amount = await self._account_position(symbol)
                self._check_position(amount)
                position_side = int(self.state["tranches"][-1]["side"]) if self.state["tranches"] else 0
                entry_price = float(self.state["tranches"][-1]["price"]) if self.state["tranches"] else 0.0
                entry_time = int(self.state["tranches"][-1].get("time", 0)) if self.state["tranches"] else 0
                held_seconds = max(0, int(time.time()) - entry_time) if entry_time else 0
                held_bars = held_seconds // seconds if seconds else 0

                entry, side, exit_signal, evaluation = evaluate_strategy_signal(
                    self.state["strategy_mode"],
                    values,
                    self.state,
                    evaluation_time=last_candle,
                    position_side=position_side,
                    entry_price=entry_price,
                    held_bars=held_bars,
                )
                self.state["last_evaluation"] = evaluation
                self.state["last_evaluated_candle"] = last_candle
                self._save()
                if self.state["tranches"] and exit_signal:
                    # Exit one owned tranche per bar; all exits are reduce-only.
                    await self._submit(-int(self.state["tranches"][-1]["side"]), 0,
                                       reduce_only=True, reason="signal_exit")
                elif entry and len(self.state["tranches"]) < self.state["max_tranches"]:
                    if time.time() - self.state["last_order_time"] < self.state["min_seconds_between_orders"]:
                        return
                    await self._submit(side, self.state["notional_usd"], reduce_only=False,
                                       reason="closed_bar_signal", signal_values=values)
            except Exception as exc:
                if not self.state["recovery_required"]:
                    self.state["last_error"] = str(exc)
                if "differs from the bot" in str(exc):
                    self.state.update(enabled=False, recovery_required=True)
                self._save()
