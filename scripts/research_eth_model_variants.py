#!/usr/bin/env python3
"""Rank causal Ridge variants by development-period alpha metrics.

Each worker fits a complete walk-forward forecast stream. Variants are ranked on
the first five half-year folds only; the newest half-year is printed separately.
This script reads public candle JSON and never contacts an exchange or order API.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import itertools
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import causal_ridge
from scripts.research_eth_improvement import HALF_YEAR_SECONDS, correlation, fold_boundaries, load_rows, ranks


FEATURE_SETS = {
    "all": (True, True, True, True, True),
    "no_volatility": (True, True, True, True, False),
    "no_momentum": (False, True, True, True, True),
    "no_ma": (True, True, True, False, True),
    "momentum_macd_rsi": (True, True, True, False, False),
    "macd_rsi_ma": (False, True, True, True, False),
    "momentum_ma": (True, False, False, True, False),
    "rsi_ma": (False, False, True, True, False),
}


def variants() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen = set()

    def add(**kwargs: Any) -> None:
        value = {
            "name": kwargs.pop("name"),
            "train_window": 1000,
            "ridge_lambda": 400.0,
            "horizon_bars": 1,
            "feature_set": "all",
            **kwargs,
        }
        key = (value["train_window"], value["ridge_lambda"], value["horizon_bars"], value["feature_set"])
        if key not in seen:
            seen.add(key)
            out.append(value)

    for window, ridge in itertools.product((300, 500, 750, 1000, 1200), (25.0, 100.0, 400.0, 1200.0, 4000.0)):
        add(name=f"w{window}-l{ridge:g}", train_window=window, ridge_lambda=ridge)
    for horizon in (2, 3, 4, 6):
        add(name=f"h{horizon}", horizon_bars=horizon)
    for feature_set in FEATURE_SETS:
        add(name=feature_set, feature_set=feature_set)
    return out


def pearson_and_rank_ic(
    signals: Sequence[Dict[str, Any]],
    bars: Sequence[Dict[str, Any]],
    start: int,
    end: int,
    horizon: int,
) -> Dict[str, float]:
    predictions: List[float] = []
    realized: List[float] = []
    directional: List[float] = []
    for signal in signals:
        idx = int(signal["index"])
        if idx < start or idx + horizon >= end:
            continue
        pred = float(signal["expected_bps"])
        actual = math.log(float(bars[idx + horizon]["close"]) / float(bars[idx]["close"])) * 10_000.0
        predictions.append(pred)
        realized.append(actual)
        directional.append((1.0 if pred > 0 else -1.0) * actual)
    return {
        "rank_ic": correlation(ranks(predictions), ranks(realized)),
        "pearson": correlation(predictions, realized),
        "norm_edge_bps": statistics.fmean(directional) if directional else 0.0,
        "count": float(len(predictions)),
    }


def evaluate_variant(payload: Tuple[Dict[str, Any], List[Dict[str, Any]], List[Dict[str, Any]], List[Tuple[int, int]], int]) -> Dict[str, Any]:
    variant, bars, daily_bars, folds, holdout_start = payload
    feature_values = FEATURE_SETS[variant["feature_set"]]
    settings = {
        **causal_ridge.DEFAULT_SETTINGS,
        "train_window": variant["train_window"],
        "ridge_lambda": variant["ridge_lambda"],
        "horizon_bars": variant["horizon_bars"],
        "use_confidence_gate": False,
        "use_expected_edge_gate": False,
        "use_daily_trend_filter": False,
        "entry_direction_mode": "long_only",
        **dict(zip(("use_momentum", "use_macd", "use_rsi", "use_ma", "use_volatility"), feature_values)),
    }
    replay = causal_ridge.run_causal_replay(
        bars,
        daily_bars,
        settings,
        notional_usd=100.0,
        initial_equity_usd=100.0,
        max_eval_bars=len(bars),
    )
    signals = replay["entry_signals"]
    horizon = int(variant["horizon_bars"])
    development = pearson_and_rank_ic(signals, bars, folds[0][0], holdout_start, horizon)
    fold_metrics = [pearson_and_rank_ic(signals, bars, start, end, horizon) for start, end in folds]
    holdout = pearson_and_rank_ic(signals, bars, holdout_start, len(bars), horizon)
    score = (
        development["rank_ic"] * 2.0
        + statistics.median(row["rank_ic"] for row in fold_metrics)
        + min(row["rank_ic"] for row in fold_metrics) * 0.35
        + development["norm_edge_bps"] / 10_000.0
    )
    return {
        "variant": variant,
        "development": development,
        "folds": fold_metrics,
        "holdout": holdout,
        "score": score,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--four-hour", nargs="+", type=Path, required=True)
    parser.add_argument("--daily", nargs="+", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--top", type=int, default=12)
    args = parser.parse_args()

    bars = causal_ridge.parse_binance_klines(load_rows(args.four_hour), "4h")
    daily_bars = causal_ridge.parse_binance_klines(load_rows(args.daily), "1d")
    holdout_start_time = int(bars[-1]["time"]) - HALF_YEAR_SECONDS
    holdout_start = next(idx for idx, bar in enumerate(bars) if int(bar["time"]) >= holdout_start_time)
    folds = fold_boundaries(bars, int(bars[holdout_start]["time"]))
    all_variants = variants()
    print(f"variants={len(all_variants)} workers={args.workers} bars={len(bars)} folds={len(folds)}", flush=True)

    payloads = [(variant, bars, daily_bars, folds, holdout_start) for variant in all_variants]
    results: List[Dict[str, Any]] = []
    with concurrent.futures.ProcessPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(evaluate_variant, payload): payload[0]["name"] for payload in payloads}
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            results.append(result)
            dev = result["development"]
            print(
                f"done {result['variant']['name']}: devIC={dev['rank_ic']:+.4f} "
                f"edge={dev['norm_edge_bps']:+.2f}bp",
                flush=True,
            )

    results.sort(key=lambda row: row["score"], reverse=True)
    print("RANKED_ON_DEVELOPMENT", flush=True)
    for position, result in enumerate(results[: args.top], 1):
        variant = result["variant"]
        dev = result["development"]
        hold = result["holdout"]
        fold_ics = [round(row["rank_ic"], 4) for row in result["folds"]]
        print(
            f"#{position} {variant['name']} w={variant['train_window']} lambda={variant['ridge_lambda']:g} "
            f"h={variant['horizon_bars']} features={variant['feature_set']} "
            f"devIC={dev['rank_ic']:+.4f} devPearson={dev['pearson']:+.4f} "
            f"devEdge={dev['norm_edge_bps']:+.2f}bp foldIC={fold_ics} "
            f"holdIC={hold['rank_ic']:+.4f} holdEdge={hold['norm_edge_bps']:+.2f}bp",
            flush=True,
        )


if __name__ == "__main__":
    main()
