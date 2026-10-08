"""Conservative LIFO attribution for variable ADR/CSOP entries and saved exit quantities."""
import math
from .macro_policy import policy_for_level


EXIT_FEE_BPS = 5.0
EXIT_SLIPPAGE_BPS = 3.0
FUNDING_RESERVE_BPS_DAY = 3.0
LEG_PAIR_MAX_DELAY_MS = 5000
MIN_NET_PROFIT_USD = 0.02
MIN_NET_PROFIT_PCT = 0.10


def aggregate_orders(executions):
    orders = {}
    seen = set()
    for trade in executions:
        fill_key = (trade['symbol'], trade['id'])
        if fill_key in seen:
            continue
        seen.add(fill_key)
        key = (trade['symbol'], trade['order_id'], trade['side'])
        order = orders.setdefault(key, {**trade, 'qty': 0.0, 'cost': 0.0,
                                        'fee': 0.0, 'fee_known': True})
        order['qty'] += trade['qty']
        order['cost'] += trade['qty'] * trade['price']
        order['time'] = max(order['time'], trade['time'])
        fee = trade.get('commission')
        if fee is None or not math.isfinite(fee) or (fee != 0 and trade.get('commission_asset') != 'USDT'):
            order['fee_known'] = False
        else:
            order['fee'] += max(0.0, fee)
    return sorted(orders.values(), key=lambda order: order['time'])


def infer_entry_pairs(orders, stock_symbol):
    """Infer legacy ADR/ETF pairs from the strategy's sequential order history.

    Scale-in submits the ADR order first and waits for it to fill before submitting
    its ETF hedge. Therefore a valid inferred pair is the sole matching-size ETF entry
    after an ADR entry and before the next ADR entry, within a short delay.
    """
    entries = [order for order in orders
               if ((order['symbol'] == 'SKHYUSDT' and order['side'] == 'SELL')
                   or (order['symbol'] == stock_symbol and order['side'] == 'BUY'))]
    pairs = {}
    sizes = {p['adr_entry_qty']: p['stock_entry_qty'] for p in map(policy_for_level, range(3))}
    for index, adr in enumerate(entries):
        expected_stock = next((stock for qty, stock in sizes.items() if abs(adr['qty']-qty) < 1e-8), None)
        if adr['symbol'] != 'SKHYUSDT' or expected_stock is None:
            continue
        candidates = []
        for candidate in entries[index + 1:]:
            if candidate['symbol'] == 'SKHYUSDT':
                break
            delay = candidate['time'] - adr['time']
            if delay > LEG_PAIR_MAX_DELAY_MS:
                break
            if delay >= 0 and abs(candidate['qty'] - expected_stock) < 1e-8:
                candidates.append(candidate)
        if len(candidates) == 1:
            pairs[adr['order_id']] = candidates[0]['order_id']
    return pairs


def infer_exit_pairs(orders, stock_symbol):
    """Pair sequential ADR covers with a unique subsequent ETF reduction.

    Exit sizes vary with the saved policy. Ambiguous or delayed fills are left
    unpaired rather than assigning a misleading chart price.
    """
    adr_exits = [order for order in orders
                 if order['symbol'] == 'SKHYUSDT' and order['side'] == 'BUY']
    stock_exits = [order for order in orders
                   if order['symbol'] == stock_symbol and order['side'] == 'SELL']
    pairs = {}
    used_stock_ids = set()
    for index, adr in enumerate(adr_exits):
        next_adr_time = adr_exits[index + 1]['time'] if index + 1 < len(adr_exits) else math.inf
        candidates = [stock for stock in stock_exits
                      if stock['order_id'] not in used_stock_ids
                      and 0 <= stock['time'] - adr['time'] <= 30000
                      and stock['time'] < next_adr_time]
        if len(candidates) == 1:
            stock = candidates[0]
            pairs[adr['order_id']] = stock['order_id']
            used_stock_ids.add(stock['order_id'])
    return pairs


