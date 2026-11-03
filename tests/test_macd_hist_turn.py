import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from backend.crypto_bot import CryptoBot
from backend.lighter_crypto_bot import LighterCryptoBot
from backend.lighter_strategy import (evaluate_macd_hist_turn_signals,
    evaluate_macd_zero_cross_signals, evaluate_strategy_signal, required_strategy_bars)
from backend.server import _run_crypto_backtest_sync


def evaluate_histogram(histogram, *, old=False, signal=2.0, **kwargs):
    # Supply known completed MACD/Signal values to test the predicate boundaries
    # independently of EMA fitting. Integration tests below use real prices/EMAs.
    h=[histogram[0]]*33+list(histogram)
    with patch('backend.lighter_strategy._ema_series',side_effect=[
        [value+signal for value in h], [0.0]*len(h), [signal]*len(h)]):
        evaluator=evaluate_macd_zero_cross_signals if old else evaluate_macd_hist_turn_signals
        return evaluator([100.0]*len(h),**kwargs)


class HistogramTurnTests(unittest.TestCase):
    def test_directional_turns_inside_histogram_zone_before_zero_cross(self):
        for h,side in [([-1.,-2.,-1.8],1),([1.,2.,1.8],-1)]:
            entry,candidate,_,detail=evaluate_histogram(h)
            self.assertTrue(entry);self.assertEqual(candidate,side)
            self.assertEqual(detail['strategy'],'macd_hist_turn')
            self.assertFalse(evaluate_histogram(h,old=True)[0])
            self.assertLess(side*detail['histogram'],0)
            self.assertLessEqual(side*detail['previous_histogram_delta'],0)
            self.assertGreater(side*detail['histogram_delta'],0)
            self.assertNotIn('entry_histogram_zero_cross',detail['condition_pass'])
            for held in (-1,0,1):
                self.assertEqual(evaluate_histogram(h,position_side=held)[:2],(entry,side))

    def test_flat_previous_delta_allowed_but_flat_current_or_ongoing_rise_rejected(self):
        self.assertTrue(evaluate_histogram([-1.,-1.,-.8])[0])
        self.assertTrue(evaluate_histogram([1.,1.,.8])[0])
        for h in [[-1.,-2.,-2.],[-3.,-2.,-1.],[1.,2.,2.],[3.,2.,1.],[-1.,-2.,0.],[1.,2.,0.]]:
            self.assertFalse(evaluate_histogram(h)[0],h)

    def test_each_entry_switch_is_real_and_independent(self):
        # A bullish delta turn above zero is blocked by H-zone, unless disabled.
        self.assertFalse(evaluate_histogram([1.,.5,.8])[0])
        entry,side,_,detail=evaluate_histogram([1.,.5,.8],use_macd_hist_zone=False)
        self.assertTrue(entry);self.assertEqual(side,1)
        self.assertFalse(detail['condition_enabled']['entry_histogram_zone'])
        # Switching off the turn must allow H-zone alone even while H is falling.
        self.assertFalse(evaluate_histogram([-1.,-2.,-3.])[0])
        entry,side,_,detail=evaluate_histogram([-1.,-2.,-3.],use_macd_hist_turn=False)
        self.assertTrue(entry);self.assertEqual(side,1)
        self.assertFalse(detail['condition_enabled']['entry_histogram_delta_turn'])
        self.assertFalse(evaluate_histogram([-1.,-2.,-1.8],use_macd_signal_zone=True)[0])
        self.assertFalse(evaluate_histogram([-1.,-2.,-1.8],use_macd_hist_turn=False,use_macd_hist_zone=False)[0])
        self.assertTrue(evaluate_histogram([-1.,-2.,-1.8],use_macd_zero_cross=False)[0])

    def test_exit_stays_opposite_histogram_zero_cross(self):
        self.assertFalse(evaluate_histogram([-1.,-2.,-1.8],position_side=-1)[2])
        for h,held in [([-.3,-.1,.2],-1),([.3,.1,-.2],1)]:
            self.assertTrue(evaluate_histogram(h,position_side=held)[2])
            self.assertFalse(evaluate_histogram(h,position_side=held,use_macd_hist_exit=False)[2])
            self.assertFalse(evaluate_histogram(h,position_side=0)[2])

    def test_real_price_dispatch_hourly_gate_and_causal_replay_entry_stream(self):
        bars=[dict(time=100000+i*300,value=100+.12*i+4*math.sin(i/6)) for i in range(180)]
        options=dict(macd_fast_period=4,macd_slow_period=10,macd_signal_period=3)
        required=required_strategy_bars('macd_hist_turn',options)
        expected=[]
        for i in range(required-1,len(bars)):
            prices=[row['value'] for row in bars[:i+1]]
            entry,side,_,detail=evaluate_strategy_signal('macd_hist_turn',prices,options)
            if entry:
                expected.append((bars[i]['time'],side))
                blocked=dict(ready=True,long_ok=side<0,short_ok=side>0)
                self.assertFalse(evaluate_strategy_signal('macd_hist_turn',prices,{**options,'use_hourly_hist':True},hourly_histogram=blocked)[0])
        self.assertTrue(expected)
        replay=_run_crypto_backtest_sync(bars,True,strategy_mode='macd_hist_turn',use_hourly_hist=False,**options)
        self.assertEqual([(row['time'],row['side']) for row in replay['entry_signals']],expected)
        no_exits=_run_crypto_backtest_sync(bars,True,strategy_mode='macd_hist_turn',use_hourly_hist=False,use_macd_hist_exit=False,use_take_profit=False,**options)
        self.assertEqual(replay['entry_signals'],no_exits['entry_signals'])
        self.assertEqual(replay['latest_evaluation']['strategy'],'macd_hist_turn')
        self.assertFalse(replay['entry_trend'].get('enabled',False))


class HistogramTurnConfigTests(unittest.IsolatedAsyncioTestCase):
    async def test_mode_switches_drafts_and_pause_guard_persist(self):
        with tempfile.TemporaryDirectory() as directory:
            for cls in (CryptoBot,LighterCryptoBot):
                path=Path(directory)/cls.__name__
                bot=cls(AsyncMock(),path)
                await bot.configure(dict(strategy_mode='macd_hist_turn',use_macd_hist_turn=False,use_macd_hist_zone=False))
                restored=cls(AsyncMock(),path)
                self.assertEqual(restored.state['strategy_mode'],'macd_hist_turn')
                for key in ['use_macd_hist_turn','use_macd_hist_zone']:
                    self.assertFalse(restored.public_state()['strategy_params'][key])
                await restored.save_strategy_draft('macd_hist_turn',dict(macd_fast_period=4,macd_slow_period=10,macd_signal_period=3))
                self.assertEqual(restored.state['strategy_drafts']['macd_hist_turn']['macd_slow_period'],10)
                restored.state['enabled']=True
                with self.assertRaisesRegex(ValueError,'Pause'):
                    await restored.configure(dict(use_macd_hist_zone=True))
