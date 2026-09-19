"""Causal, long-only quantitative strategy backtests used by the Strategy Lab UI."""

from __future__ import annotations

from bisect import bisect_right
import math
from typing import Any, Dict, List, Optional


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
    *,
    entry_5m: bool = True,
    entry_1h: bool = True,
    exit_5m: bool = True,
    exit_1h: bool = True,
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
        is_bb_pierce = (bb_lower is not None) and (float(bar.get("low", close)) <= bb_lower) and (close > bb_lower)
        is_z_extreme = z_score <= -1.8
        has_volatility = candle_range >= (0.6 * atr) if atr > 0 else True
        should_enter = (is_z_extreme or is_bb_pierce) and has_volatility

        should_exit = (bb_mid is not None and close >= bb_mid) or z_score >= 0.5 or bool(bar.get("bullish")) or bool(hourly.get("bullish"))
        reason = "Z-Score <= -1.8 / Lower BB Pierce" if should_enter else ("BB Mean / Upper Reversion" if should_exit else "")

    elif strategy_mode == "rsi_momentum":
        # Framework 2: Momentum Deceleration & Exhaustion
        is_rsi_oversold = (rsi_5m < 30.0) and (rsi_1h < 45.0)
        is_stoch_hook = (stoch_k < 20.0) and (rsi_5m < 35.0)
        should_enter = is_rsi_oversold or is_stoch_hook

        should_exit = (rsi_5m >= 60.0) or (stoch_k >= 80.0) or bool(bar.get("bullish")) or bool(hourly.get("bullish"))
        reason = "5m/1h RSI Oversold (<30/45)" if should_enter else ("RSI Overbought (>60)" if should_exit else "")

    elif strategy_mode == "multi_factor":
        # Framework 3: Multi-Factor Voting Gate (Macro + 2-of-3 Micro)
        macro_pass = (rsi_1h >= 35.0) or (hourly.get("ma24") is not None and close >= float(hourly["ma24"]))
        vote_stretch = z_score <= -1.4 or (bb_lower is not None and close <= bb_lower * 1.002)
        vote_vol = vol_ratio >= 1.3
        vote_rsi = rsi_5m <= 35.0 or stoch_k <= 25.0
        micro_votes = sum([vote_stretch, vote_vol, vote_rsi])

        should_enter = macro_pass and (micro_votes >= 2)
        should_exit = (rsi_5m >= 65.0) or (bb_upper is not None and close >= bb_upper) or bool(bar.get("bullish"))
        reason = f"Voting Gate PASS ({micro_votes}/3 votes)" if should_enter else ("Multi-Factor Exit" if should_exit else "")

    elif strategy_mode == "ou_quant":
        # Framework 4: Quantitative Ornstein-Uhlenbeck SDE
        is_ou_discount = ou_z <= -1.5
        is_rev_regime = p_rev >= 0.55
        should_enter = is_ou_discount and is_rev_regime

        should_exit = ou_z >= 0.0 or bool(bar.get("bullish")) or bool(hourly.get("bullish"))
        reason = f"OU Discount ({ou_z:.2f}σ, P_rev {p_rev:.2f})" if should_enter else ("OU Mean Target" if should_exit else "")

    else:
        # Framework 5: Dual MA Stack (or Custom Checkboxes)
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
    entry_5m: bool = True,
    entry_1h: bool = True,
    exit_5m: bool = True,
    exit_1h: bool = True,
) -> Dict[str, Any]:
    """Backtest quantitative strategy framework with multi-tranche LIFO queue.

    Signals are evaluated at candle close and filled at the next 5-minute open.
    Dip entry scales in up to max_tranches; rally exit pops tranches in LIFO order.
    """
    bars = _with_indicators(candles_5m)
    hours = _with_indicators(candles_1h)
    hour_times = [int(row["time"]) for row in hours]
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
        hourly = hour_at(int(bar["time"]))
        if hourly is None or not is_warmed_up(bar, hourly):
            continue
        next_bar = bars[index + 1]
        fill_price = float(next_bar["open"])
        if fill_price <= 0:
            continue

        should_enter, should_exit, reason = evaluate_strategy_signals(
            mode, bar, hourly,
            entry_5m=entry_5m, entry_1h=entry_1h,
            exit_5m=exit_5m, exit_1h=exit_1h,
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
