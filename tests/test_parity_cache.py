import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from backend import server


class ParityCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_timeframes_and_limits_have_independent_fresh_caches(self):
        client = AsyncMock()
        async def request(method, path, params):
            step = 300000 if params['interval'] == '5m' else 3600000
            return [[step * i, 0, 0, 0, 100] for i in range(params['limit'])]
        client.request.side_effect = request
        with patch.object(server, 'binance_client', client), patch.object(server, '_parity_cache', {}):
            five, hourly = await asyncio.gather(
                server.get_cached_parity_bars('5m', 60), server.get_cached_parity_bars('1h', 60))
            self.assertEqual(five[1]['time'], 300)
            self.assertEqual(hourly[1]['time'], 3600)
            self.assertEqual(await server.get_cached_parity_bars('5m', 60), five)
            self.assertEqual(await server.get_cached_parity_bars('1h', 60), hourly)
            self.assertEqual(client.request.await_count, 4)
            self.assertEqual(len(await server.get_cached_parity_bars('5m', 24)), 24)
            self.assertEqual(client.request.await_count, 6)

    async def test_failed_refresh_never_returns_other_timeframe_or_expired_data(self):
        client = AsyncMock()
        client.request.side_effect = RuntimeError('market data unavailable')
        cache = {'5m_60': {'timestamp': 100, 'data': [{'time': 100, 'value': 140}]}}
        with patch.object(server, 'binance_client', client), patch.object(server, '_parity_cache', cache):
            with patch.object(server.time, 'time', return_value=101):
                self.assertEqual(await server.get_cached_parity_bars('1h', 60), [])
            with patch.object(server.time, 'time', return_value=105):
                self.assertEqual(await server.get_cached_parity_bars('5m', 60), [])
