import unittest
from backend.dynamic_backtest import replay, replay_markers

BASE = 1704067200


def bars(values, adrs=None):
    return [dict(time=BASE+i*300, value=v, adr=adrs[i] if adrs else 100,
                 csop=5, domestic=100/v*100) for i, v in enumerate(values)]


LOOSE = dict(entry_ma_stack_5m=False, entry_ma_stack_1h=False,
             entry_base_spread=False, entry_ma_stretch=False,
             exit_ma_stack_5m=False, exit_ma_stack_1h=False)


class ReplayTests(unittest.TestCase):
    def run_replay(self, data, toggles=None, capital=500, start=6, end=None):
        return replay(data, BASE+start*300, BASE+(end or len(data))*300, capital, toggles or LOOSE)

    def test_disabling_stretch_replays_more_entries_without_capacity_block(self):
        data = bars([140]*30)
        strict = self.run_replay(data, {**LOOSE, 'entry_ma_stretch': True})
        loose = self.run_replay(data)
        self.assertEqual(strict['summary']['entries'], 0)
        self.assertGreater(loose['summary']['entries'], 0)
        self.assertEqual(loose['summary']['capital_blocked_signals'], 0)
        self.assertEqual(data, bars([140]*30), 'Replay must not mutate market data')

    def test_lifo_exits_and_retained_core(self):
        data = bars([140]*8+[139,139], [100]*8+[95,95])
        result = self.run_replay(data)
        self.assertEqual([(e['is_entry'],e['trade_id']) for e in result['events']],
                         [(True,1),(True,2),(False,2),(False,1)])
        s = result['summary']
        self.assertEqual(s['open_tranches'], 0)
        self.assertAlmostEqual(s['core_adr_qty'], .02)
        self.assertAlmostEqual(s['core_stock_qty'], .4)
        # Marked equity includes all .16 short during the price drop, then costs.
        self.assertAlmostEqual(s['net_pnl_usd'], .16*5-s['fees_usd']-s['slippage_usd']-s['funding_reserve_usd'], places=5)

    def test_disabling_profit_allows_simulated_losing_exit(self):
        data = bars([140]*10)
        strict = self.run_replay(data, {**LOOSE, 'exit_convergence': False})
        loose = self.run_replay(data, {**LOOSE, 'exit_convergence': False, 'exit_net_profit': False})
        self.assertEqual(strict['summary']['exits'], 0)
        self.assertGreater(loose['summary']['exits'], 0)
        self.assertLess(loose['trades'][0]['estimated_net_pnl_usd'], 0)

    def test_capital_and_live_risk_switches_never_change_price_replay(self):
        data = bars([140]*40)
        baseline = self.run_replay(data, capital=500)
        for capital in (0, .01, 5, 100000):
            result = self.run_replay(data, capital=capital)
            self.assertEqual(result, baseline)
        result = self.run_replay(data, {**LOOSE, 'entry_capacity': False,
            'entry_gross_leverage': False, 'entry_margin_buffer': False}, capital=0)
        self.assertEqual(result, baseline)
        self.assertEqual(result['summary']['entries'], 34)
        self.assertFalse(result['summary']['halted'])
        self.assertGreater(result['summary']['max_drawdown_usd'], 0)
        self.assertAlmostEqual(result['summary']['peak_gross_exposure_usd'], 34*(.08*100+1.4*5))

    def test_large_losses_do_not_stop_remaining_signals(self):
        result = self.run_replay(bars([140]*40, [100]*8+[10000]*32), capital=.01)
        self.assertEqual(result['summary']['evaluated_bars'], 34)
        self.assertEqual(result['summary']['entries'], 34)
        self.assertLess(result['summary']['net_pnl_usd'], -1000)
        self.assertFalse(result['summary']['halted'])

    def test_future_candles_cannot_change_prior_decisions(self):
        original = bars([140]*8+[139]*8, [100]*8+[95]*8)
        short = self.run_replay(original, end=10)
        changed = original[:10]+bars([900]*6)
        # Replace future values in place at their original times.
        for i in range(10,len(changed)):
            changed[i] = dict(original[i], value=900, adr=900)
        long = self.run_replay(changed)
        self.assertEqual(short['events'], [e for e in long['events'] if e['time'] < BASE+3000])

    def test_hourly_filter_needs_sixty_completed_hours(self):
        data = bars([140+i*.001 for i in range(725)])
        toggles = {**LOOSE, 'entry_peak_rollover': False, 'entry_ma_stack_1h': True}
        result = self.run_replay(data, toggles, start=0)
        self.assertGreater(result['summary']['entries'], 0)
        self.assertGreaterEqual(result['events'][0]['time']+300, BASE+60*3600)
        # Changing the last five minutes of hour 60 cannot affect earlier decisions.
        self.assertEqual(self.run_replay(data, toggles, start=0, end=719)['summary']['entries'], 0)

    def test_warmup_does_not_trade_and_missing_prices_are_not_invented(self):
        data = bars([140]*10)
        data[7]['csop'] = None
        result = self.run_replay(data)
        self.assertTrue(all(e['time'] >= BASE+1800 for e in result['events']))
        self.assertFalse(any(e['time'] == data[7]['time'] for e in result['events']))
        self.assertEqual(result['summary']['missing_price_bars'], 1)

    def test_chart_interval_changes_only_marker_buckets(self):
        result = self.run_replay(bars([140]*8+[139,139], [100]*8+[95,95]))
        five = replay_markers(result, 300)
        hourly = replay_markers(result, 3600)
        self.assertEqual(sum(m['count'] for m in five), sum(m['count'] for m in hourly))
        self.assertTrue(all(m.get('entry_spread', 0) > 0 for m in five))
        self.assertTrue(any(not m['is_entry'] and m.get('exit_spread', 0) > 0 for m in five))

    def test_ma_stack_requires_current_price_in_order(self):
        # 60 bars of rising spread
        rising = [140 + i * 0.01 for i in range(60)]
        # When current price is above MA7 (> MA24 > MA60), entry triggers
        data_valid = bars(rising)
        toggles = {**LOOSE, 'entry_peak_rollover': False, 'entry_ma_stack_5m': True}
        res_valid = self.run_replay(data_valid, toggles, start=0)
        self.assertGreater(res_valid['summary']['entries'], 0)

        # When current price drops below MA7 on the 60th bar, stack is invalid
        broken = list(rising)
        broken[-1] = 139.0
        data_broken = bars(broken)
        res_broken = self.run_replay(data_broken, toggles, start=0)
        self.assertEqual(res_broken['summary']['entries'], 0)


if __name__ == '__main__':
    unittest.main()
