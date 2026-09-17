import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

from backend import server
from backend.binance_client import BinanceFuturesClient


class BinanceSpotOverviewTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_account_refresh_is_bounded_shared_and_recovers(self):
        client = BinanceFuturesClient(api_key="key", api_secret="secret")
        client._overview_cache = {"authenticated": True, "positions": [{"symbol": "old"}]}
        client._overview_cache_time = -100
        async def hung():
            await asyncio.Event().wait()
        client._fetch_detailed_account_overview = AsyncMock(side_effect=hung)
        with patch('backend.binance_client.ACCOUNT_REFRESH_TIMEOUT', .01):
            results = await asyncio.gather(*(client.get_detailed_account_overview() for _ in range(8)))
        self.assertEqual(client._fetch_detailed_account_overview.await_count, 1)
        self.assertTrue(all(not r['authenticated'] and r['status'] == 'unavailable' for r in results))
        self.assertEqual(results[0]['positions'], [], 'expired balances cannot authorize trading')
        self.assertIn('timed out', results[0]['error'])
        await client.get_detailed_account_overview()
        self.assertEqual(client._fetch_detailed_account_overview.await_count, 1, 'brief backoff prevents retry storms')
        client._overview_cache_time = -100
        client._fetch_detailed_account_overview = AsyncMock(return_value={'authenticated': True, 'positions': []})
        self.assertTrue((await client.get_detailed_account_overview())['authenticated'])

    async def test_cancelled_browser_does_not_cancel_shared_refresh(self):
        client = BinanceFuturesClient(api_key="key", api_secret="secret")
        entered, release = asyncio.Event(), asyncio.Event()
        async def fetch():
            entered.set()
            await release.wait()
            return {'authenticated': True, 'positions': []}
        client._fetch_detailed_account_overview = AsyncMock(side_effect=fetch)
        waiter = asyncio.create_task(client.get_detailed_account_overview())
        await entered.wait()
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        release.set()
        await client._overview_task
        self.assertTrue((await client.get_detailed_account_overview())['authenticated'])
        self.assertEqual(client._fetch_detailed_account_overview.await_count, 1)

    async def test_read_timeout_is_explicit_and_order_is_never_retried(self):
        client = BinanceFuturesClient(api_key="private-key", api_secret="private-secret")
        class TimeoutResponse:
            async def __aenter__(self):
                raise asyncio.TimeoutError()
            async def __aexit__(self, *args):
                return False
        session = Mock()
        session.request.return_value = TimeoutResponse()
        client.get_session = AsyncMock(return_value=session)
        with self.assertRaisesRegex(TimeoutError, 'Binance GET /fapi/v2/account timed out'):
            await client.get_raw_account()
        self.assertEqual(session.request.call_args.kwargs['timeout'].total, 4)
        session.request.reset_mock()
        with self.assertRaisesRegex(TimeoutError, 'Binance POST /fapi/v1/order timed out'):
            await client.create_order('SKHYUSDT', 'SELL', .08)
        self.assertEqual(session.request.call_count, 1)
        self.assertNotIn('timeout', session.request.call_args.kwargs)

    async def test_futures_overview_coalesces_concurrent_callers_and_copies_cache(self):
        client = BinanceFuturesClient(api_key="key", api_secret="secret")

        async def fetch_once():
            await asyncio.sleep(0)
            return {"authenticated": True, "summary": {"total_equity_usd": 499.0}, "positions": []}

        client._fetch_detailed_account_overview = AsyncMock(side_effect=fetch_once)
        results = await asyncio.gather(*(client.get_detailed_account_overview() for _ in range(6)))

        self.assertEqual(client._fetch_detailed_account_overview.await_count, 1)
        results[0]["summary"]["total_equity_usd"] = 0
        cached = await client.get_detailed_account_overview()
        self.assertEqual(cached["summary"]["total_equity_usd"], 499.0)
        self.assertEqual(client._fetch_detailed_account_overview.await_count, 1)

    async def test_spot_overview_reports_usdt_and_stablecoins(self):
        client = BinanceFuturesClient(api_key="key", api_secret="secret")
        client.request = AsyncMock(return_value={
            "balances": [
                {"asset": "USDT", "free": "464.9", "locked": "0"},
                {"asset": "USDC", "free": "10", "locked": "2"},
                {"asset": "COW", "free": "2.04", "locked": "0"},
                {"asset": "BTC", "free": "0", "locked": "0"},
            ]
        })

        with patch("backend.binance_client.config.USE_TESTNET", False):
            result = await client.get_spot_account_overview()

        self.assertTrue(result["authenticated"])
        self.assertEqual(result["summary"]["usdt_balance"], 464.9)
        self.assertEqual(result["summary"]["stablecoin_equity_usd"], 476.9)
        self.assertEqual([asset["asset"] for asset in result["assets"]], ["USDT", "USDC", "COW"])
        client.request.assert_awaited_once_with(
            "GET", "/api/v3/account", signed=True, base_url="https://api.binance.com"
        )

    async def test_portfolio_keeps_futures_margin_separate_from_spot(self):
        binance = AsyncMock()
        binance.get_detailed_account_overview.return_value = {
            "authenticated": True,
            "summary": {"total_equity_usd": 34.3, "available_margin_usd": 7.76},
            "assets": [],
            "positions": [],
        }
        binance.get_spot_account_overview.return_value = {
            "authenticated": True,
            "summary": {"usdt_balance": 464.9, "stablecoin_equity_usd": 464.9},
            "assets": [{"asset": "USDT", "total": 464.9}],
        }
        upbit = AsyncMock()
        upbit.get_detailed_account_overview.return_value = {
            "authenticated": True,
            "summary": {"total_equity_usd": 266.22, "total_equity_krw": 372714.25, "usdt_krw_rate": 1400},
            "assets": [],
        }

        with patch.object(server, "binance_client", binance), patch.object(server, "upbit_client", upbit):
            result = await server.get_portfolio_overview()

        self.assertEqual(result["binance"]["futures_equity_usd"], 34.3)
        self.assertEqual(result["binance"]["spot_usdt"], 464.9)
        self.assertEqual(result["binance"]["total_equity_usd"], 499.2)
        self.assertEqual(result["combined_equity_usd"], 765.42)
        self.assertEqual(result["details"]["binance"]["summary"]["available_margin_usd"], 7.76)


if __name__ == "__main__":
    unittest.main()
