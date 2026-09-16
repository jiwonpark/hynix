import unittest
from unittest.mock import AsyncMock, patch
from backend import server


class BacktestAPITests(unittest.IsolatedAsyncioTestCase):
    async def test_simulation_does_not_read_or_write_account_state(self):
        start = 1704067200
        data = [dict(time=start+i*300, value=140, adr=100, domestic=100/1.4, csop=5) for i in range(20)]
        request = server.DynamicBacktestRequest(start_time=start, end_time=start+6000,
            initial_equity=500, toggles={'entry_ma_stretch':False, 'entry_base_spread':False,
                                       'entry_ma_stack_5m':False,'entry_ma_stack_1h':False})
        with patch.object(server, 'backtest_market_bars', AsyncMock(return_value=data)), \
             patch.object(server, 'load_auto_tranche_state', side_effect=AssertionError('no account state')), \
             patch.object(server, 'save_auto_tranche_state', side_effect=AssertionError('no writes')), \
             patch.object(server, 'binance_client', AsyncMock()) as client:
            result = await server.dynamic_backtest(request)
            self.assertTrue(result['success'])
            self.assertGreater(result['summary']['entries'],0)
            self.assertEqual(result['summary']['mode'], 'price_signals')
            request.initial_equity = .01
            self.assertEqual(await server.dynamic_backtest(request), result)
            client.create_order.assert_not_awaited()
            client.get_detailed_account_overview.assert_not_awaited()
            request.toggles['entry_ma_stretch'] = True
            stricter = await server.dynamic_backtest(request)
            self.assertEqual(stricter['summary']['entries'],0)

    async def test_market_cache_reuses_prices_and_excludes_open_candles(self):
        now = 1704070800
        requested = []
        async def prices(method, path, params):
            self.assertEqual(path,'/fapi/v1/klines')
            self.assertEqual(params['interval'],'5m')
            requested.append(params)
            price = {'SKHYUSDT':100,'SKHYNIXUSDT':700,'CSOPSKHYNIX2LUSDT':5}[params['symbol']]
            return [[t*1000,0,0,0,price] for t in (now-600,now-300,now)]
        with patch.object(server, 'binance_client', AsyncMock()) as client, \
             patch.object(server.time, 'time', return_value=now), \
             patch.object(server, '_backtest_market_cache', server.OrderedDict()):
            client.request.side_effect=prices
            data=await server.backtest_market_bars(now-600,now)
            again=await server.backtest_market_bars(now-600,now)
            self.assertEqual(data,again)
            self.assertEqual(len(requested),3)
            self.assertEqual([b['time'] for b in data],[now-600,now-300])
