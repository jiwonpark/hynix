"""Durable per-fill Lighter conditional exits; no trading in read-only status paths."""
import asyncio
import secrets
import time
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR


def terminal_order(order):
    status = str(order.get("status", "")).lower()
    return status == "filled" or status.startswith(("cancel", "expir", "reject"))


def protection_children(lot, state, price_decimals, fee_rate, next_index):
    """Solve net P&L / entry notional, then round triggers toward entry."""
    side = int(lot["side"])
    entry, qty = float(lot["price"]), float(lot["qty"])
    entry_fee = float(lot.get("fee_usd", 0)) / qty
    scale = 10 ** price_decimals
    children = []
    for kind, sign in (("take_profit", 1), ("stop_loss", -1)):
        if not state.get("use_" + kind, kind == "take_profit"):
            continue
        target = sign * float(state[kind + "_pct"]) / 100
        trigger = (side * entry + entry * target + entry_fee) / (side - fee_rate)
        if trigger <= 0:
            raise ValueError("Native protection target has no positive trigger price")
        # TP rounds away from entry so the rounded trigger meets the requested
        # minimum profit; SL rounds toward entry so it does not increase risk.
        rounding = ROUND_CEILING if (side > 0) else ROUND_FLOOR
        ticks = int((Decimal(str(trigger)) * scale).to_integral_value(rounding=rounding))
        children.append({"kind": kind, "client_order_index": next_index(),
                         "trigger_ticks": ticks, "trigger_price": ticks / scale,
                         "accounted_qty": 0.0, "accounted_quote": 0.0})
    return children


def exchange_time_ms(value):
    value = int(value or 0)
    return value * 1000 if 0 < value < 100_000_000_000 else value


