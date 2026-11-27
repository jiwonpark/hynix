#!/usr/bin/env python3
"""Reproduce a cost-stressed, causal ETH strategy search for Tab 11.

The model forecast is computed once with matured labels only. Strategy candidates
are ranked on the first five chronological half-year folds; the newest half-year
is printed afterward as a fixed holdout and is never part of the ranking score.
No exchange credentials or order endpoints are used.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import causal_ridge


SECONDS_PER_DAY = 86_400
HALF_YEAR_SECONDS = 182 * SECONDS_PER_DAY
FEATURE_SETS = {
    "all": (True, True, True, True, True),
    "no_ma": (True, True, True, False, True),
    "momentum_ma": (True, False, False, True, False),
    "momentum_macd_rsi": (True, True, True, False, False),
}


@dataclass(frozen=True)
class Candidate:
    confidence_pct: float = 52.0
    daily_ma_period: int = 100
    min_hold_bars: int = 3
    continuation: str = "entry"
    daily_slope_days: int = 0
    rsi_max: Optional[float] = None
    pullback: str = "none"
    max_one_bar_bps: Optional[float] = None
    min_expected_bps: float = 0.0
    direction_mode: str = "long_only"

    def label(self) -> str:
        parts = [
            f"conf{self.confidence_pct:g}",
            f"dMA{self.daily_ma_period}",
            f"hold{self.min_hold_bars}",
            f"continue:{self.continuation}",
            self.direction_mode,
        ]
        if self.daily_slope_days:
            parts.append(f"dSlope{self.daily_slope_days}")
        if self.rsi_max is not None:
            parts.append(f"rsi<={self.rsi_max:g}")
        if self.pullback != "none":
            parts.append(self.pullback)
        if self.max_one_bar_bps is not None:
            parts.append(f"ret1<={self.max_one_bar_bps:g}bp")
        if self.min_expected_bps:
            parts.append(f"edge>={self.min_expected_bps:g}bp")
        return ",".join(parts)


def load_rows(paths: Sequence[Path]) -> List[List[Any]]:
    rows: List[List[Any]] = []
    for path in paths:
        with path.open() as handle:
            rows.extend(json.load(handle))
    return rows


def ranks(values: Sequence[float]) -> List[float]:
    order = sorted(range(len(values)), key=lambda idx: values[idx])
    out = [0.0] * len(values)
    cursor = 0
    while cursor < len(order):
        end = cursor + 1
        while end < len(order) and values[order[end]] == values[order[cursor]]:
            end += 1
        rank = (cursor + end - 1) / 2.0 + 1.0
        for pos in range(cursor, end):
            out[order[pos]] = rank
        cursor = end
    return out


def correlation(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) < 3 or len(left) != len(right):
        return 0.0
    avg_left = statistics.fmean(left)
    avg_right = statistics.fmean(right)
    num = sum((x - avg_left) * (y - avg_right) for x, y in zip(left, right))
    den_left = sum((x - avg_left) ** 2 for x in left)
    den_right = sum((y - avg_right) ** 2 for y in right)
    return num / math.sqrt(den_left * den_right) if den_left > 0 and den_right > 0 else 0.0


def rank_ic(
    signals: Sequence[Dict[str, Any]],
    bars: Sequence[Dict[str, Any]],
    start: int,
    end: int,
    horizon: int = 1,
) -> float:
    predictions: List[float] = []
    realized: List[float] = []
    for signal in signals:
        idx = int(signal["index"])
        if idx < start or idx + horizon >= end:
            continue
        predictions.append(float(signal["expected_bps"]))
        realized.append(math.log(float(bars[idx + horizon]["close"]) / float(bars[idx]["close"])) * 10_000.0)
    return correlation(ranks(predictions), ranks(realized))


def daily_contexts(
    bars: Sequence[Dict[str, Any]],
    daily_bars: Sequence[Dict[str, Any]],
    periods: Iterable[int],
    slope_days: Iterable[int],
) -> Dict[Tuple[int, int], List[Optional[Dict[str, Any]]]]:
    ordered = sorted(daily_bars, key=lambda bar: int(bar["time"]))
    daily_index = {int(bar["time"]): idx for idx, bar in enumerate(ordered)}
    closes = [float(bar["close"]) for bar in ordered]
    result: Dict[Tuple[int, int], List[Optional[Dict[str, Any]]]] = {}
    for period in periods:
        aligned = causal_ridge.align_daily_trend(bars, ordered, period)
        ma_values = causal_ridge.simple_moving_average(closes, period)
        for days in slope_days:
            contexts: List[Optional[Dict[str, Any]]] = []
            for ctx in aligned:
                if ctx is None:
                    contexts.append(None)
                    continue
                d_idx = daily_index[int(ctx["daily_time"])]
                slope_sign = 0
                if days:
                    past = d_idx - days
                    if past >= 0 and ma_values[past] is not None:
                        slope_sign = 1 if float(ctx["daily_ma"]) > float(ma_values[past]) else (-1 if float(ctx["daily_ma"]) < float(ma_values[past]) else 0)
                contexts.append({**ctx, "slope_sign": slope_sign})
            result[(period, days)] = contexts
    return result


def condition_stream(
    candidate: Candidate,
    signals_by_index: Dict[int, Dict[str, Any]],
    bars: Sequence[Dict[str, Any]],
    indicators: Dict[str, Any],
    daily_cache: Dict[Tuple[int, int], List[Optional[Dict[str, Any]]]],
) -> Tuple[Dict[int, int], Dict[int, int]]:
    entry: Dict[int, int] = {}
    core: Dict[int, int] = {}
    contexts = daily_cache[(candidate.daily_ma_period, candidate.daily_slope_days)]
    ma_fast = indicators["ma_fast"]
    rsi = indicators["rsi"]
    closes = indicators["closes"]
    slope_lookback = 3
    for idx, signal in signals_by_index.items():
        ctx = contexts[idx]
        raw_side = int(signal["raw_side"])
        direction_ok = raw_side == 1 or (candidate.direction_mode == "two_way" and raw_side == -1)
        slope_ok = (
            not candidate.daily_slope_days
            or (ctx is not None and int(ctx["slope_sign"]) == raw_side)
        )
        base = (
            direction_ok
            and float(signal["confidence_pct"]) >= candidate.confidence_pct
            and abs(float(signal["expected_bps"])) >= candidate.min_expected_bps
            and ctx is not None
            and int(ctx["daily_trend"]) == raw_side
            and slope_ok
        )
        core[idx] = raw_side if base else 0
        allowed = base
        if allowed and candidate.rsi_max is not None:
            allowed = rsi[idx] is not None and (
                (raw_side == 1 and float(rsi[idx]) <= candidate.rsi_max)
                or (raw_side == -1 and float(rsi[idx]) >= 100.0 - candidate.rsi_max)
            )
        if allowed and candidate.max_one_bar_bps is not None:
            one_bar_bps = math.log(float(closes[idx]) / float(closes[idx - 1])) * 10_000.0
            allowed = (
                (raw_side == 1 and one_bar_bps <= candidate.max_one_bar_bps)
                or (raw_side == -1 and one_bar_bps >= -candidate.max_one_bar_bps)
            )
        if allowed and candidate.pullback != "none":
            fast = ma_fast[idx]
            if fast is None:
                allowed = False
            elif candidate.pullback == "below_fast_ma":
                allowed = (
                    (raw_side == 1 and float(closes[idx]) < float(fast))
                    or (raw_side == -1 and float(closes[idx]) > float(fast))
                )
            elif candidate.pullback == "riding":
                ref = ma_fast[idx - slope_lookback] if idx >= slope_lookback else None
                allowed = ref is not None and (
                    (raw_side == 1 and float(fast) > float(ref) and float(closes[idx]) < float(fast))
                    or (raw_side == -1 and float(fast) < float(ref) and float(closes[idx]) > float(fast))
                )
            else:
                raise ValueError(f"Unknown pullback: {candidate.pullback}")
        entry[idx] = raw_side if allowed else 0
    return entry, core


def simulate(
    candidate: Candidate,
    bars: Sequence[Dict[str, Any]],
    entry: Dict[int, int],
    core: Dict[int, int],
    start: int,
    end: int,
    cost_bps: float,
) -> Dict[str, float]:
    equity = 100.0
    peak = equity
    max_drawdown = 0.0
    trades: List[float] = []
    open_pos: Optional[Dict[str, Any]] = None
    pending: Optional[Tuple[str, int]] = None
    fee = cost_bps / 10_000.0

    def close(price: float) -> None:
        nonlocal equity, peak, max_drawdown, open_pos
        if open_pos is None:
            return
        net_return = int(open_pos["side"]) * (price / float(open_pos["entry_price"]) - 1.0) - fee
        equity += 100.0 * net_return
        trades.append(net_return * 100.0)
        peak = max(peak, equity)
        if peak > 0:
            max_drawdown = max(max_drawdown, (peak - equity) / peak * 100.0)
        open_pos = None

    for idx in range(start, end):
        bar = bars[idx]
        if pending is not None:
            action, action_side = pending
            if action in {"exit", "reverse"}:
                close(float(bar["open"]))
            if action in {"entry", "reverse"}:
                open_pos = {"entry_price": float(bar["open"]), "entry_index": idx, "side": action_side}
        pending = None

        if open_pos is not None:
            adverse_price = float(bar["low"]) if int(open_pos["side"]) > 0 else float(bar["high"])
            adverse_return = int(open_pos["side"]) * (adverse_price / float(open_pos["entry_price"]) - 1.0) - fee
            adverse_equity = equity + 100.0 * adverse_return
            if peak > 0:
                max_drawdown = max(max_drawdown, (peak - adverse_equity) / peak * 100.0)
            marked_return = int(open_pos["side"]) * (float(bar["close"]) / float(open_pos["entry_price"]) - 1.0) - fee
            marked_equity = equity + 100.0 * marked_return
            peak = max(peak, marked_equity)

        if idx + 1 >= end:
            continue
        if open_pos is None:
            signal_side = int(entry.get(idx, 0))
            if signal_side:
                pending = ("entry", signal_side)
            continue

        held = idx - int(open_pos["entry_index"]) + 1
        if held < candidate.min_hold_bars:
            continue
        if candidate.continuation == "entry":
            signal_side = int(entry.get(idx, 0))
        elif candidate.continuation == "core":
            signal_side = int(core.get(idx, 0))
        elif candidate.continuation == "fixed":
            signal_side = 0
        else:
            raise ValueError(f"Unknown continuation: {candidate.continuation}")
        open_side = int(open_pos["side"])
        if signal_side != open_side:
            pending = ("reverse", signal_side) if signal_side else ("exit", 0)

    if open_pos is not None:
        close(float(bars[end - 1]["close"]))
    gains = sum(value for value in trades if value > 0)
    losses = -sum(value for value in trades if value < 0)
    return {
        "return": equity - 100.0,
        "drawdown": max_drawdown,
        "trades": float(len(trades)),
        "profit_factor": gains / losses if losses > 1e-12 else (99.0 if gains > 0 else 0.0),
        "win_rate": (sum(1 for value in trades if value > 0) / len(trades) * 100.0) if trades else 0.0,
        "worst_trade": min(trades) if trades else 0.0,
    }


def summarize_folds(
    candidate: Candidate,
    bars: Sequence[Dict[str, Any]],
    entry: Dict[int, int],
    core: Dict[int, int],
    folds: Sequence[Tuple[int, int]],
    cost_bps: float,
) -> Dict[str, Any]:
    rows = [simulate(candidate, bars, entry, core, start, end, cost_bps) for start, end in folds]
    total = simulate(candidate, bars, entry, core, folds[0][0], folds[-1][1], cost_bps)
    return {
        "folds": rows,
        "total": total,
        "positive_folds": sum(1 for row in rows if row["return"] > 0),
        "worst_fold": min(row["return"] for row in rows),
        "median_fold": statistics.median(row["return"] for row in rows),
    }


def fold_boundaries(bars: Sequence[Dict[str, Any]], holdout_start_time: int) -> List[Tuple[int, int]]:
    first_time = int(bars[0]["time"])
    boundaries = [first_time]
    cursor = first_time + HALF_YEAR_SECONDS
    while cursor < holdout_start_time:
        boundaries.append(cursor)
        cursor += HALF_YEAR_SECONDS
    boundaries.append(holdout_start_time)
    indices: List[int] = []
    bar_cursor = 0
    for boundary in boundaries:
        while bar_cursor < len(bars) and int(bars[bar_cursor]["time"]) < boundary:
            bar_cursor += 1
        indices.append(bar_cursor)
    return [(indices[i], indices[i + 1]) for i in range(len(indices) - 1) if indices[i + 1] - indices[i] >= 300]


def candidate_grid(
    direction_modes: Sequence[str] = ("long_only",),
    edge_values: Sequence[float] = (0.0,),
    simple_recipes: bool = False,
) -> Iterable[Candidate]:
    recipes = [{}] if simple_recipes else [
        {},
        {"daily_slope_days": 10},
        {"daily_slope_days": 20},
        {"rsi_max": 60.0},
        {"rsi_max": 55.0},
        {"rsi_max": 50.0},
        {"pullback": "below_fast_ma"},
        {"pullback": "riding"},
        {"max_one_bar_bps": 0.0},
        {"max_one_bar_bps": -25.0},
        {"max_one_bar_bps": -50.0},
        {"daily_slope_days": 10, "rsi_max": 55.0},
        {"daily_slope_days": 10, "pullback": "below_fast_ma"},
        {"daily_slope_days": 10, "max_one_bar_bps": 0.0},
        {"rsi_max": 55.0, "pullback": "below_fast_ma"},
    ]
    for confidence, daily_ma, hold, continuation, edge, recipe, direction_mode in itertools.product(
        (48.0, 50.0, 52.0, 54.0, 56.0),
        (50, 75, 100, 125, 150, 200),
        (2, 3, 4, 6, 9, 12),
        ("entry", "core", "fixed"),
        edge_values,
        recipes,
        direction_modes,
    ):
        yield Candidate(
            confidence_pct=confidence,
            daily_ma_period=daily_ma,
            min_hold_bars=hold,
            continuation=continuation,
            min_expected_bps=edge,
            direction_mode=direction_mode,
            **recipe,
        )


def score(summary_10: Dict[str, Any], summary_20: Dict[str, Any]) -> float:
    total = summary_20["total"]
    calmar = total["return"] / max(5.0, total["drawdown"])
    return (
        calmar * 3.0
        + summary_20["median_fold"] * 0.12
        + summary_20["worst_fold"] * 0.20
        + summary_10["positive_folds"] * 0.40
        + min(3.0, total["profit_factor"]) * 0.35
    )


def format_metrics(metrics: Dict[str, float]) -> str:
    return (
        f"ret={metrics['return']:+.2f}% dd={metrics['drawdown']:.2f}% "
        f"PF={metrics['profit_factor']:.2f} trades={int(metrics['trades'])} "
        f"win={metrics['win_rate']:.1f}% worst={metrics['worst_trade']:.2f}%"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--four-hour", nargs="+", type=Path, required=True)
    parser.add_argument("--daily", nargs="+", type=Path, required=True)
    parser.add_argument("--top", type=int, default=10)
    parser.add_argument("--train-window", type=int, default=1000)
    parser.add_argument("--ridge-lambda", type=float, default=400.0)
    parser.add_argument("--horizon", type=int, default=1)
    parser.add_argument("--feature-set", choices=tuple(FEATURE_SETS), default="all")
    parser.add_argument("--direction-modes", nargs="+", choices=("long_only", "two_way"), default=("long_only",))
    parser.add_argument("--edge-values", nargs="+", type=float, default=(0.0,))
    parser.add_argument("--simple-recipes", action="store_true")
    parser.add_argument("--baseline-only", action="store_true")
    args = parser.parse_args()

    bars = causal_ridge.parse_binance_klines(load_rows(args.four_hour), "4h")
    daily_bars = causal_ridge.parse_binance_klines(load_rows(args.daily), "1d")
    settings = {
        **causal_ridge.DEFAULT_SETTINGS,
        "use_confidence_gate": False,
        "use_expected_edge_gate": False,
        "use_daily_trend_filter": False,
        "entry_direction_mode": "long_only",
        "cost_bps": 10.0,
        "train_window": args.train_window,
        "ridge_lambda": args.ridge_lambda,
        "horizon_bars": args.horizon,
    }
    settings.update(dict(zip(
        ("use_momentum", "use_macd", "use_rsi", "use_ma", "use_volatility"),
        FEATURE_SETS[args.feature_set],
    )))
    replay = causal_ridge.run_causal_replay(
        bars,
        daily_bars,
        settings,
        notional_usd=100.0,
        initial_equity_usd=100.0,
        max_eval_bars=len(bars),
    )
    signals = replay["entry_signals"]
    signals_by_index = {int(signal["index"]): signal for signal in signals}
    indicators = causal_ridge.calculate_indicators(bars, settings)

    holdout_start_time = int(bars[-1]["time"]) - HALF_YEAR_SECONDS
    holdout_start = next(idx for idx, bar in enumerate(bars) if int(bar["time"]) >= holdout_start_time)
    folds = fold_boundaries(bars, int(bars[holdout_start]["time"]))
    periods = (50, 75, 100, 125, 150, 200)
    slopes = (0, 10, 20)
    daily_cache = daily_contexts(bars, daily_bars, periods, slopes)

    print(
        f"bars={len(bars)} daily={len(daily_bars)} signals={len(signals)} "
        f"dev_folds={len(folds)} holdout_bars={len(bars) - holdout_start} "
        f"window={args.train_window} lambda={args.ridge_lambda:g} horizon={args.horizon} "
        f"features={args.feature_set}"
    )
    print(f"rank_ic_dev={rank_ic(signals, bars, folds[0][0], holdout_start, args.horizon):+.4f}")
    print(f"rank_ic_holdout={rank_ic(signals, bars, holdout_start, len(bars), args.horizon):+.4f}")

    baseline = Candidate()
    base_entry, base_core = condition_stream(baseline, signals_by_index, bars, indicators, daily_cache)
    base_dev_10 = summarize_folds(baseline, bars, base_entry, base_core, folds, 10.0)
    base_dev_20 = summarize_folds(baseline, bars, base_entry, base_core, folds, 20.0)
    base_hold_10 = simulate(baseline, bars, base_entry, base_core, holdout_start, len(bars), 10.0)
    base_hold_20 = simulate(baseline, bars, base_entry, base_core, holdout_start, len(bars), 20.0)
    print("BASELINE", baseline.label())
    print("  dev10", format_metrics(base_dev_10["total"]), "folds", [round(row["return"], 2) for row in base_dev_10["folds"]])
    print("  dev20", format_metrics(base_dev_20["total"]), "folds", [round(row["return"], 2) for row in base_dev_20["folds"]])
    print("  hold10", format_metrics(base_hold_10))
    print("  hold20", format_metrics(base_hold_20))
    if args.baseline_only:
        return

    ranked: List[Tuple[float, Candidate, Dict[str, Any], Dict[str, Any], Dict[int, int], Dict[int, int]]] = []
    for candidate in candidate_grid(args.direction_modes, args.edge_values, args.simple_recipes):
        entry, core = condition_stream(candidate, signals_by_index, bars, indicators, daily_cache)
        dev_10 = summarize_folds(candidate, bars, entry, core, folds, 10.0)
        dev_20 = summarize_folds(candidate, bars, entry, core, folds, 20.0)
        total_20 = dev_20["total"]
        if (
            total_20["trades"] < 30
            or total_20["return"] <= 0
            or total_20["profit_factor"] < 1.25
            or dev_20["positive_folds"] < max(3, len(folds) - 1)
            or dev_20["worst_fold"] < -5.0
        ):
            continue
        ranked.append((score(dev_10, dev_20), candidate, dev_10, dev_20, entry, core))
    ranked.sort(key=lambda item: item[0], reverse=True)

    print(f"qualified={len(ranked)}")
    for position, item in enumerate(ranked[: args.top], 1):
        candidate_score, candidate, dev_10, dev_20, entry, core = item
        hold_10 = simulate(candidate, bars, entry, core, holdout_start, len(bars), 10.0)
        hold_20 = simulate(candidate, bars, entry, core, holdout_start, len(bars), 20.0)
        full_10 = simulate(candidate, bars, entry, core, folds[0][0], len(bars), 10.0)
        print(f"#{position} score={candidate_score:.3f} {candidate.label()}")
        print("  dev10", format_metrics(dev_10["total"]), "folds", [round(row["return"], 2) for row in dev_10["folds"]])
        print("  dev20", format_metrics(dev_20["total"]), "folds", [round(row["return"], 2) for row in dev_20["folds"]])
        print("  hold10", format_metrics(hold_10))
        print("  hold20", format_metrics(hold_20))
        print("  full10", format_metrics(full_10))


if __name__ == "__main__":
    main()
