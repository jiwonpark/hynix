"""Conservative LIFO attribution for the fixed ADR/CSOP tranche strategy."""
import math


EXIT_FEE_BPS = 5.0
EXIT_SLIPPAGE_BPS = 3.0
FUNDING_RESERVE_BPS_DAY = 3.0
LEG_PAIR_MAX_DELAY_MS = 5000


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
    its ETF hedge.  Therefore a valid legacy pair is the sole fixed-size ETF entry
    after an ADR entry and before the next ADR entry, within a short delay.
    """
    entries = [order for order in orders
               if ((order['symbol'] == 'SKHYUSDT' and order['side'] == 'SELL')
                   or (order['symbol'] == stock_symbol and order['side'] == 'BUY'))]
    pairs = {}
    for index, adr in enumerate(entries):
        if adr['symbol'] != 'SKHYUSDT' or abs(adr['qty'] - .08) >= 1e-8:
            continue
        candidates = []
        for candidate in entries[index + 1:]:
            if candidate['symbol'] == 'SKHYUSDT':
                break
            delay = candidate['time'] - adr['time']
            if delay > LEG_PAIR_MAX_DELAY_MS:
                break
            if delay >= 0 and abs(candidate['qty'] - 1.4) < 1e-8:
                candidates.append(candidate)
        if len(candidates) == 1:
            pairs[adr['order_id']] = candidates[0]['order_id']
    return pairs


def estimate_tranche_exit(target, executions, adr_mark, stock_mark, stock_symbol, pairs, now):
    result = {'available': False, 'net_pnl_usd': None, 'profitable': False,
              'reason': 'NO_TARGET_TRANCHE', 'threshold_usd': 0.02,
              'valuation': 'mark_prices_with_cost_reserves',
              'exit_fee_bps': EXIT_FEE_BPS, 'slippage_bps': EXIT_SLIPPAGE_BPS,
              'funding_reserve_bps_day': FUNDING_RESERVE_BPS_DAY}
    if not target:
        return result
    result['adr_order_id'] = target['trade_id']
    if stock_symbol != 'CSOPSKHYNIX2LUSDT':
        return {**result, 'reason': 'UNSUPPORTED_HEDGE_SYMBOL'}
    if not all(math.isfinite(p) and p > 0 for p in (adr_mark, stock_mark)):
        return {**result, 'reason': 'MISSING_MARK_PRICES'}
    orders = aggregate_orders(executions)
    adr_entries = [o for o in orders if o['symbol'] == 'SKHYUSDT' and o['side'] == 'SELL']
    adr = next((o for o in adr_entries if o['order_id'] == target['trade_id']), None)
    # Reconstruct the hedge stack independently; an unmatched hedge exit must
    # not cause an unrelated ETF lot to be attributed to the selected ADR lot.
    stock_stack = []
    for order in orders:
        if order['symbol'] != stock_symbol:
            continue
        qty = round(order['qty'], 8)
        if order['side'] == 'BUY':
            while qty > 1e-8:
                chunk = min(1.4, qty)
                stock_stack.append({'order': order, 'trim_qty': min(1.2, chunk)})
                qty = round(qty - chunk, 8)
        else:
            while qty > 1e-8 and stock_stack:
                top = stock_stack[-1]
                consumed = min(qty, top['trim_qty'])
                top['trim_qty'] = round(top['trim_qty'] - consumed, 8)
                qty = round(qty - consumed, 8)
                if top['trim_qty'] <= 1e-8:
                    stock_stack.pop()
    if not adr or not stock_stack:
        return {**result, 'reason': 'MISSING_ENTRY_LEG'}
    active_stock = {item['order']['order_id']: item for item in stock_stack}
    saved_pair = next((p for p in reversed(pairs) if str(p['adr_order_id']) == adr['order_id']), None)
    if saved_pair:
        stock_item = active_stock.get(str(saved_pair['stock_order_id']))
        pairing = 'recorded_order_ids'
    else:
        inferred_order_id = infer_entry_pairs(orders, stock_symbol).get(adr['order_id'])
        stock_item = active_stock.get(inferred_order_id)
        pairing = 'restored_from_account_history_sequence'
    if not stock_item:
        return {**result, 'reason': 'AMBIGUOUS_OR_MISMATCHED_ENTRY_LEGS'}
    stock = stock_item['order']
    if target['trim_qty'] < .07 or stock_item['trim_qty'] < 1.2:
        return {**result, 'reason': 'INCOMPLETE_REMAINING_TRANCHE'}
    if not adr['fee_known'] or not stock['fee_known']:
        return {**result, 'reason': 'ENTRY_COMMISSION_UNAVAILABLE_IN_USDT'}
    adr_entry = adr['cost'] / adr['qty']
    stock_entry = stock['cost'] / stock['qty']
    if not all(math.isfinite(p) and p > 0 for p in (adr_entry, stock_entry)):
        return {**result, 'reason': 'INVALID_ENTRY_PRICES'}
    adr_pnl = .07 * (adr_entry - adr_mark)
    stock_pnl = 1.2 * (stock_mark - stock_entry)
    entry_fees = adr['fee'] * .07 / adr['qty'] + stock['fee'] * 1.2 / stock['qty']
    exit_notional = .07 * adr_mark + 1.2 * stock_mark
    closing_fee = exit_notional * EXIT_FEE_BPS / 10000
    slippage = exit_notional * EXIT_SLIPPAGE_BPS / 10000
    holding_days = max(0, now - min(adr['time'], stock['time']) / 1000) / 86400
    funding = (.07 * adr_entry + 1.2 * stock_entry) * FUNDING_RESERVE_BPS_DAY / 10000 * holding_days
    net = adr_pnl + stock_pnl - entry_fees - closing_fee - slippage - funding
    return {**result, 'available': True, 'profitable': net > .02, 'reason': 'ESTIMATE_READY',
            'stock_order_id': stock['order_id'], 'pairing': pairing,
            'adr_entry_price': adr_entry, 'stock_entry_price': stock_entry,
            'adr_exit_qty': .07, 'stock_exit_qty': 1.2,
            'adr_pnl_usd': adr_pnl, 'stock_pnl_usd': stock_pnl,
            'gross_pnl_usd': adr_pnl + stock_pnl, 'entry_fees_usd': entry_fees,
            'estimated_exit_fee_usd': closing_fee, 'slippage_reserve_usd': slippage,
            'funding_reserve_usd': funding, 'net_pnl_usd': net}
