"""Independent, fail-closed Lighter perp executor for Tab 5.

Supports live execution for all testable quantitative single-leg strategies:
grid, ou_quant, ma_stack, multi_factor, trend_pullback, custom.
"""

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

from .crypto_bot import INTERVAL_SECONDS
from .lighter_strategy import (
    evaluate_strategy_signal,
    evaluate_grid_signals,
    LIVE_STRATEGIES,
    OU_MIN_ABS_DEVIATION_PP,
    OU_MACRO_EMA_SPAN,
    OU_MACRO_SLOPE_BARS,
    required_strategy_bars,
)


# Verified against Lighter's live perp market list. Market details are checked
# again before every order so a suspended market cannot be traded.
MARKETS = {"BTC": 1, "ETH": 0, "SOL": 2, "DOGE": 3, "XRP": 7}
DEFAULT_STATE = {
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
    "use_ma_stack_1h": True,
    "ma_stack_opposite_only": True, "use_opposite_stack_exit": True,
    "use_ma_diff_hook": True, "use_ma_diff_exit": True, "min_diff_bars": 2,
    "ma_accel_period": 24, "ma_accel_min_slope": 0.0, "ma_accel_min_accel": 0.0,
    "use_ma_slope": True, "use_ma_accel": True, "use_ma_pullback": True, "use_ma_cross_exit": True,
    "fast_ma_period": 9, "slow_ma_period": 21, "min_cross_spread_bps": 0.0,
    "use_golden_cross": True, "use_death_cross": True, "use_cross_spread": True, "use_cross_exit": True,
    "macd_fast_period": 12, "macd_slow_period": 26, "macd_signal_period": 9,
    "use_macd_signal_negative": True, "use_macd_hist_negative": True, "use_macd_hist_reversal": True,
    "use_macd_signal_positive": True, "use_macd_hist_positive": True, "use_macd_hist_reversal_exit": True,
    "use_macd_strength": True, "macd_strength_min_pct": 30.0,
    "use_macd_two_stage_exit": True, "macd_first_exit_pct": 50.0, "macd_exit_stage": 0,
    "long_multiplier": 1.0, "short_multiplier": 1.0,
    "use_convergence": True, "use_dwell": True, "use_bottoming": False, "base_spacing_pct": 0.2, "min_dwell_bars": 4,
    "tranches": [], "execution_history": [], "pending_order": None,
    "last_evaluated_candle": 0, "last_order_time": 0,
    "last_evaluation": None, "last_error": None, "recovery_required": False,
    "execution_blocked": False, "blocked_reason": None,
}


