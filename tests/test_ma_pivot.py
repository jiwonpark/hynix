import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from backend.ma_pivot import analyze_ma_points, evaluate_ma_pivot, validate_setting
from backend.lighter_strategy import evaluate_strategy_signal, required_strategy_bars
from backend.crypto_bot import CryptoBot
from backend.lighter_crypto_bot import LighterCryptoBot
from backend.server import _run_crypto_backtest_sync

FIXTURES = json.loads((Path(__file__).parent/'fixtures/ma_pivot_cases.json').read_text())


class PivotRuleTests(unittest.TestCase):
    def test_shared_geometry_cases(self):
        for case in FIXTURES:
            with self.subTest(case=case['name']):
                result = analyze_ma_points(case['values'],case['minimum'])
                for expected,key in [('ready','ready'),('up','up_count'),('down','down_count'),('long','long_pass'),('short','short_pass')]:
                    self.assertEqual(result[key],case[expected])

    def test_finite_history_and_confirmed_pivots(self):
        self.assertFalse(analyze_ma_points([1,float('nan'),2])['ready'])
        self.assertFalse(evaluate_ma_pivot([100]*125,60,120)['ready'])
        self.assertFalse(evaluate_ma_pivot([100]*300,7,120)['ready'])
        self.assertEqual(required_strategy_bars('ma_proximity',dict(use_ma_pivot_direction=True,ma_pivot_period=60,ma_pivot_lookback=440)),499)
        self.assertEqual(required_strategy_bars('ma_proximity',dict(use_ma_pivot_direction=False)),26)

    def test_filter_toggle_scope_and_completed_price_snapshot(self):
        prices=[100+3*math.sin(i/5) for i in range(200)]
        config=dict(ma_accel_period=7,use_ma_slope=False,use_ma_pullback=True,use_ma_stack_1h=False,ma_pivot_period=7,ma_pivot_lookback=30)
        blocked=allowed=0
        for i in range(40,len(prices)):
            source=prices[:i+1]
            base=evaluate_strategy_signal('ma_proximity',source,config)
            filtered=evaluate_strategy_signal('ma_proximity',source,dict(config,use_ma_pivot_direction=True))
            self.assertEqual(filtered[3]['ma_pivot'],evaluate_ma_pivot(source,7,30,1))
            if base[0] and not filtered[0]: blocked+=1
            if filtered[0]: allowed+=1
            quote=source[:-1]+[source[-1]*1.05]
            quote_eval=evaluate_strategy_signal('ma_proximity',quote,dict(config,use_ma_pivot_direction=True),ma_pivot_prices=source)
            self.assertEqual(quote_eval[3]['ma_pivot'],filtered[3]['ma_pivot'])
            accel=evaluate_strategy_signal('ma_acceleration',source,config)
            other=evaluate_strategy_signal('ma_acceleration',source,dict(config,use_ma_pivot_direction=True))
            self.assertEqual(accel,other)
        self.assertGreater(blocked,0)
        self.assertGreater(allowed,0)

    def test_replay_matches_flat_live_entry_and_ignores_position_exits(self):
        bars=[dict(time=100000+i*300,value=100+3*math.sin(i/5)+.2*math.sin(i/2)) for i in range(240)]
        config=dict(ma_accel_period=7,use_ma_slope=False,use_ma_pullback=True,use_ma_pivot_direction=True,ma_pivot_period=7,ma_pivot_lookback=30,ma_pivot_min_arrows=1)
        replay=_run_crypto_backtest_sync(bars,True,strategy_mode='ma_proximity',use_hourly_hist=False,**config)
        expected=[]
        for i in range(8,len(bars)):
            entry,side,_,_=evaluate_strategy_signal('ma_proximity',[b['value'] for b in bars[:i+1]],config)
            if entry: expected.append((bars[i]['time'],side))
        self.assertTrue(expected)
        self.assertEqual([(s['time'],s['side']) for s in replay['entry_signals']],expected)
        exits=_run_crypto_backtest_sync(bars,True,strategy_mode='ma_proximity',use_hourly_hist=False,use_stop_loss=True,stop_loss_pct=.01,take_profit_fee_rate=0,**config)
        self.assertEqual(replay['entry_signals'],exits['entry_signals'])
        self.assertEqual(replay['latest_evaluation']['ma_pivot'],evaluate_ma_pivot([b['value'] for b in bars],7,30,1))


