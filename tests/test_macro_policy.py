import unittest
from backend.macro_policy import macro_policy, policy_for_level, closed_values, confirmed_rebound
from backend.dynamic_backtest import replay, replay_markers
from backend.tranche_accounting import aggregate_orders, entry_profiles, reconstruct_leg_stack, estimate_tranche_exit

BASE = 1704067200


class MacroPolicyTests(unittest.TestCase):
    def hours(self, level):
        values = [100+i*.1 for i in range(60)]
        if level == 1:
            values[-3:] = [105.65, 105.66, 105.67]
        if level == 2:
            values[-3:] = [106, 105.95, 105.9]
        return values

    def test_slowing_and_rollover_increase_entry_but_never_exit_size(self):
        for level in range(3):
            policy = macro_policy(self.hours(level))
            self.assertEqual(policy['level'], level)
            self.assertEqual(policy['adr_entry_qty'], (.08, .1, .12)[level])
            self.assertEqual(policy['stock_entry_qty'], (1.4, 1.75, 2.1)[level])
            self.assertEqual(policy['adr_exit_qty'], .07)
            self.assertEqual(policy['stock_exit_qty'], 1.2)
        self.assertEqual(macro_policy([100]*60)['level'], 0)
        self.assertFalse(macro_policy(self.hours(2)[:-1])['ready'])
        self.assertFalse(macro_policy([float('nan')]*60)['ready'])
        self.assertEqual(macro_policy(list(reversed(self.hours(0))))['level'], 0)

    def test_forming_stale_and_gapped_hours_cannot_boost(self):
        bars = [dict(time=BASE+i*3600, value=v) for i, v in enumerate(self.hours(2))]
        now = BASE+60*3600
        forming = dict(time=now, value=1)
        self.assertEqual(macro_policy(closed_values(bars+[forming], 3600, now))['level'], 2)
        self.assertFalse(macro_policy(closed_values(bars, 3600, now+3600))['ready'])
        self.assertFalse(macro_policy(closed_values(bars[:30]+bars[31:], 3600, now))['ready'])
        self.assertFalse(confirmed_rebound([104, 103, 102]))
        self.assertFalse(confirmed_rebound([102, 102, 103]))
        self.assertTrue(confirmed_rebound([102, 103, 104]))

    def test_boosted_replay_waits_for_rebound_and_retains_larger_core(self):
        values = [v for v in self.hours(2) for _ in range(12)] + [105, 104.9, 104.95, 105]
        data = [dict(time=BASE+i*300, value=v, adr=100 if i<720 else 95,
                     csop=5, domestic=100/v*100) for i,v in enumerate(values)]
        toggles = dict(entry_ma_stack_5m=False, entry_ma_stack_1h=False, entry_ma_stretch=False,
                       exit_ma_stack_5m=False, exit_ma_stack_1h=False)
        before = replay(data, BASE+719*300, BASE+722*300, toggles=toggles)
        self.assertEqual(before['summary']['entries'], 1)
        self.assertEqual(before['summary']['exits'], 0, 'falling below MA must not close boosted entry')
        after = replay(data, BASE+719*300, BASE+724*300, toggles=toggles)
        self.assertEqual(after['summary']['exits'], 1)
        self.assertAlmostEqual(after['summary']['core_adr_qty'], .05)
        self.assertAlmostEqual(after['summary']['core_stock_qty'], .9)
        self.assertEqual(after['trades'][0]['exit_policy']['minimum_net_profit_usd'], .04)
        markers = replay_markers(after, 300)
        self.assertEqual(markers[0]['qty'], .12)
        self.assertEqual(markers[1]['qty'], .07)
        self.assertEqual(markers[0]['pnl_model']['threshold_usd'], .04)
        self.assertAlmostEqual(markers[0]['convergence_target_spread'], 105.74)

    def test_history_restores_one_exit_unit_per_boosted_entry(self):
        def trade(symbol, order, side, qty, price, time):
            return dict(symbol=symbol, id=str(order), order_id=str(order), side=side, qty=qty,
                        price=price, time=time, commission=.001, commission_asset='USDT')
        fills = [trade('SKHYUSDT', 1, 'SELL', .1, 100, 1000),
                 trade('CSOPSKHYNIX2LUSDT', 2, 'BUY', 1.75, 5, 1001),
                 trade('SKHYUSDT', 3, 'SELL', .12, 100, 2000),
                 trade('CSOPSKHYNIX2LUSDT', 4, 'BUY', 2.1, 5, 2001)]
        orders = aggregate_orders(fills)
        profiles = entry_profiles(orders, 'CSOPSKHYNIX2LUSDT', [])
        self.assertEqual(profiles['3']['policy']['level'], 2)
        stack = reconstruct_leg_stack(orders, 'SKHYUSDT', 'SELL', .08, .07, profiles)
        self.assertEqual(len(stack), 2, 'larger entry is not multiple speculative tranches')
        target = dict(trade_id='3', trim_qty=.07, exit_policy=profiles['3']['policy'])
        profit = estimate_tranche_exit(target, fills, 95, 5, 'CSOPSKHYNIX2LUSDT', [], 3)
        self.assertTrue(profit['available'])
        self.assertEqual(profit['threshold_usd'], .04)
        fills += [trade('SKHYUSDT', 5, 'BUY', .07, 95, 3000),
                  trade('CSOPSKHYNIX2LUSDT', 6, 'SELL', 1.2, 5, 3001)]
        stack = reconstruct_leg_stack(aggregate_orders(fills), 'SKHYUSDT', 'SELL', .08, .07, profiles)
        self.assertEqual([t['order']['order_id'] for t in stack], ['1'])
        self.assertFalse(estimate_tranche_exit(target, fills, 95, 5, 'CSOPSKHYNIX2LUSDT', [], 4)['available'])

    def test_saved_exit_policy_survives_regime_changes(self):
        from unittest.mock import patch
        # An entry policy is captured in the replay lot, not recomputed on exit.
        data = [dict(time=BASE+i*300,value=v,adr=100 if i==0 else 95,csop=5,domestic=100/v*100)
                for i,v in enumerate([140,139,138,138.1,138.2])]
        toggles = dict(entry_ma_stretch=False,entry_peak_rollover=False,
                       entry_ma_stack_5m=False,entry_ma_stack_1h=False,
                       exit_ma_stack_5m=False,exit_ma_stack_1h=False)
        with patch('backend.dynamic_backtest.macro_policy', side_effect=[policy_for_level(2)]+[policy_for_level(0)]*4):
            result = replay(data, BASE, BASE+1500, toggles=toggles)
        self.assertEqual(result['trades'][0]['exit_time_ms'], (BASE+1500)*1000)
        self.assertEqual(result['trades'][0]['exit_policy']['level'], 2)
