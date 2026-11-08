"""Independent, fail-closed Lighter perp executor for Tab 5.

Supports live execution for all testable quantitative single-leg strategies:
grid, ou_quant, ma_stack, multi_factor, trend_pullback, custom.
"""

from .hourly_histogram import HourlyHistogramMixin
from .single_leg_take_profit import TakeProfitMixin
from .lighter_native_protection import NativeProtectionMixin, protection_children
import asyncio
import copy
import json
import logging
import math
import os
import secrets
import time
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

from .entry_count_limit import parse_entry_count_limit, has_entry_slot
from .single_leg_direction import entry_direction_allowed, parse_entry_direction_mode
from .crypto_bot import INTERVAL_SECONDS
from .lighter_strategy import (
    evaluate_strategy_signal,
    evaluate_grid_signals,
    LIVE_STRATEGIES,
    OU_MIN_ABS_DEVIATION_PP,
    OU_MACRO_EMA_SPAN,
    OU_MACRO_SLOPE_BARS,
    hourly_macro_alignment,
    macd_histogram_acceleration_alignment,
    required_strategy_bars,
)


# Verified against Lighter's live perp market list. Market details are checked
# again before every order so a suspended market cannot be traded.
MARKETS = {"BTC": 1, "ETH": 0, "SOL": 2, "DOGE": 3, "XRP": 7}
DEFAULT_STATE = {
    "use_hourly_hist": True, "hourly_hist_fast": 20, "hourly_hist_slow": 60, "hourly_hist_signal": 9,
    "use_take_profit": True, "take_profit_pct": 0.2,
    "use_stop_loss": False, "stop_loss_pct": 0.2,
    "use_native_protection": False, "native_protection_pending_activation": False, "native_brackets": [],
    "native_protection_error": None, "native_protection_checked_at": None,
    "native_protection_attempts": [], "native_protection_update_pending": [],
    "enabled": False, "selected_symbol": "BTC", "strategy_mode": "grid",
    "strategy_interval": "5m", "entry_z": 1.5, "exit_z": 0.25,
    "notional_usd": 150.0, "max_tranches": 5, "gross_leverage_cap": 8.0,
    "min_seconds_between_orders": 300, "max_book_spread_bps": 45.0,
    "ou_halflife_max": 8.0, "ou_stop_z": 3.5, "ou_min_abs_deviation_pp": 0.25,
    "ou_macro_ema_span": OU_MACRO_EMA_SPAN, "ou_macro_slope_bars": OU_MACRO_SLOPE_BARS,
    "ou_use_entry_z": True, "ou_use_halflife": True, "ou_use_min_abs_deviation": True,
    "ou_use_macro_trend": True, "ou_use_stop_zone": True, "ou_use_exit_z": True,
    "ma_stretch_min": 0.30, "ma_trailing_stop": 0.15, "min_consensus_votes": 3,
    "trend_macro_window": 24, "trend_pullback_dist": 0.15, "trend_tp_dist": 0.05, "trend_slope_min": 0.002,
    "use_ma_stretch": True, "use_base_spacing": True, "use_peak": True, "use_ma_stack": False,
    "use_ma_stack_1h": True, "macro_ma_period": 60,
    "macro_regime_mode": "ma_slope",
    "macro_macd_fast_period": 12, "macro_macd_slow_period": 26,
    "macro_macd_signal_period": 9, "macro_macd_confirm_bars": 2,
    "ma_stack_opposite_only": True, "use_opposite_stack_exit": True,
    "use_ma_diff_hook": True, "use_ma_diff_exit": True, "min_diff_bars": 2,
    "ma_accel_period": 24, "ma_accel_min_slope": 0.0, "ma_accel_min_accel": 0.0, "ma_max_distance_pct": 0.0, "ma_direction_period": 0,
    "use_ma_slope": True, "use_ma_accel": True, "use_ma_pullback": True, "use_ma_cross_exit": True,
    "fast_ma_period": 9, "slow_ma_period": 21, "min_cross_spread_bps": 0.0,
    "use_golden_cross": True, "use_death_cross": True, "use_cross_spread": True, "use_cross_exit": True,
    "macd_fast_period": 12, "macd_slow_period": 26, "macd_signal_period": 9,
    "use_macd_signal_negative": True, "use_macd_hist_negative": True, "use_macd_hist_reversal": True,
    "use_macd_signal_positive": True, "use_macd_hist_positive": True, "use_macd_hist_reversal_exit": True,
    "use_macd_hist_turn": True, "use_macd_hist_zone": True, "use_macd_hist_exit_zone": True,
    "use_macd_signal_slope_5m": True,
    "use_macd_zero_cross": True, "use_macd_signal_zone": False, "use_macd_hist_exit": True,
    "use_macd_strength": True, "macd_strength_min_pct": 30.0,
    "use_macd_two_stage_exit": True, "macd_first_exit_pct": 50.0, "macd_exit_stage": 0,
    "long_multiplier": 1.0, "short_multiplier": 1.0, "entry_direction_mode": "two_way",
    "use_convergence": True, "use_dwell": True, "use_bottoming": False, "base_spacing_pct": 0.2, "min_dwell_bars": 4,
    "tranches": [], "execution_history": [], "pending_order": None,
    "entry_campaign": None, "last_entry_campaign": None,
    "last_evaluated_candle": 0, "last_order_time": 0,
    "last_evaluation": None, "last_error": None, "recovery_required": False,
    "execution_blocked": False, "blocked_reason": None,
    "strategy_drafts": {},
}


