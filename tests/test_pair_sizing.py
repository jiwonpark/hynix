import copy
import time
import unittest
from decimal import Decimal
from unittest.mock import AsyncMock

from backend.macro_policy import policy_for_level
from backend.pair_sizing import (ADR, ETF, REFERENCE_RULES, size_policy, parse_rules,
                                 exchange_rules, live_sizing_inputs)
from backend.tranche_accounting import (aggregate_orders, entry_profiles,
    reconstruct_leg_stack, estimate_tranche_exit)
from backend.dynamic_backtest import replay, replay_markers


def exchange_info():
    return {'symbols': [{'symbol': name, 'status': 'TRADING', 'orderTypes': ['MARKET'],
        'filters': [{'filterType': kind, 'minQty': '.01', 'maxQty': rule['max_qty'], 'stepSize': '.01'}
                    for kind in ('LOT_SIZE', 'MARKET_LOT_SIZE')]
                   + [{'filterType': 'MIN_NOTIONAL', 'notional': '5'}]}
        for name, rule in REFERENCE_RULES.items()]}


class PairSizingTests(unittest.TestCase):
    def test_current_pair_and_rounding_delta(self):
        p = size_policy(policy_for_level(), 193.63, 5.378, REFERENCE_RULES)
        self.assertEqual((p['adr_entry_qty'], p['stock_entry_qty']), (.06, 1.08))
        self.assertAlmostEqual(p['entry_delta_usd'], -.00132)
        self.assertEqual(p['adr_entry_qty'], p['adr_exit_qty'])
        self.assertEqual(p['stock_entry_qty'], p['stock_exit_qty'])

    def test_prices_and_filter_changes_recalculate_the_minimum(self):
        cases = [(100, 5), (200, 5), (300, 9), (31, .781), (251, 60)]
        for a, s in cases:
            with self.subTest(adr=a, stock=s):
                p = size_policy(policy_for_level(), a, s, REFERENCE_RULES)
                qa, qs = Decimal(str(p['adr_entry_qty'])), Decimal(str(p['stock_entry_qty']))
                self.assertGreaterEqual(qa*Decimal(a), 5)
                self.assertGreaterEqual(qs*Decimal(str(s)), 5)
                self.assertEqual(qa % Decimal('.01'), 0)
                self.assertEqual(qs % Decimal('.01'), 0)
                self.assertLessEqual(abs(2*float(qs)*s-float(qa)*a), .01*s+1e-10)
                # A smaller ADR lot cannot fund even the smallest valid ETF lot.
                minimum_etf = (Decimal(5)/Decimal(str(s))/Decimal('.01')).to_integral_value(rounding='ROUND_CEILING')*Decimal('.01')
                self.assertLess((qa-Decimal('.01'))*Decimal(a), 2*minimum_etf*Decimal(str(s)))
        rules = copy.deepcopy(REFERENCE_RULES)
        rules[ETF]['min_notional'] = '20'
        p = size_policy(policy_for_level(), 200, 5, rules)
        self.assertEqual((p['adr_entry_qty'], p['stock_entry_qty']), (.2, 4))

    def test_macro_boost_adds_core_without_increasing_saved_base_exit(self):
        policies = [size_policy(policy_for_level(i), 193.63, 5.378, REFERENCE_RULES) for i in range(3)]
        self.assertEqual([p['adr_entry_qty'] for p in policies], [.06, .08, .09])
        for p in policies:
            self.assertEqual((p['adr_exit_qty'], p['stock_exit_qty']), (.06, 1.08))
        self.assertGreater(policies[1]['effective_entry_multiplier'], 1.25)

    def test_invalid_prices_limits_and_suspended_symbols_fail_closed(self):
        for price in (0, -1, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                size_policy(policy_for_level(), price, 5, REFERENCE_RULES)
        rules = copy.deepcopy(REFERENCE_RULES)
        rules[ADR]['max_qty'] = '.01'
        with self.assertRaises(ValueError):
            size_policy(policy_for_level(), 200, 5, rules)
        info = exchange_info()
        info['symbols'][0]['status'] = 'PENDING_TRADING'
        with self.assertRaises(ValueError):
            parse_rules(info)
        with self.assertRaises(ValueError):
            parse_rules({'symbols': []})

    def test_both_market_and_lot_steps_are_obeyed(self):
        info = exchange_info()
        info['symbols'][0]['filters'][0]['stepSize'] = '.02'
        info['symbols'][0]['filters'][1]['stepSize'] = '.03'
        rules = parse_rules(info)
        self.assertEqual(Decimal(rules[ADR]['step']), Decimal('.06'))
        p = size_policy(policy_for_level(), 100, 5, rules)
        self.assertEqual(p['adr_entry_qty'], .12)

    def test_mixed_legacy_and_dynamic_stack_restores_after_restart(self):
        fills, pairs = [], []
        def add(symbol, order, side, qty, price, timestamp):
            fills.append(dict(symbol=symbol, order_id=str(order), id=str(order), side=side,
                qty=qty, price=price, time=timestamp, commission=.001, commission_asset='USDT'))
        add(ADR, 1, 'SELL', .08, 200, 1000)
        add(ETF, 2, 'BUY', 1.4, 5, 1001)
        p = size_policy(policy_for_level(2), 190, 5.6, REFERENCE_RULES)
        add(ADR, 3, 'SELL', p['adr_entry_qty'], 190, 2000)
        add(ETF, 4, 'BUY', p['stock_entry_qty'], 5.6, 2001)
        pairs.append({'adr_order_id': '3', 'stock_order_id': '4', 'entry_policy': p})
        orders = aggregate_orders(fills)
        profiles = entry_profiles(orders, ETF, pairs)
        stack = reconstruct_leg_stack(orders, ADR, 'SELL', .08, .07, profiles)
        self.assertEqual([(t['qty'], t['trim_qty']) for t in stack], [(.08, .07), (.09, .06)])
        target = dict(trade_id='3', trim_qty=.06, exit_policy=p)
        profit = estimate_tranche_exit(target, fills, 180, 5.5, ETF, pairs, 100)
        self.assertTrue(profit['available'])
        self.assertEqual((profit['adr_exit_qty'], profit['stock_exit_qty']), (.06, 1.02))
        self.assertAlmostEqual(profit['gross_pnl_usd'], .06*10+1.02*(-.1))
        self.assertAlmostEqual(profit['entry_fees_usd'], .001*.06/.09+.001*1.02/1.53)
        add(ADR, 5, 'BUY', .06, 180, 3000)
        add(ETF, 6, 'SELL', 1.02, 5.5, 3001)
        stack = reconstruct_leg_stack(aggregate_orders(fills), ADR, 'SELL', .08, .07, profiles)
        self.assertEqual([t['order']['order_id'] for t in stack], ['1'])
        self.assertFalse(estimate_tranche_exit(target, fills, 180, 5.5, ETF, pairs, 101)['available'])
        older = estimate_tranche_exit(dict(trade_id='1', trim_qty=.07), fills, 180, 5.5, ETF, pairs, 101)
        self.assertTrue(older['available'])
        self.assertEqual((older['adr_exit_qty'], older['stock_exit_qty']), (.07, 1.2))

    def test_replay_models_keep_quantities_when_prices_change(self):
        start = 1704067200
        bars = [dict(time=start+i*300, adr=a, csop=5, domestic=a/1.4, value=140)
                for i, a in enumerate([190, 100, 300])]
        toggles = {key: False for key in ('entry_ma_stack_5m', 'entry_ma_stack_1h',
            'entry_ma_stretch', 'entry_peak_rollover', 'entry_base_spread')}
        result = replay(bars, start, start+900, toggles=toggles)
        self.assertEqual([t['adr_entry_qty'] for t in result['trades']], [.06, .1, .04])
        marker = replay_markers(result, 3600)[0]
        self.assertEqual([m['adr_exit_qty'] for m in marker['pnl_models']], [.06, .1, .04])
        self.assertEqual([m['stock_exit_qty'] for m in marker['pnl_models']], [1.14, 1, 1.2])


class LiveSizingTests(unittest.IsolatedAsyncioTestCase):
    async def test_filter_cache_is_bypassed_before_orders(self):
        client = AsyncMock()
        client.request.return_value = exchange_info()
        first = await exchange_rules(client)
        self.assertEqual(await exchange_rules(client), first)
        self.assertEqual(client.request.await_count, 1)
        client.request.return_value = {'symbols': []}
        with self.assertRaises(ValueError):
            await exchange_rules(client, fresh=True)

    async def test_live_inputs_use_fresh_marks_and_fail_on_stale_quotes(self):
        client = AsyncMock()
        timestamp = time.time()*1000
        async def request(method, path, params):
            if 'exchangeInfo' in path:
                return exchange_info()
            return {'time': timestamp, 'markPrice': '190' if params['symbol'] == ADR else '5.6'}
        client.request.side_effect = request
        self.assertEqual((await live_sizing_inputs(client))[:2], (190, 5.6))
        timestamp -= 60000
        with self.assertRaisesRegex(ValueError, 'Stale'):
            await live_sizing_inputs(client)
