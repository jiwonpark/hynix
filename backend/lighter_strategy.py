"""Pure strategy evaluators shared by Lighter live trading and replay."""
import math
from typing import Any, Dict, List, Optional, Tuple

OU_MIN_ABS_DEVIATION_PP = 0.25
OU_MACRO_EMA_SPAN = 60
OU_MACRO_SLOPE_BARS = 12


def _ou_macro_ema_slope(ratios: List[float], span: int = OU_MACRO_EMA_SPAN,
                        slope_bars: int = OU_MACRO_SLOPE_BARS) -> Optional[float]:
    """Causal EMA change over completed bars, with enough warmup for the span."""
    if len(ratios) < max(span * 2, slope_bars + 2):
        return None
    alpha = 2.0 / (span + 1)
    ema = ratios[0]
    earlier = None
    comparison_index = len(ratios) - slope_bars - 1
    for index, ratio in enumerate(ratios[1:], 1):
        ema += alpha * (ratio - ema)
        if index == comparison_index:
            earlier = ema
    return ema - earlier if earlier is not None else None


def _trend_score(window: List[float]) -> float:
    """Continuous causal score combining normalized slope, MA separation and efficiency."""
    logs = [math.log(max(value, 1e-12)) for value in window]
    returns = [logs[index] - logs[index - 1] for index in range(1, len(logs))]
    mean_return = sum(returns) / len(returns)
    return_std = math.sqrt(sum((value - mean_return) ** 2 for value in returns) / len(returns))
    x_mean = (len(logs) - 1) / 2
    y_mean = sum(logs) / len(logs)
    denominator = sum((index - x_mean) ** 2 for index in range(len(logs)))
    slope = sum((index - x_mean) * (logs[index] - y_mean) for index in range(len(logs))) / denominator
    slope_score = math.tanh(2.0 * slope / max(return_std, 1e-9))

    ma7 = sum(window[-7:]) / 7
    ma_window = sum(window) / len(window)
    price_std = math.sqrt(sum((value - ma_window) ** 2 for value in window) / len(window))
    ma_score = math.tanh((ma7 - ma_window) / max(price_std, 1e-9))

    travel = sum(abs(window[index] - window[index - 1]) for index in range(1, len(window)))
    efficiency = (window[-1] - window[0]) / travel if travel > 1e-12 else 0.0
    return max(-1.0, min(1.0, 0.45 * slope_score + 0.35 * ma_score + 0.20 * efficiency))


def classify_trend_direction(values: List[float], window_size: int = 24) -> str:
    """Return the causal 1-bar-confirmed fast trend regime (UPTREND / DOWNTREND / SIDEWAYS)."""
    clean = [float(value) for value in values if math.isfinite(float(value))]
    if len(clean) < window_size:
        return "UNKNOWN"
    state = "SIDEWAYS"
    pending: Optional[str] = None
    pending_count = 0
    for index in range(window_size - 1, len(clean)):
        score = _trend_score(clean[index - (window_size - 1):index + 1])
        if state == "UPTREND":
            target = "DOWNTREND" if score <= -0.20 else ("SIDEWAYS" if score < 0.05 else "UPTREND")
        elif state == "DOWNTREND":
            target = "UPTREND" if score >= 0.20 else ("SIDEWAYS" if score > -0.05 else "DOWNTREND")
        else:
            target = "UPTREND" if score >= 0.20 else ("DOWNTREND" if score <= -0.20 else "SIDEWAYS")
        if target == state:
            pending, pending_count = None, 0
        else:
            if target == pending:
                pending_count += 1
            else:
                pending, pending_count = target, 1
            if pending_count >= 2:
                state, pending, pending_count = target, None, 0
    return state


def _macro_trend_aligned(values: List[float], candidate_side: int,
                         span: int = OU_MACRO_EMA_SPAN,
                         slope_bars: int = OU_MACRO_SLOPE_BARS) -> bool:
    """Check Condition #5 (Macro trend / Green-Red range alignment).

    Requires at least 60 completed bars (1h on 1m or 5h on 5m) before enforcing
    so short-window unit tests without macro warmup remain unaffected.
    Uses responsive 1-bar trend regime as primary directional filter:
    Blocks Shorts during UPTREND and Longs during DOWNTREND. In SIDEWAYS regime,
    checks macro EMA slope.
    """
    if len(values) < 60:
        return True
    direction = classify_trend_direction(values)
    if candidate_side < 0 and direction == "UPTREND":
        return False
    if candidate_side > 0 and direction == "DOWNTREND":
        return False
    if direction == "SIDEWAYS":
        macro_slope = _ou_macro_ema_slope(values[:-1], span, slope_bars)
        if candidate_side < 0 and macro_slope is not None and macro_slope > 0:
            return False
        if candidate_side > 0 and macro_slope is not None and macro_slope < 0:
            return False
    return True


