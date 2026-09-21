"""Cross-sectional momentum ranking for the Upbit KRW universe."""
import math
import statistics
from typing import Any, Dict, List


def _pct_change(new: float, old: float) -> float:
    return ((new / old) - 1.0) * 100.0 if old > 0 else 0.0


def _rsi(closes: List[float], period: int = 14) -> float:
    changes = [b - a for a, b in zip(closes[-period - 1:-1], closes[-period:])]
    if not changes:
        return 50.0
    gains = sum(max(change, 0.0) for change in changes) / len(changes)
    losses = sum(max(-change, 0.0) for change in changes) / len(changes)
    if losses == 0:
        return 100.0 if gains else 50.0
    return 100.0 - 100.0 / (1.0 + gains / losses)


def coin_factors(ticker: Dict[str, Any], candles: List[Dict[str, Any]]) -> Dict[str, float]:
    """Calculate causal factors from completed 1h candles and a live 24h ticker."""
    closes = [float(row["close"]) for row in candles if float(row.get("close", 0)) > 0]
    if len(closes) < 25:
        raise ValueError("At least 25 completed hourly candles are required")
    returns = [math.log(b / a) for a, b in zip(closes[:-1], closes[1:]) if a > 0 and b > 0]
    volatility = statistics.pstdev(returns[-24:]) * math.sqrt(24) * 100 if returns else 0.0
    positive_hours = sum(change > 0 for change in returns[-12:]) / min(12, len(returns)) * 100
    high_24 = max(closes[-24:])
    low_24 = min(closes[-24:])
    range_position = (closes[-1] - low_24) / (high_24 - low_24) * 100 if high_24 > low_24 else 50.0
    return {
        "momentum_1h_pct": _pct_change(closes[-1], closes[-2]),
        "momentum_6h_pct": _pct_change(closes[-1], closes[-7]),
        "momentum_24h_pct": _pct_change(closes[-1], closes[-25]),
        "trend_consistency_pct": positive_hours,
        "rsi_14": _rsi(closes),
        "range_position_pct": range_position,
        "volatility_24h_pct": volatility,
        "trade_value_24h_krw": float(ticker.get("acc_trade_price_24h", 0.0)),
    }


def _percentile(values: List[float], value: float) -> float:
    if len(values) <= 1:
        return 50.0
    below = sum(item < value for item in values)
    equal = sum(item == value for item in values)
    return (below + 0.5 * equal) / len(values) * 100.0


def rank_universe(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Apply robust cross-sectional percentiles and return best scores first."""
    if not rows:
        return []
    factor_keys = ("momentum_1h_pct", "momentum_6h_pct", "momentum_24h_pct",
                   "trend_consistency_pct", "range_position_pct", "trade_value_24h_krw")
    populations = {key: [float(row[key]) for row in rows] for key in factor_keys}
    volatility = [float(row["volatility_24h_pct"]) for row in rows]
    ranked = []
    for row in rows:
        momentum = (0.20 * _percentile(populations["momentum_1h_pct"], row["momentum_1h_pct"]) +
                    0.30 * _percentile(populations["momentum_6h_pct"], row["momentum_6h_pct"]) +
                    0.20 * _percentile(populations["momentum_24h_pct"], row["momentum_24h_pct"]))
        trend = 0.12 * _percentile(populations["trend_consistency_pct"], row["trend_consistency_pct"])
        breakout = 0.08 * _percentile(populations["range_position_pct"], row["range_position_pct"])
        liquidity = 0.10 * _percentile(populations["trade_value_24h_krw"], row["trade_value_24h_krw"])
        volatility_penalty = 0.10 * _percentile(volatility, row["volatility_24h_pct"])
        score = max(0.0, min(100.0, momentum + trend + breakout + liquidity - volatility_penalty + 5.0))
        enriched = dict(row)
        enriched["score"] = round(score, 2)
        enriched["signal"] = "STRONG" if score >= 70 else "POSITIVE" if score >= 55 else "NEUTRAL" if score >= 40 else "WEAK"
        ranked.append(enriched)
    ranked.sort(key=lambda item: (-item["score"], -item["trade_value_24h_krw"], item["market"]))
    for index, row in enumerate(ranked, 1):
        row["rank"] = index
    return ranked
