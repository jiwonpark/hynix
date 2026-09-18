"""Read-only price-signal replay, unconstrained by account capital or margin."""
import math
from collections import deque
from .tranche_accounting import EXIT_FEE_BPS, EXIT_SLIPPAGE_BPS, FUNDING_RESERVE_BPS_DAY
from .macro_policy import macro_policy, confirmed_rebound

ENTRY_FEE_BPS = 5.0
STEP = 300


def replay(bars, start_time, end_time, initial_equity=None, toggles=None):
    """Start flat at start_time; preceding bars warm indicators without trading.

    Bars contain closed 5m prices. Orders are simulated at that candle's close,
    with fees and slippage deducted. Funding is a conservative reserve, not an
    exchange funding-history reconstruction. No account or execution state enters
    this calculation. The legacy initial_equity argument is ignored: capital,
    margin, leverage, and account exhaustion never suppress price signals.
    """
    toggles = toggles or {}
    def passes(key, value):
        return not toggles.get(key, True) or bool(value)
    def aligned(values, upward, current_val=None):
        if len(values) < 60:
            return False
        v = list(values)
        curr = current_val if (current_val is not None and math.isfinite(current_val)) else v[-1]
        a, b, c = sum(v[-7:])/7, sum(v[-24:])/24, sum(v[-60:])/60
        return curr > a > b > c if upward else curr < a < b < c
    def ma_pass(key, values, upward, current_val=None):
        # Explicit timeframe switches override the former combined switch.
        enabled = toggles.get(key, toggles.get('exit_ma_stack', True) if key.startswith('exit_') else True)
        return not enabled or aligned(values, upward, current_val)

    pnl = peak = peak_notional = current_notional = 0.0
    drawdown = fees = slippage = funding = 0.0
    aq = sq = adr_avg = stock_avg = 0.0
    stack, trades, events = [], [], []
    five, hourly = deque(maxlen=60), deque(maxlen=60)
    hour_parts = []
    previous = None
    last_entry = last_exit = -math.inf
    evaluated = missing = 0
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
            pnl += aq * (previous['adr'] - adr) + sq * (stock - previous['csop'])
            carry = (aq * adr_avg + sq * stock_avg) * funding_rate * (t - previous['time']) / 86400
            pnl -= carry
            funding += carry
        previous = bar
        if t < start_time:
            continue
        evaluated += 1
        peak = max(peak, pnl)
        drawdown = max(drawdown, peak-pnl)
        peak_notional = max(peak_notional, aq*adr + sq*stock)
        vals = list(five)
        macro = macro_policy(hourly)
        entry_adr, entry_stock = macro['adr_entry_qty'], macro['stock_entry_qty']
        ma24 = sum(vals[-24:]) / min(24, len(vals))
        peak_out = len(vals) >= 3 and (vals[-1] <= vals[-2] or vals[-1] < max(vals[-3:-1]))
        bottoming = len(vals) >= 3 and (vals[-1] >= vals[-2] or vals[-1] > min(vals[-3:-1]) or vals[-1] <= ma24)
        next_notional = entry_adr * adr + entry_stock * stock
        target = stack[-1] if stack else None
        sold = False
        if target:
            exit_policy = target['exit_policy']
            if exit_policy['require_confirmed_rebound']:
                bottoming = confirmed_rebound(vals)
            trim_notional = .07 * adr + 1.2 * stock
            gross = .07 * (target['adr_entry_price'] - adr) + 1.2 * (stock - target['stock_entry_price'])
            entry_trim_notional = .07 * target['adr_entry_price'] + 1.2 * target['stock_entry_price']
            allocated_entry_cost = entry_trim_notional * (entry_rate + slip_rate)
            carry = entry_trim_notional * funding_rate * (close - target['entry_time_ms']/1000) / 86400
            net = gross - allocated_entry_cost - trim_notional * (exit_rate + slip_rate) - carry
            exit_ready = all((
                passes('exit_net_profit', net > exit_policy['minimum_net_profit_usd']),
                passes('exit_convergence', spread <= target['entry_spread'] - exit_policy['convergence_pts']),
                passes('exit_dwell_time', close - target['entry_time_ms']/1000 >= 120),
                passes('exit_bottoming_out', bottoming),
                ma_pass('exit_ma_stack_5m', five, False, spread),
                ma_pass('exit_ma_stack_1h', hourly, False, spread),
                passes('exit_position_qty', aq + 1e-8 >= .07 and sq + 1e-8 >= 1.2),
                close - last_exit >= 30,
            ))
            # A simulated exit always needs an entry to close, even with the
            # speculative-tranche switch off. Retained core is carried forward.
            if exit_ready:
                exit_fee, exit_slip = trim_notional * exit_rate, trim_notional * slip_rate
                pnl -= exit_fee + exit_slip
                fees += exit_fee; slippage += exit_slip
                aq = round(aq - .07, 8); sq = round(sq - 1.2, 8)
                stack.pop()
                target.update(status='CLOSED', exit_time_ms=close*1000, estimated_net_pnl_usd=net, exit_spread=spread)
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
                ma_pass('entry_ma_stack_5m', five, True, spread),
                ma_pass('entry_ma_stack_1h', hourly, True, spread),
                close-last_entry >= 60,
            ))
            if setup:
                fee, slip = next_notional*entry_rate, next_notional*slip_rate
                pnl -= fee+slip
                fees += fee; slippage += slip
                adr_avg = (aq*adr_avg + entry_adr*adr)/(aq+entry_adr)
                stock_avg = (sq*stock_avg + entry_stock*stock)/(sq+entry_stock)
                aq = round(aq+entry_adr, 8); sq = round(sq+entry_stock, 8)
                trade = {'id': len(trades)+1, 'status': 'OPEN', 'entry_time_ms': close*1000,
                         'entry_spread': spread, 'adr_entry_price': adr, 'stock_entry_price': stock,
                         'adr_entry_qty': entry_adr, 'stock_entry_qty': entry_stock, 'exit_policy': macro}
                trades.append(trade); stack.append(trade)
                events.append({'time': t, 'is_entry': True, 'trade_id': trade['id']})
                last_entry = close
        current_notional = aq*adr + sq*stock
        peak_notional = max(peak_notional, current_notional)
        peak = max(peak, pnl)
        drawdown = max(drawdown, peak-pnl)
    return {'trades': trades, 'events': events, 'summary': {
        'mode': 'price_signals', 'capital_constrained': False,
        'net_pnl_usd': round(pnl, 6),
        'entries': len(trades), 'exits': len(trades)-len(stack), 'open_tranches': len(stack),
        'adr_short_qty': aq, 'stock_long_qty': sq,
        'core_adr_qty': round(aq-sum(t['adr_entry_qty'] for t in stack), 8),
        'core_stock_qty': round(sq-sum(t['stock_entry_qty'] for t in stack), 8),
        'boosted_entries': sum(t['exit_policy']['level'] > 0 for t in trades),
        'max_drawdown_usd': round(drawdown, 6),
        'gross_exposure_usd': round(current_notional, 6), 'peak_gross_exposure_usd': round(peak_notional, 6),
        'fees_usd': round(fees, 6), 'slippage_usd': round(slippage, 6), 'funding_reserve_usd': round(funding, 6),
        'capital_blocked_signals': 0, 'evaluated_bars': evaluated, 'missing_price_bars': missing,
        'halted': False, 'start_time': start_time, 'end_time': end_time,
    }}


