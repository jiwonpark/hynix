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
    use_ma_stack: bool = False, use_convergence: bool = True, use_dwell: bool = True,
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

    entry_signal = bool(entry_z_pass and spacing_pass and peak_pass and ma_stack_pass)

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

    macro_slope = _ou_macro_ema_slope(prices, 60, 12)
    macro_aligned = bool(macro_slope is not None and (macro_slope >= 0 if candidate_side > 0 else macro_slope <= 0)) if macro_slope is not None else True
    macro_pass = macro_aligned if use_ma_stack_1h else True

    entry_signal = bool(stack_pass and stretch_pass and macro_pass)

    golden_cross = bool((position_side > 0 and ma7 >= ma24) or (position_side < 0 and ma7 <= ma24))
    exit_signal = bool(golden_cross or held_bars >= 16) if position_side != 0 else False
    condition_pass = {
        "entry_ma_stack": stack_pass,
        "entry_stretch": stretch_pass,
        "entry_macro_trend": macro_pass,
        "entry_ma_stack_1h": macro_pass,
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
    min_consensus_votes: int = 3, evaluation_time: Optional[int] = None,
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
    entry_signal = bool(votes >= min_consensus_votes and abs(zscore) >= 0.8)

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
    trend_tp_dist: float = 0.05, trend_slope_min: float = 0.002, evaluation_time: Optional[int] = None,
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
    entry_signal = bool(buy_signal or short_signal)
    candidate_side = 1 if buy_signal else -1

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
        "entry_macro_trend": is_uptrend or is_downtrend,
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
    use_ma_stack: bool = False, use_convergence: bool = True, use_dwell: bool = True,
    use_bottoming: bool = False, base_spacing_pct: float = 0.2, min_dwell_bars: int = 4,
    evaluation_time: Optional[int] = None, position_side: int = 0, entry_price: float = 0.0,
    held_bars: int = 0,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Custom Rule Composer signals."""
    entry_signal, candidate_side, exit_signal, evaluation = evaluate_grid_signals(
        prices, entry_z=entry_z, exit_z=exit_z,
        use_ma_stretch=use_ma_stretch, use_base_spacing=use_base_spacing,
        use_peak=use_peak, use_ma_stack=use_ma_stack,
        use_convergence=use_convergence, use_dwell=use_dwell,
        use_bottoming=use_bottoming, base_spacing_pct=base_spacing_pct,
        min_dwell_bars=min_dwell_bars, evaluation_time=evaluation_time,
        position_side=position_side, entry_price=entry_price, held_bars=held_bars,
    )
    evaluation["strategy"] = "custom"
    return entry_signal, candidate_side, exit_signal, evaluation


LIVE_STRATEGIES = {"grid", "ou_quant", "ma_stack", "multi_factor", "trend_pullback", "custom"}


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

