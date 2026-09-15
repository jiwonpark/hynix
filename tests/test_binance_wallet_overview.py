import unittest
from unittest.mock import AsyncMock, patch

from backend import server
from backend.binance_client import BinanceFuturesClient


class BinanceSpotOverviewTests(unittest.IsolatedAsyncioTestCase):
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
