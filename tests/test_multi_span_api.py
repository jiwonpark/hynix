import unittest
from unittest.mock import AsyncMock, patch
from backend import server

class MultiSpanApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        server._klines_cache.clear()

    async def test_klines_1s_uses_spot_endpoint(self):
        with patch.object(server.binance_client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = [
                [1700000000000, "100.0", "101.0", "99.0", "100.5", "10.0", 1700000000999, "1000", 5, "5", "500", "0"]
            ]
            res = await server.get_klines("BTCUSDT", interval="1s", limit=10)
            self.assertEqual(len(res), 1)
            mock_req.assert_called_once()
            args, kwargs = mock_req.call_args
            self.assertEqual(args[0], "GET")
            self.assertEqual(args[1], "/api/v3/klines")
            self.assertEqual(kwargs.get("base_url"), "https://api.binance.com")
            self.assertEqual(kwargs.get("params", {}).get("interval"), "1s")

    async def test_klines_futures_default_for_other_spans(self):
        for span in ["5m", "15m", "1h", "1d"]:
            with patch.object(server.binance_client, "request", new_callable=AsyncMock) as mock_req:
                mock_req.return_value = [
                    [1700000000000, "100.0", "101.0", "99.0", "100.5", "10.0", 1700000060000, "1000", 5, "5", "500", "0"]
                ]
                res = await server.get_klines("BTCUSDT", interval=span, limit=5)
                self.assertEqual(len(res), 1)
                mock_req.assert_called_once()
                args, kwargs = mock_req.call_args
                self.assertEqual(args[0], "GET")
                self.assertEqual(args[1], "/fapi/v1/klines")
                self.assertNotIn("base_url", kwargs)

if __name__ == "__main__":
    unittest.main()
