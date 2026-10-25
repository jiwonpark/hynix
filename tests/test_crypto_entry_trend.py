import math
import unittest
from backend.server import _run_crypto_backtest_sync
from backend.lighter_strategy import evaluate_ou_signals, hourly_macro_alignment


class CryptoEntryTrendTests(unittest.TestCase):
    def setUp(self):
        self.hourly = [{'time': i * 3600, 'value': 200 - i} for i in range(65)]
        # Local chart rises while the wider hourly trend falls.
        self.bars = [{'time': 30 * 3600 + i * 300, 'value': 100 + i * .1}
                     for i in range(150)]

    def test_background_uses_hourly_gate_not_opposite_local_trend(self):
        result = _run_crypto_backtest_sync(self.bars, True, strategy_mode='macd_reversal',
                                          interval_seconds=300, macro_bars=self.hourly)
        points = result['entry_trend']['points']
        self.assertEqual(len(points), len(self.bars))
        self.assertTrue(all(p['direction'] == 'DOWNTREND' for p in points))
        for bar, point in zip(self.bars, points):
            completed = [b for b in self.hourly if b['time'] + 3600 <= bar['time'] + 300]
            self.assertEqual((point['long_ok'], point['short_ok']), hourly_macro_alignment([b['value'] for b in completed]))
            self.assertEqual(point['source_time'], completed[-1]['time'])
        future_changed = [dict(b, value=10000) if b['time'] >= self.bars[-1]['time'] + 300 else b
                          for b in self.hourly]
        changed = _run_crypto_backtest_sync(self.bars, True, strategy_mode='macd_reversal',
                                           interval_seconds=300, macro_bars=future_changed)
        self.assertEqual(result['entry_trend'], changed['entry_trend'])

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
