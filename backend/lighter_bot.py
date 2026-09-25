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


def classify_trend(values: List[float]) -> Dict[str, Any]:
    """Classify a causal MA stack; the last point is never compared with future data."""
    clean = [float(value) for value in values if math.isfinite(float(value))]
    if len(clean) < 24:
        return {"direction": "UNKNOWN", "strength": 0.0, "last": clean[-1] if clean else None}
    ma7 = sum(clean[-7:]) / 7
    ma24 = sum(clean[-24:]) / 24
    previous7 = sum(clean[-8:-1]) / 7 if len(clean) >= 8 else ma7
    slope = (ma7 - previous7) / previous7 * 100 if previous7 else 0.0
    last = clean[-1]
    if last > ma7 > ma24 and slope > 0:
        direction = "UPTREND"
    elif last < ma7 < ma24 and slope < 0:
        direction = "DOWNTREND"
    else:
        direction = "SIDEWAYS"
    separation = abs(ma7 - ma24) / ma24 * 100 if ma24 else 0.0
    return {
        "direction": direction, "strength": round(min(100.0, separation * 100), 1),
        "last": round(last, 4), "ma7": round(ma7, 4), "ma24": round(ma24, 4),
        "slope_pct": round(slope, 5),
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
        }

    async def configure(self, values: Dict[str, Any]) -> Dict[str, Any]:
        bounds = {
            "entry_z": (0.75, 4.0), "exit_z": (0.0, 1.0), "notional_usd": (10.0, 500.0),
            "max_tranches": (1, 8), "max_book_spread_bps": (1.0, 100.0),
            "max_slippage": (0.001, 0.02), "min_seconds_between_orders": (60, 86400),
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
                    raise RuntimeError("Unreconciled Lighter positions exist; start with the pair account flat")
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

    async def trends(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for interval, interval_ms in (("5m", 300_000), ("1h", 3_600_000)):
            adr, domestic = await asyncio.gather(
                self.client.candles(216, interval, 90), self.client.candles(161, interval, 90)
            )
            now_ms = int(time.time() * 1000)
            adr = [row for row in adr if int(row["t"]) + interval_ms <= now_ms]
            domestic = [row for row in domestic if int(row["t"]) + interval_ms <= now_ms]
            result[interval] = classify_trend(self._aligned_ratio(adr, domestic))
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
        if not self.state.get("tranches") and await self.client.positions():
            raise RuntimeError("Unreconciled Lighter positions detected")
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
            for tranche in list(tranches):
                await self._trade_pair(-int(tranche["side"]), float(tranche["adr_qty"]), float(tranche["domestic_qty"]), adr_quote, domestic_quote, reduce_only=True)
                tranches.remove(tranche)
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
            await self._trade_pair(side, adr_qty, domestic_qty, adr_quote, domestic_quote, reduce_only=False)
            tranches.append({"side": side, "adr_qty": adr_qty, "domestic_qty": domestic_qty,
                             "entry_ratio": ratios[-1], "entry_z": zscore, "time": int(time.time())})
            self.state["pending_execution"] = None
            self.state["last_action"] = "ENTERED_LONG_RATIO" if side > 0 else "ENTERED_SHORT_RATIO"
            self.state["last_action_time"] = int(time.time())

    async def _trade_pair(self, side: int, adr_qty: float, domestic_qty: float,
                          adr_quote: Dict[str, Any], domestic_quote: Dict[str, Any], *, reduce_only: bool) -> None:
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
