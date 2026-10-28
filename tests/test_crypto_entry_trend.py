import math
import unittest
from backend.server import _run_crypto_backtest_sync
from backend.lighter_strategy import evaluate_ou_signals, hourly_macro_alignment


class CryptoEntryTrendTests(unittest.TestCase):
    def setUp(self):
        self.hourly = [{'time': i * 3600, 'value': 200 - i} for i in range(180)]
        # Local chart rises while the wider hourly trend falls.
        self.bars = [{'time': 100 * 3600 + i * 300, 'value': 100 + i * .1}
                     for i in range(150)]

    def test_background_uses_hourly_gate_not_opposite_local_trend(self):
        result = _run_crypto_backtest_sync(self.bars, True, strategy_mode='macd_reversal',
                                          interval_seconds=300, macro_bars=self.hourly)
        points = result['entry_trend']['points']
        self.assertEqual(len(points), len(self.bars))
        self.assertTrue(all(p['direction'] == 'DOWNTREND' for p in points))
        for bar, point in zip(self.bars, points):
            completed = [b for b in self.hourly if b['time'] + 3600 <= bar['time']]
            self.assertEqual((point['long_ok'], point['short_ok']), hourly_macro_alignment([b['value'] for b in completed]))
            self.assertEqual(point['source_time'], completed[-1]['time'])
        future_changed = [dict(b, value=10000) if b['time'] >= self.bars[-1]['time'] else b
                          for b in self.hourly]
        changed = _run_crypto_backtest_sync(self.bars, True, strategy_mode='macd_reversal',
                                           interval_seconds=300, macro_bars=future_changed)
        self.assertEqual(result['entry_trend'], changed['entry_trend'])

    def test_hourly_and_five_minute_backgrounds_change_at_same_actionable_time(self):
        hourly = [{'time': i * 3600, 'value': 100 + i} for i in range(140)]
        bars_5m = [{'time': 101 * 3600 + i * 300, 'value': 100} for i in range(24)]
        bars_1h = [{'time': 101 * 3600 + i * 3600, 'value': 100} for i in range(2)]
        result_5m = _run_crypto_backtest_sync(
            bars_5m, True, strategy_mode='grid', interval_seconds=300, macro_bars=hourly)
        result_1h = _run_crypto_backtest_sync(
            bars_1h, True, strategy_mode='grid', interval_seconds=3600, macro_bars=hourly)

        five_minute_at_32 = result_5m['entry_trend']['points'][12]
        hourly_at_32 = result_1h['entry_trend']['points'][1]
        self.assertEqual(five_minute_at_32['source_time'], 101 * 3600)
        self.assertEqual(hourly_at_32['source_time'], 101 * 3600)
        self.assertEqual(five_minute_at_32['direction'], hourly_at_32['direction'])

    def test_toggle_disables_color_without_suppressing_signal_stream(self):
        result = _run_crypto_backtest_sync(self.bars, True, strategy_mode='grid',
                                          use_ma_stack_1h=False, macro_bars=self.hourly)
        self.assertFalse(result['entry_trend']['enabled'])
        self.assertTrue(all(p['direction'] == 'OFF' for p in result['entry_trend']['points']))
        self.assertIn('entry_signals', result)

    def test_ou_background_matches_exact_configured_ema_predicate(self):
        bars = [dict(b, value=100 + math.sin(i / 8) + i * .02) for i, b in enumerate(self.bars)]
        for span, slope_bars in [(60, 12), (30, 6)]:
            result = _run_crypto_backtest_sync(bars, True, strategy_mode='ou_quant',
                ou_macro_ema_span=span, ou_macro_slope_bars=slope_bars, macro_bars=self.hourly)
            for i in [max(span * 2, slope_bars + 2) - 1, len(bars) - 1]:
                _, side, _, evaluation = evaluate_ou_signals([b['value'] for b in bars[:i + 1]],
                    entry_z=1.5, exit_z=.25, ou_halflife_max=8, ou_stop_z=3.5,
                    ou_macro_ema_span=span, ou_macro_slope_bars=slope_bars)
                point = result['entry_trend']['points'][i]
                self.assertEqual(point['long_ok'] if side > 0 else point['short_ok'],
                                 evaluation['condition_pass']['entry_macro_trend'])
            self.assertEqual(result['entry_trend']['points'][0]['direction'], 'UNAVAILABLE')

    def test_missing_hourly_data_is_unavailable(self):
        result = _run_crypto_backtest_sync(self.bars, True, macro_bars=[])
        self.assertTrue(all(p['direction'] == 'UNAVAILABLE' for p in result['entry_trend']['points']))

    def test_hourly_regime_defaults_to_ma60_even_when_ma7_disagrees(self):
        values = [100.0] * 53 + [110.0] * 7 + [105.0]
        self.assertEqual(hourly_macro_alignment(values), (True, False))
        self.assertEqual(hourly_macro_alignment(values, ma_period=7), (False, True))
        falling = [200.0 - value for value in values]
        self.assertEqual(hourly_macro_alignment(falling), (False, True))
        self.assertEqual(hourly_macro_alignment([100.0] * 60), (False, False))
        self.assertEqual(hourly_macro_alignment([100.0] * 61), (True, True))

    def test_period_changes_both_entry_gate_and_background(self):
        hourly = [{'time': i * 3600, 'value': value}
                  for i, value in enumerate([100.0] * 53 + [110.0] * 7 + [105.0])]
        bars = [{'time': 61 * 3600 + i * 300, 'value': 105.0} for i in range(30)]
        for period, direction in [(60, 'UPTREND'), (7, 'DOWNTREND')]:
            result = _run_crypto_backtest_sync(bars, True, strategy_mode='grid', macro_bars=hourly,
                                               interval_seconds=300, macro_ma_period=period)
            self.assertEqual(result['entry_trend']['points'][-1]['direction'], direction)
            self.assertIn(f'MA{period} slope', result['entry_trend']['basis'])

    def test_macd_direction_gate_and_background_share_completed_hour_verdicts(self):
        hourly = [{'time': i * 3600,
                   'value': 100 + .03 * i + 4 * math.sin(i / 6)} for i in range(180)]
        bars = [{'time': 100 * 3600 + i * 300,
                 'value': 100 + math.sin(i / 7)} for i in range(150)]
        result = _run_crypto_backtest_sync(
            bars, True, strategy_mode='macd_reversal', interval_seconds=300,
            macro_bars=hourly, macro_regime_mode='macd_hist_accel',
            macro_macd_confirm_bars=2)
        self.assertIn('MACD-H below zero + rising', result['entry_trend']['basis'])
        self.assertEqual(result['metrics']['macro_regime_mode'], 'macd_hist_accel')
        self.assertTrue(any(point['direction'] in {'UPTREND', 'DOWNTREND'}
                            for point in result['entry_trend']['points']))
        self.assertEqual(result['latest_evaluation']['macro_regime_mode'], 'macd_hist_accel')
        self.assertIn('macro_histogram_slope', result['latest_evaluation'])
        self.assertNotIn('macro_histogram_slope_z', result['latest_evaluation'])