def evaluate_ou_signals(
    ratios: List[float], *, entry_z: float, exit_z: float,
    ou_halflife_max: float, ou_stop_z: float,
    evaluation_time: Optional[int] = None,
    ou_min_abs_deviation_pp: float = OU_MIN_ABS_DEVIATION_PP,
    ou_macro_ema_span: int = OU_MACRO_EMA_SPAN,
    ou_macro_slope_bars: int = OU_MACRO_SLOPE_BARS,
    ou_use_entry_z: bool = True,
    ou_use_halflife: bool = True,
    ou_use_min_abs_deviation: bool = True,
    ou_use_macro_trend: bool = True,
    ou_use_stop_zone: bool = True,
    ou_use_exit_z: bool = True,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Evaluate the production OU rules on completed ratios only.

    Callers own candle completion and execution. Keeping this calculation pure
    makes historical signal replay and live decisions identical for the same
    ratio prefix.
    """
    if len(ratios) < 25:
        raise ValueError("OU evaluation requires at least 25 completed ratios")
    window = min(24, len(ratios) - 1)
    sample = ratios[-window:]
    mean = sum(sample) / len(sample)
    x_prev = sample[:-1]
    x_curr = sample[1:]
    n = len(x_prev)
    mean_prev = sum(x_prev) / n
    mean_curr = sum(x_curr) / n
    var_prev = sum((value - mean_prev) ** 2 for value in x_prev)
    covariance = sum(
        (x_prev[index] - mean_prev) * (x_curr[index] - mean_curr)
        for index in range(n)
    )
    coefficient = covariance / var_prev if var_prev > 1e-12 else 0.95
    coefficient = max(0.01, min(0.999, coefficient))
    intercept = mean_curr - coefficient * mean_prev
    ou_mean = intercept / (1.0 - coefficient) if abs(1.0 - coefficient) > 1e-6 else mean
    theta = -math.log(coefficient)
    half_life_bars = math.log(2.0) / theta if theta > 1e-6 else 24.0
    residuals = [
        x_curr[index] - (coefficient * x_prev[index] + intercept)
        for index in range(n)
    ]
    sigma = math.sqrt(sum(value ** 2 for value in residuals) / n) if n else 0.05
    denominator = sigma / math.sqrt(2 * theta) if theta > 0 and sigma > 0 else 0.1
    z_score = (ratios[-1] - ou_mean) / denominator if denominator > 1e-6 else 0.0
    candidate_side = -1 if z_score > 0 else 1
    abs_deviation_pp = abs(ratios[-1] - ou_mean)
    macro_slope = _ou_macro_ema_slope(ratios, ou_macro_ema_span, ou_macro_slope_bars)
    macro_aligned = bool(macro_slope is not None and
                         (macro_slope >= 0 if candidate_side > 0 else macro_slope <= 0))
    condition_pass = {
        "entry_z": math.isfinite(z_score) and z_score != 0 and abs(z_score) >= entry_z,
        "entry_stop_zone": math.isfinite(z_score) and abs(z_score) < ou_stop_z,
        "entry_halflife": half_life_bars <= ou_halflife_max * 4,
        "entry_min_deviation": abs_deviation_pp >= ou_min_abs_deviation_pp,
        "entry_macro_trend": macro_aligned,
        "exit_z": abs(z_score) <= exit_z,
        "exit_emergency_stop": abs(z_score) >= ou_stop_z,
    }
    entry_signal = bool(
        math.isfinite(z_score) and z_score != 0
        and (not ou_use_entry_z or abs(z_score) >= entry_z)
        and (not ou_use_stop_zone or abs(z_score) < ou_stop_z)
        and (not ou_use_halflife or half_life_bars <= ou_halflife_max * 4)
        and (not ou_use_min_abs_deviation or abs_deviation_pp >= ou_min_abs_deviation_pp)
        and (not ou_use_macro_trend or macro_aligned))
    exit_signal = bool((ou_use_exit_z and abs(z_score) <= exit_z) or abs(z_score) >= ou_stop_z)
    evaluation = {
        "time": evaluation_time,
        "ratio": round(ratios[-1], 4),
        "mean": round(ou_mean, 4),
        "z": round(z_score, 3),
        "strategy": "ou_quant",
        "theta": round(theta, 4),
        "half_life_bars": round(half_life_bars, 1),
        "stop_z": ou_stop_z,
        "abs_deviation_pp": abs_deviation_pp,
        "min_abs_deviation_pp": ou_min_abs_deviation_pp,
        "macro_ema_span": ou_macro_ema_span,
        "macro_slope_bars": ou_macro_slope_bars,
        "macro_ema_slope": macro_slope,
        "macro_aligned": macro_aligned,
        "condition_pass": condition_pass,
        "ou_use_entry_z": ou_use_entry_z,
        "ou_use_halflife": ou_use_halflife,
        "ou_use_min_abs_deviation": ou_use_min_abs_deviation,
        "ou_use_macro_trend": ou_use_macro_trend,
        "ou_use_stop_zone": ou_use_stop_zone,
        "ou_use_exit_z": ou_use_exit_z,
        # Preserve the exact fitted parameters for the executable-quote check.
        # Rounded display values can flip a decision near the entry threshold.
        "signal_mean": ou_mean,
        "signal_scale": denominator,
        "signal_z": z_score,
    }
    return entry_signal, candidate_side, exit_signal, evaluation


def evaluate_grid_signals(
    ratios: List[float], *, entry_z: float, exit_z: float,
    use_ma_stretch: bool = True, use_base_spacing: bool = True, use_peak: bool = True,
    use_ma_stack: bool = False, use_ma_stack_1h: bool = True,
    use_convergence: bool = True, use_dwell: bool = True,
    use_bottoming: bool = False, base_spacing_pct: float = 0.2, min_dwell_bars: int = 4,
    evaluation_time: Optional[int] = None, position_side: int = 0, entry_price: float = 0.0,
    held_bars: int = 0,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Grid signals with full user-configurable condition switches."""
    if len(ratios) < 25:
        raise ValueError("Grid evaluation requires at least 25 completed ratios")
    sample = ratios[-25:-1]
    mean = sum(sample) / len(sample)
    variance = sum((value - mean) ** 2 for value in sample) / len(sample)
    zscore = (ratios[-1] - mean) / math.sqrt(variance) if variance > 1e-12 else 0.0
    candidate_side = -1 if zscore > 0 else 1
    current_price = ratios[-1]

    prev_zscore = None
    if len(ratios) >= 26:
        prev_sample = ratios[-26:-2]
        prev_mean = sum(prev_sample) / len(prev_sample)
        prev_var = sum((v - prev_mean) ** 2 for v in prev_sample) / len(prev_sample)
        prev_zscore = (ratios[-2] - prev_mean) / math.sqrt(prev_var) if prev_var > 1e-12 else 0.0

    entry_z_pass = abs(zscore) >= entry_z if use_ma_stretch else True
    step_dist = current_price * max(0.0, min(10.0, base_spacing_pct)) / 100.0
    spacing_pass = True
    if position_side != 0 and entry_price > 0:
        spacing_pass = (not use_base_spacing
                        or (candidate_side < 0 and current_price >= entry_price + step_dist)
                        or (candidate_side > 0 and current_price <= entry_price - step_dist))

    peak_pass = (not use_peak or prev_zscore is None or abs(zscore) <= abs(prev_zscore))
    ma7 = sum(ratios[-8:-1]) / 7 if len(ratios) >= 8 else mean
    stack_pass = ((zscore > 0 and current_price > ma7 > mean)
                  or (zscore < 0 and current_price < ma7 < mean))
    ma_stack_pass = not use_ma_stack or stack_pass
    macro_aligned = _macro_trend_aligned(ratios, candidate_side)
    ma_stack_1h_pass = not use_ma_stack_1h or macro_aligned

    entry_signal = bool(entry_z_pass and spacing_pass and peak_pass and ma_stack_pass and ma_stack_1h_pass)

    convergence_pass = abs(zscore) <= exit_z if use_convergence else True
    dwell_pass = not use_dwell or held_bars >= max(0, min(100, min_dwell_bars))
    bottoming_pass = (not use_bottoming or prev_zscore is None or abs(zscore) >= abs(prev_zscore))

    if position_side != 0:
        exit_signal = bool(convergence_pass and dwell_pass and bottoming_pass)
    else:
        exit_signal = bool(abs(zscore) <= exit_z if use_convergence else True)

    condition_pass = {
        "entry_z": entry_z_pass,
        "entry_spacing": spacing_pass,
        "entry_rollover": peak_pass,
        "entry_ma_stack": stack_pass,
        "entry_ma_stack_1h": macro_aligned,
        "exit_convergence": convergence_pass if position_side else abs(zscore) <= exit_z,
        "exit_dwell": dwell_pass if position_side else True,
        "exit_bottoming": bottoming_pass if position_side else True,
    }
    return entry_signal, candidate_side, exit_signal, {
        "time": evaluation_time, "ratio": round(ratios[-1], 4),
        "mean": round(mean, 4), "z": round(zscore, 3),
        "signal_z": zscore, "signal_mean": mean, "strategy": "grid",
        "condition_pass": condition_pass,
    }


def evaluate_ma_stack_signals(
    prices: List[float], *, ma_stretch_min: float = 0.30, ma_trailing_stop: float = 0.15,
    use_ma_stretch: bool = True, use_ma_stack: bool = True, use_ma_stack_1h: bool = True,
    evaluation_time: Optional[int] = None, position_side: int = 0, entry_price: float = 0.0,
    held_bars: int = 0,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Causal Trend MA Stack evaluation (MA7 / MA24 / MA60)."""
    if len(prices) < 61:
        raise ValueError("MA stack evaluation requires at least 61 completed bars")
    current_price = prices[-1]
    ma7 = sum(prices[-8:-1]) / 7
    ma24 = sum(prices[-25:-1]) / 24
    ma60 = sum(prices[-61:-1]) / 60
    sample = prices[-25:-1]
    mean = sum(sample) / len(sample)
    variance = sum((v - mean) ** 2 for v in sample) / len(sample)
    std = math.sqrt(variance)
    zscore = (current_price - mean) / std if std > 1e-12 else 0.0
    stretch_pct = abs(current_price - ma60) / ma60 * 100 if ma60 > 1e-12 else 0.0
    bearish_stack = current_price < ma7 < ma24 < ma60
    bullish_stack = current_price > ma7 > ma24 > ma60
    candidate_side = 1 if bearish_stack else -1

    stack_pass = (bearish_stack or bullish_stack) if use_ma_stack else True
    stretch_pass = stretch_pct >= ma_stretch_min if use_ma_stretch else True

    macro_aligned = _macro_trend_aligned(prices, candidate_side)
    macro_pass = macro_aligned if use_ma_stack_1h else True

    entry_signal = bool(stack_pass and stretch_pass and macro_pass)

    golden_cross = bool((position_side > 0 and ma7 >= ma24) or (position_side < 0 and ma7 <= ma24))
    exit_signal = bool(golden_cross or held_bars >= 16) if position_side != 0 else False
    condition_pass = {
        "entry_ma_stack": stack_pass,
        "entry_stretch": stretch_pass,
        "entry_macro_trend": macro_pass,
        "entry_ma_stack_1h": macro_aligned,
        "exit_ma_cross": golden_cross if position_side else None,
        "exit_trailing_stop": None,
        "exit_max_dwell": held_bars >= 16 if position_side else None,
    }
    evaluation = {
        "time": evaluation_time, "ratio": round(current_price, 4), "mean": round(ma24, 4),
        "z": round(zscore, 3), "signal_z": zscore, "signal_mean": ma24, "strategy": "ma_stack",
        "stretch_pct": round(stretch_pct, 4), "ma7": round(ma7, 4), "ma24": round(ma24, 4),
        "ma60": round(ma60, 4), "bearish_stack": bearish_stack, "bullish_stack": bullish_stack,
        "condition_pass": condition_pass,
    }
    return entry_signal, candidate_side, exit_signal, evaluation


def evaluate_multi_factor_signals(
    prices: List[float], *, entry_z: float = 1.5, exit_z: float = 0.25,
    min_consensus_votes: int = 3, use_ma_stack_1h: bool = True,
    evaluation_time: Optional[int] = None,
    position_side: int = 0, entry_price: float = 0.0, held_bars: int = 0,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Causal Multi-Factor Consensus Gate evaluation."""
    if len(prices) < 25:
        raise ValueError("Multi-factor evaluation requires at least 25 completed bars")
    current_price = prices[-1]
    sample = prices[-25:-1]
    mean = sum(sample) / len(sample)
    variance = sum((v - mean) ** 2 for v in sample) / len(sample)
    std = math.sqrt(variance)
    zscore = (current_price - mean) / std if std > 1e-12 else 0.0

    f1 = abs(zscore) >= entry_z
    v_curr = abs(current_price - prices[-2]) if len(prices) >= 2 else 0.0
    v_prev = abs(prices[-2] - prices[-3]) if len(prices) >= 3 else 0.01
    f2 = v_curr >= v_prev
    ma7 = sum(prices[-8:-1]) / 7 if len(prices) >= 8 else mean
    f3 = abs(current_price - ma7) >= (current_price * 0.001)
    local_vals = prices[-13:-1] if len(prices) >= 13 else sample
    f4 = bool((current_price >= max(local_vals) * 0.9995) or (current_price <= min(local_vals) * 1.0005))

    votes = sum([f1, f2, f3, f4])
    candidate_side = -1 if zscore > 0 else 1
    macro_aligned = _macro_trend_aligned(prices, candidate_side)
    macro_pass = not use_ma_stack_1h or macro_aligned
    entry_signal = bool(votes >= min_consensus_votes and abs(zscore) >= 0.8 and macro_pass)

    current_votes = sum([
        abs(zscore) >= entry_z * 0.5,
        abs(current_price - prices[-2]) > (current_price * 0.0005) if len(prices) >= 2 else False,
        abs(current_price - mean) > (current_price * 0.001),
        held_bars < 8,
    ])
    consensus_drop = current_votes < 2
    convergence = abs(zscore) <= exit_z
    exit_signal = bool(((consensus_drop and held_bars >= 3) or convergence or held_bars >= 20) if position_side else convergence)
    condition_pass = {
        "entry_factor_z": f1,
        "entry_factor_velocity": f2,
        "entry_factor_ma": f3,
        "entry_factor_extremum": f4,
        "entry_quorum": votes >= min_consensus_votes,
        "entry_min_z": abs(zscore) >= 0.8,
        "entry_ma_stack_1h": macro_aligned,
        "exit_consensus": (consensus_drop and held_bars >= 3) if position_side else None,
        "exit_convergence": convergence,
        "exit_max_dwell": held_bars >= 20 if position_side else None,
    }
    evaluation = {
        "time": evaluation_time, "ratio": round(current_price, 4), "mean": round(mean, 4),
        "z": round(zscore, 3), "signal_z": zscore, "signal_mean": mean, "strategy": "multi_factor",
        "votes": votes, "min_consensus_votes": min_consensus_votes, "condition_pass": condition_pass,
    }
    return entry_signal, candidate_side, exit_signal, evaluation


def evaluate_trend_pullback_signals(
    prices: List[float], *, trend_macro_window: int = 24, trend_pullback_dist: float = 0.15,
    trend_tp_dist: float = 0.05, trend_slope_min: float = 0.002, use_ma_stack_1h: bool = True,
    evaluation_time: Optional[int] = None,
    position_side: int = 0, entry_price: float = 0.0, held_bars: int = 0,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Causal Macro Trendline Reversion evaluation."""
    w = max(12, min(60, int(trend_macro_window)))
    if len(prices) < w + 1:
        raise ValueError(f"Trend pullback evaluation requires at least {w + 1} completed bars")
    current_price = prices[-1]
    sample = prices[-w-1:-1]
    n = len(sample)
    x_bar = (n - 1) / 2.0
    y_bar = sum(sample) / n
    var_x = sum((k - x_bar) ** 2 for k in range(n))
    cov_xy = sum((k - x_bar) * (sample[k] - y_bar) for k in range(n))
    beta = cov_xy / var_x if var_x > 1e-12 else 0.0
    alpha = y_bar - beta * x_bar
    trendline_val = alpha + beta * (n - 1)
    residuals = [sample[k] - (alpha + beta * k) for k in range(n)]
    std_res = math.sqrt(sum(r ** 2 for r in residuals) / n) if n else 0.1
    z_trend = (current_price - trendline_val) / std_res if std_res > 1e-6 else 0.0

    is_uptrend = beta >= trend_slope_min
    is_downtrend = beta <= -trend_slope_min

    prev_val = prices[-2]
    prev_prev_val = prices[-3] if len(prices) >= 3 else prev_val
    micro_reverting_up = (current_price > prev_val) and (prev_val <= prev_prev_val)
    micro_reverting_down = (current_price < prev_val) and (prev_val >= prev_prev_val)

    pullback_gap = current_price * (trend_pullback_dist / 100.0)
    tp_gap = current_price * (trend_tp_dist / 100.0)

    buy_signal = is_uptrend and (trendline_val - current_price >= pullback_gap) and micro_reverting_up
    short_signal = is_downtrend and (current_price - trendline_val >= pullback_gap) and micro_reverting_down
    candidate_side = 1 if buy_signal else -1
    macro_aligned = _macro_trend_aligned(prices, candidate_side)
    macro_pass = not use_ma_stack_1h or macro_aligned
    entry_signal = bool((buy_signal or short_signal) and macro_pass)

    current_pnl = position_side * (current_price / entry_price - 1) * 100 if (position_side != 0 and entry_price > 0) else 0.0
    if position_side > 0:
        tp_reached = current_price >= (trendline_val + tp_gap)
        opposite_reversal = (current_price > trendline_val) and micro_reverting_down
        trend_invalidated = beta < -trend_slope_min
    elif position_side < 0:
        tp_reached = current_price <= (trendline_val - tp_gap)
        opposite_reversal = (current_price < trendline_val) and micro_reverting_up
        trend_invalidated = beta > trend_slope_min
    else:
        tp_reached = False
        opposite_reversal = False
        trend_invalidated = False

    stop_loss = current_pnl <= -1.5 or held_bars >= 32
    exit_signal = bool((tp_reached or (opposite_reversal and current_pnl > 0) or trend_invalidated or stop_loss) if position_side else False)

    condition_pass = {
        "entry_macro_trend": (is_uptrend or is_downtrend) and macro_pass,
        "entry_ma_stack_1h": macro_aligned,
        "entry_pullback": bool((is_uptrend and trendline_val - current_price >= pullback_gap)
                               or (is_downtrend and current_price - trendline_val >= pullback_gap)),
        "entry_micro_reversal": bool((is_uptrend and micro_reverting_up)
                                     or (is_downtrend and micro_reverting_down)),
        "exit_target": tp_reached if position_side else None,
        "exit_opposite_reversal": (opposite_reversal and current_pnl > 0) if position_side else None,
        "exit_trend_invalidation": trend_invalidated if position_side else None,
        "exit_stop_or_dwell": (current_pnl <= -1.5 or held_bars >= 32) if position_side else None,
    }
    evaluation = {
        "time": evaluation_time, "ratio": round(current_price, 4), "mean": round(trendline_val, 4),
        "z": round(z_trend, 3), "signal_z": z_trend, "signal_mean": trendline_val,
        "strategy": "trend_pullback", "beta": round(beta, 5), "trendline": round(trendline_val, 4),
        "condition_pass": condition_pass,
    }
    return entry_signal, candidate_side, exit_signal, evaluation


def evaluate_custom_signals(
    prices: List[float], *, entry_z: float = 1.5, exit_z: float = 0.25,
    use_ma_stretch: bool = True, use_base_spacing: bool = True, use_peak: bool = True,
    use_ma_stack: bool = False, use_ma_stack_1h: bool = True,
    use_convergence: bool = True, use_dwell: bool = True,
    use_bottoming: bool = False, base_spacing_pct: float = 0.2, min_dwell_bars: int = 4,
    evaluation_time: Optional[int] = None, position_side: int = 0, entry_price: float = 0.0,
    held_bars: int = 0,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Custom Rule Composer signals."""
    entry_signal, candidate_side, exit_signal, evaluation = evaluate_grid_signals(
        prices, entry_z=entry_z, exit_z=exit_z,
        use_ma_stretch=use_ma_stretch, use_base_spacing=use_base_spacing,
        use_peak=use_peak, use_ma_stack=use_ma_stack, use_ma_stack_1h=use_ma_stack_1h,
        use_convergence=use_convergence, use_dwell=use_dwell,
        use_bottoming=use_bottoming, base_spacing_pct=base_spacing_pct,
        min_dwell_bars=min_dwell_bars, evaluation_time=evaluation_time,
        position_side=position_side, entry_price=entry_price, held_bars=held_bars,
    )
    evaluation["strategy"] = "custom"
    return entry_signal, candidate_side, exit_signal, evaluation


def evaluate_ma_acceleration_signals(
    prices: List[float],
    *,
    ma_accel_period: int = 24,
    ma_accel_min_slope: float = 0.0,
    ma_accel_min_accel: float = 0.0,
    use_ma_slope: bool = True,
    use_ma_accel: bool = True,
    use_ma_pullback: bool = True,
    use_ma_cross_exit: bool = True,
    use_ma_stack_1h: bool = True,
    evaluation_time: Optional[int] = None,
    position_side: int = 0,
    entry_price: float = 0.0,
    held_bars: int = 0,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Newtonian Moving Average Velocity & Acceleration Strategy.

    For a given 5m MA:
    - Long Setup:
      1. MA is rising (V_t > min_slope >= 0)
      2. MA is accelerating (A_t > min_accel >= 0)
      3. Price is below the MA (Price < MA)
      Exit: Price recovers and crosses above the MA (Price >= MA)
    - Short Setup (opposite):
      1. MA is falling (V_t < -min_slope <= 0)
      2. MA is decelerating / accelerating downward (A_t < -min_accel <= 0)
      3. Price is above the MA (Price > MA)
      Exit: Price drops and crosses below the MA (Price <= MA)
    """
    w = max(3, int(ma_accel_period))
    if len(prices) < w + 2:
        raise ValueError(f"MA Acceleration evaluation requires at least {w + 2} completed bars")

    current_price = prices[-1]

    # Compute 3 consecutive MA values to get first derivative (velocity) and second derivative (acceleration)
    ma_curr = sum(prices[-w:]) / w
    ma_prev = sum(prices[-w-1:-1]) / w
    ma_prev2 = sum(prices[-w-2:-2]) / w

    # Velocity (first derivative / slope per bar)
    slope_curr = ma_curr - ma_prev
    slope_prev = ma_prev - ma_prev2

    # Acceleration (second derivative / curvature per bar)
    accel_curr = slope_curr - slope_prev

    min_slope = max(0.0, float(ma_accel_min_slope))
    min_accel = max(0.0, float(ma_accel_min_accel))

    # Long condition components:
    long_rising = slope_curr > min_slope
    long_accel = accel_curr > min_accel
    long_pullback = current_price < ma_curr

    # Short condition components:
    short_falling = slope_curr < -min_slope
    short_decel = accel_curr < -min_accel
    short_bounce = current_price > ma_curr

    # Determine candidate side based on active momentum regime
    candidate_side = 1 if (long_rising and long_accel) else (-1 if (short_falling and short_decel) else (1 if current_price < ma_curr else -1))

    macro_aligned = _macro_trend_aligned(prices, candidate_side)
    macro_pass = not use_ma_stack_1h or macro_aligned

    if candidate_side > 0:
        slope_pass = not use_ma_slope or long_rising
        accel_pass = not use_ma_accel or long_accel
        pullback_pass = not use_ma_pullback or long_pullback
        entry_signal = bool(slope_pass and accel_pass and pullback_pass and macro_pass)
    else:
        slope_pass = not use_ma_slope or short_falling
        accel_pass = not use_ma_accel or short_decel
        pullback_pass = not use_ma_pullback or short_bounce
        entry_signal = bool(slope_pass and accel_pass and pullback_pass and macro_pass)

    # Exit conditions:
    tp_exit = False
    if position_side > 0:
        tp_exit = current_price >= ma_curr if use_ma_cross_exit else False
    elif position_side < 0:
        tp_exit = current_price <= ma_curr if use_ma_cross_exit else False

    current_pnl = position_side * (current_price / entry_price - 1) * 100 if (position_side != 0 and entry_price > 0) else 0.0
    emergency_stop = current_pnl <= -2.0 or held_bars >= 32
    exit_signal = bool((tp_exit or emergency_stop) if position_side != 0 else False)

    condition_pass = {
        "entry_ma_slope": slope_pass,
        "entry_ma_accel": accel_pass,
        "entry_ma_pullback": pullback_pass,
        "entry_ma_stack_1h": macro_aligned,
        "exit_ma_cross": tp_exit if position_side else None,
        "exit_emergency_stop": emergency_stop if position_side else None,
    }

    evaluation = {
        "time": evaluation_time,
        "ratio": round(current_price, 4),
        "mean": round(ma_curr, 4),
        "z": round((current_price - ma_curr) / max(1e-6, ma_curr * 0.01), 3),
        "signal_mean": ma_curr,
        "strategy": "ma_acceleration",
        "ma_period": w,
        "slope": round(slope_curr, 5),
        "prev_slope": round(slope_prev, 5),
        "acceleration": round(accel_curr, 6),
        "price_vs_ma": round(current_price - ma_curr, 4),
        "price_vs_ma_pct": round((current_price / ma_curr - 1) * 100, 3),
        "candidate_side": candidate_side,
        "condition_pass": condition_pass,
    }
    return entry_signal, candidate_side, exit_signal, evaluation

def evaluate_golden_death_cross_signals(
    prices: List[float],
    *,
    fast_ma_period: int = 9,
    slow_ma_period: int = 21,
    min_cross_spread_bps: float = 0.0,
    use_golden_cross: bool = True,
    use_death_cross: bool = True,
    use_cross_spread: bool = True,
    use_cross_exit: bool = True,
    use_ma_stack_1h: bool = True,
    use_dwell: bool = False,
    min_dwell_bars: int = 2,
    evaluation_time: Optional[int] = None,
    position_side: int = 0,
    entry_price: float = 0.0,
    held_bars: int = 0,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Dual Moving Average Crossover Strategy (Golden & Death Cross).

    Evaluates completed price candles for MA crossovers:
    - Golden Cross: Fast MA crosses above Slow MA (Bullish -> Long Entry / Short Exit)
    - Death Cross: Fast MA crosses below Slow MA (Bearish -> Short Entry / Long Exit)
    """
    fast_w = max(2, int(fast_ma_period))
    slow_w = max(fast_w + 1, int(slow_ma_period))
    if len(prices) < slow_w + 1:
        raise ValueError(f"Golden & Death Cross evaluation requires at least {slow_w + 1} completed bars")

    current_price = prices[-1]

    # Current moving averages
    fast_curr = sum(prices[-fast_w:]) / fast_w
    slow_curr = sum(prices[-slow_w:]) / slow_w

    # Previous bar moving averages
    fast_prev = sum(prices[-fast_w - 1 : -1]) / fast_w
    slow_prev = sum(prices[-slow_w - 1 : -1]) / slow_w

    # Crossover occurrences
    golden_cross = (fast_prev <= slow_prev) and (fast_curr > slow_curr)
    death_cross = (fast_prev >= slow_prev) and (fast_curr < slow_curr)

    # Spread calculation
    spread_diff = fast_curr - slow_curr
    spread_pct = (spread_diff / slow_curr) * 100.0 if slow_curr > 1e-9 else 0.0
    spread_bps = abs(spread_pct) * 100.0
    min_bps = max(0.0, float(min_cross_spread_bps))
    spread_pass = (not use_cross_spread) or (spread_bps >= min_bps)

    # Candidate side determination
    if golden_cross:
        candidate_side = 1
        macro_aligned = _macro_trend_aligned(prices, 1)
        macro_pass = not use_ma_stack_1h or macro_aligned
        entry_signal = bool(use_golden_cross and spread_pass and macro_pass)
    elif death_cross:
        candidate_side = -1
        macro_aligned = _macro_trend_aligned(prices, -1)
        macro_pass = not use_ma_stack_1h or macro_aligned
        entry_signal = bool(use_death_cross and spread_pass and macro_pass)
    else:
        candidate_side = 1 if fast_curr >= slow_curr else -1
        macro_aligned = _macro_trend_aligned(prices, candidate_side)
        macro_pass = not use_ma_stack_1h or macro_aligned
        entry_signal = False

    # Exit conditions
    tp_exit = False
    dwell_pass = held_bars >= max(1, int(min_dwell_bars))
    if position_side > 0:
        if use_cross_exit:
            # Long exits when Death Cross occurs or Fast MA falls below Slow MA
            tp_exit = (fast_curr <= slow_curr) and (not use_dwell or dwell_pass)
    elif position_side < 0:
        if use_cross_exit:
            # Short exits when Golden Cross occurs or Fast MA rises above Slow MA
            tp_exit = (fast_curr >= slow_curr) and (not use_dwell or dwell_pass)

    current_pnl = (
        position_side * (current_price / entry_price - 1) * 100
        if (position_side != 0 and entry_price > 0)
        else 0.0
    )
    emergency_stop = current_pnl <= -2.0 or held_bars >= 48
    exit_signal = bool((tp_exit or emergency_stop) if position_side != 0 else False)

    condition_pass = {
        "entry_golden_cross": golden_cross if candidate_side > 0 else (not use_golden_cross),
        "entry_death_cross": death_cross if candidate_side < 0 else (not use_death_cross),
        "entry_cross_spread": spread_pass,
        "entry_ma_stack_1h": macro_aligned,
        "exit_cross": tp_exit if position_side else None,
        "exit_dwell": dwell_pass if position_side else None,
        "exit_emergency_stop": emergency_stop if position_side else None,
    }

    regime = (
        "GOLDEN_CROSS"
        if golden_cross
        else (
            "DEATH_CROSS"
            if death_cross
            else ("FAST > SLOW (BULL)" if fast_curr >= slow_curr else "FAST < SLOW (BEAR)")
        )
    )

    evaluation = {
        "time": evaluation_time,
        "ratio": round(current_price, 4),
        "mean": round(slow_curr, 4),
        "signal_mean": slow_curr,
        "z": round((fast_curr - slow_curr) / max(1e-6, slow_curr * 0.001), 3),
        "strategy": "golden_death_cross",
        "fast_ma_period": fast_w,
        "slow_ma_period": slow_w,
        "fast_ma": round(fast_curr, 4),
        "slow_ma": round(slow_curr, 4),
        "prev_fast_ma": round(fast_prev, 4),
        "prev_slow_ma": round(slow_prev, 4),
        "spread_bps": round(spread_bps, 2),
        "spread_pct": round(spread_pct, 4),
        "golden_cross": bool(golden_cross),
        "death_cross": bool(death_cross),
        "regime": regime,
        "candidate_side": candidate_side,
        "condition_pass": condition_pass,
    }
    return entry_signal, candidate_side, exit_signal, evaluation


LIVE_STRATEGIES = {"grid", "ou_quant", "ma_stack", "multi_factor", "trend_pullback", "custom", "ma_acceleration", "golden_death_cross"}


def evaluate_strategy_signal(
    strategy_mode: str,
    prices: List[float],
    config: Dict[str, Any],
    *,
    evaluation_time: Optional[int] = None,
    position_side: int = 0,
    entry_price: float = 0.0,
    held_bars: int = 0,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Dispatch evaluation to any live-deployable quantitative strategy regime."""
    if strategy_mode not in LIVE_STRATEGIES:
        raise ValueError(f"Unsupported strategy mode: {strategy_mode}")
    if strategy_mode == "ou_quant":
        entry_signal, candidate_side, exit_signal, details = evaluate_ou_signals(
            prices,
            entry_z=float(config.get("entry_z", 1.4)),
            exit_z=float(config.get("exit_z", 0.20)),
            ou_halflife_max=float(config.get("ou_halflife_max", 8.0)),
            ou_stop_z=float(config.get("ou_stop_z", 3.5)),
            ou_min_abs_deviation_pp=float(config.get("ou_min_abs_deviation_pp", OU_MIN_ABS_DEVIATION_PP)),
            ou_macro_ema_span=int(config.get("ou_macro_ema_span", OU_MACRO_EMA_SPAN)),
            ou_macro_slope_bars=int(config.get("ou_macro_slope_bars", OU_MACRO_SLOPE_BARS)),
            ou_use_entry_z=bool(config.get("ou_use_entry_z", True)),
            ou_use_halflife=bool(config.get("ou_use_halflife", True)),
            ou_use_min_abs_deviation=bool(config.get("ou_use_min_abs_deviation", True)),
            ou_use_macro_trend=bool(config.get("ou_use_macro_trend", config.get("use_ma_stack_1h", True))),
            ou_use_stop_zone=bool(config.get("ou_use_stop_zone", True)),
            ou_use_exit_z=bool(config.get("ou_use_exit_z", True)),
            evaluation_time=evaluation_time,
        )
    elif strategy_mode == "ma_stack":
        entry_signal, candidate_side, exit_signal, details = evaluate_ma_stack_signals(
            prices,
            ma_stretch_min=float(config.get("ma_stretch_min", 0.30)),
            ma_trailing_stop=float(config.get("ma_trailing_stop", 0.15)),
            use_ma_stretch=bool(config.get("use_ma_stretch", True)),
            use_ma_stack=bool(config.get("use_ma_stack", True)),
            use_ma_stack_1h=bool(config.get("use_ma_stack_1h", True)),
            evaluation_time=evaluation_time,
            position_side=position_side,
            entry_price=entry_price,
            held_bars=held_bars,
        )
    elif strategy_mode == "multi_factor":
        entry_signal, candidate_side, exit_signal, details = evaluate_multi_factor_signals(
            prices,
            entry_z=float(config.get("entry_z", 1.5)),
            exit_z=float(config.get("exit_z", 0.25)),
            min_consensus_votes=int(config.get("min_consensus_votes", 3)),
            use_ma_stack_1h=bool(config.get("use_ma_stack_1h", True)),
            evaluation_time=evaluation_time,
            position_side=position_side,
            entry_price=entry_price,
            held_bars=held_bars,
        )
    elif strategy_mode == "trend_pullback":
        entry_signal, candidate_side, exit_signal, details = evaluate_trend_pullback_signals(
            prices,
            trend_macro_window=int(config.get("trend_macro_window", 24)),
            trend_pullback_dist=float(config.get("trend_pullback_dist", 0.15)),
            trend_tp_dist=float(config.get("trend_tp_dist", 0.05)),
            trend_slope_min=float(config.get("trend_slope_min", 0.002)),
            use_ma_stack_1h=bool(config.get("use_ma_stack_1h", True)),
            evaluation_time=evaluation_time,
            position_side=position_side,
            entry_price=entry_price,
            held_bars=held_bars,
        )
    elif strategy_mode == "ma_acceleration":
        return evaluate_ma_acceleration_signals(
            prices,
            ma_accel_period=int(config.get("ma_accel_period", 24)),
            ma_accel_min_slope=float(config.get("ma_accel_min_slope", 0.0)),
            ma_accel_min_accel=float(config.get("ma_accel_min_accel", 0.0)),
            use_ma_slope=bool(config.get("use_ma_slope", True)),
            use_ma_accel=bool(config.get("use_ma_accel", True)),
            use_ma_pullback=bool(config.get("use_ma_pullback", True)),
            use_ma_cross_exit=bool(config.get("use_ma_cross_exit", True)),
            use_ma_stack_1h=bool(config.get("use_ma_stack_1h", True)),
            evaluation_time=evaluation_time,
            position_side=position_side,
            entry_price=entry_price,
            held_bars=held_bars,
        )
    elif strategy_mode == "golden_death_cross":
        return evaluate_golden_death_cross_signals(
            prices,
            fast_ma_period=int(config.get("fast_ma_period", 9)),
            slow_ma_period=int(config.get("slow_ma_period", 21)),
            min_cross_spread_bps=float(config.get("min_cross_spread_bps", 0.0)),
            use_golden_cross=bool(config.get("use_golden_cross", True)),
            use_death_cross=bool(config.get("use_death_cross", True)),
            use_cross_spread=bool(config.get("use_cross_spread", True)),
            use_cross_exit=bool(config.get("use_cross_exit", True)),
            use_ma_stack_1h=bool(config.get("use_ma_stack_1h", True)),
            use_dwell=bool(config.get("use_dwell", False)),
            min_dwell_bars=int(config.get("min_dwell_bars", 2)),
            evaluation_time=evaluation_time,
            position_side=position_side,
            entry_price=entry_price,
            held_bars=held_bars,
        )
    elif strategy_mode == "custom":
        return evaluate_custom_signals(
            prices,
            entry_z=float(config.get("entry_z", 1.5)),
            exit_z=float(config.get("exit_z", 0.25)),
            use_ma_stretch=bool(config.get("use_ma_stretch", True)),
            use_base_spacing=bool(config.get("use_base_spacing", True)),
            use_peak=bool(config.get("use_peak", True)),
            use_ma_stack=bool(config.get("use_ma_stack", False)),
            use_ma_stack_1h=bool(config.get("use_ma_stack_1h", True)),
            use_convergence=bool(config.get("use_convergence", True)),
            use_dwell=bool(config.get("use_dwell", True)),
            use_bottoming=bool(config.get("use_bottoming", False)),
            base_spacing_pct=float(config.get("base_spacing_pct", 0.2)),
            min_dwell_bars=int(config.get("min_dwell_bars", 4)),
            evaluation_time=evaluation_time,
            position_side=position_side,
            entry_price=entry_price,
            held_bars=held_bars,
        )
    else:  # "grid"
        return evaluate_grid_signals(
            prices,
            entry_z=float(config.get("entry_z", 1.5)),
            exit_z=float(config.get("exit_z", 0.25)),
            use_ma_stretch=bool(config.get("use_ma_stretch", True)),
            use_base_spacing=bool(config.get("use_base_spacing", True)),
            use_peak=bool(config.get("use_peak", True)),
            use_ma_stack=bool(config.get("use_ma_stack", False)),
            use_ma_stack_1h=bool(config.get("use_ma_stack_1h", True)),
            use_convergence=bool(config.get("use_convergence", True)),
            use_dwell=bool(config.get("use_dwell", True)),
            use_bottoming=bool(config.get("use_bottoming", False)),
            base_spacing_pct=float(config.get("base_spacing_pct", 0.2)),
            min_dwell_bars=int(config.get("min_dwell_bars", 4)),
            evaluation_time=evaluation_time,
            position_side=position_side,
            entry_price=entry_price,
            held_bars=held_bars,
        )

    current_price = prices[-1] if prices else 0.0
    use_base_spacing = bool(config.get("use_base_spacing", True))
    base_spacing_pct = float(config.get("base_spacing_pct", 0.2))
    step_dist = current_price * max(0.0, min(10.0, base_spacing_pct)) / 100.0
    spacing_pass = True
    if position_side != 0 and entry_price > 0:
        spacing_pass = (not use_base_spacing
                        or (candidate_side < 0 and current_price >= entry_price + step_dist)
                        or (candidate_side > 0 and current_price <= entry_price - step_dist))
    if not spacing_pass:
        entry_signal = False

    use_dwell = bool(config.get("use_dwell", True))
    min_dwell_bars = int(config.get("min_dwell_bars", 4))
    dwell_pass = not use_dwell or held_bars >= max(0, min(100, min_dwell_bars))
    if position_side != 0 and not dwell_pass:
        exit_signal = False

    if isinstance(details.get("condition_pass"), dict):
        details["condition_pass"]["entry_spacing"] = spacing_pass
        details["condition_pass"]["exit_dwell"] = dwell_pass
    return entry_signal, candidate_side, exit_signal, details

