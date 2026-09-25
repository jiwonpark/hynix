"""Causal, long-only quantitative strategy backtests used by the Strategy Lab UI."""

from __future__ import annotations

import asyncio
import copy
import uuid
from decimal import Decimal, ROUND_DOWN
from bisect import bisect_right
import json
import logging
import math
import os
from pathlib import Path
import time
from typing import Any, Dict, List, Optional, Tuple


MA_WINDOWS = (7, 24, 60, 200)
BB_WINDOW = 20
BB_STD = 2.0
RSI_PERIOD = 14
ATR_PERIOD = 14
OU_LOOKBACK = 48

STRATEGY_PRESETS = {
    "ma_stack": {
        "id": "ma_stack",
        "name": "📈 Dual MA Stack (Trend Dip)",
        "badge": "MA STACK",
        "desc": "Scales into dips on 5m & 1h Bearish MA Stack (Price < MA7 < MA24 < MA60); exits on Bullish rally.",
    },
    "bollinger_zscore": {
        "id": "bollinger_zscore",
        "name": "📊 Bollinger & Z-Score (Mean-Reversion)",
        "badge": "BOLLINGER / Z-SCORE",
        "desc": "Triggers when price pierces Lower BB or 24h Z-score <= -1.8 with ATR volatility expansion; exits at BB mean.",
    },
    "rsi_momentum": {
        "id": "rsi_momentum",
        "name": "⚡ RSI Momentum & Divergence",
        "badge": "RSI MOMENTUM",
        "desc": "Triggers on dual-timeframe oversold (5m RSI < 30 & 1h RSI < 45) or StochRSI hook; exits on momentum recovery.",
    },
    "multi_factor": {
        "id": "multi_factor",
        "name": "⚖️ Multi-Factor Voting Gate",
        "badge": "VOTING GATE (2-OF-3)",
        "desc": "Requires structural macro trend plus 2-of-3 micro dip votes (Z-score stretch, volume absorption, RSI oversold).",
    },
    "ou_quant": {
        "id": "ou_quant",
        "name": "🔬 Quant Ornstein-Uhlenbeck (SDE)",
        "badge": "OU SDE QUANT",
        "desc": "Calibrates continuous SDE drift equilibrium; enters when price is discounted >= 1.5σ from OU mean.",
    },
}


