"""Independent, fail-closed Lighter perp Grid executor for Tab 5."""

import asyncio
import copy
import json
import math
import os
import secrets
import time
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from typing import Any, Dict, Optional

from .crypto_bot import INTERVAL_SECONDS
from .lighter_strategy import evaluate_grid_signals


# Verified against Lighter's live perp market list. Market details are checked
# again before every order so a suspended market cannot be traded.
MARKETS = {"BTC": 1, "ETH": 0, "SOL": 2, "DOGE": 3, "XRP": 7}
DEFAULT_STATE = {
    "enabled": False, "selected_symbol": "BTC", "strategy_mode": "grid",
    "strategy_interval": "5m", "entry_z": 1.5, "exit_z": 0.25,
    "notional_usd": 150.0, "max_tranches": 5,
    "min_seconds_between_orders": 300, "max_book_spread_bps": 45.0,
    "tranches": [], "execution_history": [], "pending_order": None,
    "last_evaluated_candle": 0, "last_order_time": 0,
    "last_evaluation": None, "last_error": None, "recovery_required": False,
}


class LighterCryptoBot:
    def __init__(self, client: Any, state_path: Optional[Path] = None):
        self.client = client
        self.state_path = state_path or Path(__file__).with_name("lighter_crypto_bot_state.json")
        self.lock = asyncio.Lock()
        self.state = copy.deepcopy(DEFAULT_STATE)
        self._load()

    def _load(self) -> None:
        if not self.state_path.exists():
            return
        try:
            saved = json.loads(self.state_path.read_text(encoding="utf-8"))
            if not isinstance(saved, dict):
                raise ValueError("State must be an object")
            self.state.update({key: saved[key] for key in DEFAULT_STATE if key in saved})
            if (self.state["selected_symbol"] not in MARKETS or
                    self.state["strategy_mode"] != "grid" or
                    self.state["strategy_interval"] not in INTERVAL_SECONDS or
                    not isinstance(self.state["tranches"], list)):
                raise ValueError("Unsupported persisted Lighter crypto configuration")
            if self.state["pending_order"]:
                self.state.update(enabled=False, recovery_required=True,
                                  last_error="Pending Lighter order requires reconciliation")
        except Exception as exc:
            self.state.update(enabled=False, recovery_required=True,
                              last_error=f"Cannot load Lighter crypto state: {exc}")

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
        result.update(live_strategies=["grid"], execution_implemented=True,
                      venue="Lighter", history_event_count=len(result["execution_history"]),
                      risk_capacity={"active_tranches": len(result["tranches"]),
                                     "max_tranches": result["max_tranches"],
                                     "gross_leverage_cap": 1.0})
        return result

    async def configure(self, values: Dict[str, Any]) -> Dict[str, Any]:
        permitted = {"selected_symbol", "strategy_mode", "strategy_interval", "entry_z", "exit_z",
                     "notional_usd", "max_tranches", "min_seconds_between_orders", "max_book_spread_bps"}
        unknown = set(values) - permitted
        if unknown:
            raise ValueError(f"Unsupported live setting: {', '.join(sorted(unknown))}")
        candidate = dict(self.state)
        for key, value in values.items():
            if key in {"selected_symbol", "strategy_mode", "strategy_interval"}:
                candidate[key] = str(value)
            elif key in {"max_tranches", "min_seconds_between_orders"}:
                candidate[key] = int(value)
            else:
                candidate[key] = float(value)
        if candidate["selected_symbol"] not in MARKETS:
            raise ValueError("Unsupported Lighter perp symbol")
        if candidate["strategy_mode"] != "grid":
            raise ValueError("This strategy is available in replay only; live supports Grid")
        if candidate["strategy_interval"] not in INTERVAL_SECONDS:
            raise ValueError("Unsupported candle interval")
        for key, (low, high) in {"entry_z": (0.1, 10), "exit_z": (0, 5),
                                "notional_usd": (10, 500), "max_tranches": (1, 5),
                                "min_seconds_between_orders": (6, 86400),
                                "max_book_spread_bps": (1, 100)}.items():
            value = candidate[key]
            if not math.isfinite(value) or not low <= value <= high:
                raise ValueError(f"{key} must be between {low} and {high}")
        if candidate["exit_z"] >= candidate["entry_z"]:
            raise ValueError("Exit Z must be below Entry Z")
        async with self.lock:
            if self.state["enabled"] and any(candidate[key] != self.state[key] for key in
                ("selected_symbol", "strategy_mode", "strategy_interval", "entry_z", "exit_z",
                 "notional_usd", "max_tranches")):
                raise ValueError("Pause the live bot before changing strategy or sizing")
            if self.state["tranches"] and candidate["selected_symbol"] != self.state["selected_symbol"]:
                raise ValueError("Close tracked inventory before changing symbol")
            self.state.update({key: candidate[key] for key in values})
            self._save()
            return self.public_state()

    async def _account_position(self, symbol: str) -> tuple[Dict[str, Any], float, list[Dict[str, Any]]]:
        account = await self.client.account_status()
        if not account.get("authenticated") or not account.get("execution_enabled"):
            raise ValueError("Lighter account is unavailable or has no collateral")
        positions = await self.client.positions(fresh=True)
        market_id = MARKETS[symbol]
        selected = [p for p in positions if int(p.get("market_id", -1)) == market_id]
        if len(selected) > 1:
            raise ValueError("Unexpected Lighter position layout")
        amount = 0.0
        if selected:
            row = selected[0]
            raw = float(row.get("position", 0) or row.get("size", 0) or 0)
            sign = int(row.get("sign", 1 if raw >= 0 else -1))
            amount = abs(raw) * (1 if sign > 0 else -1)
        return account, amount, positions

    def _check_position(self, amount: float, size_step: float) -> None:
        expected = sum(float(item["qty"]) * int(item["side"]) for item in self.state["tranches"])
        if abs(amount - expected) > max(size_step / 2, abs(expected) * 0.00001):
            raise ValueError("Lighter position differs from the bot's persisted fills; reconciliation required")

    async def _market(self, symbol: str, *, fresh: bool = False) -> tuple[int, Dict[str, Any], float]:
        market_id = MARKETS[symbol]
        detail = await self.client.market_detail(market_id, fresh=fresh)
        if detail.get("status") != "active" or detail.get("market_type") != "perp" or detail.get("symbol") != symbol:
            raise ValueError(f"Lighter {symbol} perp is not active")
        return market_id, detail, 10 ** -int(detail["supported_size_decimals"])

    async def _book(self, market_id: int, *, enforce_spread: bool = True) -> tuple[float, float]:
        book = await self.client.order_book(market_id, 20, fresh=True)
        bid = max((float(p["price"]) for p in book.get("bids") or []), default=0.0)
        ask = min((float(p["price"]) for p in book.get("asks") or []), default=0.0)
        if not 0 < bid <= ask:
            raise ValueError("Lighter executable book is unavailable")
        if enforce_spread and (ask - bid) / ((ask + bid) / 2) * 10000 > self.state["max_book_spread_bps"]:
            raise ValueError("Lighter executable spread exceeds configured safeguard")
        return bid, ask

    @staticmethod
    def _entry_quantity(target_usd: float, price: float, detail: Dict[str, Any]) -> float:
        decimals = int(detail["supported_size_decimals"])
        step = Decimal(1).scaleb(-decimals)
        target = Decimal(str(target_usd))
        px = Decimal(str(price))
        minimum = Decimal(str(detail.get("min_base_amount") or 0))
        min_quote = Decimal(str(detail.get("min_quote_amount") or 0))
        down = (target / px / step).to_integral_value(rounding=ROUND_DOWN) * step
        candidates = [qty for qty in (down, down + step) if qty >= minimum and qty * px >= min_quote]
        if not candidates:
            raise ValueError("Configured order is below Lighter market minimum")
        chosen = min(candidates, key=lambda qty: abs(qty * px - target))
        actual = chosen * px
        if actual < target * Decimal("0.75") or actual > target * Decimal("1.25"):
            raise ValueError(f"Lighter lot size makes nearest order ${actual:.2f}; adjust target")
        return float(chosen)

    async def toggle(self, enabled: bool) -> Dict[str, Any]:
        async with self.lock:
            if not enabled:
                self.state["enabled"] = False
                self._save()
                return self.public_state()
            if self.state["recovery_required"] or self.state["pending_order"]:
                raise ValueError("Resolve Lighter execution recovery before enabling")
            symbol = self.state["selected_symbol"]
            market_id, detail, step = await self._market(symbol, fresh=True)
            account, amount, _ = await self._account_position(symbol)
            self._check_position(amount, step)
            _, ask = await self._book(market_id)
            self._entry_quantity(self.state["notional_usd"], ask, detail)
            if float(account.get("collateral", 0)) <= 0:
                raise ValueError("No available Lighter collateral")
            seconds = INTERVAL_SECONDS[self.state["strategy_interval"]]
            self.state["last_evaluated_candle"] = int(time.time()) // seconds * seconds - seconds
            self.state.update(enabled=True, last_error=None)
            self._save()
            return self.public_state()

    def _record_fill(self, order: Dict[str, Any], pending: Dict[str, Any]) -> Dict[str, Any]:
        filled = float(order.get("filled_size", 0) or 0)
        price = float(order.get("fill_price", 0) or 0)
        step = float(pending["size_step"])
        expected = float(pending["qty"])
        if not order.get("fill_confirmed") or price <= 0 or abs(filled - expected) > max(step / 2, expected * 0.00001):
            raise ValueError("Lighter order did not confirm the complete intended fill")
        side = int(pending["side"])
        is_exit = bool(pending["reduce_only"])
        event = {"event": "EXIT" if is_exit else "ENTRY", "symbol": pending["symbol"],
                 "market_id": pending["market_id"], "side": side, "qty": filled,
                 "price": price, "notional_usd": filled * price,
                 "order_id": str(pending["client_order_index"]),
                 "client_order_index": pending["client_order_index"],
                 "reason": pending["reason"], "time": int(order.get("fill_time_ms", 0) or 0) // 1000 or int(time.time()),
                 "fee_usd": float(order.get("fee_usd", 0) or 0),
                 "pnl_authoritative": False}
        if is_exit:
            closed = self.state["tranches"].pop()
            gross = int(closed["side"]) * filled * (price - float(closed["price"]))
            net = gross - float(closed.get("fee_usd", 0)) - event["fee_usd"]
            event.update(entry_price=closed["price"], entry_order_id=closed["order_id"],
                         original_side=closed["side"], gross_pnl_usd=gross,
                         net_pnl_usd=net, pnl_source="ESTIMATED_EX_FUNDING")
        else:
            self.state["tranches"].append({"side": side, "qty": filled, "price": price,
                                            "fee_usd": event["fee_usd"],
                                            "order_id": event["order_id"], "time": event["time"]})
        self.state["execution_history"].append(event)
        self.state["execution_history"] = self.state["execution_history"][-500:]
        self.state.update(pending_order=None, last_order_time=event["time"], last_error=None)
        self._save()
        return event

    async def _submit(self, side: int, notional: float, *, reduce_only: bool, reason: str,
                      signal_values: Optional[list[float]] = None) -> Dict[str, Any]:
        async with self.client.execution_lock:
            symbol = self.state["selected_symbol"]
            market_id, detail, step = await self._market(symbol, fresh=True)
            account, amount, positions = await self._account_position(symbol)
            self._check_position(amount, step)
            bid, ask = await self._book(market_id, enforce_spread=not reduce_only)
            price = ask if side > 0 else bid
            if signal_values is not None and not reduce_only:
                valid, quote_side, _, _ = evaluate_grid_signals(
                    signal_values[:-1] + [price], entry_z=self.state["entry_z"],
                    exit_z=self.state["exit_z"])
                if not valid or quote_side != side:
                    raise ValueError("Current Lighter quote no longer supports the candle entry signal")
            if reduce_only:
                if not self.state["tranches"] or amount * side >= 0:
                    raise ValueError("No bot-owned tranche can be reduced in that direction")
                qty = float(self.state["tranches"][-1]["qty"])
            else:
                if self.state["pending_order"] or self.state["recovery_required"]:
                    raise ValueError("Execution recovery required")
                if len(self.state["tranches"]) >= self.state["max_tranches"]:
                    raise ValueError("Tranche capacity reached")
                if amount and amount * side < 0:
                    raise ValueError("Cannot reverse an active campaign")
                qty = self._entry_quantity(notional, price, detail)
                collateral = float(account.get("collateral", 0) or 0)
                gross = 0.0
                for position in positions:
                    size = abs(float(position.get("position", 0) or position.get("size", 0) or 0))
                    value = abs(float(position.get("position_value", 0) or 0))
                    if size and not value:
                        mark = float(position.get("mark_price", 0) or position.get("avg_entry_price", 0) or 0)
                        if mark <= 0:
                            raise ValueError("Cannot determine account-wide Lighter exposure")
                        value = size * mark
                    gross += value
                allocated = sum(abs(float(p.get("allocated_margin", 0) or 0)) for p in positions)
                order_usd = qty * price
                if gross + order_usd > collateral or order_usd > (collateral - allocated) / 1.25:
                    raise ValueError("Account-wide 1x gross cap or 125% margin reserve would be exceeded")
            order_index = secrets.randbelow(self.client.MAX_CLIENT_ORDER_INDEX - 1) + 1
            pending = {"client_order_index": order_index, "symbol": symbol, "market_id": market_id,
                       "side": side, "qty": qty, "size_step": step,
                       "reduce_only": reduce_only, "reason": reason, "created_at": int(time.time())}
            self.state["pending_order"] = pending
            self._save()
            try:
                result = await self.client.create_market_order(
                    market_id, qty, price, is_ask=side < 0, reduce_only=reduce_only,
                    client_order_index=order_index)
                return self._record_fill(result, pending)
            except Exception as exc:
                self.state.update(enabled=False, recovery_required=True,
                                  last_error=f"Lighter order outcome uncertain; reconcile {order_index}: {exc}")
                self._save()
                raise

    async def reconcile(self) -> Dict[str, Any]:
        async with self.lock:
            if self.state["enabled"]:
                raise ValueError("Pause the bot before reconciliation")
            pending = self.state["pending_order"]
            event = None
            if pending:
                idx = int(pending["client_order_index"])
                order = await self.client.account_order(idx)
                if not order:
                    raise ValueError("Lighter order is not found; outcome remains uncertain")
                fill = await self.client.execution_fill(idx, int(pending["market_id"]), float(pending["qty"]))
                if fill.get("fill_confirmed"):
                    event = self._record_fill(fill, pending)
                elif str(order.get("status", "")).lower() in {"cancelled", "canceled", "expired", "rejected"} and not float(order.get("filled_base_amount", 0) or 0):
                    self.state["pending_order"] = None
                    self._save()
                else:
                    raise ValueError("Lighter order may be open or partially filled; manual recovery required")
            symbol = self.state["selected_symbol"]
            _, _, step = await self._market(symbol)
            _, amount, _ = await self._account_position(symbol)
            self._check_position(amount, step)
            self.state.update(recovery_required=False, last_error=None)
            self._save()
            return {"event": event, "bot": self.public_state()}

    async def verify_startup(self) -> None:
        if not self.state["enabled"] and not self.state["tranches"]:
            return
        async with self.lock:
            try:
                if self.state["pending_order"]:
                    raise ValueError("Pending order requires reconciliation")
                symbol = self.state["selected_symbol"]
                _, _, step = await self._market(symbol)
                _, amount, _ = await self._account_position(symbol)
                self._check_position(amount, step)
            except Exception as exc:
                self.state.update(enabled=False, recovery_required=True,
                                  last_error=f"Startup reconciliation failed: {exc}")
                self._save()

    async def manual_entry(self, side: int, notional: float) -> Dict[str, Any]:
        if side not in (-1, 1) or not math.isfinite(notional) or not 10 <= notional <= 500:
            raise ValueError("Side must be long/short and notional $10–$500")
        async with self.lock:
            if self.state["enabled"]:
                raise ValueError("Pause auto trading before manual entry")
            return await self._submit(side, notional, reduce_only=False, reason="manual")

    async def manual_reduce(self) -> Dict[str, Any]:
        async with self.lock:
            if self.state["enabled"] or self.state["recovery_required"] or self.state["pending_order"]:
                raise ValueError("Pause and reconcile the bot before manual reduction")
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
            symbol = self.state["selected_symbol"]
            interval = self.state["strategy_interval"]
            seconds = INTERVAL_SECONDS[interval]
            try:
                market_id, _, step = await self._market(symbol)
                rows = await self.client.candles(market_id, interval, 125, fresh=True)
                now_ms = int(time.time() * 1000)
                closed = [row for row in rows if int(row["t"]) + seconds * 1000 <= now_ms - 1000]
                if len(closed) < 25:
                    raise ValueError("Insufficient completed Lighter candles")
                last_candle = int(closed[-1]["t"]) // 1000
                if last_candle <= self.state["last_evaluated_candle"]:
                    return
                if time.time() - (last_candle + seconds) > 30:
                    self.state["last_evaluated_candle"] = last_candle
                    self._save()
                    return
                values = [float(row["c"]) for row in closed]
                entry, side, exit_signal, evaluation = evaluate_grid_signals(
                    values, entry_z=self.state["entry_z"], exit_z=self.state["exit_z"],
                    evaluation_time=last_candle)
                self.state["last_evaluation"] = evaluation
                self.state["last_evaluated_candle"] = last_candle
                self._save()
                _, amount, _ = await self._account_position(symbol)
                self._check_position(amount, step)
                if self.state["tranches"] and exit_signal:
                    await self._submit(-int(self.state["tranches"][-1]["side"]), 0,
                                       reduce_only=True, reason="signal_exit")
                elif entry and len(self.state["tranches"]) < self.state["max_tranches"]:
                    if time.time() - self.state["last_order_time"] >= self.state["min_seconds_between_orders"]:
                        await self._submit(side, self.state["notional_usd"], reduce_only=False,
                                           reason="closed_bar_signal", signal_values=values)
            except Exception as exc:
                if not self.state["recovery_required"]:
                    self.state["last_error"] = str(exc)
                if "differs from the bot" in str(exc):
                    self.state.update(enabled=False, recovery_required=True)
                self._save()
