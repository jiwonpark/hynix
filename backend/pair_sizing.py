"""Price-based ADR/2x ETF lots; exchange filters are mandatory for live sizing."""
import asyncio
import math
import time
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP

ADR = 'SKHYUSDT'
ETF = 'CSOPSKHYNIX2LUSDT'
# Explicit reference rules for standalone historical simulations, never live orders.
REFERENCE_RULES = {symbol: {'step': '0.01', 'min_qty': '0.01', 'max_qty': maximum,
                           'min_notional': '5'}
                   for symbol, maximum in ((ADR, '2300'), (ETF, '80000'))}


def positive(value):
    number = Decimal(str(value))
    if not number.is_finite() or number <= 0:
        raise ValueError('Sizing requires finite positive prices and contract limits')
    return number


def round_step(value, step, rounding=ROUND_CEILING):
    return (value / step).to_integral_value(rounding=rounding) * step


def parse_rules(info):
    result = {}
    for symbol in info.get('symbols', []):
        name = symbol['symbol']
        if name not in (ADR, ETF):
            continue
        if symbol['status'] != 'TRADING' or 'MARKET' not in symbol['orderTypes']:
            raise ValueError(f'{name} is not available for market orders')
        filters = {f['filterType']: f for f in symbol['filters']}
        lot, market = filters['LOT_SIZE'], filters['MARKET_LOT_SIZE']
        steps = [positive(f['stepSize']) for f in (lot, market) if Decimal(f['stepSize']) > 0]
        places = max(-s.as_tuple().exponent for s in steps)
        scale = Decimal(10) ** places
        step = Decimal(math.lcm(*(int(s*scale) for s in steps))) / scale
        result[name] = {
            'step': str(step),
            'min_qty': str(max(positive(lot['minQty']), Decimal(market['minQty']))),
            'max_qty': str(min(positive(lot['maxQty']), positive(market['maxQty']))),
            'min_notional': str(positive(filters['MIN_NOTIONAL']['notional'])),
        }
    if set(result) != {ADR, ETF}:
        raise ValueError('Missing ADR/ETF exchange filters')
    return result


async def exchange_rules(client, fresh=False):
    cached = getattr(client, '_pair_sizing_rules', None)
    if not fresh and isinstance(cached, tuple) and time.monotonic() - cached[0] < 300:
        return cached[1]
    rules = parse_rules(await client.request('GET', '/fapi/v1/exchangeInfo', {}))
    client._pair_sizing_rules = (time.monotonic(), rules)
    return rules


async def live_sizing_inputs(client):
    rules, adr, etf = await asyncio.gather(
        exchange_rules(client, fresh=True),
        client.request('GET', '/fapi/v1/premiumIndex', {'symbol': ADR}),
        client.request('GET', '/fapi/v1/premiumIndex', {'symbol': ETF}),
    )
    now = time.time() * 1000
    for quote in (adr, etf):
        if not -5000 <= now - float(quote['time']) <= 30000:
            raise ValueError('Stale mark prices; cannot size a new entry')
    return float(positive(adr['markPrice'])), float(positive(etf['markPrice'])), rules


def size_policy(policy, adr_price, stock_price, rules):
    """Smallest ADR lot funding a valid ETF lot, with nearest-step ETF balance.

    Normal entry equals the minimum pair. Macro boosts add core above that pair;
    the base exit quantities are saved with the entry, never repriced on exit.
    """
    a, s = positive(adr_price), positive(stock_price)
    ar, sr = rules[ADR], rules[ETF]
    astep, sstep = positive(ar['step']), positive(sr['step'])
    amin = round_step(max(positive(ar['min_qty']), positive(ar['min_notional']) / a), astep)
    smin = round_step(max(positive(sr['min_qty']), positive(sr['min_notional']) / s), sstep)
    unit_a = round_step(max(amin, 2*smin*s/a), astep)
    unit_s = max(smin, round_step(unit_a*a/(2*s), sstep, ROUND_HALF_UP))
    multiplier = positive(policy['entry_multiplier'])
    if multiplier < 1:
        raise ValueError('Entry multiplier cannot be smaller than the exit unit')
    entry_a = round_step(unit_a*multiplier, astep)
    entry_s = max(unit_s, round_step(entry_a*a/(2*s), sstep, ROUND_HALF_UP))
    if entry_a > positive(ar['max_qty']) or entry_s > positive(sr['max_qty']):
        raise ValueError('Balanced pair exceeds exchange market quantity limits')
    delta = 2*entry_s*s - entry_a*a
    return {**policy, 'sizing_version': 'dollar_2x_v1', 'sizing_available': True,
            'adr_entry_qty': float(entry_a), 'stock_entry_qty': float(entry_s),
            'adr_exit_qty': float(unit_a), 'stock_exit_qty': float(unit_s),
            'sizing_adr_price': float(a), 'sizing_stock_price': float(s),
            'hedge_multiplier': 2.0, 'effective_entry_multiplier': float(entry_a/unit_a),
            'entry_delta_usd': float(delta), 'entry_delta_pct': float(delta/(entry_a*a)*100),
            'exchange_rules': rules}
