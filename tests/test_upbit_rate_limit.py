import asyncio
import unittest
from unittest.mock import AsyncMock, patch, MagicMock
from backend.upbit_client import UpbitClient

class TestUpbitRateLimit(unittest.TestCase):
    def setUp(self):
        self.client = UpbitClient(access_key="test_acc", secret_key="test_sec")

    def test_candle_cache_stores_and_bridges(self):
        async def run():
            call_count = 0
            async def fake_request(method, endpoint, params=None, signed=False, max_retries=4):
                nonlocal call_count
                call_count += 1
                to = params.get("to") if params else None
                return [
                    {"candle_date_time_utc": "2026-09-18T09:40:00", "opening_price": 100, "high_price": 105, "low_price": 99, "trade_price": 102, "candle_acc_trade_volume": 1.0},
                    {"candle_date_time_utc": "2026-09-18T09:35:00", "opening_price": 98, "high_price": 101, "low_price": 97, "trade_price": 100, "candle_acc_trade_volume": 2.0},
                ]

            self.client.request = fake_request
            
            # Freeze time at 09:42 UTC (within current 5m bar of 09:40 UTC open)
            with patch("time.time", return_value=1789724710): # 09:42 UTC
                candles = await self.client.get_minute_candles("KRW-BTC", 5, count=2)
                self.assertEqual(len(candles), 2)
                self.assertEqual(call_count, 1)

                # Second call requesting 2: served from cache immediately without calling request
                candles2 = await self.client.get_minute_candles("KRW-BTC", 5, count=2)
                self.assertEqual(len(candles2), 2)
                self.assertEqual(call_count, 1)

        asyncio.run(run())

    def test_request_retries_on_429(self):
        async def run():
            attempts = 0
            mock_session = AsyncMock()
            mock_session.closed = False

            class FakeResponse:
                def __init__(self, status, payload):
                    self.status = status
                    self._payload = payload
                async def json(self):
                    return self._payload
                async def text(self):
                    return str(self._payload)
                async def __aenter__(self):
                    return self
                async def __aexit__(self, exc_type, exc, tb):
                    pass

            def fake_request(*args, **kwargs):
                nonlocal attempts
                attempts += 1
                if attempts < 3:
                    return FakeResponse(429, {"name": "too_many_requests"})
                return FakeResponse(200, [{"market": "KRW-BTC", "trade_price": 100000000.0}])

            mock_session.request = MagicMock(side_effect=fake_request)
            self.client._session = mock_session
            self.client._throttle = AsyncMock()

            with patch("asyncio.sleep", AsyncMock()):
                res = await self.client.request("GET", "/v1/ticker", params={"markets": "KRW-BTC"})
            self.assertEqual(attempts, 3)
            self.assertIsInstance(res, list)
            self.assertEqual(res[0]["trade_price"], 100000000.0)

        asyncio.run(run())

if __name__ == "__main__":
    unittest.main()
