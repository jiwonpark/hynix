"""Persistent paper tracking for strategy signals blocked by capital constraints."""
import math
import time

from .tranche_accounting import (
    EXIT_FEE_BPS,
    EXIT_SLIPPAGE_BPS,
    FUNDING_RESERVE_BPS_DAY,
    MIN_NET_PROFIT_USD,
)


ENTRY_FEE_BPS = 5.0
ENTRY_ADR_QTY = 0.08
ENTRY_STOCK_QTY = 1.40
EXIT_ADR_QTY = 0.07
EXIT_STOCK_QTY = 1.20
MAX_RECORDS = 200


def _valid_prices(*values):
    try:
        return all(math.isfinite(float(value)) and float(value) > 0 for value in values)
    except (TypeError, ValueError):
        return False


def estimate_counterfactual_exit(trade, adr_mark, stock_mark, now):
    prices = (trade.get("adr_entry_price"), trade.get("stock_entry_price"), adr_mark, stock_mark)
    if not _valid_prices(*prices):
        return None
    prices = tuple(float(value) for value in prices)
    entry_notional = ENTRY_ADR_QTY * prices[0] + ENTRY_STOCK_QTY * prices[1]
    exit_notional = EXIT_ADR_QTY * adr_mark + EXIT_STOCK_QTY * stock_mark
    entry_fees = entry_notional * ENTRY_FEE_BPS / 10000
    gross = EXIT_ADR_QTY * (prices[0] - adr_mark) + EXIT_STOCK_QTY * (stock_mark - prices[1])
    exit_fees = exit_notional * EXIT_FEE_BPS / 10000
    slippage = exit_notional * EXIT_SLIPPAGE_BPS / 10000
    holding_days = max(0.0, now - trade["entry_time_ms"] / 1000) / 86400
    funding = entry_notional * FUNDING_RESERVE_BPS_DAY / 10000 * holding_days
    return {
        "gross_pnl_usd": gross,
        "entry_fees_usd": entry_fees,
        "exit_fees_usd": exit_fees,
        "slippage_usd": slippage,
        "funding_usd": funding,
        "net_pnl_usd": gross - entry_fees - exit_fees - slippage - funding,
    }


def update_counterfactual_trades(state, criteria, adr_mark, stock_mark, now=None):
    """Advance virtual trades only when a genuine setup was blocked by capital."""
    now = time.time() if now is None else float(now)
    records = state.setdefault("counterfactual_trades", [])
    open_trades = [trade for trade in records if trade.get("status") == "OPEN"]

    # Match the live worker's priority: exit the newest eligible tranche before considering entry.
    if open_trades:
        trade = open_trades[-1]
        estimate = estimate_counterfactual_exit(trade, adr_mark, stock_mark, now)
        target = float(trade["entry_spread"]) - 0.08
        exit_ready = bool(
            estimate
            and estimate["net_pnl_usd"] > MIN_NET_PROFIT_USD
            and now - trade["entry_time_ms"] / 1000 >= 120
            and float(criteria.get("current_spread", math.inf)) <= target
            and criteria.get("is_bottoming_out")
            and criteria.get("is_exit_ma_aligned")
        )
        if exit_ready:
            trade.update(
                status="CLOSED",
                exit_time_ms=int(now * 1000),
                exit_spread=float(criteria["current_spread"]),
                adr_exit_price=float(adr_mark),
                stock_exit_price=float(stock_mark),
                estimated_net_pnl_usd=round(estimate["net_pnl_usd"], 6),
            )
            state["last_counterfactual_action"] = "MISSED_EXIT_RECORDED"
            return True

    blocker = criteria.get("scale_in_blocked_reason")
    if not criteria.get("scale_in_setup") or blocker not in {"POSITION_CAPACITY", "INSUFFICIENT_MARGIN"}:
        return False
    if not _valid_prices(adr_mark, stock_mark):
        return False

    candle_ms = int(now // 300) * 300000
    if any(trade.get("entry_candle_ms") == candle_ms for trade in records):
        return False
    records.append({
        "id": f"missed-{int(now * 1000)}",
        "status": "OPEN",
        "blocked_reason": blocker,
        "entry_time_ms": int(now * 1000),
        "entry_candle_ms": candle_ms,
        "entry_spread": float(criteria["current_spread"]),
        "adr_entry_price": float(adr_mark),
        "stock_entry_price": float(stock_mark),
        "adr_entry_qty": ENTRY_ADR_QTY,
        "stock_entry_qty": ENTRY_STOCK_QTY,
    })
    if len(records) > MAX_RECORDS:
        del records[:len(records) - MAX_RECORDS]
    state["last_counterfactual_action"] = "MISSED_ENTRY_RECORDED"
    return True


def chart_markers(records, bars, interval_ms):
    if not records or not bars:
        return []
    start_ms = bars[0]["time"] * 1000
    end_ms = bars[-1]["time"] * 1000 + interval_ms
    markers = []
    for trade in records:
        for is_entry, time_key in ((True, "entry_time_ms"), (False, "exit_time_ms")):
            event_ms = trade.get(time_key)
            if event_ms is None or not start_ms <= event_ms < end_ms:
                continue
            bucket_sec = (event_ms // interval_ms) * (interval_ms // 1000)
            marker_bar = min(bars, key=lambda bar: abs(bar["time"] - bucket_sec))
            reason = str(trade.get("blocked_reason", "CAPITAL CONSTRAINT")).replace("_", " ")
            net_pnl = trade.get("estimated_net_pnl_usd")
            hover = (
                f"MISSED SHORT 0.08 · {reason}"
                if is_entry else f"MISSED COVER 0.07 · est. net ${net_pnl:+.3f}"
            )
            marker = {
                "time": marker_bar["time"],
                "position": "aboveBar" if is_entry else "belowBar",
                "color": "#dc2626" if is_entry else "#16a34a",
                "shape": "arrowDown" if is_entry else "arrowUp",
                "text": "",
                "hoverText": hover,
                "outlineGlyph": "⇩" if is_entry else "⇧",
                "is_entry": is_entry,
                "hypothetical": True,
                "qty": ENTRY_ADR_QTY if is_entry else EXIT_ADR_QTY,
                "blocked_reason": trade.get("blocked_reason"),
            }
            if is_entry:
                entry_notional = ENTRY_ADR_QTY * trade["adr_entry_price"] + ENTRY_STOCK_QTY * trade["stock_entry_price"]
                marker["convergence_target_spread"] = round(trade["entry_spread"] - 0.08, 2)
                marker["pnl_model"] = {
                    "adr_entry_price": trade["adr_entry_price"],
                    "stock_entry_price": trade["stock_entry_price"],
                    "entry_fees_usd": entry_notional * ENTRY_FEE_BPS / 10000,
                    "entry_time_ms": trade["entry_time_ms"],
                    "adr_exit_qty": EXIT_ADR_QTY,
                    "stock_exit_qty": EXIT_STOCK_QTY,
                    "exit_fee_bps": EXIT_FEE_BPS,
                    "slippage_bps": EXIT_SLIPPAGE_BPS,
                    "funding_reserve_bps_day": FUNDING_RESERVE_BPS_DAY,
                    "threshold_usd": MIN_NET_PROFIT_USD,
                }
            markers.append(marker)
    return sorted(markers, key=lambda marker: marker["time"])