def entry_profiles(orders, stock_symbol, pairs):
    """Recover adaptive lots from persisted pairs or exact paired order sizes."""
    matched = infer_entry_pairs(orders, stock_symbol)
    saved = {str(p['adr_order_id']): p for p in pairs}
    matched.update({key: str(p['stock_order_id']) for key, p in saved.items()})
    stocks = {o['order_id']: o for o in orders if o['symbol'] == stock_symbol and o['side'] == 'BUY'}
    profiles = {}
    for adr in orders:
        if adr['symbol'] != 'SKHYUSDT' or adr['side'] != 'SELL':
            continue
        stock = stocks.get(matched.get(adr['order_id']))
        if not stock:
            continue
        recorded = saved.get(adr['order_id'], {}).get('entry_policy')
        if recorded and recorded.get('sizing_version') == 'dollar_2x_v1':
            # Never infer new variable-size lots from size or timing alone.
            try:
                valid = all(math.isfinite(recorded[k]) and recorded[k] > 0 for k in
                            ('adr_entry_qty', 'stock_entry_qty', 'adr_exit_qty', 'stock_exit_qty'))
                valid = valid and recorded['adr_exit_qty'] <= adr['qty'] + 1e-8 and recorded['stock_exit_qty'] <= stock['qty'] + 1e-8
                valid = valid and abs(adr['qty']-recorded['adr_entry_qty']) < 1e-8 and abs(stock['qty']-recorded['stock_entry_qty']) < 1e-8
            except (KeyError, TypeError):
                valid = False
            if valid:
                profiles[adr['order_id']] = {'stock_order_id': stock['order_id'], 'policy': recorded,
                    'entry_spread': saved[adr['order_id']].get('entry_spread')}
            continue
        for level in range(3):
            policy = policy_for_level(level)
            if abs(adr['qty']-policy['adr_entry_qty']) < 1e-8 and abs(stock['qty']-policy['stock_entry_qty']) < 1e-8:
                recorded = saved.get(adr['order_id'], {}).get('entry_policy')
                if recorded and all(key in recorded for key in policy):
                    policy = recorded
                profiles[adr['order_id']] = {'stock_order_id': stock['order_id'], 'policy': policy,
                    'entry_spread': saved.get(adr['order_id'], {}).get('entry_spread')}
                break
    return profiles


def reconstruct_leg_stack(orders, symbol, entry_side, entry_unit, exit_unit, adaptive_ids=()):
    stack = []
    for order in orders:
        if order['symbol'] != symbol:
            continue
        qty = round(order['qty'], 8)
        if order['side'] == entry_side:
            while qty > 1e-8:
                chunk = qty if order['order_id'] in adaptive_ids else min(entry_unit, qty)
                profile = adaptive_ids.get(order['order_id'], {}) if isinstance(adaptive_ids, dict) else {}
                key = 'adr_exit_qty' if symbol == 'SKHYUSDT' else 'stock_exit_qty'
                trim = profile.get('policy', {}).get(key, exit_unit)
                stack.append({'order': order, 'qty': chunk, 'trim_qty': min(trim, chunk)})
                qty = round(qty-chunk, 8)
        else:
            while qty > 1e-8 and stack:
                top = stack[-1]
                used = min(qty, top['trim_qty'])
                top['trim_qty'] = round(top['trim_qty']-used, 8)
                qty = round(qty-used, 8)
                if top['trim_qty'] <= 1e-8:
                    stack.pop()
    return stack


def prepare_exit_context(executions, stock_symbol, pairs, *, orders=None, profiles=None):
    """Build history attribution once for all tranches in a single snapshot."""
    if orders is None:
        orders = aggregate_orders(executions)
    if profiles is None:
        profiles = entry_profiles(orders, stock_symbol, pairs)
    stock_stack = reconstruct_leg_stack(orders, stock_symbol, 'BUY', 1.4, 1.2,
                                        {p['stock_order_id']: p for p in profiles.values()})
    return {
        'adr_entries': {o['order_id']: o for o in orders if o['symbol'] == 'SKHYUSDT' and o['side'] == 'SELL'},
        'active_stock': {item['order']['order_id']: item for item in stock_stack},
        'saved_pairs': {str(p['adr_order_id']): p for p in pairs},
        'inferred_pairs': infer_entry_pairs(orders, stock_symbol),
        'profiles': profiles,
    }


