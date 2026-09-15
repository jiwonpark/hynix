"""Read-only, chronological replay of the selectable fixed-tranche strategy."""
import math
from collections import deque
from .tranche_accounting import EXIT_FEE_BPS, EXIT_SLIPPAGE_BPS, FUNDING_RESERVE_BPS_DAY, MIN_NET_PROFIT_USD

ENTRY_FEE_BPS = 5.0
STEP = 300


def replay(bars, start_time, end_time, initial_equity, toggles=None):
    """Start flat at start_time; preceding bars warm indicators without trading.

    Bars contain closed 5m prices. Orders are simulated at that candle's close,
    with fees and slippage deducted. Funding is a conservative reserve, not an
    exchange funding-history reconstruction. No account or execution state enters
    this calculation.
    """
    toggles = toggles or {}
    def passes(key, value):
        return not toggles.get(key, True) or bool(value)
    def aligned(values, upward):
        if len(values) < 60:
            return False
        v = list(values)
        a, b, c = sum(v[-7:])/7, sum(v[-24:])/24, sum(v[-60:])/60
        return a > b > c if upward else a < b < c
    def ma_pass(key, values, upward):
        # Explicit timeframe switches override the former combined switch.
        enabled = toggles.get(key, toggles.get('exit_ma_stack', True) if key.startswith('exit_') else True)
        return not enabled or aligned(values, upward)

    equity = float(initial_equity)
    peak = equity
    drawdown = fees = slippage = funding = 0.0
    aq = sq = adr_avg = stock_avg = 0.0
    stack, trades, events = [], [], []
    five, hourly = deque(maxlen=60), deque(maxlen=60)
    hour_parts = []
    previous = None
    last_entry = last_exit = -math.inf
    evaluated = missing = 0
    blocked = 0
    halted = False
    entry_rate = ENTRY_FEE_BPS / 10000
    exit_rate = EXIT_FEE_BPS / 10000
    slip_rate = EXIT_SLIPPAGE_BPS / 10000
    funding_rate = FUNDING_RESERVE_BPS_DAY / 10000
    for bar in sorted(bars, key=lambda b: b['time']):
        t = int(bar['time'])
        close = t + STEP
        if close > end_time:
            break
        if not all(isinstance(bar.get(k), (int, float)) and math.isfinite(bar[k]) and bar[k] > 0
                   for k in ('value', 'adr', 'csop', 'domestic')):
            missing += 1
            five.clear(); hourly.clear(); hour_parts.clear()
            continue
        if previous and t != previous['time'] + STEP:
            five.clear(); hourly.clear(); hour_parts.clear()
        if t % 3600 == 0:
            hour_parts = []
        five.append(bar['value'])
        hour_parts.append(bar)
        if close % 3600 == 0:
            if len(hour_parts) == 12 and hour_parts[0]['time'] == close - 3600:
                hourly.append(bar['value'])
            else:
                hourly.clear()
            hour_parts = []
        adr, stock, spread = bar['adr'], bar['csop'], bar['value']
        if previous and (aq or sq):
            equity += aq * (previous['adr'] - adr) + sq * (stock - previous['csop'])
            carry = (aq * adr_avg + sq * stock_avg) * funding_rate * (t - previous['time']) / 86400
            equity -= carry
            funding += carry
        previous = bar
        if t < start_time:
            continue
        evaluated += 1
        drawdown = max(drawdown, (peak-equity)/peak*100)
        if equity <= 0:
            halted = True
            break
        vals = list(five)
        ma24 = sum(vals[-24:]) / min(24, len(vals))
        peak_out = len(vals) >= 3 and (vals[-1] <= vals[-2] or vals[-1] < max(vals[-3:-1]))
        bottoming = len(vals) >= 3 and (vals[-1] >= vals[-2] or vals[-1] > min(vals[-3:-1]) or vals[-1] <= ma24)
        notional = aq * adr + sq * stock
        next_notional = .08 * adr + 1.4 * stock
        required_margin = max(2.50, next_notional / 10 * 1.25)
        target = stack[-1] if stack else None
        sold = False
        if target:
            trim_notional = .07 * adr + 1.2 * stock
            gross = .07 * (target['adr_entry_price'] - adr) + 1.2 * (stock - target['stock_entry_price'])
            entry_trim_notional = .07 * target['adr_entry_price'] + 1.2 * target['stock_entry_price']
            allocated_entry_cost = entry_trim_notional * (entry_rate + slip_rate)
            carry = entry_trim_notional * funding_rate * (close - target['entry_time_ms']/1000) / 86400
            net = gross - allocated_entry_cost - trim_notional * (exit_rate + slip_rate) - carry
            exit_ready = all((
                passes('exit_net_profit', net > MIN_NET_PROFIT_USD),
                passes('exit_convergence', spread <= target['entry_spread'] - .08),
                passes('exit_dwell_time', close - target['entry_time_ms']/1000 >= 120),
                passes('exit_bottoming_out', bottoming),
                ma_pass('exit_ma_stack_5m', five, False),
                ma_pass('exit_ma_stack_1h', hourly, False),
                passes('exit_position_qty', aq + 1e-8 >= .07 and sq + 1e-8 >= 1.2),
                close - last_exit >= 30,
            ))
            # A simulated exit always needs an entry to close, even with the
            # speculative-tranche switch off. Retained core is carried forward.
            if exit_ready:
                exit_fee, exit_slip = trim_notional * exit_rate, trim_notional * slip_rate
                equity -= exit_fee + exit_slip
                fees += exit_fee; slippage += exit_slip
                aq = round(aq - .07, 8); sq = round(sq - 1.2, 8)
                stack.pop()
                target.update(status='CLOSED', exit_time_ms=close*1000, estimated_net_pnl_usd=net)
                events.append({'time': t, 'is_entry': False, 'trade_id': target['id'], 'net_pnl_usd': net})
                last_exit = close
                sold = True
        if not sold:
            # Match the live baseline formula using simulated average entry costs.
            baseline = spread
            if aq and sq and stock_avg > 0:
                baseline = adr_avg / (bar['domestic'] / (1 + (stock-stock_avg)/stock_avg/2)) * 100
            setup = all((
                passes('entry_ma_stretch', len(vals) >= 6 and spread-ma24 >= .10),
                passes('entry_base_spread', not aq or spread >= baseline + .10),
                passes('entry_peak_rollover', peak_out),
                ma_pass('entry_ma_stack_5m', five, True),
                ma_pass('entry_ma_stack_1h', hourly, True),
                passes('entry_worker_state', close-last_entry >= 60),
            ))
            capacity = notional + next_notional <= equity * 8
            margin = equity - notional/10 >= required_margin
            risk = all((passes('entry_capacity', capacity), passes('entry_gross_leverage', capacity),
                        passes('entry_margin_buffer', margin)))
            if setup and not risk:
                blocked += 1
            if setup and risk:
                fee, slip = next_notional*entry_rate, next_notional*slip_rate
                equity -= fee+slip
                fees += fee; slippage += slip
                adr_avg = (aq*adr_avg + .08*adr)/(aq+.08)
                stock_avg = (sq*stock_avg + 1.4*stock)/(sq+1.4)
                aq = round(aq+.08, 8); sq = round(sq+1.4, 8)
                trade = {'id': len(trades)+1, 'status': 'OPEN', 'entry_time_ms': close*1000,
                         'entry_spread': spread, 'adr_entry_price': adr, 'stock_entry_price': stock}
                trades.append(trade); stack.append(trade)
                events.append({'time': t, 'is_entry': True, 'trade_id': trade['id']})
                last_entry = close
        peak = max(peak, equity)
        drawdown = max(drawdown, (peak-equity)/peak*100)
    return {'trades': trades, 'events': events, 'summary': {
        'initial_equity': initial_equity, 'ending_equity': round(equity, 6),
        'net_pnl_usd': round(equity-initial_equity, 6), 'return_pct': round((equity/initial_equity-1)*100, 4),
        'entries': len(trades), 'exits': len(trades)-len(stack), 'open_tranches': len(stack),
        'core_adr_qty': round(aq-len(stack)*.08, 8), 'core_stock_qty': round(sq-len(stack)*1.4, 8),
        'max_drawdown_pct': round(max(drawdown, 100 if halted else 0), 4),
        'fees_usd': round(fees, 6), 'slippage_usd': round(slippage, 6), 'funding_reserve_usd': round(funding, 6),
        'capital_blocked_signals': blocked, 'evaluated_bars': evaluated, 'missing_price_bars': missing,
        'halted': halted, 'start_time': start_time, 'end_time': end_time,
    }}


