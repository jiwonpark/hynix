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

    # Evaluate exits for all eligible open trades so each missed tranche can take profit.
    state_changed = False
    for trade in open_trades:
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
            state_changed = True
            state["last_counterfactual_action"] = "MISSED_EXIT_RECORDED"

    # Allow comprehensive multi-tranche paper tracking (up to 10 paper tranches)
    open_count = sum(1 for t in records if t.get("status") == "OPEN")
    if open_count >= 10:
        return state_changed

    blocker = criteria.get("scale_in_blocked_reason")
    if not criteria.get("scale_in_setup") or blocker not in {"POSITION_CAPACITY", "INSUFFICIENT_MARGIN"}:
        return state_changed
    if not _valid_prices(adr_mark, stock_mark):
        return state_changed

    # 15-minute (900s) wave cadence between entries to capture distinct crests without 5m clutter
    if records:
        last_entry_time = max(t.get("entry_time_ms", 0) for t in records) / 1000
        if (now - last_entry_time) < 900:
            return state_changed

    candle_ms = int(now // 300) * 300000
    if any(trade.get("entry_candle_ms") == candle_ms for trade in records):
        return state_changed
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


def reconcile_counterfactual_trades(state, executions, candle_interval_ms=300000):
    """Purge open counterfactual trades whose entry candle was executed with a real fill (e.g. manual scale in)."""
    records = state.get("counterfactual_trades", [])
    if not records or not executions:
        return False
    real_entry_candles = set()
    for ex in executions:
        is_entry = (
            ex.get("type") == "SHORT"
            or ex.get("action_type") == "ENTRY_SHORT"
            or (ex.get("symbol") == "SKHYUSDT" and ex.get("side") == "SELL")
        )
        if is_entry:
            t = ex.get("time", 0)
            t_ms = int(t * 1000) if t < 1e11 else int(t)
            candle_bucket = (t_ms // candle_interval_ms) * candle_interval_ms
            real_entry_candles.add(candle_bucket)

    if not real_entry_candles:
        return False

    initial_len = len(records)
    state["counterfactual_trades"] = [
        t for t in records
        if not (t.get("status") == "OPEN" and t.get("entry_candle_ms") in real_entry_candles)
    ]
    if len(state["counterfactual_trades"]) != initial_len:
        state["last_counterfactual_action"] = "SUPERSEDED_BY_MANUAL_EXECUTION"
        return True
    return False


def backfill_historical_paper_trades(
    bars,
    executions=None,
    interval_ms=300000,
    current_tranches=10,
    existing_records=None,
    min_cooldown_bars=3,
    tranche_capacity=None,
):
    """
    Scans historical parity bars to synthesize counterfactual (paper) trades
    that occurred when the reconstructed tranche count reached the live dynamic
    capacity used by the execution engine.
    """
    if not bars or len(bars) < 26 or tranche_capacity is None:
        return []
    try:
        tranche_capacity = int(tranche_capacity)
    except (TypeError, ValueError):
        return []
    if tranche_capacity <= 0:
        return []

    existing_candle_times = set()
    if existing_records:
        for r in existing_records:
            t = r.get("entry_candle_ms")
            if t is not None:
                existing_candle_times.add(int(t // interval_ms * (interval_ms // 1000)))
            if r.get("exit_candle_ms") is not None:
                existing_candle_times.add(int(r["exit_candle_ms"] // interval_ms * (interval_ms // 1000)))

    confirmed_entry_times = set()
    confirmed_exit_times = set()
    trade_deltas_by_sec = []
    step_sec = interval_ms // 1000
    if executions:
        for ex in executions:
            t = ex.get("time", 0)
            t_sec = int(t / 1000) if t > 1e11 else int(t)
            is_entry = (
                ex.get("type") == "SHORT"
                or ex.get("action_type") == "ENTRY_SHORT"
                or (ex.get("symbol") == "SKHYUSDT" and ex.get("side") == "SELL")
            )
            # Find closest candle bar within 1 bar window
            matched = min(bars, key=lambda b: abs(b["time"] - t_sec))
            if abs(matched["time"] - t_sec) <= step_sec:
                if is_entry:
                    confirmed_entry_times.add(matched["time"])
                else:
                    confirmed_exit_times.add(matched["time"])
            if is_entry:
                trade_deltas_by_sec.append((t_sec, +1))
            else:
                trade_deltas_by_sec.append((t_sec, -1))

    trade_deltas_by_sec.sort(key=lambda x: x[0])

    def get_tranches_at_sec(target_sec):
        tranches = current_tranches
        for t_sec, delta in reversed(trade_deltas_by_sec):
            if t_sec > target_sec:
                tranches -= delta
            else:
                break
        return max(0, tranches)

    backfilled = []
    last_entry_bar_idx = -999

    for i in range(24, len(bars)):
        bar = bars[i]
        bar_time = bar["time"]
        val = float(bar["value"])

        if bar_time in existing_candle_times:
            last_entry_bar_idx = i
            continue

        if bar_time in confirmed_entry_times:
            last_entry_bar_idx = i
            continue

        tranches = get_tranches_at_sec(bar_time)
        if tranches < tranche_capacity:
            continue

        if (i - last_entry_bar_idx) < min_cooldown_bars:
            continue

        ma_window = [float(b["value"]) for b in bars[i - 23 : i + 1]]
        ma24 = sum(ma_window) / 24.0
        stretch = val - ma24
        if stretch < 0.10:
            continue

        prev_val = float(bars[i - 1]["value"])
        prev2_val = float(bars[i - 2]["value"]) if i >= 2 else prev_val
        is_peaking_out = (prev_val >= prev2_val and val <= prev_val) or (val < max(prev_val, prev2_val))
        if not is_peaking_out:
            continue

        adr_px = float(bar.get("adr") or 0.0)
        stock_px = float(bar.get("csop") or (adr_px / 37.5 if adr_px > 0 else 0.0))
        if adr_px <= 0 or stock_px <= 0:
            continue

        entry_time_ms = bar_time * 1000
        trade = {
            "id": f"hist-missed-{entry_time_ms}",
            "status": "OPEN",
            "blocked_reason": "POSITION_CAPACITY",
            "entry_time_ms": entry_time_ms,
            "entry_candle_ms": entry_time_ms,
            "entry_spread": round(val, 3),
            "adr_entry_price": adr_px,
            "stock_entry_price": stock_px,
            "adr_entry_qty": ENTRY_ADR_QTY,
            "stock_entry_qty": ENTRY_STOCK_QTY,
            "historical_backfill": True,
        }
        last_entry_bar_idx = i

        target_spread = round(val - 0.08, 3)
        for k in range(i + 1, len(bars)):
            exit_bar = bars[k]
            exit_time_sec = exit_bar["time"]
            if (exit_time_sec - bar_time) < 120:
                continue

            k_val = float(exit_bar["value"])
            if k_val <= target_spread:
                k_ma_window = [float(b["value"]) for b in bars[max(0, k - 23) : k + 1]]
                k_ma24 = sum(k_ma_window) / len(k_ma_window)
                k_prev = float(bars[k - 1]["value"])
                is_bottoming = (k_val >= k_prev or k_val <= k_ma24)
                if is_bottoming:
                    exit_adr = float(exit_bar.get("adr") or adr_px)
                    exit_stock = float(exit_bar.get("csop") or stock_px)
                    est = estimate_counterfactual_exit(trade, exit_adr, exit_stock, exit_time_sec)
                    if est and est["net_pnl_usd"] > MIN_NET_PROFIT_USD:
                        trade.update({
                            "status": "CLOSED",
                            "exit_time_ms": exit_time_sec * 1000,
                            "exit_candle_ms": exit_time_sec * 1000,
                            "exit_spread": round(k_val, 3),
                            "adr_exit_price": exit_adr,
                            "stock_exit_price": exit_stock,
                            "estimated_net_pnl_usd": round(est["net_pnl_usd"], 6),
                        })
                        break

        backfilled.append(trade)

    return backfilled


def chart_markers(records, bars, interval_ms, confirmed_markers=None):
    if not records or not bars:
        return []
    confirmed_keys = set()
    if confirmed_markers:
        for cm in confirmed_markers:
            if not cm.get("hypothetical"):
                confirmed_keys.add((cm["time"], bool(cm.get("is_entry"))))

    start_ms = bars[0]["time"] * 1000
    end_ms = bars[-1]["time"] * 1000 + interval_ms
    marker_map = {}
    for trade in records:
        for is_entry, time_key in ((True, "entry_time_ms"), (False, "exit_time_ms")):
            event_ms = trade.get(time_key)
            if event_ms is None or not start_ms <= event_ms < end_ms:
                continue
            bucket_sec = (event_ms // interval_ms) * (interval_ms // 1000)
            marker_bar = min(bars, key=lambda bar: abs(bar["time"] - bucket_sec))
            marker_time = marker_bar["time"]
            # If a confirmed execution already exists for this candle bar and direction,
            # suppress the hypothetical marker so the real fill shows in place of paper.
            if (marker_time, is_entry) in confirmed_keys:
                continue
            key = (marker_time, is_entry)
            reason = str(trade.get("blocked_reason", "CAPITAL CONSTRAINT")).replace("_", " ")
            net_pnl = trade.get("estimated_net_pnl_usd")

            if key in marker_map:
                existing = marker_map[key]
                existing["count"] = existing.get("count", 1) + 1
                qty = (ENTRY_ADR_QTY if is_entry else EXIT_ADR_QTY) * existing["count"]
                existing["qty"] = round(qty, 2)
                if not is_entry and net_pnl is not None:
                    prev_pnl = existing.get("estimated_net_pnl_usd", 0.0)
                    total_pnl = prev_pnl + net_pnl
                    existing["estimated_net_pnl_usd"] = total_pnl
                    cnt_str = f" ({existing['count']}x)" if existing["count"] > 1 else ""
                    existing["hoverText"] = f"MISSED COVER {qty:.2f}{cnt_str} · est. net ${total_pnl:+.3f}"
                continue

            hover = (
                f"MISSED SHORT 0.08 · {reason}"
                if is_entry else f"MISSED COVER 0.07 · est. net ${net_pnl:+.3f}"
            )
            marker = {
                "time": marker_time,
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
                "estimated_net_pnl_usd": net_pnl if not is_entry and net_pnl is not None else 0.0,
                "count": 1,
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
            marker_map[key] = marker
    return sorted(marker_map.values(), key=lambda marker: marker["time"])