class NativeProtectionMixin:
    def native_protection_status(self):
        groups = self.state.get("native_brackets", [])
        lots = self.state.get("tranches", [])
        covered = {g["entry_order_id"] for g in groups if g["phase"] == "live"}
        return {"enabled": self.state.get("use_native_protection", False),
                "state": "ERROR" if self.state.get("native_protection_error") else
                         "PENDING RESUME" if self.state.get("native_protection_pending_activation") else
                         "WORKING" if groups else "WAITING" if self.state.get("use_native_protection") else "OFF",
                "protected_slices": sum(str(t.get("order_id", "")) in covered for t in lots),
                "tracked_slices": len(lots), "groups": groups,
                "error": self.state.get("native_protection_error"),
                "time": self.state.get("native_protection_checked_at")}

    async def _native_rows(self, group, snapshot=None):
        rows = []
        for child in group["children"]:
            row = snapshot.get(str(child["client_order_index"])) if snapshot is not None else await self.client.account_order(child["client_order_index"])
            if not row and snapshot is not None:
                row = await self.client.account_order(child["client_order_index"])
            # An absent order after a lost placement response is NOT permission
            # to submit again. Keep the persisted IDs and stop new risk.
            if not row:
                raise ValueError(f"Native order {child['client_order_index']} outcome unavailable; reconcile before trading")
            rows.append(row)
        return rows

    def _native_account_fills(self, group, rows):
        if sum(float(r.get("filled_base_amount", 0) or 0) for r in rows) > group["qty"] + group["size_step"] / 2:
            raise ValueError("Native group fills exceed its owned slice; reconcile exchange inventory")
        for child, row in zip(group["children"], rows):
            total = float(row.get("filled_base_amount", 0) or 0)
            quote = float(row.get("filled_quote_amount", 0) or 0)
            qty = total - float(child["accounted_qty"])
            if qty <= group["size_step"] / 2:
                continue
            lot = next((t for t in self.state["tranches"] if str(t["order_id"]) == group["entry_order_id"]), None)
            if not lot or qty > float(lot["qty"]) + group["size_step"] / 2:
                raise ValueError("Native fill exceeds its remaining owned slice")
            quote_delta = quote - float(child["accounted_quote"])
            if quote_delta <= 0:
                raise ValueError("Native fill quote is unavailable; cannot reconcile inventory")
            if self.state.get("pending_order"):
                raise ValueError("Resolve pending market order before accounting native fills")
            # Counters and inventory are saved together by _record_fill.
            child.update(accounted_qty=total, accounted_quote=quote)
            self._record_fill({"filled_size": qty, "fill_price": quote_delta / qty,
                               "fill_confirmed": True, "fee_usd": quote_delta * group["fee_rate"],
                               "fill_time_ms": exchange_time_ms(row.get("updated_at", 0))},
                              {"symbol": group["symbol"], "market_id": group["market_id"],
                               "side": -group["side"], "qty": qty, "size_step": group["size_step"],
                               "reduce_only": True, "reason": "native_" + child["kind"],
                               "client_order_index": child["client_order_index"],
                               "entry_order_id": group["entry_order_id"]})

    async def _cancel_native_group(self, group, rows):
        group["phase"] = "cancelling"
        self._save()
        errors = []
        for row in rows:
            if not terminal_order(row):
                try:
                    await self.client.cancel_protection_order(group["market_id"], row["order_index"])
                except Exception as exc:
                    errors.append(str(exc))
        for attempt in range(8):
            rows = await self._native_rows(group)
            self._native_account_fills(group, rows)
            if all(terminal_order(row) for row in rows):
                return
            await asyncio.sleep(.25)
        raise ValueError("Native cancellation not confirmed; market exit withheld: " + "; ".join(errors))

    async def _retire_expired_missing_group(self, group):
        """Never infer rejection from absence alone; require expired signed intent,
        complete authenticated fill coverage and unchanged, fresh owned inventory.
        Legacy groups need an independently verified expiry before using this path.
        """
        deadline = int(group.get("submission_expires_at_ms", 0) or 0)
        if group["phase"] not in {"placing", "submitted"} or not deadline:
            return False
        if int(time.time() * 1000) <= deadline + 60_000:
            return False
        ids = {str(c["client_order_index"]) for c in group["children"]}
        for child in group["children"]:
            if await self.client.account_order(child["client_order_index"]):
                return False
        trades = await self.client.account_trades(group["market_id"], limit=100, strict=True)
        if any(not exchange_time_ms(t.get("timestamp")) or not any(k in t for k in ("ask_client_id_str", "ask_client_id", "bid_client_id_str", "bid_client_id")) for t in trades):
            raise ValueError("Native recovery trade history is incomplete")
        if len(trades) >= 100 and min(exchange_time_ms(t.get("timestamp")) for t in trades) >= group["created_at"] * 1000:
            raise ValueError("Native recovery needs older trade-history coverage; missing order is not resolved")
        for trade in trades:
            if any(str(trade.get(key, "")) in ids for key in
                   ("ask_client_id_str", "ask_client_id", "bid_client_id_str", "bid_client_id")):
                raise ValueError("Missing native order has exchange fills; preserve intent and reconcile fills")
        _, amount, _ = await self._account_position(group["symbol"])
        expected = sum(int(t["side"]) * float(t["qty"]) for t in self.state["tranches"])
        if abs(amount - expected) > group["size_step"] / 2:
            raise ValueError("Native recovery position mismatch; preserve slice ownership")
        attempts = self.state.setdefault("native_protection_attempts", [])
        attempts.append({**group, "outcome": "EXPIRED_WITHOUT_ORDERS_OR_FILLS",
                         "verified_at": int(time.time()), "verified_position": amount})
        self.state["native_protection_attempts"] = attempts[-50:]
        self.state["native_brackets"].remove(group)
        self._finish_entry_campaign("native_submission_expired")
        # Do not silently retry the expired intent or resume a paused bot.
        self.state.update(enabled=False, native_protection_pending_activation=True,
                          execution_blocked=False, blocked_reason=None, last_error=None)
        self._save()
        return True

    async def reconcile_native_protection(self, *, cancel=False):
        """Caller owns bot and execution locks. Safe after restart and while paused."""
        try:
            groups = list(self.state.get("native_brackets", []))
            snapshot = None
            if groups and hasattr(self.client, "account_orders"):
                ids = [c["client_order_index"] for g in groups for c in g["children"]]
                snapshot = {}
                for start in range(0, len(ids), 50):
                    for row in await self.client.account_orders(ids[start:start + 50]):
                        snapshot[str(row.get("client_order_index"))] = row
            for group in groups:
                if (snapshot is None or any(str(c["client_order_index"]) not in snapshot for c in group["children"])):
                    if await self._retire_expired_missing_group(group):
                        continue
                rows = await self._native_rows(group, snapshot)
                self._native_account_fills(group, rows)
                lot = next((t for t in self.state["tranches"] if str(t["order_id"]) == group["entry_order_id"]), None)
                resized = not lot or abs(float(lot["qty"]) - group["qty"]) > group["size_step"] / 2
                if cancel or resized or group["phase"] == "cancelling" or any(terminal_order(r) for r in rows):
                    await self._cancel_native_group(group, rows)
                    self.state["native_brackets"].remove(group)
                else:
                    group["phase"] = "live"
                self._save()
            previous_error = self.state.get("native_protection_error")
            self.state["native_protection_error"] = None
            if (previous_error and self.state.get("last_error") == previous_error
                    and not self.state.get("pending_order") and not self.state.get("recovery_required")):
                self.state.update(last_error=None, execution_blocked=False, blocked_reason=None)
            self.state["native_protection_checked_at"] = int(time.time())
            self._save()
        except Exception as exc:
            self.state["native_protection_error"] = str(exc)
            self._finish_entry_campaign("native_protection_error")
            self.state.update(execution_blocked=True, blocked_reason=str(exc), last_error=str(exc))
            self._save()
            raise

    async def arm_native_protection(self):
        if not self.state.get("use_native_protection"):
            return
        if self.state.get("native_protection_pending_activation"):
            if not self.state.get("enabled"):
                return
            self.state["native_protection_pending_activation"] = False
            self._save()
        if self.state.get("native_protection_error"):
            raise ValueError(self.state["native_protection_error"])
        if self.state.get("pending_order"):
            raise ValueError("Resolve pending order before placing native protection")
        covered = {g["entry_order_id"] for g in self.state.get("native_brackets", [])}
        if all(str(t["order_id"]) in covered for t in self.state["tranches"]):
            return
        market_id, detail, step = await self._market(self.state["selected_symbol"], fresh=True)
        _, amount, _ = await self._account_position(self.state["selected_symbol"])
        self._check_position(amount, step, mark_price=float(detail.get("mark_price", 0) or 0),
                             min_base_amount=float(detail.get("min_base_amount", 0) or 0))
        fee = await self.take_profit_fee_rate()
        covered = {g["entry_order_id"] for g in self.state.get("native_brackets", [])}
        for lot in list(self.state["tranches"]):
            if str(lot["order_id"]) in covered:
                continue
            children = protection_children(lot, self.state, int(detail["supported_price_decimals"]), fee,
                                            lambda: secrets.randbelow(self.client.MAX_CLIENT_ORDER_INDEX - 1) + 1)
            if not children:
                continue
            group = {"entry_order_id": str(lot["order_id"]), "market_id": market_id,
                     "symbol": self.state["selected_symbol"], "side": int(lot["side"]),
                     "qty": float(lot["qty"]), "fee_rate": fee, "size_step": step,
                     "phase": "preparing", "children": children, "created_at": int(time.time())}
            self.state["native_brackets"].append(group)
            self._save()  # Never submit a child without a durable client ID.
            try:
                def signed(metadata):
                    group.update(metadata, phase="submitted")
                    self._save()
                result = await self.client.create_protection_orders(
                    market_id, group["qty"], group["side"], children, on_signed=signed)
                group["submission_accepted"] = True
                if result and result.get("tx_hash"):
                    group["submission_tx_hash"] = result["tx_hash"]
                self._save()
                # Accepted transaction alone does not prove working orders.
                await self.reconcile_native_protection()
            except Exception as exc:
                group["submission_error"] = str(exc)
                if group["phase"] == "preparing":
                    # The client contract persists a signed intent before any
                    # send. Without that callback, no order was submitted.
                    self.state["native_brackets"].remove(group)
                    self.state.setdefault("native_protection_attempts", []).append(
                        {**group, "outcome": "NOT_SUBMITTED", "verified_at": int(time.time())})
                    self.state["native_protection_attempts"] = self.state["native_protection_attempts"][-50:]
                    self.state.update(enabled=False, native_protection_pending_activation=True)
                self.state["native_protection_error"] = str(exc)
                self._finish_entry_campaign("native_protection_error")
                self.state.update(execution_blocked=True, blocked_reason=str(exc), last_error=str(exc))
                self._save()
                raise
