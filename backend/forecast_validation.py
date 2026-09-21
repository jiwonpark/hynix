"""Durable, strictly forward Upbit forecast validation ledger."""
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

STATE_FILE = Path(__file__).with_name("upbit_forecast_validation.json")
HORIZON_SECONDS = 6 * 3600
ROUND_TRIP_COST_PCT = 0.20


def _load(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"version": 1, "forecasts": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("forecasts"), list):
        raise ValueError("Invalid forecast validation ledger")
    return data


def _save(path: Path, state: Dict[str, Any]) -> None:
    temporary = path.with_suffix(".tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def _summary(forecasts: List[Dict[str, Any]]) -> Dict[str, Any]:
    resolved = [item for item in forecasts if item.get("status") == "resolved"]
    signals = [item for item in resolved if item.get("qualified")]
    baseline = sum(item["target_hit"] for item in resolved) / len(resolved) * 100 if resolved else 0.0
    hit_rate = sum(item["target_hit"] for item in signals) / len(signals) * 100 if signals else 0.0
    average_net = sum(item["net_return_pct"] for item in signals) / len(signals) if signals else 0.0
    brier = sum((item["calibrated_probability_pct"] / 100 - item["target_hit"]) ** 2 for item in resolved) / len(resolved) if resolved else 1.0
    lift = hit_rate - baseline if signals else 0.0
    ready = len(signals) >= 200 and lift >= 3.0 and average_net > 0.10 and brier <= 0.22
    return {"resolved_forecasts": len(resolved), "pending_forecasts": sum(item.get("status") == "pending" for item in forecasts),
            "qualified_signals": len(signals), "signal_hit_rate_pct": round(hit_rate, 2),
            "baseline_hit_rate_pct": round(baseline, 2), "lift_pct_points": round(lift, 2),
            "average_net_return_pct": round(average_net, 3), "brier_score": round(brier, 4),
            "round_trip_cost_pct": ROUND_TRIP_COST_PCT, "live_ready": ready,
            "minimum_signals_required": 200}


def _calibrate(rows: List[Dict[str, Any]], forecasts: List[Dict[str, Any]]) -> None:
    resolved = [item for item in forecasts if item.get("status") == "resolved"]
    for row in rows:
        raw = float(row["forecast_probability_pct"])
        same_bin = [item for item in resolved if int(float(item["raw_probability_pct"]) // 10) == int(raw // 10)]
        empirical = (sum(item["target_hit"] for item in same_bin) + 2) / (len(same_bin) + 4) * 100
        weight = min(1.0, len(same_bin) / 100.0)
        calibrated = raw * (1 - weight) + empirical * weight
        row["raw_probability_pct"] = round(raw, 2)
        row["forecast_probability_pct"] = round(calibrated, 2)
        row["calibration_samples"] = len(same_bin)
        row["score"] = round(50 + (calibrated - 50) * float(row["forecast_confidence_pct"]) / 100, 2)
        row["signal"] = "HIGH" if row["score"] >= 60 and row.get("expected_return_6h_pct", 0) > 0 else "WATCH" if row["score"] >= 53 else "NO EDGE"


def update_forward_validation(rows: List[Dict[str, Any]], candles_by_market: Dict[str, List[Dict[str, Any]]],
                              path: Path = STATE_FILE) -> Dict[str, Any]:
    """Settle old predictions and persist a new non-overlapping forecast per market."""
    state = _load(path)
    forecasts = state["forecasts"]
    now = int(time.time())
    for item in forecasts:
        if item.get("status") != "pending":
            continue
        candles = candles_by_market.get(item["market"], [])
        future = [bar for bar in candles if int(bar["time"]) >= item["entry_time"] and int(bar["time"]) < item["expires_at"]]
        reason = None
        exit_price = None
        for bar in future:
            hit_up = float(bar["high"]) >= item["entry_price"] * 1.02
            hit_down = float(bar["low"]) <= item["entry_price"] * .99
            if hit_up or hit_down:
                reason = "TARGET" if hit_up and not hit_down else "STOP"
                exit_price = item["entry_price"] * (1.02 if reason == "TARGET" else .99)
                break
        if reason is None and now >= item["expires_at"] and future:
            reason, exit_price = "HORIZON", float(future[-1]["close"])
        if reason:
            gross = (exit_price / item["entry_price"] - 1) * 100
            item.update(status="resolved", resolved_at=now, exit_reason=reason,
                        target_hit=1 if reason == "TARGET" else 0,
                        gross_return_pct=round(gross, 4),
                        net_return_pct=round(gross - ROUND_TRIP_COST_PCT, 4))
    _calibrate(rows, forecasts)
    pending_markets = {item["market"] for item in forecasts if item.get("status") == "pending"}
    latest_by_market = {}
    for item in forecasts:
        latest_by_market[item["market"]] = max(latest_by_market.get(item["market"], 0), item["entry_time"])
    for row in rows:
        market = row["market"]
        candles = candles_by_market.get(market, [])
        if not candles or market in pending_markets:
            continue
        entry_time = int(candles[-1]["time"]) + 3600
        if entry_time - latest_by_market.get(market, 0) < HORIZON_SECONDS:
            continue
        forecasts.append({"id": f"{market}:{entry_time}", "market": market, "created_at": now,
                          "entry_time": entry_time, "expires_at": entry_time + HORIZON_SECONDS,
                          "entry_price": float(candles[-1]["close"]),
                          "raw_probability_pct": float(row["raw_probability_pct"]),
                          "calibrated_probability_pct": float(row["forecast_probability_pct"]),
                          "confidence_pct": float(row["forecast_confidence_pct"]),
                          "qualified": row["forecast_probability_pct"] >= 60 and row["forecast_confidence_pct"] >= 40,
                          "status": "pending"})
    state["forecasts"] = forecasts[-20000:]
    state["updated_at"] = now
    _save(path, state)
    return _summary(state["forecasts"])
