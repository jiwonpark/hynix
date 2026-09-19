"""Causal, long-only strategy backtests used by the Strategy Lab UI."""

from __future__ import annotations

from bisect import bisect_right
from typing import Any, Dict, List, Optional


MA_WINDOWS = (7, 24, 60)


def _with_indicators(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    closes: List[float] = []
    sums = {window: 0.0 for window in MA_WINDOWS}
    result: List[Dict[str, Any]] = []
    for raw in sorted(rows, key=lambda row: int(row["time"])):
        row = dict(raw)
        close = float(row["close"])
        closes.append(close)
        for window in MA_WINDOWS:
            sums[window] += close
            if len(closes) > window:
                sums[window] -= closes[-window - 1]
            row[f"ma{window}"] = sums[window] / window if len(closes) >= window else None
        if row["ma60"] is None:
            row["bullish"] = False
            row["bearish"] = False
        else:
            row["bullish"] = close > row["ma7"] > row["ma24"] > row["ma60"]
            row["bearish"] = close < row["ma7"] < row["ma24"] < row["ma60"]
        result.append(row)
    return result


def run_ma_stack_backtest(
    candles_5m: List[Dict[str, Any]],
    candles_1h: List[Dict[str, Any]],
    *,
    fee_bps: float = 5.0,
    initial_capital_krw: float = 10_000_000.0,
    max_tranches: int = 5,
    entry_5m: bool = True,
    entry_1h: bool = True,
    exit_5m: bool = True,
    exit_1h: bool = True,
) -> Dict[str, Any]:
    """Backtest dual-timeframe MA stacking with multi-tranche LIFO queue.

    Signals are evaluated at candle close and filled at the next 5-minute open.
    Dip entry scales in up to max_tranches; rally exit pops tranches in LIFO order.
    """
    bars = _with_indicators(candles_5m)
    hours = _with_indicators(candles_1h)
    hour_times = [int(row["time"]) for row in hours]
    fee_rate = max(0.0, float(fee_bps)) / 10_000.0
    cash = float(initial_capital_krw)
    tranche_capital = initial_capital_krw / float(max(1, max_tranches))
    tranche_stack: List[Dict[str, Any]] = []
    trades: List[Dict[str, Any]] = []
    markers: List[Dict[str, Any]] = []
    equity_curve: List[Dict[str, float]] = []
    total_fees = 0.0

    def hour_at(timestamp: int) -> Optional[Dict[str, Any]]:
        index = bisect_right(hour_times, timestamp) - 1
        return hours[index] if index >= 0 else None

    for index, bar in enumerate(bars):
        close = float(bar["close"])
        open_quantity = sum(t["quantity"] for t in tranche_stack)
        current_equity = cash + open_quantity * close
        equity_curve.append({"time": int(bar["time"]), "value": current_equity})
        if index + 1 >= len(bars) or bar["ma60"] is None:
            continue
        hourly = hour_at(int(bar["time"]))
        if hourly is None or hourly["ma60"] is None:
            continue
        next_bar = bars[index + 1]
        fill_price = float(next_bar["open"])
        if fill_price <= 0:
            continue

        enabled_exits = []
        if exit_5m:
            enabled_exits.append(bool(bar["bullish"]))
        if exit_1h:
            enabled_exits.append(bool(hourly["bullish"]))
        should_exit = bool(enabled_exits) and any(enabled_exits)

        enabled_entries = []
        if entry_5m:
            enabled_entries.append(bool(bar["bearish"]))
        if entry_1h:
            enabled_entries.append(bool(hourly["bearish"]))
        should_enter = bool(enabled_entries) and all(enabled_entries)

        if should_exit and tranche_stack:
            popped = tranche_stack.pop()
            gross = popped["quantity"] * fill_price
            exit_fee = gross * fee_rate
            cash += gross - exit_fee
            total_fees += exit_fee
            net_pnl = gross - exit_fee - popped["capital_before"]
            net_return = (net_pnl / popped["capital_before"]) * 100.0
            trade = {
                "id": popped["id"],
                "entry_time": popped["time"],
                "exit_time": int(next_bar["time"]),
                "entry_price": popped["price"],
                "exit_price": fill_price,
                "quantity": popped["quantity"],
                "net_return_pct": net_return,
                "pnl_krw": net_pnl,
                "fees_krw": popped["fee"] + exit_fee,
            }
            trades.append(trade)
            if popped.get("marker_index") is not None and popped["marker_index"] < len(markers):
                entry_marker = markers[popped["marker_index"]]
                entry_marker["exit_price"] = fill_price
                entry_marker["exit_time"] = int(next_bar["time"])
                entry_marker["net_return_pct"] = net_return
            markers.append({
                "time": int(next_bar["time"]),
                "source": "virtual",
                "hypothetical": True,
                "backtest": True,
                "is_entry": False,
                "action": "exit",
                "direction": "long",
                "position": "aboveBar",
                "shape": "arrowDown",
                "color": "#dc2626",
                "entry_price": popped["price"],
                "exit_price": fill_price,
                "net_return_pct": net_return,
                "hoverText": f"SELL {popped['id']} ₩{fill_price:,.0f} · {net_return:+.2f}% net",
            })
        elif should_enter and len(tranche_stack) < max_tranches and cash >= tranche_capital * 0.95:
            alloc_cash = min(cash, tranche_capital)
            entry_fee = alloc_cash * fee_rate
            spendable = alloc_cash - entry_fee
            qty = spendable / fill_price
            total_fees += entry_fee
            cash -= alloc_cash
            tranche_id = f"T{len(tranche_stack) + 1}"
            tranche = {
                "id": tranche_id,
                "time": int(next_bar["time"]),
                "price": fill_price,
                "quantity": qty,
                "fee": entry_fee,
                "capital_before": alloc_cash,
                "marker_index": len(markers),
            }
            entry_marker = {
                "time": int(next_bar["time"]),
                "source": "virtual",
                "hypothetical": True,
                "backtest": True,
                "is_entry": True,
                "action": "entry",
                "direction": "long",
                "position": "belowBar",
                "shape": "arrowUp",
                "color": "#16a34a",
                "entry_price": fill_price,
                "hoverText": f"BUY {tranche_id} ₩{fill_price:,.0f}",
            }
            markers.append(entry_marker)
            tranche_stack.append(tranche)

    last_close = float(bars[-1]["close"]) if bars else 0.0
    open_quantity = sum(t["quantity"] for t in tranche_stack)
    ending_equity = cash + open_quantity * last_close
    values = [point["value"] for point in equity_curve]
    peak = 0.0
    max_drawdown = 0.0
    for value in values:
        peak = max(peak, value)
        if peak:
            max_drawdown = min(max_drawdown, (value / peak - 1.0) * 100.0)
    completed = len(trades)
    wins = sum(1 for trade in trades if trade["net_return_pct"] > 0)
    buy_hold = ((last_close / float(bars[0]["open"]) - 1.0) * 100.0) if bars and bars[0]["open"] else 0.0

    active_stack_serialized = []
    for idx, t in enumerate(reversed(tranche_stack)):
        unrealized_pnl = (t["quantity"] * last_close * (1.0 - fee_rate)) - t["capital_before"]
        unrealized_ret = (unrealized_pnl / t["capital_before"]) * 100.0 if t["capital_before"] else 0.0
        active_stack_serialized.append({
            "id": t["id"],
            "index": len(tranche_stack) - 1 - idx,
            "time": t["time"],
            "entry_price": t["price"],
            "quantity": t["quantity"],
            "capital_before": t["capital_before"],
            "unrealized_pnl_krw": unrealized_pnl,
            "unrealized_return_pct": unrealized_ret,
        })

    return {
        "strategy": "dual_timeframe_ma_stack",
        "bars": bars,
        "hourly": hours,
        "markers": markers,
        "trades": trades,
        "active_tranche_stack": active_stack_serialized,
        "open_position": tranche_stack[-1] if tranche_stack else None,
        "capacity": {
            "max_tranches": max_tranches,
            "active_tranches": len(tranche_stack),
            "remaining_tranches": max(0, max_tranches - len(tranche_stack)),
            "tranche_capital_krw": tranche_capital,
            "free_cash_krw": cash,
            "invested_capital_krw": initial_capital_krw - cash,
            "open_quantity_btc": open_quantity,
        },
        "stats": {
            "initial_capital_krw": initial_capital_krw,
            "ending_equity_krw": ending_equity,
            "net_return_pct": (ending_equity / initial_capital_krw - 1.0) * 100.0,
            "buy_hold_pct": buy_hold,
            "max_drawdown_pct": max_drawdown,
            "completed_trades": completed,
            "win_rate_pct": (wins / completed * 100.0) if completed else 0.0,
            "total_fees_krw": total_fees,
        },
    }