def _with_indicators(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Compute moving averages, Bollinger Bands, rolling Z-score, RSI, StochRSI, ATR, and OU statistics."""
    sorted_rows = sorted(rows, key=lambda r: int(r["time"]))
    if not sorted_rows:
        return []

    closes: List[float] = []
    highs: List[float] = []
    lows: List[float] = []
    volumes: List[float] = []

    # Moving average sums
    ma_sums = {w: 0.0 for w in MA_WINDOWS}
    bb_sum = 0.0
    bb_sum_sq = 0.0
    vol_sum = 0.0

    # RSI Wilder state
    avg_gain = 0.0
    avg_loss = 0.0
    rsi_history: List[float] = []

    # ATR Wilder state
    avg_tr = 0.0

    result: List[Dict[str, Any]] = []

    for i, raw in enumerate(sorted_rows):
        row = dict(raw)
        close = float(row["close"])
        high = float(row.get("high", close))
        low = float(row.get("low", close))
        vol = float(row.get("volume", 0.0) or 0.0)

        closes.append(close)
        highs.append(high)
        lows.append(low)
        volumes.append(vol)
        n = len(closes)

        # 1. Moving Averages (7, 24, 60, 200)
        for w in MA_WINDOWS:
            ma_sums[w] += close
            if n > w:
                ma_sums[w] -= closes[n - w - 1]
            row[f"ma{w}"] = ma_sums[w] / w if n >= w else None

        # 2. Moving Average Stacks (Bearish & Bullish)
        if row["ma60"] is not None:
            row["bullish"] = close > row["ma7"] > row["ma24"] > row["ma60"]
            row["bearish"] = close < row["ma7"] < row["ma24"] < row["ma60"]
        else:
            row["bullish"] = False
            row["bearish"] = False

        # 3. Bollinger Bands (20, 2.0)
        bb_sum += close
        bb_sum_sq += close * close
        if n > BB_WINDOW:
            old_c = closes[n - BB_WINDOW - 1]
            bb_sum -= old_c
            bb_sum_sq -= old_c * old_c

        if n >= BB_WINDOW:
            mean = bb_sum / BB_WINDOW
            var = max(0.0, (bb_sum_sq / BB_WINDOW) - (mean * mean))
            sigma = math.sqrt(var)
            row["bb_middle"] = mean
            row["bb_upper"] = mean + BB_STD * sigma
            row["bb_lower"] = mean - BB_STD * sigma
            row["bb_sigma"] = sigma
            band_width = row["bb_upper"] - row["bb_lower"]
            row["bb_pct_b"] = (close - row["bb_lower"]) / band_width if band_width > 0 else 0.5
        else:
            row["bb_middle"] = None
            row["bb_upper"] = None
            row["bb_lower"] = None
            row["bb_sigma"] = None
            row["bb_pct_b"] = None

        # 4. Volume SMA 20
        vol_sum += vol
        if n > 20:
            vol_sum -= volumes[n - 21]
        row["vol_sma20"] = vol_sum / 20 if n >= 20 else vol
        row["vol_ratio"] = (vol / row["vol_sma20"]) if row.get("vol_sma20", 0) > 0 else 1.0

        # 5. Wilder's RSI (14)
        if i == 0:
            row["rsi"] = 50.0
            rsi_history.append(50.0)
        else:
            change = close - closes[i - 1]
            gain = max(0.0, change)
            loss = max(0.0, -change)
            if i < RSI_PERIOD:
                avg_gain = ((avg_gain * (i - 1)) + gain) / i
                avg_loss = ((avg_loss * (i - 1)) + loss) / i
                row["rsi"] = 50.0
            else:
                if i == RSI_PERIOD:
                    avg_gain = ((avg_gain * (RSI_PERIOD - 1)) + gain) / RSI_PERIOD
                    avg_loss = ((avg_loss * (RSI_PERIOD - 1)) + loss) / RSI_PERIOD
                else:
                    avg_gain = (avg_gain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD
                    avg_loss = (avg_loss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD

                if avg_loss == 0.0 and avg_gain == 0.0:
                    row["rsi"] = 50.0
                elif avg_loss == 0.0:
                    row["rsi"] = 100.0
                else:
                    rs = avg_gain / avg_loss
                    row["rsi"] = 100.0 - (100.0 / (1.0 + rs))
            rsi_history.append(row["rsi"])

        # 6. Stochastic RSI (14, 3)
        if len(rsi_history) >= 14:
            slice_rsi = rsi_history[-14:]
            min_rsi = min(slice_rsi)
            max_rsi = max(slice_rsi)
            stoch = ((row["rsi"] - min_rsi) / (max_rsi - min_rsi) * 100.0) if (max_rsi - min_rsi) > 0 else 50.0
            row["stoch_k"] = stoch
        else:
            row["stoch_k"] = 50.0

        # 7. Wilder's ATR (14)
        if i == 0:
            tr = high - low
            avg_tr = tr
            row["atr"] = tr
        else:
            prev_c = closes[i - 1]
            tr = max(high - low, abs(high - prev_c), abs(low - prev_c))
            if i < ATR_PERIOD:
                avg_tr = ((avg_tr * (i - 1)) + tr) / i
            else:
                avg_tr = (avg_tr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD
            row["atr"] = avg_tr

        # 8. Rolling Z-Score (vs 48-bar VWAP / SMA)
        lookback_z = min(n, 48)
        slice_c = closes[-lookback_z:]
        slice_v = volumes[-lookback_z:]
        sum_pv = sum(c * v for c, v in zip(slice_c, slice_v))
        sum_v = sum(slice_v)
        vwap = (sum_pv / sum_v) if sum_v > 0 else (sum(slice_c) / lookback_z)
        mean_c = sum(slice_c) / lookback_z
        std_c = math.sqrt(max(1e-8, sum((c - mean_c) ** 2 for c in slice_c) / lookback_z))
        row["vwap"] = vwap
        row["z_score"] = (close - vwap) / std_c if std_c > 0 else 0.0

        # 9. Ornstein-Uhlenbeck (OU) Mean-Reversion Metric
        if n >= OU_LOOKBACK:
            ou_slice = closes[-OU_LOOKBACK:]
            x_prev = ou_slice[:-1]
            x_curr = ou_slice[1:]
            m_prev = sum(x_prev) / len(x_prev)
            m_curr = sum(x_curr) / len(x_curr)
            cov = sum((p - m_prev) * (c - m_curr) for p, c in zip(x_prev, x_curr))
            var_p = sum((p - m_prev) ** 2 for p in x_prev)
            b = (cov / var_p) if var_p > 1e-8 else 1.0
            if 0.01 < b < 0.999:
                a = m_curr - b * m_prev
                mu_ou = a / (1.0 - b)
                res_var = max(1e-8, sum((c - (a + b * p)) ** 2 for p, c in zip(x_prev, x_curr)) / len(x_prev))
                sigma_ou = math.sqrt(res_var / max(1e-4, 1.0 - b * b))
                row["ou_mu"] = mu_ou
                row["ou_z"] = (close - mu_ou) / sigma_ou if sigma_ou > 0 else 0.0
            else:
                row["ou_mu"] = mean_c
                row["ou_z"] = (close - mean_c) / std_c if std_c > 0 else 0.0

            # Autocorrelation of returns
            lookback_rets = min(24, n - 1)
            rets = [(closes[k] / closes[k - 1]) - 1.0 for k in range(n - lookback_rets, n)]
            if len(rets) >= 4:
                r_prev = rets[:-1]
                r_curr = rets[1:]
                m_rp = sum(r_prev) / len(r_prev)
                m_rc = sum(r_curr) / len(r_curr)
                cov_r = sum((p - m_rp) * (c - m_rc) for p, c in zip(r_prev, r_curr))
                var_r = math.sqrt(max(1e-8, sum((p - m_rp) ** 2 for p in r_prev) * sum((c - m_rc) ** 2 for c in r_curr)))
                rho1 = (cov_r / var_r) if var_r > 1e-8 else 0.0
                row["p_reversion"] = max(0.15, min(0.95, 0.50 - 1.2 * rho1))
            else:
                row["p_reversion"] = 0.50
        else:
            row["ou_mu"] = None
            row["ou_z"] = None
            row["p_reversion"] = 0.50

        result.append(row)
    return result


def evaluate_strategy_signals(
    strategy_mode: str,
    bar: Dict[str, Any],
    hourly: Dict[str, Any],
    **options: Any,
) -> tuple[bool, bool, str]:
    """Evaluate entry and exit conditions causally for the given strategy mode."""
    close = float(bar["close"])
    z_score = float(bar["z_score"]) if bar.get("z_score") is not None else 0.0
    rsi_5m = float(bar["rsi"]) if bar.get("rsi") is not None else 50.0
    rsi_1h = float(hourly["rsi"]) if hourly.get("rsi") is not None else 50.0
    bb_lower = bar.get("bb_lower")
    bb_mid = bar.get("bb_middle")
    bb_upper = bar.get("bb_upper")
    stoch_k = float(bar["stoch_k"]) if bar.get("stoch_k") is not None else 50.0
    ou_z = float(bar["ou_z"]) if bar.get("ou_z") is not None else 0.0
    p_rev = float(bar["p_reversion"]) if bar.get("p_reversion") is not None else 0.50
    vol_ratio = float(bar["vol_ratio"]) if bar.get("vol_ratio") is not None else 1.0
    atr = float(bar["atr"]) if bar.get("atr") is not None else 1.0
    candle_range = float(bar.get("high", close)) - float(bar.get("low", close))

    if strategy_mode == "bollinger_zscore":
        # Framework 1: Statistical Mean-Reversion & Volatility Bands
        use_z = options.get("entry_zscore", options.get("entry_z_extreme", True))
        use_bb = options.get("entry_bb_pierce", options.get("entry_bb_lower", True))
        use_atr = options.get("entry_atr_filter", True)

        is_bb_pierce = (bb_lower is not None) and (float(bar.get("low", close)) <= bb_lower) and (close > bb_lower)
        is_z_extreme = z_score <= -1.8
        has_volatility = (candle_range >= (0.6 * atr)) if (use_atr and atr > 0) else True

        entry_candidates = []
        if use_z and is_z_extreme:
            entry_candidates.append(True)
        if use_bb and is_bb_pierce:
            entry_candidates.append(True)
        should_enter = bool(entry_candidates) and has_volatility

        use_exit_mid = options.get("exit_bb_middle", True)
        use_exit_z = options.get("exit_z_extreme", options.get("exit_z_score", True))
        use_exit_stack = options.get("exit_bullish_stack", True)

        exit_candidates = []
        if use_exit_mid and bb_mid is not None and close >= bb_mid:
            exit_candidates.append(True)
        if use_exit_z and z_score >= 0.5:
            exit_candidates.append(True)
        if use_exit_stack and (bool(bar.get("bullish")) or bool(hourly.get("bullish"))):
            exit_candidates.append(True)
        should_exit = bool(exit_candidates)
        reason = "Z-Score <= -1.8 / Lower BB Pierce" if should_enter else ("BB Mean / Upper Reversion" if should_exit else "")

    elif strategy_mode == "rsi_momentum":
        # Framework 2: Momentum Deceleration & Exhaustion
        use_rsi_dual = options.get("entry_rsi_dual", options.get("entry_5m", True))
        use_stoch_hook = options.get("entry_stoch_hook", True)

        is_rsi_oversold = (rsi_5m < 30.0) and (rsi_1h < 45.0)
        is_stoch_hook = (stoch_k < 20.0) and (rsi_5m < 35.0)

        entry_candidates = []
        if use_rsi_dual and is_rsi_oversold:
            entry_candidates.append(True)
        if use_stoch_hook and is_stoch_hook:
            entry_candidates.append(True)
        should_enter = bool(entry_candidates)

        use_exit_rsi = options.get("exit_rsi_5m", True)
        use_exit_stoch = options.get("exit_stoch_k", True)
        use_exit_stack = options.get("exit_bullish_stack", True)

        exit_candidates = []
        if use_exit_rsi and rsi_5m >= 60.0:
            exit_candidates.append(True)
        if use_exit_stoch and stoch_k >= 80.0:
            exit_candidates.append(True)
        if use_exit_stack and (bool(bar.get("bullish")) or bool(hourly.get("bullish"))):
            exit_candidates.append(True)
        should_exit = bool(exit_candidates)
        reason = "5m/1h RSI Oversold (<30/45)" if should_enter else ("RSI Overbought (>60)" if should_exit else "")

    elif strategy_mode == "multi_factor":
        # Framework 3: Multi-Factor Voting Gate (Macro + 2-of-3 Micro)
        use_macro = options.get("entry_macro_1h", True)
        macro_pass = ((rsi_1h >= 35.0) or (hourly.get("ma24") is not None and close >= float(hourly["ma24"]))) if use_macro else True

        use_v_stretch = options.get("entry_micro_stretch", True)
        use_v_vol = options.get("entry_micro_volume", True)
        use_v_rsi = options.get("entry_micro_rsi", True)

        vote_stretch = (z_score <= -1.4 or (bb_lower is not None and close <= bb_lower * 1.002)) if use_v_stretch else False
        vote_vol = (vol_ratio >= 1.3) if use_v_vol else False
        vote_rsi = (rsi_5m <= 35.0 or stoch_k <= 25.0) if use_v_rsi else False
        micro_votes = sum([vote_stretch, vote_vol, vote_rsi])

        should_enter = macro_pass and (micro_votes >= 2)

        use_exit_rsi = options.get("exit_rsi_65", True)
        use_exit_bb = options.get("exit_bb_upper", True)
        use_exit_stack = options.get("exit_bullish_stack", True)

        exit_candidates = []
        if use_exit_rsi and rsi_5m >= 65.0:
            exit_candidates.append(True)
        if use_exit_bb and bb_upper is not None and close >= bb_upper:
            exit_candidates.append(True)
        if use_exit_stack and bool(bar.get("bullish")):
            exit_candidates.append(True)
        should_exit = bool(exit_candidates)
        reason = f"Voting Gate PASS ({micro_votes}/3 votes)" if should_enter else ("Multi-Factor Exit" if should_exit else "")

    elif strategy_mode == "ou_quant":
        # Framework 4: Quantitative Ornstein-Uhlenbeck SDE
        use_ou = options.get("entry_ou_spread", True)
        use_prev = options.get("entry_p_reversion", True)

        is_ou_discount = (ou_z <= -1.5) if use_ou else True
        is_rev_regime = (p_rev >= 0.55) if use_prev else True
        should_enter = is_ou_discount and is_rev_regime

        use_exit_mean = options.get("exit_ou_mean", True)
        use_exit_stack = options.get("exit_bullish_stack", True)

        exit_candidates = []
        if use_exit_mean and ou_z >= 0.0:
            exit_candidates.append(True)
        if use_exit_stack and (bool(bar.get("bullish")) or bool(hourly.get("bullish"))):
            exit_candidates.append(True)
        should_exit = bool(exit_candidates)
        reason = f"OU Discount ({ou_z:.2f}σ, P_rev {p_rev:.2f})" if should_enter else ("OU Mean Target" if should_exit else "")

    else:
        # Framework 5: Dual MA Stack (or Custom Checkboxes)
        entry_5m = options.get("entry_5m", options.get("entry_ma_stack_5m", True))
        entry_1h = options.get("entry_1h", options.get("entry_ma_stack_1h", True))
        exit_5m = options.get("exit_5m", options.get("exit_ma_stack_5m", True))
        exit_1h = options.get("exit_1h", options.get("exit_ma_stack_1h", True))

        enabled_entries = []
        if entry_5m:
            enabled_entries.append(bool(bar.get("bearish")))
        if entry_1h:
            enabled_entries.append(bool(hourly.get("bearish")))
        should_enter = bool(enabled_entries) and all(enabled_entries)

        enabled_exits = []
        if exit_5m:
            enabled_exits.append(bool(bar.get("bullish")))
        if exit_1h:
            enabled_exits.append(bool(hourly.get("bullish")))
        should_exit = bool(enabled_exits) and any(enabled_exits)
        reason = "Bearish MA Stack (Dip)" if should_enter else ("Bullish MA Stack (Rally)" if should_exit else "")

    return should_enter, should_exit, reason


def run_ma_stack_backtest(
    candles_5m: List[Dict[str, Any]],
    candles_1h: List[Dict[str, Any]],
    *,
    strategy_mode: str = "ma_stack",
    fee_bps: float = 5.0,
    initial_capital_krw: float = 10_000_000.0,
    max_tranches: int = 5,
    **options: Any,
) -> Dict[str, Any]:
    """Backtest quantitative strategy framework with multi-tranche LIFO queue.

    Signals are evaluated at candle close and filled at the next 5-minute open.
    Dip entry scales in up to max_tranches; rally exit pops tranches in LIFO order.
    """
    bars = _with_indicators(candles_5m)
    hours = _with_indicators(candles_1h)
    hour_times = [int(row["time"]) + 3600 for row in hours]
    fee_rate = max(0.0, float(fee_bps)) / 10_000.0
    cash = float(initial_capital_krw)
    tranche_capital = initial_capital_krw / float(max(1, max_tranches))
    tranche_stack: List[Dict[str, Any]] = []
    trades: List[Dict[str, Any]] = []
    markers: List[Dict[str, Any]] = []
    equity_curve: List[Dict[str, float]] = []
    total_fees = 0.0

    mode = strategy_mode if strategy_mode in STRATEGY_PRESETS else "ma_stack"

    def hour_at(timestamp: int) -> Optional[Dict[str, Any]]:
        index = bisect_right(hour_times, timestamp) - 1
        return hours[index] if index >= 0 else None

    def is_warmed_up(b: Dict[str, Any], h: Dict[str, Any]) -> bool:
        if mode == "ma_stack":
            return b.get("ma60") is not None and h.get("ma60") is not None
        if mode == "bollinger_zscore":
            return b.get("bb_lower") is not None and h.get("bb_lower") is not None
        if mode == "rsi_momentum":
            return b.get("rsi") is not None and h.get("rsi") is not None
        if mode == "multi_factor":
            return b.get("bb_lower") is not None and h.get("rsi") is not None
        if mode == "ou_quant":
            return b.get("ou_z") is not None
        return b.get("ma60") is not None and h.get("ma60") is not None

    for index, bar in enumerate(bars):
        close = float(bar["close"])
        open_quantity = sum(t["quantity"] for t in tranche_stack)
        current_equity = cash + open_quantity * close
        equity_curve.append({"time": int(bar["time"]), "value": current_equity})
        if index + 1 >= len(bars):
            continue
        hourly = hour_at(int(bar["time"]) + 300)
        if hourly is None or not is_warmed_up(bar, hourly):
            continue
        next_bar = bars[index + 1]
        fill_price = float(next_bar["open"])
        if fill_price <= 0:
            continue

        should_enter, should_exit, reason = evaluate_strategy_signals(
            mode, bar, hourly,
            **options,
        )

        if should_exit and tranche_stack:
            popped = tranche_stack.pop()
            gross = popped["quantity"] * fill_price
            exit_fee = gross * fee_rate
            cash += gross - exit_fee
            total_fees += exit_fee
            net_pnl = gross - exit_fee - popped["capital_before"]
            net_return = (net_pnl / popped["capital_before"]) * 100.0
            trade = {
                "id": popped["id"],
                "entry_time": popped["time"],
                "exit_time": int(next_bar["time"]),
                "entry_price": popped["price"],
                "exit_price": fill_price,
                "quantity": popped["quantity"],
                "net_return_pct": net_return,
                "pnl_krw": net_pnl,
                "fees_krw": popped["fee"] + exit_fee,
            }
            trades.append(trade)
            if popped.get("marker_index") is not None and popped["marker_index"] < len(markers):
                entry_marker = markers[popped["marker_index"]]
                entry_marker["exit_price"] = fill_price
                entry_marker["exit_time"] = int(next_bar["time"])
                entry_marker["net_return_pct"] = net_return
            markers.append({
                "time": int(next_bar["time"]),
                "source": "virtual",
                "hypothetical": True,
                "backtest": True,
                "is_entry": False,
                "action": "exit",
                "direction": "long",
                "position": "aboveBar",
                "shape": "arrowDown",
                "color": "#dc2626",
                "entry_price": popped["price"],
                "exit_price": fill_price,
                "net_return_pct": net_return,
                "hoverText": f"SELL {popped['id']} ₩{fill_price:,.0f} · {net_return:+.2f}% net",
            })
        elif should_enter and len(tranche_stack) < max_tranches and cash >= tranche_capital * 0.95:
            alloc_cash = min(cash, tranche_capital)
            entry_fee = alloc_cash * fee_rate
            spendable = alloc_cash - entry_fee
            qty = spendable / fill_price
            total_fees += entry_fee
            cash -= alloc_cash
            tranche_id = f"T{len(tranche_stack) + 1}"
            tranche = {
                "id": tranche_id,
                "time": int(next_bar["time"]),
                "price": fill_price,
                "quantity": qty,
                "fee": entry_fee,
                "capital_before": alloc_cash,
                "marker_index": len(markers),
            }
            entry_marker = {
                "time": int(next_bar["time"]),
                "source": "virtual",
                "hypothetical": True,
                "backtest": True,
                "is_entry": True,
                "action": "entry",
                "direction": "long",
                "position": "belowBar",
                "shape": "arrowUp",
                "color": "#16a34a",
                "entry_price": fill_price,
                "hoverText": f"BUY {tranche_id} ₩{fill_price:,.0f}",
            }
            markers.append(entry_marker)
            tranche_stack.append(tranche)

    last_close = float(bars[-1]["close"]) if bars else 0.0
    open_quantity = sum(t["quantity"] for t in tranche_stack)
    ending_equity = cash + open_quantity * last_close
    values = [point["value"] for point in equity_curve]
    peak = 0.0
    max_drawdown = 0.0
    for value in values:
        peak = max(peak, value)
        if peak:
            max_drawdown = min(max_drawdown, (value / peak - 1.0) * 100.0)
    completed = len(trades)
    wins = sum(1 for trade in trades if trade["net_return_pct"] > 0)
    buy_hold = ((last_close / float(bars[0]["open"]) - 1.0) * 100.0) if bars and bars[0]["open"] else 0.0

    active_stack_serialized = []
    for idx, t in enumerate(reversed(tranche_stack)):
        unrealized_pnl = (t["quantity"] * last_close * (1.0 - fee_rate)) - t["capital_before"]
        unrealized_ret = (unrealized_pnl / t["capital_before"]) * 100.0 if t["capital_before"] else 0.0
        active_stack_serialized.append({
            "id": t["id"],
            "index": len(tranche_stack) - 1 - idx,
            "time": t["time"],
            "entry_price": t["price"],
            "quantity": t["quantity"],
            "capital_before": t["capital_before"],
            "unrealized_pnl_krw": unrealized_pnl,
            "unrealized_return_pct": unrealized_ret,
        })

    preset = STRATEGY_PRESETS.get(mode, STRATEGY_PRESETS["ma_stack"])

    return {
        "strategy": mode,
        "strategy_name": preset["name"],
        "strategy_badge": preset["badge"],
        "strategy_desc": preset["desc"],
        "presets": list(STRATEGY_PRESETS.values()),
        "bars": bars,
        "hourly": hours,
        "markers": markers,
        "trades": trades,
        "active_tranche_stack": active_stack_serialized,
        "open_position": tranche_stack[-1] if tranche_stack else None,
        "capacity": {
            "max_tranches": max_tranches,
            "active_tranches": len(tranche_stack),
            "remaining_tranches": max(0, max_tranches - len(tranche_stack)),
            "tranche_capital_krw": tranche_capital,
            "free_cash_krw": cash,
            "invested_capital_krw": initial_capital_krw - cash,
            "open_quantity_btc": open_quantity,
        },
        "stats": {
            "initial_capital_krw": initial_capital_krw,
            "ending_equity_krw": ending_equity,
            "net_return_pct": (ending_equity / initial_capital_krw - 1.0) * 100.0,
            "buy_hold_pct": buy_hold,
            "max_drawdown_pct": max_drawdown,
            "completed_trades": completed,
            "win_rate_pct": (wins / completed * 100.0) if completed else 0.0,
            "total_fees_krw": total_fees,
        },
    }


logger = logging.getLogger("skhynix-daemon")
LAB_STATE_FILE = Path(__file__).parent / "strategy_lab_state.json"


class UpbitStrategyExecutionEngine:
    """
    Automated execution engine for Strategy Lab.
    Supports real-time spot trading on Upbit or simulated paper execution for
    whichever quantitative strategy is selected (Dual MA Stack, Bollinger/Z-score,
    RSI Momentum, Multi-Factor Gate, Quant OU SDE).
    """

    def __init__(self, state_file: Optional[Path] = None):
        self.state_file = state_file or LAB_STATE_FILE
        self._lock: Optional[asyncio.Lock] = None

    @property
    def lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def _default_state(self) -> Dict[str, Any]:
        return {
            "enabled": False,
            "mode": "paper",  # 'paper' or 'live'
            "active_strategy": "multi_factor",
            "strategy_options": {},
            "market": "KRW-BTC",
            "tranche_size_krw": 2000000.0,
            "max_tranches": 5,
            "min_profit_pct": 0.20,
            "active_tranches": [],
            "trade_history": [],
            "pending_order": None,
            "last_entry_bar_time": 0,
            "last_exit_bar_time": 0,
            "last_eval_time": 0,
            "last_signal": None,
            "last_error": None,
            "created_at": time.time(),
            "updated_at": time.time(),
        }

    def load_state(self) -> Dict[str, Any]:
        if not self.state_file.exists():
            state = self._default_state()
            self.save_state(state)
            return state
        try:
            with open(self.state_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if not isinstance(data, dict):
                    raise ValueError("Strategy Lab state must be an object")
                defaults = self._default_state()
                for k, v in defaults.items():
                    if k not in data:
                        data[k] = v
                return data
        except Exception as e:
            logger.error(f"Error loading strategy_lab_state: {e}")
            raise RuntimeError("Cannot read Strategy Lab state; execution blocked") from e

    def save_state(self, state: Dict[str, Any]) -> None:
        state["updated_at"] = time.time()
        try:
            tmp_file = self.state_file.with_suffix(".tmp")
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=2, ensure_ascii=False, allow_nan=False)
                f.flush()
                os.fsync(f.fileno())
            tmp_file.replace(self.state_file)
            try:
                directory_fd = os.open(str(self.state_file.parent), os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        except Exception as e:
            logger.error(f"Error saving strategy_lab_state: {e}")
            raise

    def get_status(self, current_price: Optional[float] = None) -> Dict[str, Any]:
        state = self.load_state()
        active_strategy = state.get("active_strategy", "multi_factor")
        preset = STRATEGY_PRESETS.get(active_strategy, STRATEGY_PRESETS["multi_factor"])

        tranches = state.get("active_tranches", [])
        fee_rate = 0.0005  # 5 bps standard taker

        total_invested = 0.0
        total_coin_qty = 0.0
        total_unrealized_pnl = 0.0

        enriched_tranches = []
        for idx, t in enumerate(tranches):
            entry_price = float(t.get("entry_price", 0.0))
            coin_qty = float(t.get("coin_qty", 0.0))
            entry_notional = float(t.get("entry_notional_krw", entry_price * coin_qty))
            total_invested += entry_notional
            total_coin_qty += coin_qty

            pnl_krw = 0.0
            ret_pct = 0.0
            if current_price and current_price > 0 and entry_notional > 0:
                cur_val = coin_qty * current_price * (1.0 - fee_rate)
                pnl_krw = cur_val - entry_notional
                ret_pct = (pnl_krw / entry_notional) * 100.0
                total_unrealized_pnl += pnl_krw

            enriched = dict(t)
            enriched["index"] = idx + 1
            enriched["current_price"] = current_price
            enriched["unrealized_pnl_krw"] = round(pnl_krw, 2)
            enriched["unrealized_return_pct"] = round(ret_pct, 2)
            enriched_tranches.append(enriched)

        history = state.get("trade_history", [])
        total_trades = len(history)
        win_trades = sum(1 for tr in history if tr.get("net_pnl_krw", 0) > 0)
        loss_trades = sum(1 for tr in history if tr.get("net_pnl_krw", 0) <= 0)
        realized_pnl = sum(tr.get("net_pnl_krw", 0.0) for tr in history)
        win_rate = (win_trades / total_trades * 100.0) if total_trades > 0 else 0.0

        return {
            "enabled": bool(state.get("enabled", False)),
            "mode": state.get("mode", "paper"),
            "active_strategy": active_strategy,
            "strategy_name": preset["name"],
            "strategy_badge": preset["badge"],
            "strategy_desc": preset["desc"],
            "strategy_options": state.get("strategy_options", {}),
            "market": state.get("market", "KRW-BTC"),
            "tranche_size_krw": float(state.get("tranche_size_krw", 2000000.0)),
            "max_tranches": int(state.get("max_tranches", 5)),
            "min_profit_pct": float(state.get("min_profit_pct", 0.20)),
            "active_tranches_count": len(tranches),
            "remaining_tranches": max(0, int(state.get("max_tranches", 5)) - len(tranches)),
            "total_invested_krw": round(total_invested, 2),
            "total_coin_qty": round(total_coin_qty, 8),
            "total_unrealized_pnl_krw": round(total_unrealized_pnl, 2),
            "active_tranches": list(reversed(enriched_tranches)),  # LIFO order
            "recent_trades": list(reversed(history[-30:])),
            "last_signal": state.get("last_signal"),
            "last_error": state.get("last_error"),
            "last_eval_time": state.get("last_eval_time", 0),
            "pending_order": ({k: v for k, v in state["pending_order"].items()
                               if k != "original_tranches"} if state.get("pending_order") else None),
            "stats": {
                "total_trades": total_trades,
                "winning_trades": win_trades,
                "losing_trades": loss_trades,
                "win_rate_pct": round(win_rate, 2),
                "realized_pnl_krw": round(realized_pnl, 2),
            },
        }

    async def set_strategy(self, strategy: str, options: Optional[Dict[str, Any]] = None, enable: Optional[bool] = None) -> Dict[str, Any]:
        async with self.lock:
            state = self.load_state()
            if strategy in STRATEGY_PRESETS:
                state["active_strategy"] = strategy
            if options is not None:
                state["strategy_options"] = options
            if enable and state.get("pending_order"):
                raise ValueError("Resolve pending order before enabling trading")
            if enable:
                self._validate_inventory(state)
            if enable is not None:
                state["enabled"] = bool(enable)
            self.save_state(state)
            return self.get_status()

    @staticmethod
    def _validate_inventory(state: Dict[str, Any]) -> None:
        if state.get("mode") not in ("paper", "live"):
            raise ValueError("Invalid execution mode")
        if any(t.get("mode") != state["mode"] or t.get("market") != state["market"]
               for t in state["active_tranches"]):
            raise ValueError("Position mode/market mismatch; reconcile inventory before trading")

    async def set_mode(self, mode: str, enable: Optional[bool] = None,
                       strategy: Optional[str] = None, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        async with self.lock:
            state = self.load_state()
            if mode not in ("paper", "live"):
                raise ValueError("Mode must be paper or live")
            if mode != state["mode"] and (state["active_tranches"] or state.get("pending_order")):
                raise ValueError("Close positions and resolve pending orders before switching modes")
            state["mode"] = mode
            self._validate_inventory(state)
            if strategy is not None:
                if strategy not in STRATEGY_PRESETS:
                    raise ValueError("Unknown strategy")
                state["active_strategy"] = strategy
            if options is not None:
                state["strategy_options"] = options
            if enable and state.get("pending_order"):
                raise ValueError("Resolve pending order before enabling trading")
            if enable:
                self._validate_inventory(state)
            if enable is not None:
                state["enabled"] = bool(enable)
            self.save_state(state)
            return self.get_status()

    async def set_sizing(
        self,
        tranche_size_krw: Optional[float] = None,
        max_tranches: Optional[int] = None,
        min_profit_pct: Optional[float] = None,
    ) -> Dict[str, Any]:
        async with self.lock:
            state = self.load_state()
            if tranche_size_krw is not None:
                if not math.isfinite(float(tranche_size_krw)) or float(tranche_size_krw) < 5000:
                    raise ValueError("Tranche size must be at least 5000 KRW")
                state["tranche_size_krw"] = float(tranche_size_krw)
            if max_tranches is not None:
                if int(max_tranches) != max_tranches or not 1 <= max_tranches <= 20:
                    raise ValueError("Max tranches must be an integer between 1 and 20")
                state["max_tranches"] = int(max_tranches)
            if min_profit_pct is not None:
                if not math.isfinite(float(min_profit_pct)) or float(min_profit_pct) < 0:
                    raise ValueError("Minimum net profit must be nonnegative")
                state["min_profit_pct"] = float(min_profit_pct)
            self.save_state(state)
            return self.get_status()

    async def toggle_enabled(self, enabled: Optional[bool] = None) -> Dict[str, Any]:
        async with self.lock:
            state = self.load_state()
            if enabled is None:
                state["enabled"] = not bool(state.get("enabled", False))
            else:
                state["enabled"] = bool(enabled)
            if state["enabled"]:
                self._validate_inventory(state)
                if state.get("pending_order"):
                    raise ValueError("Resolve pending order before enabling trading")
            self.save_state(state)
            return self.get_status()

    async def clear_history(self) -> Dict[str, Any]:
        async with self.lock:
            state = self.load_state()
            if state.get("pending_order"):
                raise ValueError("Resolve pending order before clearing history")
            state["trade_history"] = []
            self.save_state(state)
            return self.get_status()

    @staticmethod
    def _volume(quantity: float) -> str:
        # Never round up a sell beyond the tracked holding.
        return str(Decimal(str(quantity)).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN))

    @staticmethod
    def _exit_record(tranche, qty, funds, fee, pending):
        cost = float(tranche["entry_notional_krw"]) * qty / float(tranche["coin_qty"])
        net = funds - fee - cost
        return {
            "id": tranche["id"], "strategy": tranche["strategy"], "mode": tranche["mode"],
            "entry_time": tranche["entry_time"], "exit_time": pending["time"],
            "entry_price": tranche["entry_price"], "exit_price": funds / qty,
            "coin_qty": qty, "entry_notional_krw": cost, "exit_notional_krw": funds - fee,
            "gross_pnl_krw": funds - cost, "net_pnl_krw": net,
            "net_return_pct": net / cost * 100 if cost else 0,
            "hold_seconds": pending["time"] - tranche["entry_time"],
            "exit_reason": pending["kind"], "upbit_uuid": tranche.get("upbit_uuid"),
            "exit_upbit_uuid": pending.get("uuid"), "order_identifier": pending["identifier"],
        }

    def _apply_fill(self, state, pending, fill):
        """Rebuild this order's accounting from its durable pre-order snapshot.

        Upbit reports cumulative fills. Repeated reads, partial fills and restart
        recovery therefore cannot double-count a fill or discard unsold quantity.
        """
        qty = float(fill["executed_volume"])
        trades = fill.get("trades", [])
        trade_qty = sum(float(t["volume"]) for t in trades)
        funds = sum(float(t.get("funds", float(t["price"]) * float(t["volume"]))) for t in trades)
        fee = float(fill["paid_fee"])
        if not all(math.isfinite(v) and v >= 0 for v in (qty, funds, fee)):
            raise ValueError("Invalid exchange fill values")
        if not math.isclose(trade_qty, qty, rel_tol=1e-8, abs_tol=1e-12) or (qty > 0 and funds <= 0):
            raise ValueError("Incomplete exchange fill details; awaiting reconciliation")
        if qty < pending.get("executed_volume", 0):
            raise ValueError("Exchange fill regressed; awaiting reconciliation")
        stack = copy.deepcopy(pending["original_tranches"])
        records = []
        if pending["kind"] == "ENTRY":
            if qty > 0:
                stack.append({
                    "id": pending["identifier"], "market": pending["market"],
                    "strategy": pending["strategy"], "mode": "live", "entry_time": pending["time"],
                    "entry_price": funds / qty, "coin_qty": qty,
                    "entry_notional_krw": funds + fee, "fee_krw": fee,
                    "upbit_uuid": pending.get("uuid"),
                })
        elif qty > 0:
            available = sum(float(t["coin_qty"]) for t in stack)
            if qty > available + 1e-12 or qty > float(pending["volume"]) + 1e-12:
                raise ValueError("Exchange fill exceeds tracked sell quantity")
            remaining = qty
            while remaining > 1e-12 and stack:
                tranche = stack[-1]
                original_qty = float(tranche["coin_qty"])
                sold = min(remaining, original_qty)
                records.append(self._exit_record(tranche, sold, funds * sold / qty, fee * sold / qty, pending))
                left = original_qty - sold
                if left <= 1e-12:
                    stack.pop()
                else:
                    tranche["coin_qty"] = left
                    tranche["entry_notional_krw"] *= left / original_qty
                    tranche["fee_krw"] = float(tranche.get("fee_krw", 0)) * left / original_qty
                remaining -= sold
        state["active_tranches"] = stack
        state["trade_history"] = [r for r in state["trade_history"]
                                  if r.get("order_identifier") != pending["identifier"]] + records
        pending["executed_volume"] = qty
        pending["exchange_state"] = fill.get("state")
        if qty > 0:
            state["last_signal"] = {"type": pending["kind"], "time": pending["time"],
                                    "price": funds / qty, "mode": "live", "strategy": pending["strategy"]}

    async def _reconcile(self, client, state):
        pending = state.get("pending_order")
        if not pending:
            return
        try:
            lookup = {"uuid": pending["uuid"]} if pending.get("uuid") else {"identifier": pending["identifier"]}
            fill = await client.get_order(**lookup)
            if fill.get("uuid"):
                pending["uuid"] = fill["uuid"]
            self._apply_fill(state, pending, fill)
            if fill.get("state") in ("done", "cancel", "prevented"):
                state["pending_order"] = None
                state["last_error"] = (None if float(fill["executed_volume"]) > 0
                                       else "Order ended without a fill")
            else:
                state["last_error"] = "Order pending; new orders blocked until reconciliation"
        except Exception as e:
            state["last_error"] = f"Order reconciliation required: {e}"
        # A failed write must escape; a restart will retry from the persisted snapshot.
        self.save_state(state)

    async def reconcile_pending(self, client):
        async with self.lock:
            state = self.load_state()
            await self._reconcile(client, state)
            return self.get_status()

    async def _submit(self, client, state, kind, timestamp, volume=None, price=None):
        pending = {
            "identifier": "lab-" + uuid.uuid4().hex, "uuid": None, "kind": kind,
            "time": timestamp, "market": state["market"], "strategy": state["active_strategy"],
            "volume": volume, "price": price, "executed_volume": 0,
            "original_tranches": copy.deepcopy(state["active_tranches"]),
        }
        state["pending_order"] = pending
        state["last_entry_bar_time" if kind == "ENTRY" else "last_exit_bar_time"] = timestamp
        self.save_state(state)  # Must succeed BEFORE any request reaches the exchange.
        try:
            args = {"market": pending["market"], "identifier": pending["identifier"]}
            if kind == "ENTRY":
                args.update(side="bid", price=price, ord_type="price")
            else:
                args.update(side="ask", volume=volume, ord_type="market")
            result = await client.create_order(**args)
        except Exception as e:
            # Unknown outcomes are never resubmitted, even across process restarts.
            # Definitive API rejections can release the pending intent, but pause the bot.
            if getattr(e, "definitive_rejection", False):
                state["pending_order"] = None
            state["enabled"] = False
            state["last_error"] = f"Order submission failed; bot paused: {e}"
            self.save_state(state)
            return
        pending["uuid"] = result.get("uuid")
        self.save_state(state)
        await self._reconcile(client, state)

    async def execute_step(self, upbit_client, five_m_candles, one_h_candles):
        async with self.lock:
            state = self.load_state()
            state["last_eval_time"] = time.time()
            if state.get("pending_order"):
                await self._reconcile(upbit_client, state)
                return self.get_status()
            if not state["enabled"]:
                return self.get_status()
            try:
                self._validate_inventory(state)
            except ValueError as e:
                state.update(enabled=False, last_error=str(e))
                self.save_state(state)
                return self.get_status()
            now = time.time()
            bars = _with_indicators([b for b in five_m_candles if int(b["time"]) + 300 <= now])
            if len(bars) < 60:
                return self.get_status()
            closed_bar = bars[-1]
            decision_time = int(closed_bar["time"]) + 300
            # Do not trade old signals after a data outage or weekend-style gap.
            if now - decision_time >= 300:
                return self.get_status()
            hours = _with_indicators([h for h in one_h_candles if int(h["time"]) + 3600 <= decision_time])
            if not hours:
                return self.get_status()
            entry, exit_, _ = evaluate_strategy_signals(
                state["active_strategy"], closed_bar, hours[-1], **state["strategy_options"])
            tickers = await upbit_client.get_tickers([state["market"]])
            price = float(tickers[0]["trade_price"]) if tickers else 0
            if not math.isfinite(price) or price <= 0:
                return self.get_status()
            stack = state["active_tranches"]
            # Exit existing inventory first; at most one order per evaluation.
            if exit_ and stack and decision_time > state["last_exit_bar_time"]:
                top = stack[-1]
                qty, cost = float(top["coin_qty"]), float(top["entry_notional_krw"])
                net_return = ((price * qty * .9995) / cost - 1) * 100 if cost else -math.inf
                if net_return >= float(state["min_profit_pct"]):
                    if state["mode"] == "live":
                        await self._submit(upbit_client, state, "EXIT", decision_time, volume=self._volume(qty))
                    else:
                        pending = {"identifier": "paper-" + uuid.uuid4().hex, "kind": "EXIT", "time": decision_time}
                        state["trade_history"].append(self._exit_record(top, qty, price * qty, price * qty * .0005, pending))
                        stack.pop()
                        state["last_exit_bar_time"] = decision_time
                        state["last_signal"] = {"type": "EXIT", "time": decision_time, "price": price, "mode": "paper"}
                        state["last_error"] = None
                        self.save_state(state)
                    return self.get_status(price)
            if entry and len(stack) < state["max_tranches"] and decision_time > state["last_entry_bar_time"]:
                capital = float(state["tranche_size_krw"])
                if state["mode"] == "live":
                    account = await upbit_client.get_detailed_account_overview()
                    cash = float(account.get("summary", {}).get("cash_krw", 0))
                    if cash < capital * 1.0005:
                        state["last_error"] = "Insufficient KRW including entry fee"
                        self.save_state(state)
                        return self.get_status(price)
                    await self._submit(upbit_client, state, "ENTRY", decision_time, price=str(int(capital)))
                else:
                    stack.append({"id": "paper-" + uuid.uuid4().hex, "market": state["market"],
                                  "strategy": state["active_strategy"], "mode": "paper", "entry_time": decision_time,
                                  "entry_price": price, "coin_qty": capital * .9995 / price,
                                  "entry_notional_krw": capital, "fee_krw": capital * .0005, "upbit_uuid": None})
                    state["last_entry_bar_time"] = decision_time
                    state["last_signal"] = {"type": "ENTRY", "time": decision_time, "price": price, "mode": "paper"}
                    state["last_error"] = None
                    self.save_state(state)
            return self.get_status(price)

    async def emergency_flatten(self, upbit_client, current_price=None):
        async with self.lock:
            state = self.load_state()
            state["enabled"] = False
            self.save_state(state)  # Paused even if the exchange or process fails below.
            if state.get("pending_order"):
                await self._reconcile(upbit_client, state)
                if state.get("pending_order"):
                    return self.get_status(current_price)
            self._validate_inventory(state)
            if not state["active_tranches"]:
                return self.get_status(current_price)
            now = int(time.time())
            if state["mode"] == "live":
                qty = sum(float(t["coin_qty"]) for t in state["active_tranches"])
                await self._submit(upbit_client, state, "EMERGENCY_FLATTEN", now, volume=self._volume(qty))
            else:
                if not current_price or not math.isfinite(current_price) or current_price <= 0:
                    raise ValueError("A current price is required for paper flattening")
                pending = {"identifier": "paper-" + uuid.uuid4().hex, "kind": "EMERGENCY_FLATTEN", "time": now}
                for t in reversed(state["active_tranches"]):
                    qty = float(t["coin_qty"])
                    state["trade_history"].append(self._exit_record(t, qty, current_price * qty, current_price * qty * .0005, pending))
                state["active_tranches"] = []
                state["last_signal"] = {"type": "EMERGENCY_FLATTEN", "time": now, "price": current_price}
                self.save_state(state)
            return self.get_status(current_price)


# Global singleton engine instance
strategy_execution_engine = UpbitStrategyExecutionEngine()

