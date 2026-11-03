import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from backend.crypto_bot import CryptoBot
from backend.lighter_crypto_bot import LighterCryptoBot
from backend.lighter_strategy import evaluate_macd_zero_cross_signals, evaluate_strategy_signal
from backend.server import _run_crypto_backtest_sync


class HistogramEntryTests(unittest.TestCase):
    def setUp(self):
        values=[100+.3*i+4*math.sin(i/7) for i in range(200)]
        self.prices=next(values[:i] for i in range(70,200)
            if evaluate_macd_zero_cross_signals(values[:i])[3]['histogram_turn']=='CROSS_UP'
            and evaluate_macd_zero_cross_signals(values[:i])[3]['signal']>0)

    def test_default_long_and_short_crosses_ignore_signal_zone(self):
        for prices,side in [(self.prices,1),([300-value for value in self.prices],-1)]:
            entry,candidate,_,details=evaluate_macd_zero_cross_signals(prices)
            self.assertTrue(entry);self.assertEqual(candidate,side)
            self.assertGreater(side*details['signal'],0) # Previously rejected origin zone.
            self.assertFalse(details['condition_enabled']['entry_signal_zone'])
            self.assertFalse(evaluate_macd_zero_cross_signals(prices,use_macd_signal_zone=True)[0])
            for held in (-1,0,1):
                self.assertEqual(evaluate_macd_zero_cross_signals(prices,position_side=held)[:2],(entry,side))

    def test_hourly_filter_and_histogram_exit_remain_independent(self):
        allowed=dict(ready=True,long_ok=True,short_ok=False)
        blocked=dict(ready=True,long_ok=False,short_ok=True)
        self.assertTrue(evaluate_strategy_signal('macd_zero_cross',self.prices,dict(use_hourly_hist=True),hourly_histogram=allowed)[0])
        entry,_,exit_signal,_=evaluate_strategy_signal('macd_zero_cross',self.prices,dict(use_hourly_hist=True),position_side=-1,hourly_histogram=blocked)
        self.assertFalse(entry);self.assertTrue(exit_signal)

    def test_replay_defaults_to_histogram_only(self):
        bars=[dict(time=100000+i*300,value=100+.3*i+4*math.sin(i/7)) for i in range(300)]
        options=dict(strategy_mode='macd_zero_cross',use_hourly_hist=False)
        default=_run_crypto_backtest_sync(bars,True,**options)
        loose=_run_crypto_backtest_sync(bars,True,use_macd_signal_zone=False,**options)
        strict=_run_crypto_backtest_sync(bars,True,use_macd_signal_zone=True,**options)
        self.assertEqual(default['entry_signals'],loose['entry_signals'])
        self.assertGreater(len(loose['entry_signals']),len(strict['entry_signals']))
        strict_signals={(row['time'],row.get('side')) for row in strict['entry_signals']}
        self.assertTrue(strict_signals.issubset({(row['time'],row.get('side')) for row in loose['entry_signals']}))


class HistogramEntryConfigTests(unittest.IsolatedAsyncioTestCase):
    async def test_default_off_and_saved_opt_in_and_opt_out_survive_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            for cls in (CryptoBot,LighterCryptoBot):
                path=Path(directory)/cls.__name__
                bot=cls(AsyncMock(),path)
                self.assertFalse(bot.public_state()['strategy_params']['use_macd_signal_zone'])
                self.assertTrue(bot.state['use_macd_zero_cross'])
                self.assertTrue(bot.state['use_hourly_hist'])
                await bot.configure(dict(strategy_mode='macd_zero_cross',use_macd_signal_zone=True))
                restored=cls(AsyncMock(),path)
                self.assertTrue(restored.public_state()['strategy_params']['use_macd_signal_zone'])
                await restored.configure(dict(use_macd_signal_zone=False))
                self.assertFalse(cls(AsyncMock(),path).public_state()['strategy_params']['use_macd_signal_zone'])
