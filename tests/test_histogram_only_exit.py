import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from backend.lighter_strategy import evaluate_macd_zero_cross_signals, evaluate_strategy_signal
from backend.crypto_bot import CryptoBot
from backend.lighter_crypto_bot import LighterCryptoBot
from backend.server import _run_crypto_backtest_sync


class HistogramExitTests(unittest.TestCase):
    def setUp(self):
        values=[100+.3*i+4*math.sin(i/7) for i in range(200)]
        self.prices=next(values[:i] for i in range(70,200)
                         if evaluate_macd_zero_cross_signals(values[:i])[3]['histogram_turn']=='CROSS_UP'
                         and evaluate_macd_zero_cross_signals(values[:i])[3]['signal']>0)

    def test_short_exit_on_cross_up_even_with_positive_signal(self):
        entry,_,exit_signal,details=evaluate_macd_zero_cross_signals(self.prices,position_side=-1,use_macd_signal_zone=True)
        self.assertFalse(entry)
        self.assertGreater(details['signal'],0)
        self.assertTrue(exit_signal)
        self.assertTrue(details['condition_pass']['exit_histogram_zero_cross'])
        self.assertNotIn('exit_signal_zone',details['condition_pass'])

    def test_long_exit_on_cross_down_even_with_negative_signal(self):
        mirrored=[300-value for value in self.prices]
        entry,_,exit_signal,details=evaluate_macd_zero_cross_signals(mirrored,position_side=1,use_macd_signal_zone=True)
        self.assertFalse(entry);self.assertLess(details['signal'],0)
        self.assertTrue(exit_signal)
        self.assertEqual(details['histogram_turn'],'CROSS_DOWN')

    def test_exit_switch_is_independent_from_entry_and_hourly_conditions(self):
        kwargs=dict(position_side=-1)
        self.assertTrue(evaluate_macd_zero_cross_signals(self.prices,use_macd_zero_cross=False,**kwargs)[2])
        self.assertFalse(evaluate_macd_zero_cross_signals(self.prices,use_macd_hist_exit=False,**kwargs)[2])
        self.assertFalse(evaluate_macd_zero_cross_signals(self.prices,position_side=0)[2])
        self.assertFalse(evaluate_macd_zero_cross_signals(self.prices,position_side=1)[2])
        entry,_,exit_signal,_=evaluate_strategy_signal('macd_zero_cross',self.prices,
            dict(use_hourly_hist=True),hourly_histogram={'ready':True,'long_ok':False,'short_ok':False},**kwargs)
        self.assertFalse(entry);self.assertTrue(exit_signal)
        # Switching off this exit never changes the entry stream.
        for held in (-1,0,1):
            on=evaluate_macd_zero_cross_signals(self.prices,position_side=held,use_macd_signal_zone=False)
            off=evaluate_macd_zero_cross_signals(self.prices,position_side=held,use_macd_signal_zone=False,use_macd_hist_exit=False)
            self.assertEqual(on[:2],off[:2])

    def test_replay_exits_with_histogram_only_and_keeps_entry_markers(self):
        bars=[dict(time=100000+i*300,value=100+.05*i+3*math.sin(i/5)) for i in range(300)]
        kwargs=dict(strategy_mode='macd_zero_cross',use_macd_signal_zone=False,
                    macd_fast_period=4,macd_slow_period=10,macd_signal_period=3)
        on=_run_crypto_backtest_sync(bars,True,**kwargs)
        off=_run_crypto_backtest_sync(bars,True,use_macd_hist_exit=False,**kwargs)
        self.assertEqual(on['entry_signals'],off['entry_signals'])
        self.assertGreater(len(on['trades']),0);self.assertEqual(len(off['trades']),0)


class ExitConfigTests(unittest.IsolatedAsyncioTestCase):
    async def test_config_persists_exit_independently(self):
        with tempfile.TemporaryDirectory() as directory:
            for cls in (CryptoBot,LighterCryptoBot):
                path=Path(directory)/cls.__name__
                bot=cls(AsyncMock(),path)
                self.assertTrue(bot.state['use_macd_hist_exit'])
                await bot.configure(dict(strategy_mode='macd_zero_cross',use_macd_hist_exit=False))
                restored=cls(AsyncMock(),path)
                self.assertFalse(restored.public_state()['strategy_params']['use_macd_hist_exit'])
                self.assertTrue(restored.state['use_macd_zero_cross'])
                self.assertFalse(restored.state['use_macd_signal_zone'])
