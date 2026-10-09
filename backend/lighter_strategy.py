"""Pure strategy evaluators shared by Lighter live trading and replay."""
import math
from typing import Any, Dict, List, Optional, Tuple


def evaluate_ou_signals(
    ratios: List[float], *, entry_z: float, exit_z: float,
    ou_halflife_max: float, ou_stop_z: float,
    evaluation_time: Optional[int] = None,
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
    entry_signal = bool(
        abs(z_score) >= entry_z and half_life_bars <= ou_halflife_max * 4)
    exit_signal = bool(abs(z_score) <= exit_z or abs(z_score) >= ou_stop_z)
    evaluation = {
        "time": evaluation_time,
        "ratio": round(ratios[-1], 4),
        "mean": round(ou_mean, 4),
        "z": round(z_score, 3),
        "strategy": "ou_quant",
        "theta": round(theta, 4),
        "half_life_bars": round(half_life_bars, 1),
        "stop_z": ou_stop_z,
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