class LighterCryptoBot:
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
                          "use_macd_strength": bool(self.state.get("use_macd_strength", True)),
                          "macd_strength_min_pct": float(self.state.get("macd_strength_min_pct", 30.0)),
                          "use_macd_two_stage_exit": bool(self.state.get("use_macd_two_stage_exit", True)),
                          "macd_first_exit_pct": float(self.state.get("macd_first_exit_pct", 50.0)),
                          "macd_exit_stage": int(self.state.get("macd_exit_stage", 0)),
                      })
        result["gross_leverage_cap"] = float(self.state.get("gross_leverage_cap", self.GROSS_LEVERAGE_CAP))
        result["execution_blocked"] = bool(self.state.get("execution_blocked") or self.state.get("recovery_required") or self.state.get("pending_order"))
        result["blocked_reason"] = (self.state.get("blocked_reason") or self.state.get("last_error")) if result["execution_blocked"] else None
        result["can_execute_entry"] = bool(self.state.get("enabled") and not result["execution_blocked"])
        result["can_execute_exit"] = bool(self.state.get("enabled") and not self.state.get("recovery_required") and not self.state.get("pending_order"))
        return result

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
                        raw_trades = await self.client.account_trades(market_id, limit=100)
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
                            original_side = -side if is_exit else side
                            exchange_events.append({
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
                                "client_order_index": trade_id,
                                "status": "CLOSED" if is_exit else "OPEN",
                                "pnl_authoritative": is_exit,
                                "pnl_source": "LIGHTER_REALIZED_PNL" if is_exit else "ESTIMATED_EX_FUNDING",
                                "reason": "lighter_trade",
                            })
                    self._trade_cache = (symbol, now, 5.0, list(exchange_events))
                except Exception as exc:
                    logger.warning("Could not fetch Lighter trades for status reconciliation: %s", exc)
                    self._trade_cache = (symbol, now, 10.0, [])

        if exchange_events:
            # Merge with bot execution history by order_id
            seen_orders = {str(e.get("order_id")) for e in exchange_events}
            for local in result["execution_history"]:
                if str(local.get("order_id")) not in seen_orders:
                    exchange_events.append(local)
            exchange_events.sort(key=lambda e: int(e.get("time", 0)))
            result["execution_history"] = exchange_events[-500:]
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
            "selected_symbol", "strategy_mode", "strategy_interval", "entry_z", "exit_z",
            "notional_usd", "max_tranches", "min_seconds_between_orders", "max_book_spread_bps",
            "ou_halflife_max", "ou_stop_z", "ou_min_abs_deviation_pp",
            "ou_macro_ema_span", "ou_macro_slope_bars",
            "ou_use_entry_z", "ou_use_halflife", "ou_use_min_abs_deviation",
            "ou_use_macro_trend", "ou_use_stop_zone", "ou_use_exit_z",
            "ma_stretch_min", "ma_trailing_stop", "min_consensus_votes",
            "trend_macro_window", "trend_pullback_dist", "trend_tp_dist", "trend_slope_min",
            "ma_accel_period", "ma_accel_min_slope", "ma_accel_min_accel",
            "use_ma_slope", "use_ma_accel", "use_ma_pullback", "use_ma_cross_exit",
            "fast_ma_period", "slow_ma_period", "min_cross_spread_bps",
            "use_golden_cross", "use_death_cross", "use_cross_spread", "use_cross_exit",
            "macd_fast_period", "macd_slow_period", "macd_signal_period",
            "use_macd_signal_negative", "use_macd_hist_negative", "use_macd_hist_reversal",
            "use_macd_signal_positive", "use_macd_hist_positive", "use_macd_hist_reversal_exit",
            "use_macd_strength", "macd_strength_min_pct", "use_macd_two_stage_exit", "macd_first_exit_pct",
            "use_ma_stretch", "use_base_spacing", "use_peak", "use_ma_stack",
            "use_ma_stack_1h", "use_convergence", "use_dwell", "use_bottoming", "base_spacing_pct", "min_dwell_bars",
            "ma_stack_opposite_only", "use_opposite_stack_exit",
            "use_ma_diff_hook", "use_ma_diff_exit", "min_diff_bars",
            "long_multiplier", "short_multiplier", "gross_leverage_cap",
        }
        unknown = set(values) - permitted
        if unknown:
            raise ValueError(f"Unsupported live setting: {', '.join(sorted(unknown))}")
        candidate = dict(self.state)
        for key, value in values.items():
            if key in {"selected_symbol", "strategy_mode", "strategy_interval"}:
                candidate[key] = str(value)
            elif key in {"max_tranches", "min_seconds_between_orders", "ou_macro_ema_span",
                        "ou_macro_slope_bars", "min_consensus_votes", "trend_macro_window", "min_dwell_bars",
                        "ma_accel_period", "fast_ma_period", "slow_ma_period", "min_diff_bars",
                        "macd_fast_period", "macd_slow_period", "macd_signal_period"}:
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
                          "use_macd_signal_positive", "use_macd_hist_positive", "use_macd_hist_reversal_exit"}:
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
            "entry_z": (0.1, 10.0), "exit_z": (0.0, 5.0),
            "notional_usd": (10.0, 500.0), "max_tranches": (1, 5),
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
        if candidate["strategy_mode"] in {"macd_reversal", "macd_strength_scaleout"}:
            if candidate.get("macd_fast_period", 12) >= candidate.get("macd_slow_period", 26):
                raise ValueError("MACD slow period must be greater than MACD fast period")
        async with self.lock:
            if self.state["enabled"] and any(candidate[key] != self.state[key] for key in
                ("selected_symbol", "strategy_mode", "strategy_interval", "entry_z", "exit_z",
                 "notional_usd", "max_tranches", "ma_stretch_min", "min_consensus_votes", "trend_macro_window",
                 "macd_fast_period", "macd_slow_period", "macd_signal_period",
                 "use_macd_signal_negative", "use_macd_hist_negative", "use_macd_hist_reversal",
                 "use_macd_signal_positive", "use_macd_hist_positive", "use_macd_hist_reversal_exit",
                 "use_macd_strength", "macd_strength_min_pct", "use_macd_two_stage_exit", "macd_first_exit_pct")):
                raise ValueError("Pause the live bot before changing strategy or sizing")
            if self.state["tranches"] and candidate["selected_symbol"] != self.state["selected_symbol"]:
                raise ValueError("Close tracked inventory before changing symbol")
            if self.state["tranches"] and candidate["strategy_mode"] != self.state["strategy_mode"]:
                raise ValueError("Close tracked inventory before changing strategy")
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
                self.state["enabled"] = False
                self.state["execution_blocked"] = False
                self.state["blocked_reason"] = None
                self._save()
                return self.public_state()
            if self.state["pending_order"]:
                resolved, _ = await self._resolve_pending_order()
                if not resolved:
                    raise ValueError("Resolve Lighter execution recovery before enabling")
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
            closed = self.state["tranches"][-1] if self.state["tranches"] else None
            if closed:
                original_qty = float(closed["qty"])
                if filled >= original_qty - max(step / 2, original_qty * 0.00001):
                    self.state["tranches"].pop()
                else:
                    closed = dict(closed)
                    self.state["tranches"][-1]["qty"] = original_qty - filled
                    fee_share = float(closed.get("fee_usd", 0)) * filled / original_qty
                    self.state["tranches"][-1]["fee_usd"] = float(closed.get("fee_usd", 0)) - fee_share
                    closed["fee_usd"] = fee_share
                gross = int(closed["side"]) * filled * (price - float(closed["price"]))
                net = gross - float(closed.get("fee_usd", 0)) - event["fee_usd"]
                event.update(entry_price=closed["price"], entry_order_id=closed["order_id"],
                             original_side=closed["side"], gross_pnl_usd=gross,
                             net_pnl_usd=net, pnl_source="ESTIMATED_EX_FUNDING")
            else:
                event.update(entry_price=price, entry_order_id="external",
                             original_side=-side, gross_pnl_usd=0.0,
                             net_pnl_usd=-event["fee_usd"], pnl_source="ESTIMATED_EX_FUNDING")
        else:
            self.state["tranches"].append({"side": side, "qty": filled, "price": price,
                                            "fee_usd": event["fee_usd"],
                                            "order_id": event["order_id"], "time": event["time"]})
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

    async def _submit(self, side: int, notional: float, *, reduce_only: bool, reason: str,
                      signal_values: Optional[list[float]] = None,
                      reduce_fraction: float = 1.0, exit_stage_after: Optional[int] = None) -> Dict[str, Any]:
        async with self.client.execution_lock:
            symbol = self.state["selected_symbol"]
            market_id, detail, step = await self._market(symbol, fresh=True)
            account, amount, positions = await self._account_position(symbol)
            mark_px = float(detail.get("mark_price", 0) or 0)
            min_base = float(detail.get("min_base_amount", 0) or 0)
            self._check_position(amount, step, mark_price=mark_px, min_base_amount=min_base)
            bid, ask = await self._book(market_id, enforce_spread=not reduce_only)
            price = ask if side > 0 else bid
            if signal_values is not None and not reduce_only:
                valid, quote_side, _, _ = evaluate_strategy_signal(
                    self.state["strategy_mode"],
                    signal_values[:-1] + [price],
                    self.state,
                    evaluation_time=int(time.time()),
                    position_side=0,
                    entry_price=0.0,
                    held_bars=0,
                )
                if not valid or quote_side != side:
                    raise ValueError("Current Lighter quote no longer supports the candle entry signal")
            if reduce_only:
                if not self.state["tranches"] or amount * side >= 0:
                    raise ValueError("No bot-owned tranche can be reduced in that direction")
                owned_qty = float(self.state["tranches"][-1]["qty"])
                qty = math.floor((owned_qty * min(1.0, max(0.0, reduce_fraction))) / step) * step
                if qty < step:
                    qty = owned_qty
            else:
                if self.state["pending_order"] or self.state["recovery_required"]:
                    raise ValueError("Execution recovery required")
                if len(self.state["tranches"]) >= self.state["max_tranches"]:
                    raise ValueError("Tranche capacity reached")
                is_dust_pos = (abs(amount) * mark_px < self.DUST_NOTIONAL_THRESHOLD_USD) or (min_base > 0 and abs(amount) < min_base)
                if not is_dust_pos and amount and amount * side < 0:
                    raise ValueError("Cannot reverse an active campaign")
                mult = float(self.state.get("long_multiplier", 1.0)) if side > 0 else float(self.state.get("short_multiplier", 1.0))
                effective_notional = notional * max(0.1, mult)
                qty = self._entry_quantity(effective_notional, price, detail)
                self._check_entry_capacity(account, positions, qty * price)
            order_index = secrets.randbelow(self.client.MAX_CLIENT_ORDER_INDEX - 1) + 1
            pending = {"client_order_index": order_index, "symbol": symbol, "market_id": market_id,
                       "side": side, "qty": qty, "size_step": step,
                       "reduce_only": reduce_only, "reason": reason, "created_at": int(time.time())}
            if exit_stage_after is not None:
                pending["macd_exit_stage_after"] = int(exit_stage_after)
            self.state["pending_order"] = pending
            self._save()
            try:
                result = await self.client.create_market_order(
                    market_id, qty, price, is_ask=side < 0, reduce_only=reduce_only,
                    client_order_index=order_index)
                return self._record_fill(result, pending)
            except Exception as exc:
                self.state.update(recovery_required=True, execution_blocked=True,
                                  blocked_reason=f"Lighter order outcome uncertain; reconcile {order_index}: {exc}",
                                  last_error=f"Lighter order outcome uncertain; reconcile {order_index}: {exc}")
                self._save()
                raise

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
            self.state.update(recovery_required=False, execution_blocked=False, blocked_reason=None, last_error=None)
            self._save()
            return {"event": event, "bot": await self.reconciled_public_state()}

    async def verify_startup(self) -> None:
        if not self.state["enabled"] and not self.state["tranches"] and not self.state["pending_order"]:
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

    async def flatten(self) -> Dict[str, Any]:
        async with self.lock:
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

    async def run_once(self) -> None:
        if not self.state["enabled"]:
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

                required_bars = required_strategy_bars(self.state["strategy_mode"], self.state)
                request_limit = min(500, max(130, required_bars + 1))
                rows = await self.client.candles(market_id, interval, request_limit, fresh=True)
                now_ms = int(time.time() * 1000)
                closed = [row for row in rows if int(row["t"]) + seconds * 1000 <= now_ms - 1000]
                if len(closed) < required_bars:
                    raise ValueError("Insufficient completed Lighter candles")
                last_candle = int(closed[-1]["t"]) // 1000
                if last_candle <= self.state["last_evaluated_candle"]:
                    return
                if time.time() - (last_candle + seconds) > 30:
                    self.state["last_evaluated_candle"] = last_candle
                    self._save()
                    return
                values = [float(row["c"]) for row in closed]
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
                    if self.state["strategy_mode"] == "macd_strength_scaleout" and self.state.get("use_macd_two_stage_exit", True) and int(self.state.get("macd_exit_stage", 0)) == 0:
                        fraction = float(self.state.get("macd_first_exit_pct", 50.0)) / 100.0
                        await self._submit(-int(self.state["tranches"][-1]["side"]), 0,
                                           reduce_only=True, reason="macd_first_peak_exit",
                                           reduce_fraction=fraction, exit_stage_after=1)
                    else:
                        await self._submit(-int(self.state["tranches"][-1]["side"]), 0,
                                           reduce_only=True, reason="macd_final_peak_exit", exit_stage_after=0)
                elif entry and len(self.state["tranches"]) < self.state["max_tranches"]:
                    if self.state["strategy_mode"] == "macd_strength_scaleout" and self.state["tranches"]:
                        return
                    if time.time() - self.state["last_order_time"] >= self.state["min_seconds_between_orders"]:
                        if position_side and position_side * side < 0:
                            self.state["blocked_reason"] = "Opposite entry blocked: Active campaign must exit before reversing"
                            self._save()
                            return
                        await self._submit(side, self.state["notional_usd"], reduce_only=False,
                                           reason="closed_bar_signal", signal_values=values)
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
