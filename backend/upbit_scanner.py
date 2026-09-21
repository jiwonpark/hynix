"""Causal pre-move forecasting for the Upbit KRW universe."""
import math
import statistics
from typing import Any, Dict, List, Optional, Tuple

HORIZON_HOURS = 6
UPSIDE_TARGET_PCT = 2.0
DOWNSIDE_BARRIER_PCT = 1.0


def _pct_change(new: float, old: float) -> float:
    return ((new / old) - 1.0) * 100.0 if old > 0 else 0.0


def _rsi(closes: List[float], period: int = 14) -> float:
    changes = [b - a for a, b in zip(closes[-period - 1:-1], closes[-period:])]
    gains = sum(max(change, 0.0) for change in changes) / len(changes) if changes else 0.0
    losses = sum(max(-change, 0.0) for change in changes) / len(changes) if changes else 0.0
    if losses == 0:
        return 100.0 if gains else 50.0
    return 100.0 - 100.0 / (1.0 + gains / losses)


def _feature_at(candles: List[Dict[str, Any]], index: int) -> Optional[Dict[str, float]]:
    """Build features using data at or before index only."""
    if index < 30:
        return None
    window = candles[:index + 1]
    closes = [float(row["close"]) for row in window]
    volumes = [float(row.get("volume", 0.0)) for row in window]
    returns = [math.log(b / a) for a, b in zip(closes[:-1], closes[1:]) if a > 0 and b > 0]
    vol6 = statistics.pstdev(returns[-6:]) if len(returns) >= 6 else 0.0
    vol24 = statistics.pstdev(returns[-24:]) if len(returns) >= 24 else 0.0
    volume3 = statistics.fmean(volumes[-3:])
    volume24 = statistics.fmean(volumes[-24:])
    high24 = max(float(row["high"]) for row in window[-24:])
    low24 = min(float(row["low"]) for row in window[-24:])
    close = closes[-1]
    return {
        "momentum_1h_pct": _pct_change(close, closes[-2]),
        "momentum_3h_pct": _pct_change(close, closes[-4]),
        "momentum_6h_pct": _pct_change(close, closes[-7]),
        "momentum_acceleration": _pct_change(close, closes[-4]) - _pct_change(closes[-4], closes[-7]),
        "volume_acceleration": volume3 / volume24 if volume24 > 0 else 1.0,
        "volatility_compression": vol6 / vol24 if vol24 > 0 else 1.0,
        "range_position_pct": (close - low24) / (high24 - low24) * 100 if high24 > low24 else 50.0,
        "rsi_14": _rsi(closes),
    }


def _outcome(candles: List[Dict[str, Any]], index: int) -> Tuple[int, float]:
    entry = float(candles[index]["close"])
    future = candles[index + 1:index + 1 + HORIZON_HOURS]
    label = 0
    for bar in future:
        hit_up = float(bar["high"]) >= entry * (1.0 + UPSIDE_TARGET_PCT / 100.0)
        hit_down = float(bar["low"]) <= entry * (1.0 - DOWNSIDE_BARRIER_PCT / 100.0)
        if hit_up or hit_down:
            label = 1 if hit_up and not hit_down else 0  # Same-bar ambiguity resolves conservatively.
            break
    realized = _pct_change(float(future[-1]["close"]), entry) if future else 0.0
    return label, realized


def _analogue_prediction(current: Dict[str, float], samples, feature_keys) -> Tuple[float, float, float, int]:
    scales = {}
    for key in feature_keys:
        values = [sample[0][key] for sample in samples]
        scales[key] = max(statistics.pstdev(values), 1e-6)
    distances = []
    for features, label, realized in samples:
        distance = math.sqrt(sum(((features[key] - current[key]) / scales[key]) ** 2 for key in feature_keys) / len(feature_keys))
        distances.append((distance, label, realized))
    neighbors = sorted(distances, key=lambda item: item[0])[:min(25, len(distances))]
    weights = [1.0 / (0.25 + item[0]) for item in neighbors]
    probability = (sum(weight * item[1] for weight, item in zip(weights, neighbors)) + 2.0) / (sum(weights) + 4.0) * 100.0
    expected_return = sum(weight * item[2] for weight, item in zip(weights, neighbors)) / sum(weights)
    mean_distance = statistics.fmean(item[0] for item in neighbors)
    confidence = min(1.0, len(neighbors) / 25.0) * (1.0 / (1.0 + mean_distance)) * 100.0
    return probability, expected_return, confidence, len(neighbors)


def _walk_forward_backtest(candles, feature_keys, samples_by_index) -> Dict[str, float]:
    """Purged expanding-window test; each forecast only sees resolved earlier outcomes."""
    evaluations = []
    start = max(75, len(candles) - 60)
    for test_index in range(start, len(candles) - HORIZON_HOURS, 2):
        # Purge the full outcome horizon between the last training label and test features.
        training = [sample for index, sample in samples_by_index.items()
                    if index < test_index - HORIZON_HOURS]
        if len(training) < 25:
            continue
        current = samples_by_index[test_index][0]
        probability, _, confidence, _ = _analogue_prediction(current, training, feature_keys)
        label, realized = _outcome(candles, test_index)
        evaluations.append((probability, confidence, label, realized))
    if not evaluations:
        return {"predictions": 0, "signals": 0, "signal_hit_rate_pct": 0.0,
                "baseline_hit_rate_pct": 0.0, "brier_score": 1.0,
                "average_signal_return_pct": 0.0, "lift_pct_points": 0.0}
    signals = [row for row in evaluations if row[0] >= 60.0 and row[1] >= 40.0]
    baseline = sum(row[2] for row in evaluations) / len(evaluations) * 100.0
    hit_rate = sum(row[2] for row in signals) / len(signals) * 100.0 if signals else 0.0
    brier = statistics.fmean((row[0] / 100.0 - row[2]) ** 2 for row in evaluations)
    average_return = statistics.fmean(row[3] for row in signals) if signals else 0.0
    return {"predictions": len(evaluations), "signals": len(signals),
            "signal_hit_rate_pct": round(hit_rate, 2), "baseline_hit_rate_pct": round(baseline, 2),
            "brier_score": round(brier, 4), "average_signal_return_pct": round(average_return, 2),
            "lift_pct_points": round(hit_rate - baseline, 2) if signals else 0.0}