class LighterCryptoBot(NativeProtectionMixin, HourlyHistogramMixin, TakeProfitMixin):
    profit_venue = "lighter"
    # Standard 8.0x gross leverage cap matching Tab 2 and Tab 3.
    # Tab 2's margin buffer applies to estimated initial margin, not gross value.
    STRESS_MOVE_PCT = 10.0
    MAX_STRESS_LOSS_PCT_EQUITY = 80.0
    GROSS_LEVERAGE_CAP = 8.0
    MARGIN_LEVERAGE_ASSUMPTION = 10.0
    MARGIN_BUFFER_MULTIPLIER = 1.25
    MIN_MARGIN_BUFFER_USD = 2.50

    def __init__(self, client: Any, state_path: Optional[Path] = None):
        self.client = client
        self.state_path = state_path or Path(__file__).with_name("lighter_crypto_bot_state.json")
        self.lock = asyncio.Lock()
        self._trade_cache: Optional[tuple] = None
        self._trade_lock = asyncio.Lock()
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
            if self.state.get("strategy_mode") == "ma_stack":
                self.state.update(
                    ma_stack_opposite_only=True,
                    use_ma_stretch=False,
                    use_ma_stack_1h=False,
                    use_convergence=False,
                    use_dwell=False,
                    use_bottoming=False,
                    use_base_spacing=False,
                )
                if "ma_stack_opposite_only" not in saved:
                    self.state.update(use_ma_stack=True, use_opposite_stack_exit=True)
            if (self.state["selected_symbol"] not in MARKETS or
                    self.state["strategy_mode"] not in LIVE_STRATEGIES or
                    self.state["strategy_interval"] not in INTERVAL_SECONDS or
                    not isinstance(self.state["tranches"], list)):
                raise ValueError("Unsupported persisted Lighter crypto configuration")
            if self.state["pending_order"]:
                self.state.update(recovery_required=True, execution_blocked=True,
                                  blocked_reason="Pending Lighter order requires reconciliation",
                                  last_error="Pending Lighter order requires reconciliation")
            elif str(self.state.get("blocked_reason") or "").startswith("Opposite entry blocked:"):
                self.state.update(blocked_reason=None, last_error=None)
        except Exception as exc:
            self.state.update(recovery_required=True, execution_blocked=True,
                              blocked_reason=f"Cannot load Lighter crypto state: {exc}",
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
        result.update(live_strategies=sorted(LIVE_STRATEGIES), execution_implemented=True,
                      venue="Lighter", history_event_count=len(result["execution_history"]),
                      risk_capacity={"active_tranches": len(result["tranches"]),
                                     "max_tranches": result["max_tranches"],
                                     "gross_leverage_cap": float(self.state.get("gross_leverage_cap", self.GROSS_LEVERAGE_CAP)),
                                     "margin_leverage_assumption": self.MARGIN_LEVERAGE_ASSUMPTION,
                                     "margin_buffer_multiplier": self.MARGIN_BUFFER_MULTIPLIER,
                                     "min_margin_buffer_usd": self.MIN_MARGIN_BUFFER_USD,
                                     "stress_move_pct": self.STRESS_MOVE_PCT,
                                     "stress_loss_budget_pct_equity": self.MAX_STRESS_LOSS_PCT_EQUITY},
                      strategy_params={
                          "entry_z": float(self.state.get("entry_z", 1.5)),
                          "exit_z": float(self.state.get("exit_z", 0.25)),
                          "use_ma_stretch": bool(self.state.get("use_ma_stretch", True)),
                          "use_base_spacing": bool(self.state.get("use_base_spacing", True)),
                          "use_peak": bool(self.state.get("use_peak", True)),
                          "use_ma_stack": bool(self.state.get("use_ma_stack", False)),
                          "use_ma_stack_1h": bool(self.state.get("use_ma_stack_1h", True)),
                          "macro_ma_period": int(self.state.get("macro_ma_period", 60)),
                          "macro_regime_mode": str(self.state.get("macro_regime_mode", "ma_slope")),
                          "macro_macd_fast_period": int(self.state.get("macro_macd_fast_period", 12)),
                          "macro_macd_slow_period": int(self.state.get("macro_macd_slow_period", 26)),
                          "macro_macd_signal_period": int(self.state.get("macro_macd_signal_period", 9)),
                          "macro_macd_confirm_bars": int(self.state.get("macro_macd_confirm_bars", 2)),
                          "ma_stack_opposite_only": bool(self.state.get("ma_stack_opposite_only", True)),
                          "use_opposite_stack_exit": bool(self.state.get("use_opposite_stack_exit", True)),
                          "use_ma_diff_hook": bool(self.state.get("use_ma_diff_hook", True)),
                          "use_ma_diff_exit": bool(self.state.get("use_ma_diff_exit", True)),
                          "min_diff_bars": int(self.state.get("min_diff_bars", 2)),
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
                          "ma_accel_period": int(self.state.get("ma_accel_period", 24)),
                          "ma_accel_min_slope": float(self.state.get("ma_accel_min_slope", 0.0)),
                          "ma_accel_min_accel": float(self.state.get("ma_accel_min_accel", 0.0)),
                          "ma_max_distance_pct": float(self.state.get("ma_max_distance_pct", 0.0)),
                          "ma_direction_period": int(self.state.get("ma_direction_period", 0)),
                          "use_ma_slope": bool(self.state.get("use_ma_slope", True)),
                          "use_ma_accel": bool(self.state.get("use_ma_accel", True)),
                          "use_ma_pullback": bool(self.state.get("use_ma_pullback", True)),
                          "use_ma_cross_exit": bool(self.state.get("use_ma_cross_exit", True)),
                          "macd_fast_period": int(self.state.get("macd_fast_period", 12)),
                          "macd_slow_period": int(self.state.get("macd_slow_period", 26)),
                          "macd_signal_period": int(self.state.get("macd_signal_period", 9)),
                          "use_macd_signal_negative": bool(self.state.get("use_macd_signal_negative", True)),
                          "use_macd_hist_negative": bool(self.state.get("use_macd_hist_negative", True)),
                          "use_macd_hist_reversal": bool(self.state.get("use_macd_hist_reversal", True)),
                          "use_macd_signal_positive": bool(self.state.get("use_macd_signal_positive", True)),
                          "use_macd_hist_positive": bool(self.state.get("use_macd_hist_positive", True)),
                          "use_macd_hist_reversal_exit": bool(self.state.get("use_macd_hist_reversal_exit", True)),
                          "use_macd_hist_turn": bool(self.state.get("use_macd_hist_turn", True)),
                          "use_macd_hist_zone": bool(self.state.get("use_macd_hist_zone", True)),
                          "use_macd_hist_exit_zone": bool(self.state.get("use_macd_hist_exit_zone", True)),
                          "use_macd_signal_slope_5m": bool(self.state.get("use_macd_signal_slope_5m", True)),
                          "use_macd_zero_cross": bool(self.state.get("use_macd_zero_cross", True)),
                          "use_macd_signal_zone": bool(self.state.get("use_macd_signal_zone", False)),
                          "use_macd_strength": bool(self.state.get("use_macd_strength", True)),
                          "macd_strength_min_pct": float(self.state.get("macd_strength_min_pct", 30.0)),
                          "use_macd_two_stage_exit": bool(self.state.get("use_macd_two_stage_exit", True)),
                          "macd_first_exit_pct": float(self.state.get("macd_first_exit_pct", 50.0)),
                          "macd_exit_stage": int(self.state.get("macd_exit_stage", 0)),
                      })
        result["gross_leverage_cap"] = float(self.state.get("gross_leverage_cap", self.GROSS_LEVERAGE_CAP))
        result["native_protection"] = self.native_protection_status()
        result["execution_blocked"] = bool(self.state.get("execution_blocked") or self.state.get("recovery_required") or self.state.get("pending_order"))
        result["blocked_reason"] = (self.state.get("blocked_reason") or self.state.get("last_error")) if result["execution_blocked"] else None
        result["can_execute_entry"] = bool(self.state.get("enabled") and not result["execution_blocked"])
        result["can_execute_exit"] = bool(self.state.get("enabled") and not self.state.get("recovery_required") and not self.state.get("pending_order"))
        result["strategy_params"]["use_macd_hist_exit"] = bool(self.state.get("use_macd_hist_exit", True))
        result["strategy_params"].update({key:self.state[key] for key in ("use_hourly_hist","hourly_hist_fast","hourly_hist_slow","hourly_hist_signal")})
        result["strategy_params"].update(use_take_profit=bool(self.state.get("use_take_profit", True)), take_profit_pct=float(self.state.get("take_profit_pct", 0.2)))
        result["strategy_params"]["use_native_protection"] = bool(self.state.get("use_native_protection", False))
        result["strategy_params"].update(use_stop_loss=bool(self.state.get("use_stop_loss", False)), stop_loss_pct=float(self.state.get("stop_loss_pct", 0.2)))
        return result

    async def save_strategy_draft(self, mode: str, values: Dict[str, Any]) -> Dict[str, Any]:
        """Persist replay parameters without changing the live strategy configuration."""
        if mode not in {"macd_hist_turn", "macd_zero_cross", "macd_reversal", "macd_strength_scaleout"}:
            raise ValueError("Unsupported strategy draft")
        allowed = {"macd_fast_period", "macd_slow_period", "macd_signal_period"}
        if set(values) != allowed:
            raise ValueError("A MACD draft requires fast, slow, and signal periods")
        periods = {key: int(values[key]) for key in allowed}
        if not 2 <= periods["macd_fast_period"] <= 100:
            raise ValueError("MACD fast period must be between 2 and 100")
        if not periods["macd_fast_period"] < periods["macd_slow_period"] <= 200:
            raise ValueError("MACD slow period must be greater than fast and at most 200")
        if not 2 <= periods["macd_signal_period"] <= 100:
            raise ValueError("MACD signal period must be between 2 and 100")
        async with self.lock:
            drafts = copy.deepcopy(self.state.get("strategy_drafts") or {})
            drafts[mode] = periods
            self.state["strategy_drafts"] = drafts
            self._save()
            return self.public_state()

    @staticmethod
    def _trade_client_order_index(trade: Dict[str, Any], is_buyer=None) -> Optional[str]:
        """Return an exchange-provided client order reference, never a trade id."""
        role = "bid" if is_buyer else "ask"
        keys = (f"{role}_client_id_str", f"{role}_client_id") if is_buyer is not None else ()
        for key in (*keys, "client_order_index", "client_order_id", "client_order_id_str"):
            value = trade.get(key)
            if value not in (None, ""):
                return str(value)
        return None

    @staticmethod
    def _same_execution_fill(exchange: Dict[str, Any], local: Dict[str, Any]) -> bool:
        """Strict fallback match for feeds that omit the client order reference."""
        if str(exchange.get("event", "")) != str(local.get("event", "")):
            return False
        if str(exchange.get("symbol", "")) != str(local.get("symbol", "")):
            return False
        if int(exchange.get("side", 0) or 0) != int(local.get("side", 0) or 0):
            return False
        if abs(int(exchange.get("time", 0) or 0) - int(local.get("time", 0) or 0)) > 3:
            return False
        exchange_qty = float(exchange.get("qty", 0) or 0)
        local_qty = float(local.get("qty", 0) or 0)
        qty_tolerance = max(1e-12, max(abs(exchange_qty), abs(local_qty)) * 1e-6)
        if abs(exchange_qty - local_qty) > qty_tolerance:
            return False
        exchange_price = float(exchange.get("price", 0) or 0)
        local_price = float(local.get("price", 0) or 0)
        price_tolerance = max(1e-8, max(abs(exchange_price), abs(local_price)) * 5e-6)
        return abs(exchange_price - local_price) <= price_tolerance

    @classmethod
    def _merge_execution_history(cls, exchange_events: list[Dict[str, Any]],
                                 local_events: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
        """Reconcile each exchange fill to at most one local execution record."""
        # One native child can execute against several counterparties. Match
        # the complete order, not one partial trade against the whole local lot.
        grouped = {}
        for event in exchange_events:
            ref = event.get("exchange_client_order_index")
            key = (event.get("symbol"), event.get("event"), event.get("side"), str(ref)) if ref else ("trade", event.get("exchange_trade_id", event.get("order_id")))
            if key not in grouped:
                grouped[key] = copy.deepcopy(event)
                grouped[key]["exchange_trade_ids"] = [event.get("exchange_trade_id", event.get("order_id"))]
                continue
            total = grouped[key]
            trade_id = event.get("exchange_trade_id", event.get("order_id"))
            if trade_id in total["exchange_trade_ids"]:
                continue
            total["exchange_trade_ids"].append(trade_id)
            qty = float(total["qty"]) + float(event["qty"])
            total["price"] = (float(total["price"]) * float(total["qty"]) + float(event["price"]) * float(event["qty"])) / qty
            total["qty"] = qty
            for field in ("notional_usd", "fee_usd", "net_pnl_usd", "gross_pnl_usd"):
                if total.get(field) is not None and event.get(field) is not None:
                    total[field] += event[field]
            total["time"] = max(total["time"], event["time"])
        exchange_events = list(grouped.values())
        entries = {(e.get("symbol"), str(e.get("exchange_client_order_index"))): e
                   for e in exchange_events if e.get("event") == "ENTRY"}
        unmatched_local = set(range(len(local_events)))
        merged_events: list[Dict[str, Any]] = []
        for exchange in exchange_events:
            exchange_client_ref = exchange.get("exchange_client_order_index")
            match_index: Optional[int] = None
            if exchange_client_ref not in (None, ""):
                for index in unmatched_local:
                    local_ref = local_events[index].get("client_order_index", local_events[index].get("order_id"))
                    if (str(local_ref) == str(exchange_client_ref)
                            and local_events[index].get("symbol") == exchange.get("symbol")
                            and local_events[index].get("event") == exchange.get("event")
                            and int(local_events[index].get("side", 0)) == int(exchange.get("side", 0))
                            and abs(float(local_events[index].get("qty", 0)) - float(exchange.get("qty", 0))) <= max(1e-12, float(exchange.get("qty", 0)) * 1e-6)):
                        match_index = index
                        break
            if match_index is None:
                candidates = [
                    index for index in unmatched_local
                    if cls._same_execution_fill(exchange, local_events[index])
                ]
                if candidates:
                    match_index = min(
                        candidates,
                        key=lambda index: abs(
                            int(exchange.get("time", 0) or 0)
                            - int(local_events[index].get("time", 0) or 0)
                        ),
                    )
            if match_index is None:
                merged_events.append(exchange)
                continue

            local = local_events[match_index]
            unmatched_local.remove(match_index)
            merged = {**local, **exchange}
            merged["exchange_trade_id"] = exchange.get("exchange_trade_id", exchange.get("order_id"))
            merged["local_order_id"] = local.get("order_id")
            merged["order_id"] = local.get("order_id", exchange.get("order_id"))
            local_client_ref = local.get("client_order_index")
            if local_client_ref not in (None, ""):
                merged["client_order_index"] = local_client_ref
            if local.get("reason"):
                merged["reason"] = local["reason"]
            entry = entries.get((local.get("symbol"), str(local.get("entry_order_id"))))
            tranche_verified = False
            if exchange.get("event") == "EXIT" and entry and int(local.get("matched_tranches", 1)) == 1:
                qty = float(exchange["qty"])
                if (float(entry["qty"]) >= qty - 1e-12 and entry["side"] == -exchange["side"]
                        and abs(float(entry["price"]) - float(local.get("entry_price", 0))) <= max(1e-8, float(entry["price"]) * 5e-6)):
                    gross = int(entry["side"]) * qty * (float(exchange["price"]) - float(entry["price"]))
                    entry_fee = float(entry["fee_usd"]) * qty / float(entry["qty"])
                    exit_fee = float(exchange["fee_usd"])
                    net = gross - entry_fee - exit_fee
                    merged.update(entry_price=entry["price"], gross_pnl_usd=gross, net_pnl_usd=net,
                                  entry_fee_usd=entry_fee, exit_fee_usd=exit_fee,
                                  round_trip_fee_usd=entry_fee + exit_fee,
                                  pnl_pct=net / (qty * float(entry["price"])) * 100,
                                  exchange_account_pnl_usd=exchange.get("net_pnl_usd"),
                                  pnl_source="LIGHTER_VERIFIED_TRANCHE_FILLS")
                    tranche_verified = True
            if exchange.get("event") == "EXIT" and local.get("entry_order_id") and not tranche_verified:
                # Exchange account-average P&L is not this tracked lot's P&L.
                # Preserve its estimate until its own entry fills are available.
                merged["exchange_account_pnl_usd"] = exchange.get("net_pnl_usd")
                for field in ("entry_price", "gross_pnl_usd", "net_pnl_usd", "pnl_pct", "pnl_source"):
                    if field in local:
                        merged[field] = local[field]
                    else:
                        merged.pop(field, None)
                merged["pnl_authoritative"] = False
            merged_events.append(merged)

        merged_events.extend(local_events[index] for index in sorted(unmatched_local))
        merged_events.sort(key=lambda event: int(event.get("time", 0) or 0))
        return merged_events

    async def reconciled_public_state(self) -> Dict[str, Any]:
        """Annotate public state with Lighter exchange trade history and verified exits."""
        result = self.public_state()
        symbol = self.state["selected_symbol"]
        now = time.monotonic()
        async with self._trade_lock:
            cached = self._trade_cache
            if cached and cached[0] == symbol and now - cached[1] < cached[2]:
                exchange_events = list(cached[3])
            else:
                exchange_events = []
                try:
                    market_id, _, _ = await self._market(symbol)
                    creds = getattr(self.client, "get_credentials", lambda: None)() or {}
                    account_id = int(creds.get("account_index", -1) or -1)
                    if account_id >= 0 and hasattr(self.client, "account_trades"):
                        raw_trades = await self.client.account_trades(market_id, limit=100, strict=True)
                        for trade in reversed(raw_trades or []):
                            is_buyer = int(trade.get("bid_account_id", -1) or -1) == account_id
                            side = 1 if is_buyer else -1
                            qty = float(trade.get("size", 0) or 0)
                            px = float(trade.get("price", 0) or 0)
                            usd = float(trade.get("usd_amount", 0) or 0) or (qty * px)
                            t_ms = int(trade.get("timestamp", 0) or 0)
                            pnl_field = "bid_account_pnl" if is_buyer else "ask_account_pnl"
                            pnl_val = trade.get(pnl_field)
                            is_exit = pnl_val is not None
                            pnl = float(pnl_val or 0.0) if is_exit else None
                            pos_before = abs(float(trade.get("taker_position_size_before", 0) or 0))
                            quote_before = abs(float(trade.get("taker_entry_quote_before", 0) or 0))
                            entry_px = (quote_before / pos_before) if (pos_before > 0 and quote_before > 0) else px
                            raw_fee = float(trade.get("taker_fee", 0.0) or 0.0)
                            fee_rate = raw_fee / 1_000_000.0 if raw_fee >= 1.0 else raw_fee
                            fee_usd = usd * fee_rate
                            trade_id = str(trade.get("trade_id_str") or trade.get("trade_id") or "")
                            client_order_index = self._trade_client_order_index(trade, is_buyer)
                            original_side = -side if is_exit else side
                            exchange_event = {
                                "event": "EXIT" if is_exit else "ENTRY",
                                "symbol": symbol,
                                "market_id": market_id,
                                "side": side,
                                "original_side": original_side,
                                "qty": qty,
                                "price": px,
                                "entry_price": entry_px,
                                "notional_usd": usd,
                                "net_pnl_usd": pnl,
                                "gross_pnl_usd": (pnl + fee_usd) if is_exit else None,
                                "fee_usd": fee_usd,
                                "time": t_ms // 1000 if t_ms else int(time.time()),
                                "order_id": trade_id,
                                "exchange_trade_id": trade_id,
                                "status": "CLOSED" if is_exit else "OPEN",
                                "pnl_authoritative": is_exit,
                                "pnl_source": "LIGHTER_REALIZED_PNL" if is_exit else "ESTIMATED_EX_FUNDING",
                                "reason": "lighter_trade",
                            }
                            if client_order_index is not None:
                                exchange_event["exchange_client_order_index"] = client_order_index
                                exchange_event["client_order_index"] = client_order_index
                            exchange_events.append(exchange_event)
                    self._trade_cache = (symbol, now, 5.0, list(exchange_events))
                except Exception as exc:
                    logger.warning("Could not fetch Lighter trades for status reconciliation: %s", exc)
                    raise

        if exchange_events:
            result["execution_history"] = self._merge_execution_history(
                exchange_events, result["execution_history"],
            )[-500:]
            result["history_event_count"] = len(result["execution_history"])

        # If execution history is still empty but tranches exist, represent them
        if not result["execution_history"] and result.get("tranches"):
            for t in result["tranches"]:
                t_side = int(t.get("side", 1))
                t_qty = float(t.get("qty", 0))
                t_px = float(t.get("price", 0))
                result["execution_history"].append({
                    "event": "ENTRY",
                    "symbol": symbol,
                    "side": t_side,
                    "original_side": t_side,
                    "qty": t_qty,
                    "price": t_px,
                    "entry_price": t_px,
                    "notional_usd": t_qty * t_px,
                    "fee_usd": float(t.get("fee_usd", 0)),
                    "time": int(t.get("time", int(time.time()))),
                    "order_id": str(t.get("order_id", f"tranche_{int(time.time())}")),
                    "status": "OPEN",
                    "pnl_authoritative": False,
                    "reason": "active_tranche",
                })
            result["history_event_count"] = len(result["execution_history"])

        verified_exits = [e for e in result["execution_history"] if e.get("event") == "EXIT" and e.get("pnl_authoritative")]
        result["verified_exit_count"] = len(verified_exits)
        result["verified_realized_pnl_usd"] = sum(float(e.get("net_pnl_usd", 0) or 0) for e in verified_exits)
        return result

    async def configure(self, values: Dict[str, Any]) -> Dict[str, Any]:
        permitted = {
            "use_macd_hist_exit",
            "use_hourly_hist", "hourly_hist_fast", "hourly_hist_slow", "hourly_hist_signal",
            "use_native_protection", "use_take_profit", "take_profit_pct", "use_stop_loss", "stop_loss_pct",
            "selected_symbol", "strategy_mode", "strategy_interval", "entry_z", "exit_z",
            "notional_usd", "max_tranches", "min_seconds_between_orders", "max_book_spread_bps",
            "ou_halflife_max", "ou_stop_z", "ou_min_abs_deviation_pp",
            "ou_macro_ema_span", "ou_macro_slope_bars",
            "ou_use_entry_z", "ou_use_halflife", "ou_use_min_abs_deviation",
            "ou_use_macro_trend", "ou_use_stop_zone", "ou_use_exit_z",
            "ma_stretch_min", "ma_trailing_stop", "min_consensus_votes",
            "trend_macro_window", "trend_pullback_dist", "trend_tp_dist", "trend_slope_min",
            "ma_accel_period", "ma_accel_min_slope", "ma_accel_min_accel", "ma_max_distance_pct", "ma_direction_period",
            "use_ma_slope", "use_ma_accel", "use_ma_pullback", "use_ma_cross_exit",
            "fast_ma_period", "slow_ma_period", "min_cross_spread_bps",
            "use_golden_cross", "use_death_cross", "use_cross_spread", "use_cross_exit",
            "macd_fast_period", "macd_slow_period", "macd_signal_period",
            "use_macd_signal_negative", "use_macd_hist_negative", "use_macd_hist_reversal",
            "use_macd_signal_positive", "use_macd_hist_positive", "use_macd_hist_reversal_exit",
            "use_macd_hist_turn", "use_macd_hist_zone", "use_macd_hist_exit_zone", "use_macd_signal_slope_5m", "use_macd_zero_cross", "use_macd_signal_zone",
            "use_macd_strength", "macd_strength_min_pct", "use_macd_two_stage_exit", "macd_first_exit_pct",
            "use_ma_stretch", "use_base_spacing", "use_peak", "use_ma_stack",
            "use_ma_stack_1h", "macro_ma_period", "macro_regime_mode",
            "macro_macd_fast_period", "macro_macd_slow_period", "macro_macd_signal_period",
            "macro_macd_confirm_bars",
            "use_convergence", "use_dwell", "use_bottoming", "base_spacing_pct", "min_dwell_bars",
            "ma_stack_opposite_only", "use_opposite_stack_exit",
            "use_ma_diff_hook", "use_ma_diff_exit", "min_diff_bars",
            "long_multiplier", "short_multiplier", "gross_leverage_cap", "entry_direction_mode",
        }
        unknown = set(values) - permitted
        if unknown:
            raise ValueError(f"Unsupported live setting: {', '.join(sorted(unknown))}")
        candidate = dict(self.state)
        for key, value in values.items():
            if key in {"selected_symbol", "strategy_mode", "strategy_interval", "macro_regime_mode"}:
                candidate[key] = str(value)
            elif key in {"hourly_hist_fast", "hourly_hist_slow", "hourly_hist_signal"}:
                if isinstance(value,bool) or not float(value).is_integer():
                    raise ValueError("Hourly MACD periods must be integers")
                candidate[key] = int(value)
            elif key == "use_macd_hist_exit":
                candidate[key] = bool(value)
            elif key == "use_hourly_hist":
                candidate[key] = bool(value)
            elif key in {"use_native_protection", "use_take_profit", "use_stop_loss"}:
                candidate[key] = bool(value)
            elif key == "entry_direction_mode":
                candidate[key] = parse_entry_direction_mode(value)
            elif key == "max_tranches":
                candidate[key] = parse_entry_count_limit(value)
            elif key == "ma_direction_period":
                period = float(value)
                if isinstance(value, bool) or not period.is_integer() or (period != 0 and not 3 <= period <= 498):
                    raise ValueError("Direction SMA period must be 0 (same as proximity) or a whole number from 3 to 498")
                candidate[key] = int(period)
            elif key == "macro_ma_period":
                if isinstance(value, bool) or not math.isfinite(float(value)) or not float(value).is_integer():
                    raise ValueError("Wider-trend MA period must be an integer")
                candidate[key] = int(value)
            elif key in {"min_seconds_between_orders", "ou_macro_ema_span",
                        "ou_macro_slope_bars", "min_consensus_votes", "trend_macro_window", "min_dwell_bars",
                        "ma_accel_period", "fast_ma_period", "slow_ma_period", "min_diff_bars",
                        "macd_fast_period", "macd_slow_period", "macd_signal_period",
                        "macro_macd_fast_period", "macro_macd_slow_period", "macro_macd_signal_period",
                        "macro_macd_confirm_bars"}:
                candidate[key] = int(value)
            elif key in {"ou_use_entry_z", "ou_use_halflife", "ou_use_min_abs_deviation",
                        "ou_use_macro_trend", "ou_use_stop_zone", "ou_use_exit_z",
                        "use_ma_stretch", "use_base_spacing", "use_peak", "use_ma_stack",
                        "use_ma_stack_1h", "use_convergence", "use_dwell", "use_bottoming",
                        "ma_stack_opposite_only", "use_opposite_stack_exit",
                        "use_ma_diff_hook", "use_ma_diff_exit",
                        "use_ma_slope", "use_ma_accel", "use_ma_pullback", "use_ma_cross_exit",
                        "use_golden_cross", "use_death_cross", "use_cross_spread", "use_cross_exit"}:
                candidate[key] = bool(value)
            elif key in {"use_macd_signal_negative", "use_macd_hist_negative", "use_macd_hist_reversal",
                          "use_macd_signal_positive", "use_macd_hist_positive", "use_macd_hist_reversal_exit",
                          "use_macd_hist_turn", "use_macd_hist_zone", "use_macd_hist_exit_zone", "use_macd_signal_slope_5m", "use_macd_zero_cross", "use_macd_signal_zone"}:
                candidate[key] = bool(value)
            elif key in {"use_macd_strength", "use_macd_two_stage_exit"}:
                candidate[key] = bool(value)
            else:
                candidate[key] = float(value)
        if candidate["selected_symbol"] not in MARKETS:
            raise ValueError("Unsupported Lighter perp symbol")
        if candidate["strategy_mode"] not in LIVE_STRATEGIES:
            raise ValueError(f"Unsupported live strategy: {candidate['strategy_mode']}")
        if candidate["strategy_interval"] not in INTERVAL_SECONDS:
            raise ValueError("Unsupported candle interval")
        if candidate.get("macro_regime_mode") not in {"ma_slope", "macd_hist_accel", "hybrid"}:
            raise ValueError("Unsupported macro regime mode")
        if candidate["strategy_mode"] == "ma_stack":
            candidate.update(
                ma_stack_opposite_only=True,
                use_ma_stretch=False,
                use_ma_stack_1h=False,
                use_convergence=False,
                use_dwell=False,
                use_bottoming=False,
                use_base_spacing=False,
            )
        bounds = {
            "hourly_hist_fast": (2,100), "hourly_hist_slow": (3,200), "hourly_hist_signal": (2,100),
            "take_profit_pct": (0.01, 100.0),
            "stop_loss_pct": (0.01, 100.0),
            "entry_z": (0.1, 10.0), "exit_z": (0.0, 5.0), "macro_ma_period": (2, 120),
            "macro_macd_confirm_bars": (1, 12),
            "notional_usd": (10.0, 500.0),
            "long_multiplier": (0.1, 10.0), "short_multiplier": (0.1, 10.0),
            "gross_leverage_cap": (1.0, 20.0),
            "min_seconds_between_orders": (6, 86400), "max_book_spread_bps": (1, 100),
            "ou_halflife_max": (0.5, 50.0), "ou_stop_z": (1.0, 10.0),
            "ou_min_abs_deviation_pp": (0.01, 10.0),
            "ma_stretch_min": (0.01, 10.0), "ma_trailing_stop": (0.01, 10.0),
            "min_consensus_votes": (1, 4),
            "trend_macro_window": (12, 100), "trend_pullback_dist": (0.01, 10.0),
            "trend_tp_dist": (0.01, 10.0), "trend_slope_min": (0.0001, 1.0),
            "fast_ma_period": (2, 100), "slow_ma_period": (3, 200),
            "macd_fast_period": (2, 100), "macd_slow_period": (3, 200), "macd_signal_period": (2, 100),
            "macro_macd_fast_period": (2, 100), "macro_macd_slow_period": (3, 200),
            "macro_macd_signal_period": (2, 100),
            "macd_strength_min_pct": (0.0, 1000.0), "macd_first_exit_pct": (1.0, 99.0),
            "min_cross_spread_bps": (0.0, 100.0),
            "min_diff_bars": (1, 10),
            "base_spacing_pct": (0.0, 10.0), "min_dwell_bars": (0, 100),
        }
        for key, (low, high) in bounds.items():
            if key in candidate:
                value = candidate[key]
                if not math.isfinite(value) or not low <= value <= high:
                    raise ValueError(f"{key} must be between {low} and {high}")
        if candidate["strategy_mode"] in {"adaptive_tranche", "grid", "custom", "ou_quant"}:
            if candidate["exit_z"] >= candidate["entry_z"]:
                raise ValueError("Exit Z must be below Entry Z")
        if candidate["strategy_mode"] == "golden_death_cross":
            if candidate.get("fast_ma_period", 9) >= candidate.get("slow_ma_period", 21):
                raise ValueError("Slow MA period must be greater than Fast MA period")
        if candidate["strategy_mode"] in {"macd_reversal", "macd_strength_scaleout", "macd_zero_cross", "macd_hist_turn"}:
            if candidate.get("macd_fast_period", 12) >= candidate.get("macd_slow_period", 26):
                raise ValueError("MACD slow period must be greater than MACD fast period")
        if candidate.get("macro_macd_fast_period", 12) >= candidate.get("macro_macd_slow_period", 26):
            raise ValueError("Hourly MACD slow period must be greater than hourly MACD fast period")
        if candidate["hourly_hist_slow"] <= candidate["hourly_hist_fast"]:
            raise ValueError("Hourly MACD slow period must exceed fast")
        if not 0 <= candidate["ma_max_distance_pct"] <= 100:
            raise ValueError("Maximum MA distance must be between 0 and 100 percent")
        async with self.lock:
            if self.state["enabled"] and any(candidate[key] != self.state[key] for key in
                ("use_native_protection", "ma_direction_period", "ma_max_distance_pct", "use_macd_hist_exit", "use_take_profit", "take_profit_pct", "use_stop_loss", "stop_loss_pct", "selected_symbol", "strategy_mode", "strategy_interval", "entry_z", "exit_z",
                 "notional_usd", "max_tranches", "ma_stretch_min", "min_consensus_votes", "trend_macro_window",
                 "macd_fast_period", "macd_slow_period", "macd_signal_period",
                 "macro_regime_mode", "macro_macd_fast_period", "macro_macd_slow_period",
                 "macro_macd_signal_period", "macro_macd_confirm_bars",
                 "use_macd_signal_negative", "use_macd_hist_negative", "use_macd_hist_reversal",
                 "use_macd_signal_positive", "use_macd_hist_positive", "use_macd_hist_reversal_exit",
                 "use_macd_hist_turn", "use_macd_hist_zone", "use_macd_hist_exit_zone", "use_macd_signal_slope_5m", "use_macd_zero_cross", "use_macd_signal_zone",
                 "use_hourly_hist", "hourly_hist_fast", "hourly_hist_slow", "hourly_hist_signal",
                 "use_macd_strength", "macd_strength_min_pct", "use_macd_two_stage_exit", "macd_first_exit_pct")):
                raise ValueError("Pause the live bot before changing strategy or sizing")
            if self.state["tranches"] and candidate["selected_symbol"] != self.state["selected_symbol"]:
                raise ValueError("Close tracked inventory before changing symbol")
            if self.state["tranches"] and candidate["strategy_mode"] != self.state["strategy_mode"]:
                # Both modes own identical single-leg LIFO lots; only their
                # completed-candle predicates differ. No inventory migration
                # or exchange order is needed to use the new rules on resume.
                compatible_modes = {"macd_zero_cross", "macd_hist_turn"}
                if not {self.state["strategy_mode"], candidate["strategy_mode"]} <= compatible_modes:
                    raise ValueError("Close tracked inventory before changing strategy")
                if self.state.get("pending_order") or self.state.get("recovery_required"):
                    raise ValueError("Resolve pending orders and inventory recovery before changing strategy")
            native_keys = {"use_native_protection", "use_take_profit", "take_profit_pct", "use_stop_loss", "stop_loss_pct"}
            native_changed = any(candidate[k] != self.state[k] for k in native_keys)
            replacing = bool(self.state.get("native_protection_update_pending")) or (
                native_changed and bool(self.state.get("native_brackets")))
            if replacing or (native_changed and (self.state.get("use_native_protection") or candidate.get("use_native_protection"))):
                if self.state.get("pending_order") or self.state.get("recovery_required"):
                    raise ValueError("Resolve pending orders and inventory recovery before changing native protection")
            if replacing:
                if self.state["enabled"]:
                    raise ValueError("Pause the live bot before updating native protection")
                async with self.client.execution_lock:
                    # Account for fills before validating ownership. Leave all
                    # working protection intact if this preflight fails.
                    await self.reconcile_native_protection()
                    _, detail, step = await self._market(self.state["selected_symbol"], fresh=True)
                    _, amount, _ = await self._account_position(self.state["selected_symbol"])
                    self._check_position(amount, step, mark_price=float(detail.get("mark_price", 0) or 0),
                                         min_base_amount=float(detail.get("min_base_amount", 0) or 0))
                    if candidate["use_native_protection"]:
                        fee = await self.take_profit_fee_rate()
                        for lot in self.state["tranches"]:
                            children = protection_children(lot, candidate, int(detail["supported_price_decimals"]), fee, lambda: 1)
                            if children and (float(lot["qty"]) < float(detail.get("min_base_amount") or 0)
                                    or any(float(lot["qty"]) * c["trigger_price"] < float(detail.get("min_quote_amount") or 0)
                                           for c in children)):
                                raise ValueError("Replacement native protection is below exchange minimum size/notional")
                    if native_changed:
                        self.state["native_protection_update_pending"] = list(dict.fromkeys(
                            [g["entry_order_id"] for g in self.state["native_brackets"]] +
                            [str(t["order_id"]) for t in self.state["tranches"]]))
                    self.state.update({key: candidate[key] for key in values})
                    # Durable pause barrier: a restart cannot silently arm old
                    # targets or resume entries during an incomplete replacement.
                    self.state["native_protection_pending_activation"] = True
                    self._save()
                    try:
                        for owner in list(self.state["native_protection_update_pending"]):
                            await self.reconcile_native_protection(cancel_entry_ids={owner})
                            await self.arm_native_protection(replacing=True, entry_ids={owner})
                            self.state["native_protection_update_pending"].remove(owner)
                            self._save()
                    except Exception as exc:
                        raise ValueError(f"Protection update incomplete; bot remains paused. Retry Save & Deploy after resolving: {exc}") from exc
                    self.state["native_protection_pending_activation"] = False
                    self._save()
                    return self.public_state()
            if candidate["use_native_protection"] != self.state["use_native_protection"]:
                # Saving configuration while paused must not submit orders.
                # Existing slices are enrolled on the next explicit resume.
                self.state["native_protection_pending_activation"] = candidate["use_native_protection"]
                self.state["native_protection_checked_at"] = int(time.time())
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

    DUST_NOTIONAL_THRESHOLD_USD = 5.0

    def _check_position(
        self,
        amount: float,
        size_step: float,
        *,
        mark_price: float = 0.0,
        min_base_amount: float = 0.0,
    ) -> None:
        expected = sum(float(item["qty"]) * int(item["side"]) for item in self.state["tranches"])
        diff = abs(amount - expected)
        tolerance = max(size_step / 2, abs(expected) * 0.00001)
        if diff <= tolerance:
            return

        px = mark_price
        if px <= 0:
            px = float((self.state.get("last_evaluation") or {}).get("ratio", 0) or 0)
        if px <= 0 and self.state.get("tranches"):
            px = float(self.state["tranches"][-1].get("price", 0) or 0)

        notional_diff = diff * px if px > 0 else 0.0
        is_dust = False
        if notional_diff > 0 and notional_diff < self.DUST_NOTIONAL_THRESHOLD_USD:
            is_dust = True
        elif min_base_amount > 0 and diff < min_base_amount:
            if notional_diff == 0.0 or notional_diff < self.DUST_NOTIONAL_THRESHOLD_USD * 2:
                is_dust = True

        if is_dust:
            logger.info(
                "Ignoring insignificant exchange dust: expected=%s, exchange=%s, diff=%s (~$%.2f)",
                expected, amount, diff, notional_diff,
            )
            return

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

    def _check_entry_capacity(self, account: Dict[str, Any], positions: list[Dict[str, Any]],
                              order_usd: float) -> None:
        collateral = float(account.get("collateral", 0) or 0)
        selected_market_id = MARKETS[self.state["selected_symbol"]]
        gross = 0.0
        for position in positions:
            if int(position.get("market_id", -1)) != selected_market_id:
                continue
            size = abs(float(position.get("position", 0) or position.get("size", 0) or 0))
            value = abs(float(position.get("position_value", 0) or 0))
            if size and not value:
                mark = float(position.get("mark_price", 0) or position.get("avg_entry_price", 0) or 0)
                if mark <= 0:
                    raise ValueError("Cannot determine selected-contract Lighter exposure")
                value = size * mark
            gross += value
        projected_gross = gross + order_usd
        leverage_cap = float(self.state.get("gross_leverage_cap", self.GROSS_LEVERAGE_CAP))
        if projected_gross > collateral * leverage_cap:
            raise ValueError(
                f"Selected-contract gross exposure ${projected_gross:.2f} exceeds "
                f"{leverage_cap:.1f}x collateral cap ${collateral * leverage_cap:.2f}"
            )
        allocated = sum(abs(float(p.get("allocated_margin", 0) or 0)) for p in positions)
        required_margin = max(
            self.MIN_MARGIN_BUFFER_USD,
            order_usd / self.MARGIN_LEVERAGE_ASSUMPTION * self.MARGIN_BUFFER_MULTIPLIER,
        )
        available_margin = max(0.0, collateral - allocated)
        if available_margin < required_margin:
            raise ValueError(
                f"Available margin ${available_margin:.2f} is below "
                f"${required_margin:.2f} buffered initial-margin estimate"
            )

    async def toggle(self, enabled: bool) -> Dict[str, Any]:
        async with self.lock:
            if not enabled:
                self._finish_entry_campaign("bot_paused")
                self.state["enabled"] = False
                self.state["execution_blocked"] = False
                self.state["blocked_reason"] = None
                self._save()
                return self.public_state()
            if self.state.get("native_protection_update_pending"):
                raise ValueError("Finish the native protection update with Save & Deploy before resuming")
            if self.state["pending_order"]:
                resolved, _ = await self._resolve_pending_order()
                if not resolved:
                    raise ValueError("Resolve Lighter execution recovery before enabling")
            async with self.client.execution_lock:
                await self.reconcile_native_protection()
            symbol = self.state["selected_symbol"]
            market_id, detail, step = await self._market(symbol, fresh=True)
            account, amount, positions = await self._account_position(symbol)
            mark_px = float(detail.get("mark_price", 0) or 0)
            min_base = float(detail.get("min_base_amount", 0) or 0)
            try:
                self._check_position(amount, step, mark_price=mark_px, min_base_amount=min_base)
                if self.state.get("recovery_required") and not self.state.get("pending_order"):
                    self.state["recovery_required"] = False
                    self.state["execution_blocked"] = False
                    self.state["blocked_reason"] = None
                    self.state["last_error"] = None
                    self._save()
            except Exception as exc:
                self.state.update(
                    recovery_required=True,
                    execution_blocked=True,
                    blocked_reason=str(exc),
                    last_error=str(exc),
                )
                self._save()
                raise
            blocked = False
            blocked_reason = None
            if float(account.get("collateral", 0)) <= 0:
                blocked = True
                blocked_reason = "No available Lighter collateral for new entries"
            else:
                try:
                    _, ask = await self._book(market_id)
                    qty = self._entry_quantity(self.state["notional_usd"], ask, detail)
                    self._check_entry_capacity(account, positions, qty * ask)
                except Exception as exc:
                    blocked = True
                    blocked_reason = str(exc)
            seconds = INTERVAL_SECONDS[self.state["strategy_interval"]]
            self.state["last_evaluated_candle"] = int(time.time()) // seconds * seconds - seconds
            self.state.update(enabled=True, execution_blocked=blocked, blocked_reason=blocked_reason, last_error=None)
            self._save()
            return self.public_state()

    def _finish_entry_campaign(self, reason: str) -> None:
        campaign = self.state.get("entry_campaign")
        if not campaign:
            return
        finished = copy.deepcopy(campaign)
        finished.update(status=reason, ended_at=int(time.time()))
        self.state["last_entry_campaign"] = finished
        self.state["entry_campaign"] = None

    def _start_entry_campaign(
        self,
        side: int,
        signal_time: int,
        *,
        signal_values: Optional[list[float]] = None,
        macro_alignment: Optional[tuple[bool, bool]] = None,
        initial_reason: str = "closed_bar_signal",
    ) -> Dict[str, Any]:
        existing = self.state.get("entry_campaign")
        if existing and int(existing.get("side", 0)) == int(side):
            return existing
        if existing:
            self._finish_entry_campaign("replaced_by_new_signal")
        campaign = {
            "campaign_id": f"{int(signal_time)}:{int(side)}:{secrets.token_hex(4)}",
            "side": int(side),
            "signal_time": int(signal_time),
            "started_at": int(time.time()),
            "slice_notional_usd": float(self.state["notional_usd"]),
            "target_slices": self.state.get("max_tranches"),
            "starting_tranches": len(self.state["tranches"]),
            "slices_filled": 0,
            "status": "active",
            "initial_reason": initial_reason,
        }
        if signal_values is not None:
            campaign["signal_values"] = [float(value) for value in signal_values]
        if macro_alignment is not None:
            campaign["macro_alignment"] = [bool(value) for value in macro_alignment]
        self.state["entry_campaign"] = campaign
        self._save()
        return campaign

    async def _continue_entry_campaign(self) -> bool:
        """Submit one due child order for the active signal-triggered campaign."""
        campaign = self.state.get("entry_campaign")
        if not campaign or not self.state.get("enabled"):
            return False
        if self.state.get("pending_order") or self.state.get("recovery_required"):
            return False
        if self.state.get("execution_blocked"):
            blocked_reason = str(self.state.get("blocked_reason") or "")
            if any(text in blocked_reason for text in (
                "Selected-contract gross exposure",
                "Available margin",
                "Tranche capacity reached",
            )):
                self._finish_entry_campaign("safety_capacity_reached")
                self._save()
            return False
        side = int(campaign.get("side", 0))
        if side not in (-1, 1):
            self._finish_entry_campaign("invalid_campaign")
            self._save()
            return False
        if self.state["tranches"] and int(self.state["tranches"][-1]["side"]) != side:
            self._finish_entry_campaign("position_direction_changed")
            self._save()
            return False
        if not has_entry_slot(self.state):
            self._finish_entry_campaign("target_reached")
            self._save()
            return False
        if (not entry_direction_allowed(self.state.get("entry_direction_mode", "two_way"), side)
                or not await self.hourly_entry_allowed(side)
                or not await self.five_minute_signal_entry_allowed(side)):
            self._finish_entry_campaign("entry_direction_filter")
            self._save()
            return False
        first_slice = int(campaign.get("slices_filled", 0)) == 0
        immediate_reversal = first_slice and campaign.get("initial_reason") == "reversal_entry"
        if (not immediate_reversal
                and time.time() - float(self.state.get("last_order_time", 0) or 0)
                < float(self.state["min_seconds_between_orders"])):
            return False
        try:
            await self._submit(
                side,
                float(campaign.get("slice_notional_usd", self.state["notional_usd"])),
                reduce_only=False,
                reason=str(campaign.get("initial_reason") or "closed_bar_signal") if first_slice else "signal_campaign_slice",
                signal_values=list(campaign.get("signal_values") or []) if first_slice and campaign.get("signal_values") else None,
                macro_alignment=tuple(campaign["macro_alignment"]) if first_slice and campaign.get("macro_alignment") else None,
                campaign_id=str(campaign["campaign_id"]),
            )
        except ValueError as exc:
            message = str(exc)
            if any(text in message for text in (
                "Tranche capacity reached",
                "Selected-contract gross exposure",
                "Available margin",
            )):
                self._finish_entry_campaign("safety_capacity_reached")
                self.state["last_error"] = None
                self._save()
                return False
            if first_slice and not self.state.get("pending_order"):
                self._finish_entry_campaign("initial_slice_rejected")
                self._save()
            raise
        if not has_entry_slot(self.state):
            self._finish_entry_campaign("target_reached")
            self._save()
        return True

    def _record_fill(self, order: Dict[str, Any], pending: Dict[str, Any], allow_partial: bool = False) -> Dict[str, Any]:
        filled = float(order.get("filled_size", 0) or 0)
        price = float(order.get("fill_price", 0) or 0)
        step = float(pending["size_step"])
        expected = float(pending["qty"])
        if not allow_partial:
            if not order.get("fill_confirmed") or price <= 0 or abs(filled - expected) > max(step / 2, expected * 0.00001):
                raise ValueError("Lighter order did not confirm the complete intended fill")
        else:
            if price <= 0 or filled <= 0:
                raise ValueError("Lighter order has no valid filled price or quantity")
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
            self._finish_entry_campaign("exit_started")
            remaining = filled
            matched = []
            while remaining > max(step / 2, filled * 0.00001) and self.state["tranches"]:
                target_id = pending.get("entry_order_id")
                lot_index = next((i for i, t in enumerate(self.state["tranches"])
                                  if str(t["order_id"]) == str(target_id)), -1) if target_id else -1
                if target_id and lot_index < 0:
                    raise ValueError("Native exit does not match a tracked entry")
                tracked = self.state["tranches"][lot_index]
                if int(tracked["side"]) * side >= 0:
                    raise ValueError("Lighter reduction fill does not match the tracked campaign direction")
                original_qty = float(tracked["qty"])
                consumed = min(remaining, original_qty)
                consumed_all = consumed >= original_qty - max(step / 2, original_qty * 0.00001)
                entry_fee = float(tracked.get("fee_usd", 0) or 0)
                fee_share = entry_fee if consumed_all else entry_fee * consumed / original_qty
                matched.append({
                    "side": int(tracked["side"]),
                    "qty": consumed,
                    "price": float(tracked["price"]),
                    "fee_usd": fee_share,
                    "order_id": str(tracked["order_id"]),
                })
                if consumed_all:
                    self.state["tranches"].pop(lot_index)
                else:
                    tracked["qty"] = original_qty - consumed
                    tracked["fee_usd"] = entry_fee - fee_share
                remaining -= consumed

            if remaining > max(step / 2, filled * 0.00001):
                raise ValueError("Lighter reduction fill exceeds bot-owned inventory")
            if matched:
                matched_qty = sum(item["qty"] for item in matched)
                gross = sum(
                    item["side"] * item["qty"] * (price - item["price"])
                    for item in matched
                )
                entry_fees = sum(item["fee_usd"] for item in matched)
                weighted_entry = sum(item["qty"] * item["price"] for item in matched) / matched_qty
                net = gross - entry_fees - event["fee_usd"]
                event.update(
                    entry_price=weighted_entry,
                    entry_order_id=matched[0]["order_id"],
                    entry_order_ids=[item["order_id"] for item in matched],
                    matched_tranches=len(matched),
                    original_side=matched[0]["side"],
                    gross_pnl_usd=gross,
                    net_pnl_usd=net,
                    pnl_source="ESTIMATED_EX_FUNDING",
                )
            else:
                event.update(entry_price=price, entry_order_id="external",
                             original_side=-side, gross_pnl_usd=0.0,
                             net_pnl_usd=-event["fee_usd"], pnl_source="ESTIMATED_EX_FUNDING")
        else:
            self.state["tranches"].append({"side": side, "qty": filled, "price": price,
                                            "fee_usd": event["fee_usd"],
                                            "order_id": event["order_id"], "time": event["time"]})
            campaign = self.state.get("entry_campaign")
            if campaign and str(pending.get("campaign_id") or "") == str(campaign.get("campaign_id") or ""):
                campaign["slices_filled"] = int(campaign.get("slices_filled", 0)) + 1
                campaign["last_fill_time"] = event["time"]
                campaign["last_fill_price"] = price
                campaign.pop("signal_values", None)
                campaign.pop("macro_alignment", None)
                campaign.pop("initial_reason", None)
            if self.state.get("strategy_mode") == "macd_strength_scaleout":
                self.state["macd_exit_stage"] = 0
        if pending.get("macd_exit_stage_after") is not None:
            self.state["macd_exit_stage"] = int(pending["macd_exit_stage_after"])
        self.state["execution_history"].append(event)
        self.state["execution_history"] = self.state["execution_history"][-500:]
        self.state.update(pending_order=None, last_order_time=event["time"], last_error=None,
                          execution_blocked=False, blocked_reason=None)
        self._save()
        return event

    def _reduction_quantity(self, side: int, price: float, detail: Dict[str, Any],
                            step: float, reduce_fraction: float) -> float:
        """Return a valid LIFO reduction, merging newer dust with older tranches."""
        if not self.state["tranches"]:
            raise ValueError("No bot-owned tranche to reduce")
        latest = self.state["tranches"][-1]
        if int(latest["side"]) * side >= 0:
            raise ValueError("No bot-owned tranche can be reduced in that direction")

        min_base = float(detail.get("min_base_amount", 0) or 0)
        min_quote = float(detail.get("min_quote_amount", 0) or 0)
        required = max(step, min_base, (min_quote / price) if min_quote > 0 else 0.0)
        required_steps = max(1, math.ceil((required / step) - 1e-12))
        minimum_qty = required_steps * step

        latest_qty = float(latest["qty"])
        requested = latest_qty * min(1.0, max(0.0, reduce_fraction))
        quantized = math.floor((requested / step) + 1e-12) * step
        if quantized >= minimum_qty - step * 1e-9:
            return quantized

        aggregate = 0.0
        for tranche in reversed(self.state["tranches"]):
            if int(tranche["side"]) * side >= 0:
                break
            aggregate += float(tranche["qty"])
            quantized = math.floor((aggregate / step) + 1e-12) * step
            if quantized >= minimum_qty - step * 1e-9:
                return quantized
        raise ValueError(
            f"Bot-owned LIFO inventory is below the Lighter minimum reduction size "
            f"({aggregate:.8f} available; {minimum_qty:.8f} required)"
        )

    async def _submit(self, side: int, notional: float, *, reduce_only: bool, reason: str,
                      signal_values: Optional[list[float]] = None,
                      reduce_fraction: float = 1.0, exit_stage_after: Optional[int] = None,
                      macro_alignment: Optional[tuple[bool, bool]] = None,
                      campaign_id: Optional[str] = None) -> Dict[str, Any]:
        async with self.client.execution_lock:
            await self.reconcile_native_protection(cancel=reduce_only)
            symbol = self.state["selected_symbol"]
            market_id, detail, step = await self._market(symbol, fresh=True)
            account, amount, positions = await self._account_position(symbol)
            mark_px = float(detail.get("mark_price", 0) or 0)
            min_base = float(detail.get("min_base_amount", 0) or 0)
            self._check_position(amount, step, mark_price=mark_px, min_base_amount=min_base)
            bid, ask = await self._book(market_id, enforce_spread=not reduce_only)
            price = ask if side > 0 else bid
            if reason != "manual" and not reduce_only:
                if not await self.hourly_entry_allowed(side):
                    raise ValueError("Hourly MACD histogram direction blocks this entry")
                if not await self.five_minute_signal_entry_allowed(side):
                    raise ValueError("Completed 5m MACD signal slope blocks this entry")
            if signal_values is not None and not reduce_only:
                valid, quote_side, _, _ = evaluate_strategy_signal(
                    self.state["strategy_mode"],
                    signal_values[:-1] + [price],
                    self.state,
                    hourly_histogram=self.state.get("hourly_histogram"),
                    five_minute_macd_signal=self.state.get("five_minute_macd_signal"),
                    evaluation_time=int(time.time()),
                    position_side=0,
                    entry_price=0.0,
                    held_bars=0,
                    macro_alignment=macro_alignment,
                )
                if not valid or quote_side != side:
                    raise ValueError("Current Lighter quote no longer supports the candle entry signal")
            if reduce_only:
                if not self.state["tranches"] or amount * side >= 0:
                    raise ValueError("No bot-owned tranche can be reduced in that direction")
                qty = self._reduction_quantity(side, price, detail, step, reduce_fraction)
            else:
                if self.state["pending_order"] or self.state["recovery_required"]:
                    raise ValueError("Execution recovery required")
                if not has_entry_slot(self.state):
                    raise ValueError("Tranche capacity reached")
                is_dust_pos = (abs(amount) * mark_px < self.DUST_NOTIONAL_THRESHOLD_USD) or (min_base > 0 and abs(amount) < min_base)
                if not is_dust_pos and amount and amount * side < 0:
                    raise ValueError("Cannot reverse an active campaign")
                mult = float(self.state.get("long_multiplier", 1.0)) if side > 0 else float(self.state.get("short_multiplier", 1.0))
                effective_notional = notional * max(0.1, mult)
                qty = self._entry_quantity(effective_notional, price, detail)
                self._check_entry_capacity(account, positions, qty * price)
            if reason == "net_take_profit":
                if not self.state.get("use_take_profit", True) or not (await self.take_profit_evaluation(price, float(qty)))["pass"]:
                    raise ValueError("Executable quote no longer meets net take-profit target")
            if reason == "net_stop_loss":
                if not self.state.get("use_stop_loss", False) or not (await self.stop_loss_evaluation(price, float(qty)))["pass"]:
                    raise ValueError("Executable quote no longer meets net stop-loss threshold")
            order_index = secrets.randbelow(self.client.MAX_CLIENT_ORDER_INDEX - 1) + 1
            pending = {"client_order_index": order_index, "symbol": symbol, "market_id": market_id,
                       "side": side, "qty": qty, "size_step": step,
                       "reduce_only": reduce_only, "reason": reason, "created_at": int(time.time())}
            if campaign_id is not None:
                pending["campaign_id"] = str(campaign_id)
            if exit_stage_after is not None:
                pending["macd_exit_stage_after"] = int(exit_stage_after)
            self.state["pending_order"] = pending
            self._save()
            try:
                result = await self.client.create_market_order(
                    market_id, qty, price, is_ask=side < 0, reduce_only=reduce_only,
                    client_order_index=order_index)
                event = self._record_fill(result, pending)
            except Exception as exc:
                message = str(exc)
                definitive_preflight = isinstance(exc, ValueError) and (
                    "order is below its minimum size" in message
                    or "order size and reference price must be positive" in message
                )
                if definitive_preflight:
                    self.state.update(
                        pending_order=None,
                        recovery_required=False,
                        execution_blocked=False,
                        blocked_reason=None,
                        last_error=message,
                    )
                    self._save()
                    raise
                self.state.update(recovery_required=True, execution_blocked=True,
                                  blocked_reason=f"Lighter order outcome uncertain; reconcile {order_index}: {exc}",
                                  last_error=f"Lighter order outcome uncertain; reconcile {order_index}: {exc}")
                self._save()
                raise
            # Market fill has already been durably recorded. A bracket error
            # must never turn that confirmed fill into an uncertain market order.
            await self.arm_native_protection()
            return event

    async def _resolve_pending_order(self) -> tuple[bool, Optional[Dict[str, Any]]]:
        """Verify and safely resolve an in-flight, unfilled, or rejected pending order.

        Returns (resolved: bool, fill_event: Optional[Dict]).
        """
        pending = self.state.get("pending_order")
        if not pending:
            return True, None

        idx = int(pending.get("client_order_index", 0))
        market_id = int(pending.get("market_id", 1))
        qty = float(pending.get("qty", 0.0))
        created_at = int(pending.get("created_at", 0) or 0)
        age_s = time.time() - created_at if created_at > 0 else 9999

        try:
            # 1. Check if execution fill can be confirmed
            fill = await self.client.execution_fill(idx, market_id, qty)
            if fill.get("fill_confirmed"):
                event = self._record_fill(fill, pending)
                logger.info("Pending order %s confirmed filled during resolution", idx)
                return True, event

            # 2. Check account_order status on the exchange
            order = await self.client.account_order(idx) if idx else None
            if order:
                status_str = str(order.get("status", "")).lower()
                filled_base = float(order.get("filled_base_amount", 0) or 0)
                is_terminal = (
                    status_str.startswith("cancel")
                    or status_str in {"cancelled", "canceled", "expired", "rejected"}
                )
                if is_terminal:
                    if filled_base > 0:
                        px = (
                            float(order.get("filled_quote_amount", 0) or 0) / filled_base
                            if filled_base
                            else float(order.get("price", 0) or 0)
                        )
                        partial_record = {
                            "fill_confirmed": True,
                            "filled_size": filled_base,
                            "fill_price": px,
                            "fee_usd": float(order.get("integrator_taker_fee", 0) or 0),
                            "fill_time_ms": int(order.get("timestamp", 0) or 0) * 1000
                            or int(time.time() * 1000),
                        }
                        event = self._record_fill(partial_record, pending, allow_partial=True)
                        logger.info("Pending order %s was cancelled with partial fill %s; recorded fill", idx, filled_base)
                        return True, event
                    else:
                        logger.info("Pending order %s was cancelled/expired UNFILLED; safely clearing", idx)
                        self.state["pending_order"] = None
                        self.state.update(
                            recovery_required=False,
                            execution_blocked=False,
                            blocked_reason=None,
                            last_error=None,
                        )
                        self._save()
                        return True, None
                elif status_str in {"filled", "success"}:
                    px = (
                        float(order.get("filled_quote_amount", 0) or 0) / filled_base
                        if filled_base
                        else float(order.get("price", 0) or 0)
                    )
                    fill_size = filled_base if filled_base > 0 else qty
                    record = {
                        "fill_confirmed": True,
                        "filled_size": fill_size,
                        "fill_price": px,
                        "fee_usd": float(order.get("integrator_taker_fee", 0) or 0),
                        "fill_time_ms": int(order.get("timestamp", 0) or 0) * 1000
                        or int(time.time() * 1000),
                    }
                    event = self._record_fill(record, pending, allow_partial=True)
                    return True, event

            # 3. If order not found on exchange after 15 seconds:
            if not order and age_s > 15:
                symbol = self.state["selected_symbol"]
                _, amount, _ = await self._account_position(symbol)
                expected = sum(float(item["qty"]) * int(item["side"]) for item in self.state["tranches"])
                step = float(pending.get("size_step", 0.00001))
                diff = abs(amount - expected)
                if diff <= max(step / 2, abs(expected) * 0.00001):
                    logger.warning(
                        "Pending order %s not found on exchange after %.0fs and position matches expected (%s); clearing ghost pending order",
                        idx, age_s, expected,
                    )
                    self.state["pending_order"] = None
                    self.state.update(
                        recovery_required=False,
                        execution_blocked=False,
                        blocked_reason=None,
                        last_error=None,
                    )
                    self._save()
                    return True, None
        except Exception as exc:
            logger.warning("Error resolving pending order %s: %s", idx, exc)

        return False, None

    async def reconcile(self) -> Dict[str, Any]:
        async with self.lock:
            if self.state["enabled"] and not self.state["recovery_required"]:
                raise ValueError("Pause the bot before reconciliation")
            pending = self.state["pending_order"]
            event = None
            if pending:
                resolved, event = await self._resolve_pending_order()
                if not resolved:
                    idx = int(pending.get("client_order_index", 0))
                    order = await self.client.account_order(idx) if idx else None
                    if not order:
                        logger.warning("Order %s not found on exchange during reconcile; clearing pending order", idx)
                        self.state["pending_order"] = None
                        self._save()
                    else:
                        status_str = str(order.get("status", "")).lower()
                        filled_base = float(order.get("filled_base_amount", 0) or 0)
                        is_terminal_canceled = (
                            status_str.startswith("cancel")
                            or status_str in {"cancelled", "canceled", "expired", "rejected"}
                        )
                        if is_terminal_canceled:
                            if filled_base > 0:
                                px = (
                                    float(order.get("filled_quote_amount", 0) or 0) / filled_base
                                    if filled_base
                                    else float(order.get("price", 0) or 0)
                                )
                                partial_record = {
                                    "fill_confirmed": True,
                                    "filled_size": filled_base,
                                    "fill_price": px,
                                    "fee_usd": float(order.get("integrator_taker_fee", 0) or 0),
                                    "fill_time_ms": int(order.get("timestamp", 0) or 0) * 1000 or int(time.time() * 1000),
                                }
                                event = self._record_fill(partial_record, pending, allow_partial=True)
                            else:
                                self.state["pending_order"] = None
                                self._save()
                        else:
                            raise ValueError(f"Lighter order {idx} status is '{status_str}'; cancel on exchange before reconciling")
            async with self.client.execution_lock:
                await self.reconcile_native_protection()
            symbol = self.state["selected_symbol"]
            market_id, detail, step = await self._market(symbol)
            _, amount, _ = await self._account_position(symbol)
            mark_px = float(detail.get("mark_price", 0) or 0)
            if mark_px <= 0:
                try:
                    bid, ask = await self._book(market_id, enforce_spread=False)
                    mark_px = (bid + ask) / 2
                except Exception:
                    mark_px = 0.0
            min_base = float(detail.get("min_base_amount", 0) or 0)
            expected = sum(float(item["qty"]) * int(item["side"]) for item in self.state["tranches"])
            diff = abs(amount - expected)
            tolerance = max(step / 2, abs(expected) * 0.00001)
            diff_notional = diff * mark_px if mark_px > 0 else 0.0

            if diff > tolerance and self.state.get("use_native_protection"):
                raise ValueError("Native protection inventory mismatch; preserve slice ownership and investigate exchange fills")
            if diff > tolerance:
                logger.warning("Reconciling position mismatch: expected %s, exchange has %s", expected, amount)
                is_dust = (diff_notional > 0 and diff_notional < self.DUST_NOTIONAL_THRESHOLD_USD) or (min_base > 0 and diff < min_base and diff_notional < 10.0)
                if is_dust or abs(amount) < step or (abs(amount) * mark_px < self.DUST_NOTIONAL_THRESHOLD_USD and abs(amount) < min_base):
                    logger.info("Exchange position %s is negligible dust (< $%.1f / min lot); clearing bot tranches", amount, self.DUST_NOTIONAL_THRESHOLD_USD)
                    self.state["tranches"] = []
                else:
                    now_ts = int(time.time())
                    side = 1 if amount > 0 else -1
                    reconciled_tranche = {
                        "side": side,
                        "qty": abs(amount),
                        "price": mark_px,
                        "fee_usd": 0.0,
                        "order_id": f"reconciled_{now_ts}",
                        "time": now_ts,
                    }
                    self.state["tranches"] = [reconciled_tranche]
                    entry_event = {
                        "event": "ENTRY",
                        "symbol": symbol,
                        "market_id": market_id,
                        "side": side,
                        "original_side": side,
                        "qty": abs(amount),
                        "price": mark_px,
                        "entry_price": mark_px,
                        "notional_usd": abs(amount) * mark_px,
                        "order_id": reconciled_tranche["order_id"],
                        "client_order_index": reconciled_tranche["order_id"],
                        "reason": "exchange_reconciliation",
                        "time": now_ts,
                        "fee_usd": 0.0,
                        "pnl_authoritative": False,
                        "status": "OPEN",
                    }
                    self.state["execution_history"].append(entry_event)
                    self.state["execution_history"] = self.state["execution_history"][-500:]
            self._finish_entry_campaign("reconciled")
            self.state.update(recovery_required=False, execution_blocked=False, blocked_reason=None, last_error=None)
            self._save()
            return {"event": event, "bot": await self.reconciled_public_state()}

    async def verify_startup(self) -> None:
        if not self.state["enabled"] and not self.state["tranches"] and not self.state["pending_order"] and not self.state.get("native_brackets"):
            return
        async with self.lock:
            try:
                if self.state["pending_order"]:
                    resolved, _ = await self._resolve_pending_order()
                    if not resolved:
                        idx = int(self.state["pending_order"].get("client_order_index", 0))
                        order = await self.client.account_order(idx) if idx else None
                        if order:
                            status_str = str(order.get("status", "")).lower()
                            filled_base = float(order.get("filled_base_amount", 0) or 0)
                            if status_str.startswith("cancel") or status_str in {"cancelled", "canceled", "expired", "rejected"}:
                                if filled_base == 0:
                                    self.state["pending_order"] = None
                                    self.state.update(recovery_required=False, execution_blocked=False, blocked_reason=None, last_error=None)
                                    self._save()
                                else:
                                    raise ValueError("Pending order requires reconciliation")
                            else:
                                raise ValueError("Pending order requires reconciliation")
                        else:
                            created_at = int(self.state["pending_order"].get("created_at", 0) or 0)
                            if created_at > 0 and (time.time() - created_at) > 15:
                                self.state["pending_order"] = None
                                self.state.update(recovery_required=False, execution_blocked=False, blocked_reason=None, last_error=None)
                                self._save()
                            else:
                                raise ValueError("Pending order requires reconciliation")
                async with self.client.execution_lock:
                    await self.reconcile_native_protection()
                symbol = self.state["selected_symbol"]
                _, detail, step = await self._market(symbol)
                _, amount, _ = await self._account_position(symbol)
                mark_px = float(detail.get("mark_price", 0) or 0)
                min_base = float(detail.get("min_base_amount", 0) or 0)
                self._check_position(amount, step, mark_price=mark_px, min_base_amount=min_base)
            except Exception as exc:
                self.state.update(recovery_required=True, execution_blocked=True,
                                  blocked_reason=f"Startup reconciliation failed: {exc}",
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

    async def pause_reconcile_and_reduce(self) -> Dict[str, Any]:
        """Safely hand an active bot over to a manual reduce-only action.

        The UI exposes reduction while Full-Auto is running, so requiring the
        user to switch to Paper first creates an impossible workflow: Paper
        changes the same control into a simulated exit.  Pause the persisted
        daemon state first, reconcile its inventory against Lighter, and only
        then submit the reduction.  A reconciliation failure leaves the bot
        paused and does not place an order.
        """
        was_enabled = bool(self.state.get("enabled"))
        if was_enabled:
            await self.toggle(False)
        if was_enabled or self.state.get("recovery_required") or self.state.get("pending_order"):
            await self.reconcile()
        event = await self.manual_reduce()
        return {"event": event, "bot_was_paused": was_enabled}

    async def flatten(self) -> Dict[str, Any]:
        async with self.lock:
            self._finish_entry_campaign("emergency_flatten")
            self.state["enabled"] = False
            self._save()
            symbol = self.state["selected_symbol"]
            market_id, detail, step = await self._market(symbol, fresh=True)
            if self.state["pending_order"]:
                try:
                    await self._resolve_pending_order()
                except Exception as err:
                    logger.warning("Error checking pending order during flatten: %s", err)
                self.state["pending_order"] = None
            events = []
            while self.state["tranches"]:
                try:
                    events.append(await self._submit(-int(self.state["tranches"][-1]["side"]), 0,
                                                     reduce_only=True, reason="emergency_flatten"))
                except Exception as err:
                    logger.warning("Error reducing tranche during flatten: %s", err)
                    break
            try:
                _, amount, _ = await self._account_position(symbol)
                mark_px = float(detail.get("mark_price", 0) or 0)
                min_base = float(detail.get("min_base_amount", 0) or 0)
                is_dust = (abs(amount) * mark_px < self.DUST_NOTIONAL_THRESHOLD_USD) or (min_base > 0 and abs(amount) < min_base)
                if abs(amount) >= step and not is_dust:
                    bid, ask = await self._book(market_id, enforce_spread=False)
                    close_side = 1 if amount < 0 else -1
                    close_price = ask if close_side > 0 else bid
                    order_index = secrets.randbelow(self.client.MAX_CLIENT_ORDER_INDEX - 1) + 1
                    await self.client.create_market_order(
                        market_id, abs(amount), close_price, is_ask=(close_side < 0),
                        reduce_only=True, client_order_index=order_index
                    )
                    events.append({
                        "event": "EXIT", "symbol": symbol, "market_id": market_id,
                        "side": close_side, "qty": abs(amount), "price": close_price,
                        "reason": "emergency_flatten_residual",
                        "time": int(time.time()),
                        "pnl_authoritative": False,
                    })
            except Exception as exc:
                logger.warning("Error flattening residual exchange position: %s", exc)
            self.state["tranches"] = []
            self.state.update(pending_order=None, recovery_required=False, execution_blocked=False, blocked_reason=None, last_error=None)
            self._save()
            return {"events": events, "bot": self.public_state()}

    async def _refresh_paused_condition_evaluation(self) -> None:
        """Keep live condition status current while paused, without executing orders."""
        if self.state.get("strategy_mode") not in {"macd_zero_cross", "macd_hist_turn"}:
            return
        now = time.time()
        if now - float(getattr(self, "_paused_condition_refresh_at", 0.0)) < 15:
            return
        self._paused_condition_refresh_at = now
        async with self.lock:
            if self.state.get("enabled"):
                return
            interval = self.state["strategy_interval"]
            seconds = INTERVAL_SECONDS[interval]
            symbol = self.state["selected_symbol"]
            try:
                market_id, _, _ = await self._market(symbol)
                await self.refresh_hourly_histogram()
                await self.refresh_five_minute_macd_signal()
                required_bars = required_strategy_bars(self.state["strategy_mode"], self.state)
                request_limit = min(500, max(130, required_bars + 1))
                rows = await self.client.candles(market_id, interval, request_limit, fresh=True)
                now_ms = int(time.time() * 1000)
                closed = [row for row in rows if int(row["t"]) + seconds * 1000 <= now_ms - 1000]
                if len(closed) < required_bars:
                    raise ValueError("Insufficient completed Lighter candles")
                last_candle = int(closed[-1]["t"]) // 1000
                previous = self.state.get("last_evaluation") or {}
                if previous.get("strategy") == self.state["strategy_mode"] and int(previous.get("time", 0)) == last_candle:
                    return
                position_side = int(self.state["tranches"][-1]["side"]) if self.state["tranches"] else 0
                entry_price = float(self.state["tranches"][-1]["price"]) if self.state["tranches"] else 0.0
                _, side, _, evaluation = evaluate_strategy_signal(
                    self.state["strategy_mode"],
                    [float(row["c"]) for row in closed],
                    self.state,
                    hourly_histogram=self.state.get("hourly_histogram"),
                    five_minute_macd_signal=self.state.get("five_minute_macd_signal"),
                    evaluation_time=last_candle,
                    position_side=position_side,
                    entry_price=entry_price,
                    held_bars=0,
                )
                evaluation["entry_direction_mode"] = self.state.get("entry_direction_mode", "two_way")
                evaluation["entry_direction_allowed"] = entry_direction_allowed(
                    evaluation["entry_direction_mode"], side,
                )
                evaluation["execution_paused"] = True
                self.state["last_evaluation"] = evaluation
                self._save()
            except Exception as exc:
                logger.warning("Paused Lighter condition refresh failed: %s", exc)

    async def run_once(self) -> None:
        if self.state.get("native_brackets") or (self.state.get("use_native_protection") and self.state["tranches"]):
            async with self.lock:
                async with self.client.execution_lock:
                    try:
                        await self.reconcile_native_protection()
                        if not self.state.get("pending_order"):
                            await self.arm_native_protection()
                    except Exception as exc:
                        self.state.update(execution_blocked=True, blocked_reason=str(exc), last_error=str(exc))
                        self._save()
                        return
        if not self.state["enabled"]:
            await self._refresh_paused_condition_evaluation()
            return
        async with self.lock:
            if not self.state["enabled"]:
                return
            if self.state["pending_order"]:
                resolved, _ = await self._resolve_pending_order()
                if not resolved:
                    return
            symbol = self.state["selected_symbol"]
            interval = self.state["strategy_interval"]
            seconds = INTERVAL_SECONDS[interval]
            try:
                market_id, detail, step = await self._market(symbol)
                account, amount, positions = await self._account_position(symbol)
                mark_px = float(detail.get("mark_price", 0) or 0)
                min_base = float(detail.get("min_base_amount", 0) or 0)
                self._check_position(amount, step, mark_price=mark_px, min_base_amount=min_base)

                if self.state.get("recovery_required") and not self.state.get("pending_order"):
                    logger.info("Auto-clearing recovery_required: verified position with dust tolerance and no pending orders")
                    self.state.update(recovery_required=False, execution_blocked=False, blocked_reason=None, last_error=None)
                    self._save()

                if self.state.get("execution_blocked") and not self.state.get("recovery_required"):
                    if self.state.get("blocked_reason") and ("reconcil" in self.state["blocked_reason"].lower() or "dust" in self.state["blocked_reason"].lower()):
                        self.state["execution_blocked"] = False
                        self.state["blocked_reason"] = None
                        self._save()
                    else:
                        try:
                            _, ask = await self._book(market_id, enforce_spread=False)
                            qty = self._entry_quantity(self.state["notional_usd"], ask, detail)
                            self._check_entry_capacity(account, positions, qty * ask)
                            self.state["execution_blocked"] = False
                            self.state["blocked_reason"] = None
                            self._save()
                        except Exception as cap_err:
                            self.state["blocked_reason"] = str(cap_err)

                if self.state.get("use_native_protection"):
                    async with self.client.execution_lock:
                        await self.arm_native_protection()
                elif await self.check_net_exits():
                    return
                await self.refresh_hourly_histogram()
                await self.refresh_five_minute_macd_signal()
                required_bars = required_strategy_bars(self.state["strategy_mode"], self.state)
                request_limit = min(500, max(130, required_bars + 1))
                candle_options = {}
                if self.state["strategy_mode"] == "ma_proximity" and required_bars == 500:
                    candle_options["end_timestamp"] = (int(time.time()) // seconds * seconds) * 1000 - 1
                rows = await self.client.candles(market_id, interval, request_limit, fresh=True, **candle_options)
                now_ms = int(time.time() * 1000)
                closed = [row for row in rows if int(row["t"]) + seconds * 1000 <= now_ms - 1000]
                if len(closed) < required_bars:
                    raise ValueError("Insufficient completed Lighter candles")
                last_candle = int(closed[-1]["t"]) // 1000
                if last_candle <= self.state["last_evaluated_candle"]:
                    await self._continue_entry_campaign()
                    return
                if time.time() - (last_candle + seconds) > 30:
                    self.state["last_evaluated_candle"] = last_candle
                    self._save()
                    return
                values = [float(row["c"]) for row in closed]
                macro_alignment = None
                macro_candle_time = None
                macro_hourly_candle_time = None
                macro_detail: Dict[str, Any] = {}
                if (self.state["strategy_mode"] not in {"ou_quant", "macd_zero_cross", "macd_hist_turn", "ma_proximity"}
                        and self.state.get("use_ma_stack_1h", True)):
                    macro_mode = (str(self.state.get("macro_regime_mode", "ma_slope"))
                                  if self.state["strategy_mode"] in {"macd_reversal", "macd_strength_scaleout"}
                                  else "ma_slope")
                    if self.state["strategy_mode"] in {"macd_reversal", "macd_strength_scaleout"}:
                        ma_alignment = hourly_macro_alignment(
                            values, ma_period=int(self.state.get("macro_ma_period", 60)),
                        )
                        accel_alignment, macro_detail = macd_histogram_acceleration_alignment(
                            values,
                            fast_period=int(self.state.get("macro_macd_fast_period", 12)),
                            slow_period=int(self.state.get("macro_macd_slow_period", 26)),
                            signal_period=int(self.state.get("macro_macd_signal_period", 9)),
                            confirm_bars=int(self.state.get("macro_macd_confirm_bars", 2)),
                        )
                        macro_alignment = (accel_alignment if macro_mode == "macd_hist_accel" else
                                           (ma_alignment[0] and accel_alignment[0],
                                            ma_alignment[1] and accel_alignment[1])
                                           if macro_mode == "hybrid" else ma_alignment)
                        if macro_mode == "ma_slope":
                            macro_detail = {}
                        macro_candle_time = last_candle
                    else:
                        macro_required = int(self.state.get("macro_ma_period", 60)) + 1
                        macro_rows = await self.client.candles(
                            market_id, "1h", min(500, max(125, macro_required)), fresh=True,
                        )
                        macro_closed = [row for row in macro_rows
                                        if int(row["t"]) + 3600 * 1000 <= now_ms - 1000]
                        if len(macro_closed) < macro_required:
                            raise ValueError("Insufficient completed Lighter 1h candles for macro alignment")
                        ma_alignment = hourly_macro_alignment(
                            [float(row["c"]) for row in macro_closed],
                            ma_period=int(self.state.get("macro_ma_period", 60)),
                        )
                        macro_alignment = ma_alignment
                        macro_hourly_candle_time = int(macro_closed[-1]["t"]) // 1000
                        macro_candle_time = (last_candle if macro_mode == "hybrid"
                                             else macro_hourly_candle_time)
                position_side = int(self.state["tranches"][-1]["side"]) if self.state["tranches"] else 0
                entry_price = float(self.state["tranches"][-1]["price"]) if self.state["tranches"] else 0.0
                entry_time = int(self.state["tranches"][-1].get("time", 0)) if self.state["tranches"] else 0
                held_seconds = max(0, int(time.time()) - entry_time) if entry_time else 0
                held_bars = held_seconds // seconds if seconds else 0

                entry, side, exit_signal, evaluation = evaluate_strategy_signal(
                    self.state["strategy_mode"],
                    values,
                    self.state,
                    hourly_histogram=self.state.get("hourly_histogram"),
                    five_minute_macd_signal=self.state.get("five_minute_macd_signal"),
                    evaluation_time=last_candle,
                    position_side=position_side,
                    entry_price=entry_price,
                    held_bars=held_bars,
                    macro_alignment=macro_alignment,
                )
                direction_allowed = entry_direction_allowed(self.state.get("entry_direction_mode", "two_way"), side)
                evaluation["entry_direction_mode"] = self.state.get("entry_direction_mode", "two_way")
                evaluation["entry_direction_allowed"] = direction_allowed
                self.state["last_evaluation"] = evaluation
                if macro_candle_time is not None:
                    evaluation["macro_source"] = (
                        f"LIGHTER_COMPLETED_{interval.upper()}"
                        if self.state["strategy_mode"] in {"macd_reversal", "macd_strength_scaleout"}
                        else "LIGHTER_COMPLETED_1H"
                    )
                    evaluation["macro_candle_time"] = macro_candle_time
                    evaluation["macro_hourly_candle_time"] = macro_hourly_candle_time
                    evaluation["macro_ma_period"] = int(self.state.get("macro_ma_period", 60))
                    evaluation["macro_regime_mode"] = macro_mode
                    evaluation["macro_histogram"] = macro_detail.get("histogram")
                    evaluation["macro_histogram_zone"] = macro_detail.get("histogram_zone")
                    evaluation["macro_histogram_slope"] = macro_detail.get("histogram_slope")
                    evaluation["macro_acceleration_regime"] = macro_detail.get("regime")
                    evaluation["macro_macd_fast_period"] = int(self.state.get("macro_macd_fast_period", 12))
                    evaluation["macro_macd_slow_period"] = int(self.state.get("macro_macd_slow_period", 26))
                    evaluation["macro_macd_signal_period"] = int(self.state.get("macro_macd_signal_period", 9))
                self.state["last_evaluated_candle"] = last_candle
                self._save()
                if self.state["tranches"] and exit_signal:
                    self._finish_entry_campaign("strategy_exit")
                    reversing = bool(entry and direction_allowed and position_side * side < 0)
                    if (not reversing and self.state["strategy_mode"] == "macd_strength_scaleout"
                            and self.state.get("use_macd_two_stage_exit", True)
                            and int(self.state.get("macd_exit_stage", 0)) == 0):
                        fraction = float(self.state.get("macd_first_exit_pct", 50.0)) / 100.0
                        await self._submit(-int(self.state["tranches"][-1]["side"]), 0,
                                           reduce_only=True, reason="macd_first_peak_exit",
                                           reduce_fraction=fraction, exit_stage_after=1)
                    else:
                        await self._submit(-int(self.state["tranches"][-1]["side"]), 0,
                                           reduce_only=True,
                                           reason="opposite_signal_reversal" if reversing else "macd_final_peak_exit",
                                           exit_stage_after=0)
                        if reversing and not self.state["tranches"]:
                            self._start_entry_campaign(
                                side, last_candle, signal_values=values,
                                macro_alignment=macro_alignment, initial_reason="reversal_entry",
                            )
                            await self._continue_entry_campaign()
                elif entry and direction_allowed and has_entry_slot(self.state):
                    if self.state["strategy_mode"] == "macd_strength_scaleout" and self.state["tranches"]:
                        return
                    if position_side and position_side * side < 0:
                        self._finish_entry_campaign("opposite_signal")
                        if time.time() - self.state["last_order_time"] >= self.state["min_seconds_between_orders"]:
                            await self._submit(-position_side, 0, reduce_only=True,
                                               reason="opposite_signal_reversal")
                            if not self.state["tranches"]:
                                self._start_entry_campaign(
                                    side, last_candle, signal_values=values,
                                    macro_alignment=macro_alignment, initial_reason="reversal_entry",
                                )
                    else:
                        self._start_entry_campaign(
                            side, last_candle, signal_values=values,
                            macro_alignment=macro_alignment,
                        )
                await self._continue_entry_campaign()
            except Exception as exc:
                if not self.state["recovery_required"]:
                    self.state["last_error"] = str(exc)
                if "Selected-contract gross exposure" in str(exc) or "Available margin" in str(exc) or "collateral cap" in str(exc):
                    self.state["execution_blocked"] = True
                    self.state["blocked_reason"] = str(exc)
                elif "differs from the bot" in str(exc):
                    self.state.update(recovery_required=True, execution_blocked=True,
                                      blocked_reason=f"Inventory desync: {exc}")
                self._save()
