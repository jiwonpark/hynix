"""Shared net-notional take profit for the single-leg terminals (funding excluded)."""
import math
import time


def net_profit(tranches, quantity, price, exit_fee_rate, target_pct):
    """Match precisely the quantity an order will reduce, newest inventory first."""
    if not all(math.isfinite(float(x)) for x in (quantity, price, exit_fee_rate, target_pct)):
        raise ValueError("Invalid take-profit inputs")
    if quantity <= 0 or price <= 0 or not 0 <= exit_fee_rate < 1:
        raise ValueError("Invalid take-profit price, size or fee")
    remaining, basis, gross, fees = quantity, 0.0, 0.0, 0.0
    side = int(tranches[-1]["side"]) if tranches else 0
    for tranche in reversed(tranches):
        if remaining <= quantity * 1e-9:
            break
        if int(tranche["side"]) != side:
            raise ValueError("Mixed-direction inventory cannot be matched")
        size, entry = float(tranche["qty"]), float(tranche["price"])
        if size <= 0 or entry <= 0 or "fee_usd" not in tranche:
            raise ValueError("Entry size, price or fee unavailable")
        used = min(remaining, size)
        basis += used * entry
        gross += side * used * (price - entry)
        fees += float(tranche["fee_usd"]) * used / size
        remaining -= used
    if remaining > quantity * 1e-8 or basis <= 0:
        raise ValueError("Take-profit quantity exceeds owned inventory")
    exit_fee = quantity * price * exit_fee_rate
    net = gross - fees - exit_fee
    net_pct = net / basis * 100
    return {"pass": net_pct + 1e-10 >= target_pct, "net_pct": net_pct,
            "target_pct": target_pct, "net_usd": net, "entry_notional_usd": basis,
            "entry_fee_usd": fees, "estimated_exit_fee_usd": exit_fee,
            "exit_fee_rate": exit_fee_rate, "quote": price, "quantity": quantity,
            "side": side, "source": "EXECUTABLE_BOOK_EX_FUNDING", "time": time.time()}


class TakeProfitMixin:
    async def take_profit_fee_rate(self, symbol=None):
        symbol = symbol or self.state["selected_symbol"]
        cached = getattr(self, "_take_profit_rate_cache", None)
        if cached and cached[0] == symbol and time.monotonic() - cached[1] < 60:
            return cached[2]
        if self.profit_venue == "binance":
            response = await self.client.request("GET", "/fapi/v1/commissionRate", {"symbol": symbol}, signed=True)
            rate = float(response["takerCommissionRate"])
        else:
            # Only Standard accounts have a verified zero-fee policy. Fail closed
            # for other tiers rather than silently borrowing Standard's rate.
            account = await self.client._account_snapshot()
            if account.get("account_type") != 0:
                raise ValueError("Take-profit fees unavailable for non-Standard Lighter account")
            rate = 0.0
        if not math.isfinite(rate) or not 0 <= rate < 1:
            raise ValueError("Invalid exchange taker commission")
        self._take_profit_rate_cache = (symbol, time.monotonic(), rate)
        return rate

    async def take_profit_evaluation(self, price, quantity=None):
        tranches = self.state["tranches"]
        rate = await self.take_profit_fee_rate()
        matched = []
        remaining = float(quantity if quantity is not None else tranches[-1]["qty"])
        for tranche in reversed(tranches):
            if remaining <= 1e-12:
                break
            item = dict(tranche)
            if self.profit_venue == "binance":
                cache = getattr(self, "_take_profit_entry_fees", {})
                key = (self.state["selected_symbol"], str(item["order_id"]))
                if key not in cache:
                    fills = await self.client.request("GET", "/fapi/v1/userTrades",
                        {"symbol": key[0], "orderId": key[1], "limit": 1000}, signed=True)
                    fills = [row for row in fills if str(row.get("orderId")) == key[1]]
                    filled = sum(float(row["qty"]) for row in fills)
                    if not fills or len(fills) >= 1000 or abs(filled - float(item["qty"])) > max(1e-9, float(item["qty"]) * 1e-8) or any(row.get("commissionAsset") != "USDT" for row in fills):
                        raise ValueError("Complete USDT entry commissions unavailable")
                    cache[key] = sum(float(row["commission"]) for row in fills) / filled
                    self._take_profit_entry_fees = cache
                item["fee_usd"] = cache[key] * float(item["qty"])
            # Lighter entries carry confirmed fill fees, including partial reductions.
            if "fee_usd" not in item:
                raise ValueError("Confirmed entry fee unavailable")
            matched.append(item)
            remaining -= float(item["qty"])
        evaluation = net_profit(list(reversed(matched)),
            float(quantity if quantity is not None else tranches[-1]["qty"]), price, rate,
            float(self.state.get("take_profit_pct", 0.2)))
        self.state["take_profit_evaluation"] = evaluation
        return evaluation

    async def check_take_profit(self):
        if not self.state.get("use_take_profit", True) or not self.state["tranches"]:
            self.state["take_profit_evaluation"] = {"pass": None, "state": "OFF" if not self.state.get("use_take_profit", True) else "N/A", "time": time.time()}
            return False
        try:
            if self.profit_venue == "binance":
                bid, ask = await self._book(self.state["selected_symbol"], enforce_spread=False)
                quantity = float(self.state["tranches"][-1]["qty"])
            else:
                market_id, detail, step = await self._market(self.state["selected_symbol"], fresh=True)
                bid, ask = await self._book(market_id, enforce_spread=False)
                price = bid if int(self.state["tranches"][-1]["side"]) > 0 else ask
                quantity = self._reduction_quantity(-int(self.state["tranches"][-1]["side"]), price, detail, step, 1.0)
            side = int(self.state["tranches"][-1]["side"])
            evaluation = await self.take_profit_evaluation(bid if side > 0 else ask, quantity)
        except Exception as exc:
            self.state["take_profit_evaluation"] = {"pass": None, "state": "UNAVAILABLE", "error": str(exc), "time": time.time()}
            self._save()
            return False
        self._save()
        if evaluation["pass"]:
            await self._submit(-side, 0, reduce_only=True, reason="net_take_profit")
            return True
        return False
