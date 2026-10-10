import asyncio
import tempfile
import unittest
from pathlib import Path

from backend.crypto_bot import CryptoBot


class FakeClient:
    def __init__(self, fills):
        self.fills = fills
        self.calls = 0

    async def request(self, method, endpoint, params=None, signed=False):
        assert method == "GET" and endpoint == "/fapi/v1/userTrades" and signed
        self.calls += 1
        return self.fills


def fill(order_id, side, qty, commission, pnl="0", asset="USDT"):
    return {"symbol": "BTCUSDT", "orderId": order_id, "side": side, "qty": qty,
            "commission": commission, "commissionAsset": asset, "realizedPnl": pnl}


class CryptoPnlReconciliationTest(unittest.TestCase):
    def setUp(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)

    def tearDown(self):
        self.loop.close()
        asyncio.set_event_loop(None)

    def make_bot(self, fills):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        client = FakeClient(fills)
        bot = CryptoBot(client, Path(directory.name) / "state.json")
        bot.state["execution_history"] = [
            {"event": "ENTRY", "symbol": "BTCUSDT", "order_id": "10", "qty": 2,
             "price": 100, "side": 1, "pnl_authoritative": False},
            {"event": "EXIT", "symbol": "BTCUSDT", "order_id": "11", "entry_order_id": "10",
             "qty": 2, "price": 101, "entry_price": 100, "original_side": 1,
             "pnl_authoritative": False},
        ]
        return bot, client

    def test_multifill_exit_uses_exchange_pnl_and_both_order_fees(self):
        bot, client = self.make_bot([
            fill(10, "BUY", "2", "0.10"),
            fill(11, "SELL", "1", "0.05", "1.20"),
            fill(11, "SELL", "1", "0.05", "0.80"),
        ])
        result = self.loop.run_until_complete(bot.reconciled_public_state())
        exit_row = result["execution_history"][1]
        self.assertTrue(exit_row["pnl_authoritative"])
        self.assertEqual(exit_row["pnl_source"], "BINANCE_USER_TRADES")
        self.assertAlmostEqual(exit_row["net_pnl_usd"], 1.8)
        self.assertAlmostEqual(exit_row["round_trip_fee_usd"], 0.2)
        self.assertEqual(result["verified_exit_count"], 1)
        self.assertEqual(client.calls, 1)
        self.loop.run_until_complete(bot.reconciled_public_state())
        self.assertEqual(client.calls, 1)
        self.assertFalse(bot.state["execution_history"][1]["pnl_authoritative"])

    def test_incomplete_or_non_usdt_fills_remain_unverified(self):
        for fills in ([fill(10, "BUY", "2", "0.1")],
                      [fill(10, "BUY", "2", "0.1"), fill(11, "SELL", "1", "0.1", "2")],
                      [fill(10, "BUY", "2", "0.1"), fill(11, "SELL", "2", "0.1", "2", "BNB")]):
            with self.subTest(fills=fills):
                bot, _ = self.make_bot(fills)
                result = self.loop.run_until_complete(bot.reconciled_public_state())
                self.assertEqual(result["verified_exit_count"], 0)
                self.assertFalse(result["execution_history"][1]["pnl_authoritative"])

    def test_exchange_error_preserves_unverified_status(self):
        bot, client = self.make_bot([])

        async def unavailable(*args, **kwargs):
            raise TimeoutError("Binance unavailable")

        client.request = unavailable
        result = self.loop.run_until_complete(bot.reconciled_public_state())
        self.assertEqual(result["verified_exit_count"], 0)
        self.assertIn("error", result["pnl_reconciliation"])


if __name__ == "__main__":
    unittest.main()