def walk_forward_trades(candles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return non-overlapping causal virtual entries/exits for chart rendering."""
    feature_keys = ("momentum_1h_pct", "momentum_3h_pct", "momentum_6h_pct",
                    "momentum_acceleration", "volume_acceleration",
                    "volatility_compression", "range_position_pct", "rsi_14")
    samples_by_index = {}
    for index in range(30, len(candles) - HORIZON_HOURS):
        features = _feature_at(candles, index)
        if features is not None:
            label, realized = _outcome(candles, index)
            samples_by_index[index] = (features, label, realized)
    trades = []
    next_free_index = 0
    for test_index in range(max(75, len(candles) - 90), len(candles) - HORIZON_HOURS):
        if test_index < next_free_index:
            continue
        training = [sample for index, sample in samples_by_index.items()
                    if index < test_index - HORIZON_HOURS]
        if len(training) < 25:
            continue
        probability, expected, confidence, _ = _analogue_prediction(
            samples_by_index[test_index][0], training, feature_keys)
        if probability < 60.0 or confidence < 40.0 or expected <= 0:
            continue
        entry = float(candles[test_index]["close"])
        exit_index = test_index + HORIZON_HOURS
        exit_price = float(candles[exit_index]["close"])
        reason = "HORIZON"
        for index in range(test_index + 1, test_index + 1 + HORIZON_HOURS):
            bar = candles[index]
            hit_up = float(bar["high"]) >= entry * (1 + UPSIDE_TARGET_PCT / 100)
            hit_down = float(bar["low"]) <= entry * (1 - DOWNSIDE_BARRIER_PCT / 100)
            if hit_up or hit_down:
                exit_index = index
                if hit_up and not hit_down:
                    exit_price, reason = entry * (1 + UPSIDE_TARGET_PCT / 100), "TARGET"
                else:
                    exit_price, reason = entry * (1 - DOWNSIDE_BARRIER_PCT / 100), "STOP"
                break
        trades.append({"entry_time": int(candles[test_index]["time"]),
                       "exit_time": int(candles[exit_index]["time"]),
                       "entry_price": entry, "exit_price": exit_price,
                       "return_pct": round(_pct_change(exit_price, entry), 2),
                       "probability_pct": round(probability, 2),
                       "confidence_pct": round(confidence, 2), "exit_reason": reason})
        next_free_index = exit_index + 1
    return trades


def forecast_coin(ticker: Dict[str, Any], candles: List[Dict[str, Any]]) -> Dict[str, float]:
    """Estimate a six-hour upside probability from causal nearest historical analogues."""
    if len(candles) < 60:
        raise ValueError("At least 60 completed hourly candles are required")
    current = _feature_at(candles, len(candles) - 1)
    if current is None:
        raise ValueError("Insufficient feature history")
    feature_keys = ("momentum_1h_pct", "momentum_3h_pct", "momentum_6h_pct",
                    "momentum_acceleration", "volume_acceleration",
                    "volatility_compression", "range_position_pct", "rsi_14")
    samples_by_index = {}
    for index in range(30, len(candles) - HORIZON_HOURS):
        features = _feature_at(candles, index)
        if features is not None:
            label, realized = _outcome(candles, index)
            samples_by_index[index] = (features, label, realized)
    samples = list(samples_by_index.values())
    if not samples:
        raise ValueError("No historical forecast samples")
    probability, expected_return, confidence, neighbor_count = _analogue_prediction(current, samples, feature_keys)
    calibrated_score = 50.0 + (probability - 50.0) * confidence / 100.0
    closes = [float(row["close"]) for row in candles]
    returns = [math.log(b / a) for a, b in zip(closes[:-1], closes[1:])]
    result = {
        **current,
        "forecast_probability_pct": round(probability, 2),
        "expected_return_6h_pct": round(expected_return, 2),
        "forecast_confidence_pct": round(confidence, 2),
        "historical_samples": len(samples),
        "analogue_samples": neighbor_count,
        "score": round(max(0.0, min(100.0, calibrated_score)), 2),
        "volatility_24h_pct": statistics.pstdev(returns[-24:]) * math.sqrt(24) * 100,
        "trade_value_24h_krw": float(ticker.get("acc_trade_price_24h", 0.0)),
    }
    result["backtest"] = _walk_forward_backtest(candles, feature_keys, samples_by_index)
    result["signal"] = "HIGH" if result["score"] >= 60 and expected_return > 0 else "WATCH" if result["score"] >= 53 else "NO EDGE"
    return result


def rank_universe(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Rank forecasts by confidence-shrunk probability, expected return, and liquidity."""
    ranked = sorted(rows, key=lambda item: (-item["score"], -item["expected_return_6h_pct"],
                                             -item["trade_value_24h_krw"], item["market"]))
    for index, row in enumerate(ranked, 1):
        row["rank"] = index
    return ranked
