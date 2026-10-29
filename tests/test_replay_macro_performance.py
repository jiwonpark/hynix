"""Replay must reuse causal macro results without changing any signals or trades."""
import ast
import math
from pathlib import Path
import unittest
from unittest.mock import patch
from backend import lighter_strategy as strategy


class ReplayMacroTests(unittest.TestCase):
    def test_precomputed_macro_preserves_all_replay_results(self):
        tree = ast.parse(Path('backend/server.py').read_text())
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in {
            '_run_crypto_backtest_sync', '_crypto_entry_trend',
            '_hourly_macro_alignment_for_bars', '_chart_macd_acceleration_for_bars',
        }]
        scope = dict(vars(strategy))
        exec(compile(ast.Module(body=nodes, type_ignores=[]), '<replay>', 'exec'), scope)
        run = scope['_run_crypto_backtest_sync']
        values = [100 + 4 * math.sin(i / 11) + .005 * i for i in range(180)]
        bars = [{'time': i * 300, 'value': value} for i, value in enumerate(values)]
        functions = ['evaluate_grid_signals', 'evaluate_ma_acceleration_signals', 'evaluate_golden_death_cross_signals']
        for mode, name in zip(['grid', 'ma_acceleration', 'golden_death_cross'], functions):
            with self.subTest(mode=mode):
                with patch.object(strategy, '_macro_trend_aligned', side_effect=AssertionError('repeated full-history calculation')):
                    optimized = run(bars, True, strategy_mode=mode)
                original = scope[name]
                def uncached(*args, **kwargs):
                    kwargs.pop('macro_alignment', None)
                    return original(*args, **kwargs)
                scope[name] = uncached
                try:
                    baseline = run(bars, True, strategy_mode=mode)
                finally:
                    scope[name] = original
                self.assertEqual(optimized, baseline)
