"""Causal Ridge + Daily Trend Filter engine matching price-forecast-tab.js math."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .single_leg_direction import entry_direction_allowed, parse_entry_direction_mode

INTERVAL_SECONDS: Dict[str, int] = {
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
}

FEATURE_GROUPS: Tuple[str, ...] = ("momentum", "macd", "rsi", "ma", "volatility")

DEFAULT_SETTINGS: Dict[str, Any] = {
    "venue": "binance_futures",
    "symbol": "ETHUSDT",
    "interval": "4h",
    "horizon_bars": 1,
    "neutral_bps": 8.0,
    "confidence_pct": 49.0,
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
}


def _finite(value: Any) -> bool:
    if value in (None, "") or isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, float(value)))


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _median(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(float(v) for v in values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _stdev(values: Sequence[float]) -> float:
    n = len(values)
    if n < 2:
        return 0.0
    avg = _mean(values)
    return math.sqrt(sum((float(v) - avg) ** 2 for v in values) / (n - 1))


def normalize_settings(raw: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    merged = {**DEFAULT_SETTINGS, **(raw or {})}
    venue = str(merged.get("venue", DEFAULT_SETTINGS["venue"])).lower()
    if venue not in {"binance_futures", "lighter"}:
        venue = DEFAULT_SETTINGS["venue"]
    interval = str(merged.get("interval", DEFAULT_SETTINGS["interval"]))
    if interval not in {"5m", "15m", "1h", "4h"}:
        interval = DEFAULT_SETTINGS["interval"]
    symbol = "".join(
        ch for ch in str(merged.get("symbol", DEFAULT_SETTINGS["symbol"])).upper() if ch.isalnum()
    )[:20] or DEFAULT_SETTINGS["symbol"]

    settings: Dict[str, Any] = {
        **merged,
        "venue": venue,
        "symbol": symbol,
        "interval": interval,
        "horizon_bars": round(_clamp(merged["horizon_bars"], 1, 12)),
        "neutral_bps": _clamp(merged["neutral_bps"], 0, 500),
        "confidence_pct": _clamp(merged["confidence_pct"], 0, 100),
        "ridge_lambda": _clamp(merged["ridge_lambda"], 0.0001, 10000),
        "train_window": round(_clamp(merged["train_window"], 100, 1200)),
        "min_train_samples": round(_clamp(merged["min_train_samples"], 60, 1000)),
        "cost_bps": _clamp(merged["cost_bps"], 0, 500),
        "use_daily_trend_filter": bool(merged.get("use_daily_trend_filter", True)),
        "daily_ma_period": round(_clamp(merged.get("daily_ma_period", 20), 2, 200)),
        "hold_same_direction": bool(merged.get("hold_same_direction", True)),
        "entry_direction_mode": parse_entry_direction_mode(merged.get("entry_direction_mode", "two_way")),
        "use_stop_loss": bool(merged.get("use_stop_loss", False)),
        "stop_loss_pct": _clamp(merged.get("stop_loss_pct", 3.0), 0.1, 50.0),
        "momentum_lookback": round(_clamp(merged["momentum_lookback"], 2, 50)),
        "macd_fast": round(_clamp(merged["macd_fast"], 2, 100)),
        "macd_slow": round(_clamp(merged["macd_slow"], 3, 200)),
        "macd_signal": round(_clamp(merged["macd_signal"], 2, 100)),
        "rsi_period": round(_clamp(merged["rsi_period"], 2, 100)),
        "ma_fast": round(_clamp(merged["ma_fast"], 2, 200)),
        "ma_slow": round(_clamp(merged["ma_slow"], 3, 400)),
        "ma_slope_lookback": round(_clamp(merged["ma_slope_lookback"], 1, 50)),
        "atr_period": round(_clamp(merged["atr_period"], 2, 100)),
    }
    for group in FEATURE_GROUPS:
        settings[f"use_{group}"] = bool(merged.get(f"use_{group}", True))
    if settings["macd_fast"] >= settings["macd_slow"]:
        settings["macd_fast"] = max(2, settings["macd_slow"] - 1)
    if settings["ma_fast"] >= settings["ma_slow"]:
        settings["ma_fast"] = max(2, settings["ma_slow"] - 1)
    settings["min_train_samples"] = min(settings["min_train_samples"], settings["train_window"])
    return settings


def simple_moving_average(values: Sequence[float], period: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(values)
    rolling = 0.0
    for idx, raw in enumerate(values):
        val = float(raw)
        rolling += val
        if idx >= period:
            rolling -= float(values[idx - period])
        if idx >= period - 1:
            out[idx] = rolling / period
    return out


def exponential_moving_average(values: Sequence[float], period: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(values)
    if not values:
        return out
    alpha = 2.0 / (period + 1.0)
    current = float(values[0])
    out[0] = current
    for idx in range(1, len(values)):
        current = alpha * float(values[idx]) + (1.0 - alpha) * current
        out[idx] = current
    return out


def wilder_rsi(values: Sequence[float], period: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(values)
    if len(values) <= period:
        return out
    gains = 0.0
    losses = 0.0
    for idx in range(1, period + 1):
        delta = float(values[idx]) - float(values[idx - 1])
        if delta > 0:
            gains += delta
        elif delta < 0:
            losses += -delta
    avg_gain = gains / period
    avg_loss = losses / period
    out[period] = 100.0 if avg_loss == 0 else 100.0 - (100.0 / (1.0 + avg_gain / avg_loss))
    for idx in range(period + 1, len(values)):
        delta = float(values[idx]) - float(values[idx - 1])
        avg_gain = ((avg_gain * (period - 1)) + max(0.0, delta)) / period
        avg_loss = ((avg_loss * (period - 1)) + max(0.0, -delta)) / period
        out[idx] = 100.0 if avg_loss == 0 else 100.0 - (100.0 / (1.0 + avg_gain / avg_loss))
    return out


def wilder_atr(bars: Sequence[Dict[str, Any]], period: int) -> List[Optional[float]]:
    true_ranges: List[float] = []
    for idx, bar in enumerate(bars):
        hi = float(bar["high"])
        lo = float(bar["low"])
        if idx == 0:
            true_ranges.append(hi - lo)
        else:
            prev_close = float(bars[idx - 1]["close"])
            true_ranges.append(max(hi - lo, abs(hi - prev_close), abs(lo - prev_close)))
    out: List[Optional[float]] = [None] * len(bars)
    if len(bars) < period:
        return out
    current = _mean(true_ranges[:period])
    out[period - 1] = current
    for idx in range(period, len(bars)):
        current = ((current * (period - 1)) + true_ranges[idx]) / period
        out[idx] = current
    return out


def rolling_return_volatility(values: Sequence[float], period: int = 12) -> List[Optional[float]]:
    returns: List[Optional[float]] = [
        math.log(float(values[i]) / float(values[i - 1])) * 10000.0 if i > 0 else None
        for i in range(len(values))
    ]
    out: List[Optional[float]] = [None] * len(values)
    for idx in range(period, len(values)):
        window = [float(v) for v in returns[idx - period + 1 : idx + 1] if v is not None and _finite(v)]
        out[idx] = _stdev(window)
    return out


def calculate_indicators(bars: Sequence[Dict[str, Any]], settings: Dict[str, Any]) -> Dict[str, Any]:
    closes = [float(bar["close"]) for bar in bars]
    ma_fast = simple_moving_average(closes, settings["ma_fast"])
    ma_slow = simple_moving_average(closes, settings["ma_slow"])
    rsi = wilder_rsi(closes, settings["rsi_period"])
    atr = wilder_atr(bars, settings["atr_period"])
    fast_ema = exponential_moving_average(closes, settings["macd_fast"])
    slow_ema = exponential_moving_average(closes, settings["macd_slow"])
    macd = [float(fast_ema[i]) - float(slow_ema[i]) for i in range(len(closes))]
    macd_signal = exponential_moving_average(macd, settings["macd_signal"])
    macd_histogram = [macd[i] - float(macd_signal[i]) for i in range(len(closes))]
    return_volatility = rolling_return_volatility(closes, 12)
    return {
        "closes": closes,
        "ma_fast": ma_fast,
        "ma_slow": ma_slow,
        "rsi": rsi,
        "atr": atr,
        "macd": macd,
        "macd_signal": macd_signal,
        "macd_histogram": macd_histogram,
        "return_volatility": return_volatility,
    }


def feature_row_at(
    bars: Sequence[Dict[str, Any]],
    indicators: Dict[str, Any],
    settings: Dict[str, Any],
    index: int,
) -> Optional[Dict[str, Any]]:
    closes = indicators["closes"]
    ma_fast = indicators["ma_fast"]
    ma_slow = indicators["ma_slow"]
    rsi = indicators["rsi"]
    atr = indicators["atr"]
    macd_histogram = indicators["macd_histogram"]
    return_volatility = indicators["return_volatility"]

    lookback = int(settings["momentum_lookback"])
    slope_lookback = int(settings["ma_slope_lookback"])
    requirements = [2]
    if settings["use_momentum"]:
        requirements.append(lookback)
    if settings["use_macd"]:
        requirements.extend((settings["macd_slow"] + settings["macd_signal"], settings["atr_period"]))
    if settings["use_rsi"]:
        requirements.append(settings["rsi_period"] + 1)
    if settings["use_ma"]:
        requirements.extend((settings["ma_slow"] + slope_lookback, settings["atr_period"]))
    if settings["use_volatility"]:
        requirements.extend((settings["atr_period"], 13))
    minimum_index = max(requirements)
    if index < minimum_index or index >= len(bars) or not bars[index]:
        return None

    close = float(closes[index])
    atr_raw = atr[index]
    atr_value = float(atr_raw) if atr_raw is not None else 0.0
    needs_atr = bool(settings["use_macd"] or settings["use_ma"] or settings["use_volatility"])
    if not (close > 0) or (needs_atr and not (atr_value > 0)):
        return None
    atr_denom = atr_value if atr_value > 0 else 1.0

    values: List[float] = []
    names: List[str] = []

    def add(name: str, value: Any) -> bool:
        if not _finite(value):
            return False
        names.append(name)
        values.append(float(value))
        return True

    one_bar_bps = math.log(close / float(closes[index - 1])) * 10000.0
    lookback_bps = math.log(close / float(closes[index - lookback])) * 10000.0
    hist_atr = float(macd_histogram[index]) / atr_denom
    hist_diff_atr = (float(macd_histogram[index]) - float(macd_histogram[index - 1])) / atr_denom
    rsi_val = float(rsi[index]) if rsi[index] is not None else 50.0
    rsi_prev = float(rsi[index - 1]) if rsi[index - 1] is not None else rsi_val
    rsi_delta = rsi_val - rsi_prev

    if ma_fast[index] is not None and ma_slow[index] is not None and ma_fast[index - slope_lookback] is not None and ma_fast[index - 1] is not None:
        ma_f = float(ma_fast[index])
        ma_s = float(ma_slow[index])
        ma_f_prev = float(ma_fast[index - 1])
        ma_f_slope_ref = float(ma_fast[index - slope_lookback])
        ma_dist_atr = (close - ma_f) / atr_denom
        ma_spread_atr = (ma_f - ma_s) / atr_denom
        ma_slope_atr = (ma_f - ma_f_slope_ref) / atr_denom
        rising_ma = ma_f > ma_f_slope_ref
        falling_ma = ma_f < ma_f_slope_ref
        crossed_under = float(closes[index - 1]) >= ma_f_prev and close < ma_f
        crossed_over = float(closes[index - 1]) <= ma_f_prev and close > ma_f
        ride_hang = 1.0 if (crossed_under and rising_ma) else (-1.0 if (crossed_over and falling_ma) else 0.0)
    else:
        ma_dist_atr = 0.0
        ma_spread_atr = 0.0
        ma_slope_atr = 0.0
        ride_hang = 0.0

    atr_pct = (atr_value / close) * 100.0
    vol_bps = float(return_volatility[index]) if return_volatility[index] is not None else 0.0
    bar_hi = float(bars[index]["high"])
    bar_lo = float(bars[index]["low"])
    bar_range = bar_hi - bar_lo
    clv = ((2.0 * close - bar_hi - bar_lo) / bar_range) if bar_range > 0 else 0.0

    if settings["use_momentum"]:
        add("return_1_bps", one_bar_bps)
        add(f"return_{lookback}_bps", lookback_bps)
        add("momentum_accel_bps", one_bar_bps - math.log(float(closes[index - 1]) / float(closes[index - 2])) * 10000.0)
    if settings["use_macd"]:
        add("macd_hist_atr", hist_atr)
        add("macd_hist_diff_atr", hist_diff_atr)
    if settings["use_rsi"]:
        add("rsi_centered", (rsi_val - 50.0) / 10.0)
        add("rsi_delta", rsi_delta / 10.0)
    if settings["use_ma"]:
        if ma_fast[index] is None or ma_slow[index] is None or ma_fast[index - slope_lookback] is None or ma_fast[index - 1] is None:
            return None
        add("price_ma_atr", ma_dist_atr)
        add("ma_spread_atr", ma_spread_atr)
        add("ma_slope_atr", ma_slope_atr)
        add("ma_ride_hang", ride_hang)
    if settings["use_volatility"]:
        add("atr_pct", atr_pct)
        add("return_volatility_bps", vol_bps)
        add("candle_body_atr", (close - float(bars[index]["open"])) / atr_denom)
        add("candle_clv", clv)

    if not values or any(not _finite(v) for v in values):
        return None

    return {
        "index": index,
        "time": int(bars[index]["time"]),
        "values": values,
        "names": names,
        "metrics": {
            "one_bar_bps": one_bar_bps,
            "lookback_bps": lookback_bps,
            "macd_hist_atr": hist_atr,
            "macd_hist_diff_atr": hist_diff_atr,
            "rsi": rsi_val,
            "rsi_delta": rsi_delta,
            "ma_distance_atr": ma_dist_atr,
            "ma_spread_atr": ma_spread_atr,
            "ma_slope_atr": ma_slope_atr,
            "ma_ride_hang": ride_hang,
            "atr_pct": atr_pct,
            "volatility_bps": vol_bps,
            "candle_clv": clv,
        },
    }


def local_volatility_scale_bps(
    bars: Sequence[Dict[str, Any]],
    indicators: Dict[str, Any],
    settings: Dict[str, Any],
    index: int,
) -> float:
    close = float(bars[index].get("close", 0.0) or 0.0)
    if not (close > 0):
        return 10.0
    atr = indicators["atr"][index]
    atr_bps = (float(atr) / close) * 10000.0 if (_finite(atr) and float(atr) > 0) else 20.0
    rv = indicators["return_volatility"][index]
    per_bar = max(2.0, (0.55 * float(rv) + 0.45 * atr_bps * 0.72) if (_finite(rv) and float(rv) > 0) else atr_bps * 0.75)
    return per_bar * math.sqrt(max(1, int(settings.get("horizon_bars", 1))))


def build_feature_rows(
    bars: Sequence[Dict[str, Any]],
    settings: Dict[str, Any],
) -> Tuple[Dict[str, Any], List[Optional[Dict[str, Any]]]]:
    indicators = calculate_indicators(bars, settings)
    rows = [feature_row_at(bars, indicators, settings, idx) for idx in range(len(bars))]
    return indicators, rows


def solve_linear_system(matrix: Sequence[Sequence[float]], vector: Sequence[float]) -> List[float]:
    size = len(vector)
    augmented = [list(map(float, matrix[row])) + [float(vector[row])] for row in range(size)]
    for col in range(size):
        pivot = col
        best_abs = abs(augmented[pivot][col])
        for row in range(col + 1, size):
            cand = abs(augmented[row][col])
            if cand > best_abs:
                best_abs = cand
                pivot = row
        if best_abs < 1e-12:
            return [0.0] * size
        if pivot != col:
            augmented[pivot], augmented[col] = augmented[col], augmented[pivot]
        divisor = augmented[col][col]
        piv_row = augmented[col]
        for cell in range(col, size + 1):
            piv_row[cell] /= divisor
        for row in range(size):
            if row == col:
                continue
            target_row = augmented[row]
            factor = target_row[col]
            if factor == 0.0:
                continue
            for cell in range(col, size + 1):
                target_row[cell] -= factor * piv_row[cell]
    return [augmented[row][size] for row in range(size)]


def fit_ridge(samples: Sequence[Dict[str, Any]], lam: float) -> Optional[Dict[str, Any]]:
    if not samples or not samples[0].get("x"):
        return None
    n = len(samples)
    width = len(samples[0]["x"])
    means = [0.0] * width
    scales = [0.0] * width
    for sample in samples:
        xi = sample["x"]
        for col in range(width):
            means[col] += float(xi[col])
    inv_n = 1.0 / n
    for col in range(width):
        means[col] *= inv_n
    for sample in samples:
        xi = sample["x"]
        for col in range(width):
            diff = float(xi[col]) - means[col]
            scales[col] += diff * diff
    denom_var = max(1, n - 1)
    for col in range(width):
        scales[col] = max(1e-9, math.sqrt(scales[col] / denom_var))

    lam_input = max(0.0, float(lam))
    target_k = 0.8
    lam_eff = lam_input * (n / 500.0)
    off_diag_keep = 1.0 - _clamp(lam_input / (lam_input + 45.0), 0.0, 0.90)

    xtx = [[0.0] * width for _ in range(width)]
    xty = [0.0] * width
    z_rows: List[List[float]] = []
    y_norm: List[float] = []
    tanh = math.tanh

    for sample in samples:
        xi = sample["x"]
        z_row = [tanh(((float(xi[col]) - means[col]) / scales[col]) * 0.5) * 2.0 for col in range(width)]
        z_rows.append(z_row)
        yn = float(sample["y"]) / max(2.0, float(sample["scale"]))
        y_norm.append(yn)
        y_tanh = tanh(yn / target_k)
        for row in range(width):
            zr = z_row[row]
            xty[row] += zr * y_tanh
            xtx_r = xtx[row]
            xtx_r[row] += zr * zr
            for col in range(row + 1, width):
                xtx_r[col] += zr * z_row[col]

    for row in range(width):
        xtx[row][row] += lam_eff
        for col in range(row + 1, width):
            val = xtx[row][col] * off_diag_keep
            xtx[row][col] = val
            xtx[col][row] = val

    weights = solve_linear_system(xtx, xty)
    num = 0.0
    den = 0.0
    train_scores: List[float] = []
    for i in range(n):
        z_row = z_rows[i]
        score = 0.0
        for col in range(width):
            score += z_row[col] * weights[col]
        train_scores.append(score)
        clipped_y = _clamp(y_norm[i], -2.5, 2.5)
        num += score * clipped_y
        den += score * score
    amp_raw = num / den if den > 1e-9 else target_k
    amplitude = _clamp(amp_raw if amp_raw > 0 else target_k, 0.25, 2.5)
    norm_residuals = [y_norm[i] - train_scores[i] * amplitude for i in range(n)]
    norm_center = _median(norm_residuals)
    norm_sigma = _stdev(norm_residuals)

    return {
        "means": means,
        "scales": scales,
        "y_mean": 0.0,
        "weights": weights,
        "amplitude": amplitude,
        "tanh_predict": True,
        "norm_residuals": norm_residuals,
        "norm_center": norm_center,
        "norm_sigma": norm_sigma,
        "sample_count": n,
    }


def predict_ridge(model: Dict[str, Any], values: Sequence[float], target_scale: float) -> float:
    total = float(model.get("y_mean", 0.0))
    means = model["means"]
    scales = model["scales"]
    weights = model["weights"]
    for idx in range(len(values)):
        z = (float(values[idx]) - means[idx]) / scales[idx]
        norm_v = math.tanh(z * 0.5) * 2.0 if model.get("tanh_predict", True) else z
        total += weights[idx] * norm_v
    return total * float(model["amplitude"]) * float(target_scale)


def probability_from_residuals(
    expected_bps: float,
    residuals: Sequence[float],
    neutral_bps: float,
    known_center: Optional[float] = None,
    scale_factor: float = 1.0,
) -> Dict[str, float]:
    up = 1.0
    neutral = 1.0
    down = 1.0
    s = float(scale_factor) or 1.0
    center = float(known_center) if (known_center is not None and _finite(known_center)) else _median(residuals) * s
    expected = float(expected_bps)
    band = float(neutral_bps)
    for res in residuals:
        centered = float(res) * s - center
        plus = expected + centered
        minus = expected - centered
        if plus > band:
            up += 0.5
        elif plus < -band:
            down += 0.5
        else:
            neutral += 0.5
        if minus > band:
            up += 0.5
        elif minus < -band:
            down += 0.5
        else:
            neutral += 0.5
    total = up + neutral + down
    return {"up": up / total, "neutral": neutral / total, "down": down / total}


def classify_probabilities(probs: Dict[str, float]) -> str:
    best_key = "neutral"
    for key in ("neutral", "up", "down"):
        if probs[key] > probs[best_key]:
            best_key = key
    return best_key


def make_samples(
    bars: Sequence[Dict[str, Any]],
    rows: Sequence[Optional[Dict[str, Any]]],
    indicators: Dict[str, Any],
    settings: Dict[str, Any],
) -> List[Dict[str, Any]]:
    samples: List[Dict[str, Any]] = []
    horizon = int(settings["horizon_bars"])
    for idx, row in enumerate(rows):
        target_idx = idx + horizon
        if not row or target_idx >= len(bars):
            continue
        source_close = float(bars[idx]["close"])
        target_close = float(bars[target_idx]["close"])
        if not (source_close > 0) or not (target_close > 0):
            continue
        samples.append(
            {
                "index": idx,
                "target_index": target_idx,
                "x": row["values"],
                "y": math.log(target_close / source_close) * 10000.0,
                "scale": local_volatility_scale_bps(bars, indicators, settings, idx),
            }
        )
    return samples


def forecast_step_from_eligible(
    bars: Sequence[Dict[str, Any]],
    indicators: Dict[str, Any],
    row: Optional[Dict[str, Any]],
    eligible: Sequence[Dict[str, Any]],
    settings: Dict[str, Any],
    source_index: int,
) -> Optional[Dict[str, Any]]:
    if not row or len(eligible) < int(settings["min_train_samples"]):
        return None
    model = fit_ridge(eligible, settings["ridge_lambda"])
    if model is None:
        return None
    source_scale = local_volatility_scale_bps(bars, indicators, settings, source_index)
    expected_bps = predict_ridge(model, row["values"], source_scale)
    norm_center = model["norm_center"] * source_scale
    probs = probability_from_residuals(
        expected_bps,
        model["norm_residuals"],
        settings["neutral_bps"],
        norm_center,
        source_scale,
    )
    direction = classify_probabilities(probs)
    confidence = probs[direction]
    return {
        "source_index": source_index,
        "source_time": int(bars[source_index]["time"]),
        "close_time": int(bars[source_index].get("close_time", bars[source_index]["time"])),
        "expected_bps": expected_bps,
        "probabilities": probs,
        "direction": direction,
        "confidence": confidence,
        "qualified": confidence * 100.0 >= float(settings["confidence_pct"]),
        "train_samples": len(eligible),
        "residual_sigma_bps": model["norm_sigma"] * source_scale,
        "feature_names": list(row["names"]),
        "feature_metrics": dict(row["metrics"]),
    }


def align_daily_trend(
    bars: Sequence[Dict[str, Any]],
    daily_bars: Optional[Sequence[Dict[str, Any]]],
    ma_period: int = 20,
) -> List[Optional[Dict[str, Any]]]:
    """Align each bar strictly to the latest COMPLETED 1d candle <= bar.close_time."""
    if not daily_bars:
        return [None] * len(bars)
    ordered_daily = sorted(daily_bars, key=lambda b: int(b["time"]))
    d_closes = [float(b["close"]) for b in ordered_daily]
    d_ma = simple_moving_average(d_closes, max(2, int(ma_period)))

    aligned: List[Optional[Dict[str, Any]]] = [None] * len(bars)
    cursor = 0
    for idx, bar in enumerate(bars):
        bar_close_time = int(bar.get("close_time", bar["time"]))
        while cursor + 1 < len(ordered_daily) and int(ordered_daily[cursor + 1].get("close_time", ordered_daily[cursor + 1]["time"])) <= bar_close_time:
            cursor += 1
        d_bar = ordered_daily[cursor]
        d_close_time = int(d_bar.get("close_time", d_bar["time"]))
        ma_val = d_ma[cursor]
        d_close = float(d_bar["close"])
        if d_close_time <= bar_close_time and ma_val is not None and d_close > 0:
            trend = 1 if d_close > ma_val else (-1 if d_close < ma_val else 0)
            aligned[idx] = {
                "daily_time": int(d_bar["time"]),
                "daily_close_time": d_close_time,
                "daily_close": d_close,
                "daily_ma": float(ma_val),
                "daily_trend": trend,
            }
    return aligned


def parse_binance_klines(
    rows: Sequence[Sequence[Any]],
    interval: str,
    now_seconds: Optional[float] = None,
) -> List[Dict[str, Any]]:
    import time as _time

    now_sec = _time.time() if now_seconds is None else float(now_seconds)
    interval_sec = INTERVAL_SECONDS.get(interval, 14400)
    deduped: Dict[int, Dict[str, Any]] = {}
    for row in rows or ():
        if len(row) < 6:
            continue
        t_open = int(float(row[0]) // 1000)
        t_close = int(float(row[6]) // 1000) if len(row) > 6 and _finite(row[6]) else t_open + interval_sec
        if t_close > now_sec:
            continue
        bar = {
            "time": t_open,
            "close_time": t_close,
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "value": float(row[4]),
            "volume": float(row[5] or 0.0),
        }
        if all(_finite(bar[k]) for k in ("open", "high", "low", "close")) and bar["close"] > 0:
            deduped[t_open] = bar
    return [deduped[k] for k in sorted(deduped)]


def parse_lighter_candles(
    rows: Sequence[Dict[str, Any]],
    interval: str,
    now_seconds: Optional[float] = None,
) -> List[Dict[str, Any]]:
    import time as _time

    now_sec = _time.time() if now_seconds is None else float(now_seconds)
    interval_sec = INTERVAL_SECONDS.get(interval, 14400)
    deduped: Dict[int, Dict[str, Any]] = {}
    for row in rows or ():
        t_raw = row.get("t")
        if t_raw is None:
            continue
        t_ms = int(t_raw)
        t_open = t_ms // 1000 if t_ms > 10_000_000_000 else t_ms
        t_close = t_open + interval_sec
        if t_close > now_sec:
            continue
        bar = {
            "time": t_open,
            "close_time": t_close,
            "open": float(row["o"]),
            "high": float(row["h"]),
            "low": float(row["l"]),
            "close": float(row["c"]),
            "value": float(row["c"]),
            "volume": float(row.get("v", 0.0) or 0.0),
        }
        if all(_finite(bar[k]) for k in ("open", "high", "low", "close")) and bar["close"] > 0:
            deduped[t_open] = bar
    return [deduped[k] for k in sorted(deduped)]


def evaluate_live_signal(
    bars: Sequence[Dict[str, Any]],
    daily_bars: Optional[Sequence[Dict[str, Any]]],
    raw_settings: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Evaluate only the latest completed bar for autonomous execution.

    Returns `(entry_signal, candidate_side, exit_signal, details)` while keeping
    `details["conditions"]` transparent (`PASS`, `WAITING`, `OFF`, `UNAVAILABLE`).
    """
    settings = normalize_settings(raw_settings)
    enabled_groups = [group for group in FEATURE_GROUPS if settings[f"use_{group}"]]
    if not enabled_groups:
        raise ValueError("Enable at least one model input group")
    min_needed = int(settings["min_train_samples"]) + int(settings["horizon_bars"]) + 60
    if len(bars) < min_needed:
        raise ValueError(f"Need at least {min_needed} completed {settings['interval']} bars")

    indicators, rows = build_feature_rows(bars, settings)
    samples = make_samples(bars, rows, indicators, settings)
    valid_indices = [idx for idx, row in enumerate(rows) if row is not None]
    if not valid_indices:
        raise ValueError("No valid feature rows available")
    latest_idx = valid_indices[-1]
    eligible = [s for s in samples if s["target_index"] <= latest_idx][-int(settings["train_window"]):]
    latest = forecast_step_from_eligible(bars, indicators, rows[latest_idx], eligible, settings, latest_idx)
    if latest is None:
        raise ValueError("Insufficient matured training samples for Ridge fit")

    aligned_daily = align_daily_trend(bars, daily_bars, settings["daily_ma_period"])
    daily_ctx = aligned_daily[latest_idx]

    raw_dir = latest["direction"]
    raw_side = 1 if raw_dir == "up" else (-1 if raw_dir == "down" else 0)
    conf_pct = float(latest["confidence"]) * 100.0
    conf_ok = conf_pct >= float(settings["confidence_pct"])
    band_ok = abs(float(latest["expected_bps"])) > float(settings["neutral_bps"]) or raw_side != 0

    daily_filter_on = bool(settings["use_daily_trend_filter"])
    daily_ready = daily_ctx is not None
    daily_trend = int(daily_ctx["daily_trend"]) if daily_ready else 0
    if daily_filter_on:
        daily_allows_long = daily_ready and daily_trend > 0
        daily_allows_short = daily_ready and daily_trend < 0
    else:
        daily_allows_long = True
        daily_allows_short = True

    dir_mode = settings["entry_direction_mode"]
    side_allowed_by_daily = (
        (raw_side == 1 and daily_allows_long)
        or (raw_side == -1 and daily_allows_short)
    )
    entry_allowed = (
        raw_side != 0
        and conf_ok
        and side_allowed_by_daily
        and entry_direction_allowed(dir_mode, raw_side)
    )

    latest_bar = bars[latest_idx]
    evaluation = {
        "strategy": "causal_ridge_daily",
        "symbol": settings["symbol"],
        "venue": settings["venue"],
        "interval": settings["interval"],
        "time": int(latest_bar["time"]),
        "close_time": int(latest_bar.get("close_time", latest_bar["time"])),
        "close": float(latest_bar["close"]),
        "ma_fast": indicators["ma_fast"][latest_idx],
        "ma_slow": indicators["ma_slow"][latest_idx],
        "direction": raw_dir,
        "candidate_side": raw_side if entry_allowed else 0,
        "raw_side": raw_side,
        "expected_bps": float(latest["expected_bps"]),
        "confidence_pct": conf_pct,
        "min_confidence_pct": float(settings["confidence_pct"]),
        "confidence_pass": conf_ok,
        "band_pass": band_ok,
        "probabilities": latest["probabilities"],
        "residual_sigma_bps": float(latest["residual_sigma_bps"]),
        "train_samples": int(latest["train_samples"]),
        "use_daily_trend_filter": daily_filter_on,
        "daily_ma_period": int(settings["daily_ma_period"]),
        "daily_ready": daily_ready,
        "daily_trend": daily_trend,
        "daily_close": daily_ctx["daily_close"] if daily_ctx else None,
        "daily_ma": daily_ctx["daily_ma"] if daily_ctx else None,
        "daily_close_time": daily_ctx["daily_close_time"] if daily_ctx else None,
        "daily_allows_long": daily_allows_long,
        "daily_allows_short": daily_allows_short,
        "side_allowed_by_daily": side_allowed_by_daily,
        "hold_same_direction": bool(settings["hold_same_direction"]),
        "entry_direction_mode": dir_mode,
        "entry_allowed": entry_allowed,
        "feature_names": latest["feature_names"],
        "feature_metrics": latest["feature_metrics"],
    }
    # Position exit decision is handled explicitly cleanly alongside hold_same_direction
    # in ForecastTraderBot / simulate_replay so entry_allowed stays position-independent.
    return bool(entry_allowed), (raw_side if entry_allowed else 0), False, evaluation