def replay_markers(result, interval_seconds):
    trades = {t['id']: t for t in result['trades']}
    markers = {}
    for event in result['events']:
        entry = event['is_entry']
        t = (event['time'] + (240 if interval_seconds == 60 else 0))//interval_seconds*interval_seconds
        key = (t, entry)
        trade = trades[event['trade_id']]
        policy = trade['exit_policy']
        if key not in markers:
            markers[key] = {'time': t, 'is_entry': entry, 'hypothetical': True, 'backtest': True,
                'position': 'aboveBar' if entry else 'belowBar', 'shape': 'arrowDown' if entry else 'arrowUp',
                'color': '#dc2626' if entry else '#16a34a', 'text': '', 'count': 0, 'qty': 0,
                'estimated_net_pnl_usd': 0.0,
                'entry_spread': trade['entry_spread'],
                'convergence_target_spread': trade['entry_spread']-policy['convergence_pts'],
                'pnl_model': {
                    'adr_entry_price': trade['adr_entry_price'], 'stock_entry_price': trade['stock_entry_price'],
                    'entry_time_ms': trade['entry_time_ms'], 'adr_exit_qty': .07, 'stock_exit_qty': 1.2,
                    'entry_fees_usd': (.07*trade['adr_entry_price']+1.2*trade['stock_entry_price'])*(ENTRY_FEE_BPS+EXIT_SLIPPAGE_BPS)/10000,
                    'exit_fee_bps': EXIT_FEE_BPS, 'slippage_bps': EXIT_SLIPPAGE_BPS,
                    'funding_reserve_bps_day': FUNDING_RESERVE_BPS_DAY, 'threshold_usd': policy['minimum_net_profit_usd']}}
            if 'exit_spread' in trade:
                markers[key]['exit_spread'] = trade['exit_spread']
        m = markers[key]
        if m['count']:
            model = m['pnl_model']
            n = m['count']
            for field, value in (
                ('adr_entry_price', trade['adr_entry_price']),
                ('stock_entry_price', trade['stock_entry_price']),
                ('entry_time_ms', trade['entry_time_ms']),
                ('entry_fees_usd', (.07*trade['adr_entry_price']+1.2*trade['stock_entry_price'])*(ENTRY_FEE_BPS+EXIT_SLIPPAGE_BPS)/10000),
                ('threshold_usd', policy['minimum_net_profit_usd']),
            ):
                model[field] = (model[field]*n+value)/(n+1)
            m['convergence_target_spread'] = (m['convergence_target_spread']*n + trade['entry_spread']-policy['convergence_pts'])/(n+1)
            m['entry_spread'] = (m['entry_spread']*n + trade['entry_spread'])/(n+1)
            if 'exit_spread' in trade:
                m['exit_spread'] = ((m.get('exit_spread') or trade['exit_spread'])*n + trade['exit_spread'])/(n+1)
        m['count'] += 1
        m['qty'] = round(m['qty']+(trade['adr_entry_qty'] if entry else .07), 2)
        m['estimated_net_pnl_usd'] += event.get('net_pnl_usd', 0)
        m['hoverText'] = f"BACKTEST {'SHORT' if entry else 'COVER'} {m['qty']:.2f} ({m['count']}x)"
        if not entry:
            m['hoverText'] += f" · net ${m['estimated_net_pnl_usd']:+.3f}"
    return sorted(markers.values(), key=lambda m: (m['time'], not m['is_entry']))
