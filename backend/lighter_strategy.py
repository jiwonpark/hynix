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
    evaluation_time: Optional[int] = None,
) -> Tuple[bool, int, bool, Dict[str, Any]]:
    """Production Grid/Custom signals; optional research filters belong to replay."""
    if len(ratios) < 25:
        raise ValueError("Grid evaluation requires at least 25 completed ratios")
    sample = ratios[-25:-1]
    mean = sum(sample) / len(sample)
    variance = sum((value - mean) ** 2 for value in sample) / len(sample)
    zscore = (ratios[-1] - mean) / math.sqrt(variance) if variance > 1e-12 else 0.0
    return abs(zscore) >= entry_z, -1 if zscore > 0 else 1, abs(zscore) <= exit_z, {
        "time": evaluation_time, "ratio": round(ratios[-1], 4),
        "mean": round(mean, 4), "z": round(zscore, 3),
        "signal_z": zscore, "signal_mean": mean, "strategy": "grid",
    }