def replay_markers(result, interval_seconds):
    trades = {t['id']: t for t in result['trades']}
    markers = {}
    for event in result['events']:
        entry = event['is_entry']
        t = (event['time'] + (240 if interval_seconds == 60 else 0))//interval_seconds*interval_seconds
        key = (t, entry)
        trade = trades[event['trade_id']]
        if key not in markers:
            markers[key] = {'time': t, 'is_entry': entry, 'hypothetical': True, 'backtest': True,
                'position': 'aboveBar' if entry else 'belowBar', 'shape': 'arrowDown' if entry else 'arrowUp',
                'color': '#dc2626' if entry else '#16a34a', 'text': '', 'count': 0, 'qty': 0,
                'estimated_net_pnl_usd': 0.0}
            if entry:
                markers[key]['convergence_target_spread'] = trade['entry_spread']-.08
                markers[key]['pnl_model'] = {
                    'adr_entry_price': trade['adr_entry_price'], 'stock_entry_price': trade['stock_entry_price'],
                    'entry_time_ms': trade['entry_time_ms'], 'adr_exit_qty': .07, 'stock_exit_qty': 1.2,
                    'entry_fees_usd': (.07*trade['adr_entry_price']+1.2*trade['stock_entry_price'])*(ENTRY_FEE_BPS+EXIT_SLIPPAGE_BPS)/10000,
                    'exit_fee_bps': EXIT_FEE_BPS, 'slippage_bps': EXIT_SLIPPAGE_BPS,
                    'funding_reserve_bps_day': FUNDING_RESERVE_BPS_DAY, 'threshold_usd': MIN_NET_PROFIT_USD}
        m = markers[key]
        if entry and m['count']:
            model = m['pnl_model']
            n = m['count']
            for field, value in (
                ('adr_entry_price', trade['adr_entry_price']),
                ('stock_entry_price', trade['stock_entry_price']),
                ('entry_time_ms', trade['entry_time_ms']),
                ('entry_fees_usd', (.07*trade['adr_entry_price']+1.2*trade['stock_entry_price'])*(ENTRY_FEE_BPS+EXIT_SLIPPAGE_BPS)/10000),
            ):
                model[field] = (model[field]*n+value)/(n+1)
            m['convergence_target_spread'] = (m['convergence_target_spread']*n + trade['entry_spread']-.08)/(n+1)
        m['count'] += 1
        m['qty'] = round(m['count']*(.08 if entry else .07), 2)
        m['estimated_net_pnl_usd'] += event.get('net_pnl_usd', 0)
        m['hoverText'] = f"BACKTEST {'SHORT' if entry else 'COVER'} {m['qty']:.2f} ({m['count']}x)"
        if not entry:
            m['hoverText'] += f" · net ${m['estimated_net_pnl_usd']:+.3f}"
    return sorted(markers.values(), key=lambda m: (m['time'], not m['is_entry']))