def estimate_tranche_exit(target, executions, adr_mark, stock_mark, stock_symbol, pairs, now, *, context=None):
    result = {'available': False, 'net_pnl_usd': None, 'profitable': False,
              'reason': 'NO_TARGET_TRANCHE', 'threshold_usd': MIN_NET_PROFIT_USD,
              'min_profit_pct': MIN_NET_PROFIT_PCT,
              'valuation': 'mark_prices_with_cost_reserves',
              'exit_fee_bps': EXIT_FEE_BPS, 'slippage_bps': EXIT_SLIPPAGE_BPS,
              'funding_reserve_bps_day': FUNDING_RESERVE_BPS_DAY}
    if not target:
        return result
    exit_policy = target.get('exit_policy') or {}
    min_profit_pct = exit_policy.get('min_profit_pct')
    min_usd_floor = exit_policy.get('minimum_net_profit_usd', MIN_NET_PROFIT_USD)
    threshold = min_usd_floor
    result['threshold_usd'] = threshold
    if min_profit_pct is not None:
        result['min_profit_pct'] = min_profit_pct
    result['adr_order_id'] = target['trade_id']
    if stock_symbol != 'CSOPSKHYNIX2LUSDT':
        return {**result, 'reason': 'UNSUPPORTED_HEDGE_SYMBOL'}
    if not all(math.isfinite(p) and p > 0 for p in (adr_mark, stock_mark)):
        return {**result, 'reason': 'MISSING_MARK_PRICES'}
    if context is None:
        context = prepare_exit_context(executions, stock_symbol, pairs)
    adr = context['adr_entries'].get(target['trade_id'])
    active_stock = context['active_stock']
    if not adr or not active_stock:
        return {**result, 'reason': 'MISSING_ENTRY_LEG'}
    saved_pair = context['saved_pairs'].get(adr['order_id'])
    if saved_pair:
        stock_item = active_stock.get(str(saved_pair['stock_order_id']))
        pairing = 'recorded_order_ids'
    else:
        inferred_order_id = context['inferred_pairs'].get(adr['order_id'])
        stock_item = active_stock.get(inferred_order_id)
        pairing = 'restored_from_account_history_sequence'
    if not stock_item:
        return {**result, 'reason': 'AMBIGUOUS_OR_MISMATCHED_ENTRY_LEGS'}
    stock = stock_item['order']
    policy = context['profiles'].get(adr['order_id'], {}).get('policy', {})
    if saved_pair and saved_pair.get('entry_policy', {}).get('sizing_version') and not policy:
        return {**result, 'reason': 'UNVERIFIED_DYNAMIC_ENTRY'}
    aq, sq = policy.get('adr_exit_qty', .07), policy.get('stock_exit_qty', 1.2)
    if target['trim_qty'] + 1e-8 < aq or stock_item['trim_qty'] + 1e-8 < sq:
        return {**result, 'reason': 'INCOMPLETE_REMAINING_TRANCHE'}
    if not adr['fee_known'] or not stock['fee_known']:
        return {**result, 'reason': 'ENTRY_COMMISSION_UNAVAILABLE_IN_USDT'}
    adr_entry = adr['cost'] / adr['qty']
    stock_entry = stock['cost'] / stock['qty']
    if not all(math.isfinite(p) and p > 0 for p in (adr_entry, stock_entry)):
        return {**result, 'reason': 'INVALID_ENTRY_PRICES'}
    adr_pnl = aq * (adr_entry - adr_mark)
    stock_pnl = sq * (stock_mark - stock_entry)
    entry_fees = adr['fee'] * aq / adr['qty'] + stock['fee'] * sq / stock['qty']
    exit_notional = aq * adr_mark + sq * stock_mark
    closing_fee = exit_notional * EXIT_FEE_BPS / 10000
    slippage = exit_notional * EXIT_SLIPPAGE_BPS / 10000
    holding_days = max(0, now - min(adr['time'], stock['time']) / 1000) / 86400
    funding = (aq * adr_entry + sq * stock_entry) * FUNDING_RESERVE_BPS_DAY / 10000 * holding_days
    net = adr_pnl + stock_pnl - entry_fees - closing_fee - slippage - funding
    if min_profit_pct is not None and exit_notional > 0:
        threshold = max(min_usd_floor, exit_notional * (min_profit_pct / 100.0))
    else:
        threshold = min_usd_floor
    threshold = round(threshold, 4)
    result['threshold_usd'] = threshold
    result['exit_notional_usd'] = round(exit_notional, 4)
    result['net_return_pct'] = round((net / exit_notional * 100.0), 4) if exit_notional > 0 else 0.0
    return {**result, 'available': True, 'profitable': net > threshold, 'reason': 'ESTIMATE_READY',
            'stock_order_id': stock['order_id'], 'pairing': pairing,
            'adr_entry_price': adr_entry, 'stock_entry_price': stock_entry,
            'adr_exit_qty': aq, 'stock_exit_qty': sq,
            'adr_pnl_usd': adr_pnl, 'stock_pnl_usd': stock_pnl,
            'gross_pnl_usd': adr_pnl + stock_pnl, 'entry_fees_usd': entry_fees,
            'estimated_exit_fee_usd': closing_fee, 'slippage_reserve_usd': slippage,
            'funding_reserve_usd': funding, 'net_pnl_usd': net}
