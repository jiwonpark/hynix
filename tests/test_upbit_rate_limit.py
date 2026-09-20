import asyncio
import unittest
from datetime import datetime, timezone
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
            
            # Both returned candles are finalized by 09:45 UTC.
            now = datetime(2026, 9, 18, 9, 45, 10, tzinfo=timezone.utc).timestamp()
            with patch("time.time", return_value=now):
                candles = await self.client.get_minute_candles("KRW-BTC", 5, count=2)
                self.assertEqual(len(candles), 2)
                self.assertEqual(call_count, 1)

                # Second call requesting 2: served from cache immediately without calling request
                candles2 = await self.client.get_minute_candles("KRW-BTC", 5, count=2)
                self.assertEqual(len(candles2), 2)
                self.assertEqual(call_count, 1)

        asyncio.run(run())

    def test_partial_candles_are_excluded_then_refetched_at_close(self):
        async def run():
            def row(t, price):
                return dict(candle_date_time_utc=t, opening_price=100, high_price=price,
                            low_price=99, trade_price=price, candle_acc_trade_volume=1)
            partial = row("2026-09-18T09:40:00", 102)
            closed = row("2026-09-18T09:35:00", 100)
            self.client.request = AsyncMock(return_value=[partial, closed])
            now = datetime(2026, 9, 18, 9, 42, tzinfo=timezone.utc).timestamp()
            with patch("time.time", return_value=now):
                candles = await self.client.get_minute_candles("KRW-BTC", 5, 2)
                self.assertEqual([c["close"] for c in candles], [100])
                self.assertEqual(len(self.client._candle_cache[("KRW-BTC", 5)]), 1)
            self.client.request.return_value = [row("2026-09-18T09:40:00", 110), closed]
            with patch("time.time", return_value=now + 180):
                candles = await self.client.get_minute_candles("KRW-BTC", 5, 2)
                self.assertEqual(candles[-1]["close"], 110)
            self.assertEqual(self.client.request.await_count, 2)
        asyncio.run(run())

    def test_mutations_never_retry_timeout_or_server_error(self):
        async def run():
            self.client._throttle = AsyncMock()
            class Response:
                status = 503
                async def __aenter__(self): return self
                async def __aexit__(self, *args): pass
                async def json(self): return {"error":{"message":"unavailable"}}
            for outcome in (TimeoutError('lost response'), Response()):
                session = MagicMock(closed=False)
                session.request.side_effect = outcome if isinstance(outcome, Exception) else None
                session.request.return_value = outcome
                self.client._session = session
                with patch("asyncio.sleep", AsyncMock()):
                    with self.assertRaises(Exception):
                        await self.client.create_order("KRW-BTC", "bid", price="5000", ord_type="price", identifier="test-id")
                self.assertEqual(session.request.call_count, 1)
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
