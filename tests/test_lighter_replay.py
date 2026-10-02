"""Price-only replay and production signal parity regressions (no exchange calls)."""
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from backend import server
from backend.lighter_bot import LighterPairBot
from backend.lighter_strategy import evaluate_grid_signals


class GridSignalTests(unittest.TestCase):
    def test_shared_grid_preserves_production_formula_and_both_directions(self):
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterPairBot(Mock(), Path(directory) / 'bot.json')
            for mode in ('grid', 'custom'):
                bot.state.update(strategy_mode=mode, entry_z=1.5, exit_z=0.25)
                for last in (138.0, 140.0, 142.0):
                    ratios = [140 + (i % 3 - 1) * 0.1 for i in range(24)] + [last]
                    mean = sum(ratios[:-1]) / 24
                    variance = sum((v - mean) ** 2 for v in ratios[:-1]) / 24
                    z = (last - mean) / math.sqrt(variance)
                    actual = bot._evaluate_strategy_signals(ratios)
                    self.assertEqual(actual[:3], (abs(z) >= 1.5, -1 if z > 0 else 1, abs(z) <= 0.25))
                    self.assertEqual(actual, evaluate_grid_signals(
                        ratios, entry_z=1.5, exit_z=0.25, evaluation_time=actual[3]['time']))


class ReplayTests(unittest.IsolatedAsyncioTestCase):
    def bars(self, count):
        return [{'time': 1700000000 + i * 300, 'value': 140 + i / 100} for i in range(count)]

    async def replay(self, bars, mode='ou_quant', **kwargs):
        with patch.object(server, 'get_lighter_parity', AsyncMock(return_value={'success': True, 'bars': bars})):
            return await server.get_lighter_backtest(interval='5m', strategy_mode=mode, **kwargs)

    async def test_ou_replay_is_independent_of_live_capacity_and_has_no_hidden_cap(self):
        def signals(prefix, **kwargs):
            index = len(prefix) - 1
            return index < 60, 1, index == 60, {'mean': 140, 'z': 2, 'theta': .5, 'half_life_bars': 1.4}
        results = []
        with patch.object(server, 'evaluate_ou_signals', side_effect=signals):
            for capacity in (0, 1, 28, 100):
                with patch.dict(server.lighter_pair_bot.state, {'risk_capacity': {'max_tranches': capacity}}):
                    results.append(await self.replay(self.bars(61)))
        for result in results:
            self.assertEqual(result, results[0])
            self.assertEqual(len(result['trades']), 36)
            self.assertEqual(result['open_positions'], [])

    async def test_open_entries_survive_without_affecting_closed_statistics(self):
        def signals(prefix, **kwargs):
            index = len(prefix) - 1
            return index in (24, 25, 28), 1, index == 26, {'mean': 140, 'z': 2, 'theta': .5, 'half_life_bars': 1.4}
        bars = self.bars(30)
        with patch.object(server, 'evaluate_ou_signals', side_effect=signals):
            result = await self.replay(bars)
        self.assertEqual(result['summary']['trades'], 2)
        self.assertEqual(result['summary']['wins'], 2)
        self.assertEqual(len(result['open_positions']), 1)
        entry = result['open_positions'][0]
        self.assertEqual((entry['entry_time'], entry['entry'], entry['side']),
                         (bars[28]['time'], bars[28]['value'], 1))
        self.assertNotIn('exit', entry)
        self.assertAlmostEqual(entry['unrealized_pnl_pct'], (bars[29]['value'] / bars[28]['value'] - 1) * 100, places=4)
        self.assertEqual(result['summary']['net_pct'], round(sum(t['pnl_pct'] for t in result['trades']), 4))

    async def test_grid_replays_live_signals_without_forced_exit(self):
        values = [140 + (i % 3 - 1) * .1 for i in range(24)] + [141, 142, 143]
        bars = [{'time': 1700000000 + i * 300, 'value': v} for i, v in enumerate(values)]
        result = await self.replay(bars, mode='grid', use_peak=False,
                                   use_base_spacing=False, use_dwell=False)
        self.assertEqual(result['trades'], [])
        self.assertEqual(len(result['open_positions']), 3)
        for i, entry in enumerate(result['open_positions'], 24):
            signal = evaluate_grid_signals(values[:i + 1], entry_z=1.5, exit_z=.25)
            self.assertTrue(signal[0])
            self.assertEqual(entry['side'], signal[1])
            self.assertEqual(entry['entry_time'], bars[i]['time'])
        filtered = await self.replay(bars, mode='grid', use_peak=True,
                                     use_base_spacing=False, use_dwell=False)
        self.assertLess(len(filtered['open_positions']), len(result['open_positions']))

    async def test_incomplete_candle_cannot_create_an_open_entry(self):
        bars = self.bars(26)
        with patch.object(server.time, 'time', return_value=bars[-1]['time'] + 1):
            result = await self.replay(bars, mode='grid', use_peak=False, use_base_spacing=False)
        self.assertTrue(all(p['entry_time'] != bars[-1]['time'] for p in result['open_positions']))
