import asyncio
import math
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from backend.hourly_histogram import hourly_histogram_points, apply_hourly_filter
from backend.lighter_strategy import evaluate_strategy_signal
from backend.crypto_bot import CryptoBot
from backend.lighter_crypto_bot import LighterCryptoBot
from backend.server import _run_crypto_backtest_sync


class HourlyHistogramTests(unittest.TestCase):
    def setUp(self):
        self.config=dict(use_hourly_hist=True,hourly_hist_fast=4,hourly_hist_slow=10,hourly_hist_signal=3)
        self.hours=[{'time':i*3600,'value':100+3*math.sin(i/5)} for i in range(300)]

    def test_signal_second_difference_not_histogram_or_signal_slope(self):
        for values,expected in [([3.,2.,2.],1),([1.,2.,2.],-1),
                                ([1.,3.,4.],-1),([4.,2.,1.],1),
                                ([-4.,-2.,-1.],-1),([-1.,-3.,-4.],1),([1.,2.,3.],0)]:
            def components(window,*periods):
                return list(range(len(window))), [0.]*(len(window)-3)+values if len(window)>=3 else [0.]*len(window)
            with patch('backend.hourly_histogram.macd_hourly_series',side_effect=components):
                point=hourly_histogram_points(self.hours,self.config)[-1]
            self.assertEqual(point['signal_acceleration'], values[2]-2*values[1]+values[0])
            self.assertEqual(point['long_ok'], expected>0)
            self.assertEqual(point['short_ok'], expected<0)
            self.assertEqual(point['source'],'COMPLETED_1H_MACD_SIGNAL_SECOND_DIFF')
        missing=self.hours[:-2]+self.hours[-1:]
        self.assertFalse(hourly_histogram_points(missing,self.config)[-1]['ready'])

    def test_second_difference_sign_and_flat_unavailable(self):
        points=hourly_histogram_points(self.hours,self.config)
        self.assertTrue(any(p['signal_delta']<0 and p['long_ok'] for p in points if p['ready']))
        self.assertTrue(all(p['long_ok']==(p['signal_acceleration']>0) and p['short_ok']==(p['signal_acceleration']<0) for p in points if p['ready']))
        self.assertTrue(any(p['signal_delta']>0 and p['short_ok'] for p in points if p['ready']))
        self.assertTrue(all(not p['ready'] for p in points[:12]))
        flat=hourly_histogram_points([dict(b,value=100) for b in self.hours],self.config)[-1]
        self.assertTrue(flat['ready']);self.assertFalse(flat['long_ok']);self.assertFalse(flat['short_ok'])
        for side in (1,-1):
            details={}
            self.assertFalse(apply_hourly_filter(True,side,details,self.config,flat))
            self.assertFalse(apply_hourly_filter(True,side,{},self.config,None))
            self.assertTrue(apply_hourly_filter(True,side,{},dict(use_hourly_hist=False),None))

    def test_fixed_warmup_matches_live_and_replay_history_lengths(self):
        config=dict(use_hourly_hist=True,hourly_hist_fast=20,hourly_hist_slow=60,hourly_hist_signal=9)
        full=hourly_histogram_points(self.hours,config)[-1]
        short=hourly_histogram_points(self.hours[-150:],config)[-1]
        self.assertEqual(full,short)

    def test_evaluator_gate_keeps_exits_and_entries_position_independent(self):
        prices=[100+3*math.sin(i/5) for i in range(100)]
        for mode in ['macd_zero_cross','macd_reversal','grid','ma_acceleration','golden_death_cross']:
            for position in (0,1,-1):
                base=evaluate_strategy_signal(mode,prices,dict(use_hourly_hist=False),position_side=position,entry_price=100)
                blocked=evaluate_strategy_signal(mode,prices,self.config,position_side=position,entry_price=100,hourly_histogram={'ready':True,'long_ok':False,'short_ok':False})
                self.assertFalse(blocked[0]);self.assertEqual(blocked[2],base[2])

    def test_replay_maps_hourly_close_without_future_leak_and_toggle_is_real(self):
        bars=[{'time':200*3600+i*300,'value':100+3*math.sin(i/5)} for i in range(240)]
        kwargs=dict(strategy_mode='macd_zero_cross',interval_seconds=300,macro_bars=self.hours,
                    use_macd_signal_zone=False,macd_fast_period=4,macd_slow_period=10,macd_signal_period=3)
        off=_run_crypto_backtest_sync(bars,True,**kwargs)
        on=_run_crypto_backtest_sync(bars,True,**kwargs,**self.config)
        self.assertLess(len(on['entry_signals']),len(off['entry_signals']))
        self.assertGreater(len(on['entry_signals']),0)
        for point in on['entry_trend']['points']:
            if point['source_time'] is not None:
                self.assertLessEqual(point['source_time']+3600,point['time']+300)
        old=[dict(b) for b in self.hours]
        for b in old:
            if b['time']>=220*3600:b['value']*=10
        future=_run_crypto_backtest_sync(bars,True,**{**kwargs,'macro_bars':old},**self.config)
        self.assertEqual(on['entry_signals'],future['entry_signals'])
        for signal in on['entry_signals']:
            key='entry_hourly_hist_long' if signal['side']>0 else 'entry_hourly_hist_short'
            self.assertTrue(signal['conditions'][key])


