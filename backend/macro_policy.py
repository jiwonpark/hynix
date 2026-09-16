"""Shared, causal sizing and exit policy for live execution and price replay."""
import math


def policy_for_level(level=0):
    level = max(0, min(2, int(level)))
    multiplier = (1.0, 1.25, 1.5)[level]
    return {
        'level': level, 'score': level * 50,
        'regime': ('NORMAL', 'TOP_WATCH', 'TOPPING')[level],
        'entry_multiplier': multiplier,
        'adr_entry_qty': round(.08 * multiplier, 2),
        'stock_entry_qty': round(1.4 * multiplier, 2),
        'adr_exit_qty': .07, 'stock_exit_qty': 1.2,
        'convergence_pts': (.08, .12, .16)[level],
        'minimum_net_profit_usd': (.02, .03, .04)[level],
        'require_confirmed_rebound': level > 0,
    }


def macro_policy(hourly_values):
    """Use only completed hourly closes, with at least 60 contiguous hours.

    An elevated spread must show slowing upward momentum or two lower closes.
    Thresholds are initial strategy settings, not calibrated probabilities.
    """
    values = list(hourly_values)[-60:]
    base = policy_for_level()
    if len(values) < 60 or not all(math.isfinite(v) and v > 0 for v in values):
        return {**base, 'ready': False, 'reason': 'WAITING_FOR_60_CLOSED_HOURS'}
    mean = sum(values) / 60
    std = math.sqrt(sum((v-mean)**2 for v in values) / 60)
    elevated = std > 1e-9 and values[-1] >= mean + .5*std and max(values[-7:]) >= mean + std
    prior_slope = (values[-4]-values[-7])/3
    slope = (values[-1]-values[-4])/3
    slowing = prior_slope > 0 and slope <= prior_slope*.5
    rollover = values[-1] < values[-2] < values[-3]
    level = 2 if elevated and rollover else (1 if elevated and slowing else 0)
    return {**policy_for_level(level), 'ready': True,
            'reason': ('NO_MACRO_TOP', 'ELEVATED_AND_SLOWING', 'ELEVATED_AND_ROLLING_OVER')[level]}


def closed_values(bars, interval_seconds, now, limit=60):
    """Exclude forming bars and reject stale or gapped macro/rebound history."""
    closed = sorted((b for b in bars if b['time'] + interval_seconds <= now), key=lambda b: b['time'])[-limit:]
    if not closed or now - (closed[-1]['time'] + interval_seconds) >= interval_seconds:
        return []
    if any(b['time'] != a['time'] + interval_seconds for a, b in zip(closed, closed[1:])):
        return []
    return [b['value'] for b in closed]


def confirmed_rebound(values):
    """Two consecutive rising closed 5m candles; MA touch alone is insufficient."""
    return len(values) >= 3 and values[-1] > values[-2] > values[-3]