class PivotConfigurationTests(unittest.IsolatedAsyncioTestCase):
    async def test_both_venues_save_reload_report_and_guard_running_changes(self):
        for cls in (CryptoBot,LighterCryptoBot):
            with tempfile.TemporaryDirectory() as folder:
                path=Path(folder)/'state.json'
                bot=cls(AsyncMock(),path)
                self.assertFalse(bot.public_state()['strategy_params']['use_ma_pivot_direction'])
                config=dict(use_ma_pivot_direction=True,ma_pivot_period=60,ma_pivot_lookback=200,ma_pivot_min_arrows=2)
                await bot.configure(config)
                reloaded=cls(AsyncMock(),path)
                for key,value in config.items(): self.assertEqual(reloaded.public_state()['strategy_params'][key],value)
                reloaded.state['enabled']=True
                with self.assertRaisesRegex(ValueError,'ause'):
                    await reloaded.configure(dict(ma_pivot_period=7))
                self.assertEqual(reloaded.state['ma_pivot_period'],60)
                for key,value in [('ma_pivot_period',25),('ma_pivot_lookback',441),('ma_pivot_min_arrows',0),('use_ma_pivot_direction','false'),('ma_pivot_period',True),('ma_pivot_lookback',3.5)]:
                    with self.subTest(key=key,value=value),self.assertRaises(ValueError): validate_setting(key,value)

    async def test_campaign_slices_respect_latest_direction_filter(self):
        with tempfile.TemporaryDirectory() as folder:
            bot=LighterCryptoBot(AsyncMock(),Path(folder)/'state.json')
            bot.state.update(enabled=True,strategy_mode='ma_proximity',use_ma_pivot_direction=True,use_hourly_hist=False)
            bot._start_entry_campaign(1,100)
            bot._submit=AsyncMock()
            self.assertFalse(await bot._continue_entry_campaign())
            self.assertEqual(bot.state['last_entry_campaign']['status'],'ma_pivot_direction_filter')
            bot._submit.assert_not_awaited()
            import time
            completed=int(time.time())//300*300-300
            bot._start_entry_campaign(1,completed)
            bot.state['last_evaluation']=dict(strategy='ma_proximity',time=completed,ma_pivot=dict(period=24,lookback=120,min_arrows=1,ready=True,long_pass=True,short_pass=False))
            self.assertTrue(await bot._continue_entry_campaign())
            bot._submit.assert_awaited_once()
            # A paused configuration change cannot reuse old counts at a new threshold.
            bot.state['ma_pivot_min_arrows']=2
            self.assertFalse(await bot._continue_entry_campaign())
            bot.state['ma_pivot_min_arrows']=1
            bot._start_entry_campaign(1,completed)
            bot.state['entry_campaign']['slices_filled']=1
            bot.state['last_evaluation']['ma_pivot']['long_pass']=False
            self.assertFalse(await bot._continue_entry_campaign())
            bot._submit.assert_awaited_once()

class PivotReplayEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_both_venue_replay_routes_forward_new_settings(self):
        from unittest.mock import patch
        from backend import server
        from fastapi import HTTPException
        bars=[dict(time=100000+i*300,value=100+3*math.sin(i/5)) for i in range(240)]
        for venue, source in [('binance','get_crypto_candles'),('lighter','get_lighter_crypto_candles')]:
            with patch.object(server,source,AsyncMock(return_value=dict(success=True,bars=bars))):
                result=await server.get_crypto_backtest(symbol='BTC' if venue=='lighter' else 'BTCUSDT',market_source=venue,
                    strategy_mode='ma_proximity',use_hourly_hist=False,use_take_profit=False,stop_loss_pct=.2,
                    ma_direction_period=0,ma_max_distance_pct=0,use_ma_pivot_direction=True,
                    ma_pivot_period=7,ma_pivot_lookback=30,ma_pivot_min_arrows=2)
                self.assertEqual(result['latest_evaluation']['ma_pivot'],evaluate_ma_pivot([b['value'] for b in bars],7,30,2))
                self.assertTrue(result['latest_evaluation']['condition_enabled']['entry_ma_pivot_direction'])
        for params in [dict(ma_pivot_period=8),dict(ma_pivot_lookback=441),dict(ma_pivot_min_arrows=0)]:
            with self.assertRaises(HTTPException) as error: await server.get_crypto_backtest(**params)
            self.assertEqual(error.exception.status_code,422)