class HourlyLiveTests(unittest.IsolatedAsyncioTestCase):
    async def test_config_persistence_validation_and_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            for cls in (CryptoBot,LighterCryptoBot):
                path=Path(folder)/cls.__name__
                bot=cls(AsyncMock(),path)
                self.assertTrue(bot.state['use_hourly_hist'])
                await bot.configure(dict(use_hourly_hist=False,hourly_hist_fast=8,hourly_hist_slow=21,hourly_hist_signal=5))
                restored=cls(AsyncMock(),path)
                self.assertFalse(restored.public_state()['strategy_params']['use_hourly_hist'])
                self.assertEqual(restored.state['hourly_hist_slow'],21)
                for values in [dict(hourly_hist_fast=30,hourly_hist_slow=20),dict(hourly_hist_signal=1),dict(hourly_hist_fast=2.5)]:
                    with self.assertRaises(ValueError):await bot.configure(values)

    async def test_live_fetch_ignores_forming_hour_and_stale_hour(self):
        with tempfile.TemporaryDirectory() as folder:
            bot=CryptoBot(AsyncMock(),Path(folder)/'s.json')
            now=200*3600+60
            raw=[[i*3600000,0,0,0,100+math.sin(i/4),0,(i+1)*3600000-1] for i in range(20,201)]
            bot.client.request.return_value=raw
            with patch('backend.hourly_histogram.time.time',return_value=now):
                point=await bot.refresh_hourly_histogram()
            self.assertEqual(point['source_time'],199*3600)
            self.assertTrue(point['ready'])
            bot._hourly_hist_cache=None;bot.client.request.return_value=raw[:-2]
            with patch('backend.hourly_histogram.time.time',return_value=now):
                point=await bot.refresh_hourly_histogram()
            self.assertFalse(point['ready'])

    async def test_campaign_cannot_add_against_hourly_or_saved_direction(self):
        with tempfile.TemporaryDirectory() as folder:
            bot=LighterCryptoBot(AsyncMock(),Path(folder)/'s.json')
            bot.state.update(enabled=True,last_order_time=0)
            bot._start_entry_campaign(-1,100);bot.state['entry_campaign']['slices_filled']=1
            bot.hourly_entry_allowed=AsyncMock(return_value=False);bot._submit=AsyncMock()
            self.assertFalse(await bot._continue_entry_campaign())
            self.assertIsNone(bot.state['entry_campaign']);bot._submit.assert_not_awaited()
            bot._start_entry_campaign(-1,100);bot.state['entry_campaign']['slices_filled']=1
            bot.state['entry_direction_mode']='long_only';bot.hourly_entry_allowed.return_value=True
            self.assertFalse(await bot._continue_entry_campaign());bot._submit.assert_not_awaited()

    async def test_preorder_rechecks_gate_without_disabling_exits(self):
        from decimal import Decimal
        with tempfile.TemporaryDirectory() as folder:
            for cls in (CryptoBot,LighterCryptoBot):
                client=AsyncMock();client.execution_lock=asyncio.Lock()
                bot=cls(client,Path(folder)/cls.__name__)
                bot._account_position=AsyncMock(return_value=({},0) if cls is CryptoBot else ({},0,[]))
                bot._book=AsyncMock(return_value=(100,100.01));bot._check_position=lambda *a,**k:None
                bot._market=AsyncMock(return_value=(1,{},.001))
                bot.hourly_entry_allowed=AsyncMock(return_value=False)
                with self.assertRaisesRegex(ValueError,'Hourly MACD'):
                    await bot._submit(-1,100,reduce_only=False,reason='signal_campaign_slice')
                client.create_order.assert_not_awaited();client.create_market_order.assert_not_awaited()