def run_causal_replay(
    bars: Sequence[Dict[str, Any]],
    daily_bars: Optional[Sequence[Dict[str, Any]]],
    raw_settings: Optional[Dict[str, Any]] = None,
    *,
    notional_usd: float = 200.0,
    leverage: float = 1.0,
    max_eval_bars: int = 1000,
    initial_equity_usd: float = 1000.0,
) -> Dict[str, Any]:
    """Run causal walk-forward replay, keeping entry_signals independent of positions."""
    settings = normalize_settings(raw_settings)
    enabled_groups = [group for group in FEATURE_GROUPS if settings[f"use_{group}"]]
    if not enabled_groups:
        return {"error": "Enable at least one model input group.", "settings": settings, "entry_signals": [], "trades": []}
    min_needed = int(settings["min_train_samples"]) + int(settings["horizon_bars"]) + 60
    if len(bars) < min_needed:
        return {"error": f"Need at least {min_needed} completed {settings['interval']} candles.", "settings": settings, "entry_signals": [], "trades": []}

    indicators, rows = build_feature_rows(bars, settings)
    samples = make_samples(bars, rows, indicators, settings)
    aligned_daily = align_daily_trend(bars, daily_bars, settings["daily_ma_period"])

    first_valid = next((i for i, row in enumerate(rows) if row is not None), 0)
    earliest = max(
        first_valid,
        int(settings["min_train_samples"]) + int(settings["horizon_bars"]),
        len(bars) - max(100, int(max_eval_bars)),
    )

    entry_signals: List[Dict[str, Any]] = []
    entry_trend: List[Dict[str, Any]] = []
    sample_cursor = 0
    train_window = int(settings["train_window"])
    daily_on = bool(settings["use_daily_trend_filter"])
    dir_mode = settings["entry_direction_mode"]

    for src_idx in range(earliest, len(bars)):
        row = rows[src_idx]
        if row is None:
            continue
        while sample_cursor < len(samples) and samples[sample_cursor]["target_index"] <= src_idx:
            sample_cursor += 1
        eligible = samples[max(0, sample_cursor - train_window) : sample_cursor]
        step = forecast_step_from_eligible(bars, indicators, row, eligible, settings, src_idx)
        if step is None:
            continue

        d_ctx = aligned_daily[src_idx]
        d_trend = int(d_ctx["daily_trend"]) if d_ctx else 0
        raw_side = 1 if step["direction"] == "up" else (-1 if step["direction"] == "down" else 0)

        if daily_on:
            daily_ok = (d_ctx is not None) and ((raw_side == 1 and d_trend > 0) or (raw_side == -1 and d_trend < 0))
            trend_sign = d_trend if d_ctx else 0
        else:
            daily_ok = raw_side != 0
            trend_sign = 0

        entry_allowed = (
            raw_side != 0
            and bool(step["qualified"])
            and daily_ok
            and entry_direction_allowed(dir_mode, raw_side)
        )

        entry_trend.append(
            {
                "time": int(bars[src_idx]["time"]),
                "close_time": int(bars[src_idx].get("close_time", bars[src_idx]["time"])),
                "sign": trend_sign,
                "daily_close": d_ctx["daily_close"] if d_ctx else None,
                "daily_ma": d_ctx["daily_ma"] if d_ctx else None,
                "daily_time": d_ctx["daily_close_time"] if d_ctx else None,
            }
        )

        entry_signals.append(
            {
                "index": src_idx,
                "time": int(bars[src_idx]["time"]),
                "close_time": int(bars[src_idx].get("close_time", bars[src_idx]["time"])),
                "close": float(bars[src_idx]["close"]),
                "raw_direction": step["direction"],
                "raw_side": raw_side,
                "side": raw_side if entry_allowed else 0,
                "qualified": bool(step["qualified"]),
                "confidence_pct": float(step["confidence"]) * 100.0,
                "expected_bps": float(step["expected_bps"]),
                "daily_trend": trend_sign,
                "daily_ma": d_ctx["daily_ma"] if d_ctx else None,
                "daily_close": d_ctx["daily_close"] if d_ctx else None,
                "daily_ok": bool(daily_ok),
                "entry_allowed": bool(entry_allowed),
                "train_samples": int(step["train_samples"]),
            }
        )

    # Simulate trades chronologically cleanly WITHOUT modifying entry_signals.
    signal_by_index = {sig["index"]: sig for sig in entry_signals}
    horizon = int(settings["horizon_bars"])
    hold_same = bool(settings["hold_same_direction"])
    fee_rate = float(settings["cost_bps"]) / 10000.0
    use_sl = bool(settings["use_stop_loss"])
    sl_frac = float(settings["stop_loss_pct"]) / 100.0

    trades: List[Dict[str, Any]] = []
    markers: List[Dict[str, Any]] = []
    open_pos: Optional[Dict[str, Any]] = None
    eq = float(initial_equity_usd)
    peak = eq
    max_dd = 0.0
    worst_trade_pct = 0.0
    wins = 0

    for idx in range(earliest, len(bars)):
        bar = bars[idx]
        bar_time = int(bar["time"])
        bar_close = float(bar["close"])
        bar_high = float(bar["high"])
        bar_low = float(bar["low"])
        sig = signal_by_index.get(idx)
        sig_side = int(sig["side"]) if sig else 0

        # 1. Check stop-loss intrabar on open position
        if open_pos is not None and use_sl:
            hit_sl = False
            exit_px = bar_close
            if open_pos["side"] > 0 and bar_low <= open_pos["entry_price"] * (1.0 - sl_frac):
                hit_sl = True
                exit_px = open_pos["entry_price"] * (1.0 - sl_frac)
            elif open_pos["side"] < 0 and bar_high >= open_pos["entry_price"] * (1.0 + sl_frac):
                hit_sl = True
                exit_px = open_pos["entry_price"] * (1.0 + sl_frac)
            if hit_sl:
                raw_ret = open_pos["side"] * (exit_px / open_pos["entry_price"] - 1.0)
                net_ret = raw_ret - fee_rate
                pnl_pct = net_ret * 100.0
                roe_pct = net_ret * 100.0 * float(leverage)
                pnl_usd = open_pos["notional"] * net_ret
                fee_usd = open_pos["notional"] * fee_rate
                eq = max(0.0, eq + pnl_usd)
                peak = max(peak, eq)
                if peak > 0:
                    max_dd = max(max_dd, (peak - eq) / peak * 100.0)
                worst_trade_pct = min(worst_trade_pct, roe_pct)
                if pnl_usd > 0:
                    wins += 1
                pair_key = open_pos["pairKey"]
                trades.append(
                    {
                        "pairKey": pair_key,
                        "symbol": settings["symbol"],
                        "side": open_pos["side"],
                        "direction": "long" if open_pos["side"] > 0 else "short",
                        "entry_time": open_pos["entry_time"],
                        "exit_time": bar_time,
                        "entry_price": open_pos["entry_price"],
                        "exit_price": exit_px,
                        "qty": open_pos["qty"],
                        "notional": open_pos["notional"],
                        "fee_usd": fee_usd,
                        "gross_pnl_usd": open_pos["notional"] * raw_ret,
                        "net_pnl_usd": pnl_usd,
                        "pnl_pct": pnl_pct,
                        "roe_pct": roe_pct,
                        "reason": "stop_loss",
                        "source": "virtual",
                        "hypothetical": True,
                    }
                )
                markers.append(
                    {
                        "time": bar_time,
                        "source": "virtual",
                        "hypothetical": True,
                        "is_entry": False,
                        "is_exit": True,
                        "side": -open_pos["side"],
                        "direction": "long" if open_pos["side"] > 0 else "short",
                        "ratio": exit_px,
                        "entry_price": open_pos["entry_price"],
                        "exit_price": exit_px,
                        "qty": open_pos["qty"],
                        "notional": open_pos["notional"],
                        "pairKey": pair_key,
                        "pnl": pnl_usd,
                        "pnl_pct": pnl_pct,
                        "pnl_authoritative": True,
                        "hoverText": f"PAPER STOP EXIT @ ${exit_px:,.2f} · net {pnl_usd:+.2f} USD ({pnl_pct:+.2f}%)",
                    }
                )
                open_pos = None

        # 2. Evaluate exit at bar close after horizon_bars
        if open_pos is not None:
            held = idx - open_pos["entry_index"]
            if held >= horizon:
                if hold_same and sig_side == open_pos["side"]:
                    open_pos["renewals"] += 1
                else:
                    exit_px = bar_close
                    raw_ret = open_pos["side"] * (exit_px / open_pos["entry_price"] - 1.0)
                    net_ret = raw_ret - fee_rate
                    pnl_pct = net_ret * 100.0
                    roe_pct = net_ret * 100.0 * float(leverage)
                    pnl_usd = open_pos["notional"] * net_ret
                    fee_usd = open_pos["notional"] * fee_rate
                    eq = max(0.0, eq + pnl_usd)
                    peak = max(peak, eq)
                    if peak > 0:
                        max_dd = max(max_dd, (peak - eq) / peak * 100.0)
                    worst_trade_pct = min(worst_trade_pct, roe_pct)
                    if pnl_usd > 0:
                        wins += 1
                    reason = "opposite_reversal" if (sig_side != 0 and sig_side != open_pos["side"]) else "horizon_exit"
                    pair_key = open_pos["pairKey"]
                    trades.append(
                        {
                            "pairKey": pair_key,
                            "symbol": settings["symbol"],
                            "side": open_pos["side"],
                            "direction": "long" if open_pos["side"] > 0 else "short",
                            "entry_time": open_pos["entry_time"],
                            "exit_time": bar_time,
                            "entry_price": open_pos["entry_price"],
                            "exit_price": exit_px,
                            "qty": open_pos["qty"],
                            "notional": open_pos["notional"],
                            "fee_usd": fee_usd,
                            "gross_pnl_usd": open_pos["notional"] * raw_ret,
                            "net_pnl_usd": pnl_usd,
                            "pnl_pct": pnl_pct,
                            "roe_pct": roe_pct,
                            "reason": reason,
                            "source": "virtual",
                            "hypothetical": True,
                        }
                    )
                    markers.append(
                        {
                            "time": bar_time,
                            "source": "virtual",
                            "hypothetical": True,
                            "is_entry": False,
                            "is_exit": True,
                            "side": -open_pos["side"],
                            "direction": "long" if open_pos["side"] > 0 else "short",
                            "ratio": exit_px,
                            "entry_price": open_pos["entry_price"],
                            "exit_price": exit_px,
                            "qty": open_pos["qty"],
                            "notional": open_pos["notional"],
                            "pairKey": pair_key,
                            "pnl": pnl_usd,
                            "pnl_pct": pnl_pct,
                            "pnl_authoritative": True,
                            "hoverText": f"PAPER EXIT ({reason}) @ ${exit_px:,.2f} · net {pnl_usd:+.2f} USD ({pnl_pct:+.2f}%)",
                        }
                    )
                    open_pos = None

        # 3. Evaluate entry at bar close (excluding very last bar if we only simulate completed trades cleanly? No: latest entry shows open position!)
        if open_pos is None and sig_side != 0 and sig is not None:
            pair_key = f"paper:{len(trades) + 1}:{bar_time}"
            notional = float(notional_usd) * float(leverage)
            qty = notional / bar_close
            open_pos = {
                "pairKey": pair_key,
                "side": sig_side,
                "entry_index": idx,
                "entry_time": bar_time,
                "entry_price": bar_close,
                "qty": qty,
                "notional": notional,
                "renewals": 0,
            }
            markers.append(
                {
                    "time": bar_time,
                    "source": "virtual",
                    "hypothetical": True,
                    "is_entry": True,
                    "is_exit": False,
                    "side": sig_side,
                    "direction": "long" if sig_side > 0 else "short",
                    "ratio": bar_close,
                    "entry_price": bar_close,
                    "exit_price": None,
                    "qty": qty,
                    "notional": notional,
                    "pairKey": pair_key,
                    "pnl": None,
                    "pnl_pct": None,
                    "hoverText": f"PAPER {'LONG' if sig_side > 0 else 'SHORT'} @ ${bar_close:,.2f} · conf {sig['confidence_pct']:.1f}% · {sig['expected_bps']:+.1f}bp",
                }
            )

    _, _, _, latest_eval = evaluate_live_signal(bars, daily_bars, settings)
    total_trades = len(trades)
    net_pnl_usd = sum(t["net_pnl_usd"] for t in trades)
    total_fees_usd = sum(t["fee_usd"] for t in trades)
    return {
        "error": None,
        "settings": settings,
        "latest_evaluation": latest_eval,
        "latest_condition_time": latest_eval["close_time"],
        "entry_signals": entry_signals,
        "entry_trend": entry_trend,
        "daily_ma_series": [
            {"time": item["time"], "value": item["daily_ma"]}
            for item in entry_trend
            if item.get("daily_ma") is not None
        ],
        "trades": trades,
        "open_position": open_pos,
        "markers": markers,
        "summary": {
            "trades": total_trades,
            "wins": wins,
            "win_rate_pct": (wins / total_trades * 100.0) if total_trades else None,
            "net_pnl_usd": net_pnl_usd,
            "return_on_initial_pct": ((eq - initial_equity_usd) / initial_equity_usd * 100.0) if initial_equity_usd > 0 else 0.0,
            "max_drawdown_pct": max_dd,
            "worst_trade_pct": worst_trade_pct if total_trades else 0.0,
            "total_fees_usd": total_fees_usd,
            "fee_bps": float(settings["cost_bps"]),
            "hold_same_direction": hold_same,
            "use_daily_trend_filter": bool(settings["use_daily_trend_filter"]),
            "eval_bars": len(entry_signals),
        },
    }
