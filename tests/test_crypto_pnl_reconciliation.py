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


class WindowedFakeClient:
    def __init__(self, fills):
        self.fills = fills
        self.calls = []

    async def request(self, method, endpoint, params=None, signed=False):
        assert method == "GET" and endpoint == "/fapi/v1/userTrades" and signed
        self.calls.append(params)
        return [row for row in self.fills if params["startTime"] <= row["time"] <= params["endTime"]]


class DelayedEventFakeClient(WindowedFakeClient):
    def __init__(self, fills, order_times):
        super().__init__(fills)
        self.order_times = order_times

    async def request(self, method, endpoint, params=None, signed=False):
        if endpoint == "/fapi/v1/order":
            self.calls.append(params)
            return {"status": "FILLED", "updateTime": self.order_times[str(params["orderId"])]}
        return await super().request(method, endpoint, params, signed)


def fill(order_id, side, qty, commission, pnl="0", asset="USDT", timestamp=None):
    result = {"symbol": "BTCUSDT", "orderId": order_id, "side": side, "qty": qty,
              "commission": commission, "commissionAsset": asset, "realizedPnl": pnl}
    if timestamp is not None:
        result["time"] = timestamp
    return result


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

    def test_fetches_all_seven_day_windows_covering_persisted_history(self):
        day = 24 * 60 * 60
        old_entry = 1_790_000_000
        old_exit = old_entry + day
        recent_entry = old_entry + 8 * day
        recent_exit = old_entry + 9 * day
        client = WindowedFakeClient([
            fill(10, "BUY", "2", "0.10", timestamp=old_entry * 1000),
            fill(11, "SELL", "2", "0.10", "2.00", timestamp=old_exit * 1000),
            fill(12, "BUY", "2", "0.10", timestamp=recent_entry * 1000),
            fill(13, "SELL", "2", "0.10", "1.00", timestamp=recent_exit * 1000),
        ])
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        bot = CryptoBot(client, Path(directory.name) / "state.json")
        bot.state["execution_history"] = [
            {"event": "ENTRY", "symbol": "BTCUSDT", "order_id": "10", "qty": 2,
             "price": 100, "side": 1, "time": old_entry, "pnl_authoritative": False},
            {"event": "EXIT", "symbol": "BTCUSDT", "order_id": "11", "entry_order_id": "10",
             "qty": 2, "price": 101, "entry_price": 100, "original_side": 1,
             "time": old_exit, "pnl_authoritative": False},
            {"event": "ENTRY", "symbol": "BTCUSDT", "order_id": "12", "qty": 2,
             "price": 100, "side": 1, "time": recent_entry, "pnl_authoritative": False},
            {"event": "EXIT", "symbol": "BTCUSDT", "order_id": "13", "entry_order_id": "12",
             "qty": 2, "price": 101, "entry_price": 100, "original_side": 1,
             "time": recent_exit, "pnl_authoritative": False},
        ]

        result = self.loop.run_until_complete(bot.reconciled_public_state())

        self.assertEqual(result["verified_exit_count"], 2)
        self.assertAlmostEqual(result["verified_realized_pnl_usd"], 2.6)
        self.assertEqual(len(client.calls), 2)
        self.assertTrue(all(call["endTime"] - call["startTime"] < 7 * day * 1000
                            for call in client.calls))
        self.assertLessEqual(client.calls[0]["startTime"], old_entry * 1000)
        self.assertGreaterEqual(client.calls[-1]["endTime"], recent_exit * 1000)

    def test_recovers_fill_when_persisted_event_timestamp_lags_exchange(self):
        exchange_entry = 1_790_000_000
        recorded_entry = exchange_entry + 8 * 60 * 60
        recorded_exit = recorded_entry + 60 * 60
        client = DelayedEventFakeClient([
            fill(10, "BUY", "2", "0.10", timestamp=exchange_entry * 1000),
            fill(11, "SELL", "2", "0.10", "2.00", timestamp=recorded_exit * 1000),
        ], {"10": exchange_entry * 1000})
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        bot = CryptoBot(client, Path(directory.name) / "state.json")
        bot.state["execution_history"] = [
            {"event": "ENTRY", "symbol": "BTCUSDT", "order_id": "10", "qty": 2,
             "price": 100, "side": 1, "time": recorded_entry, "pnl_authoritative": False},
            {"event": "EXIT", "symbol": "BTCUSDT", "order_id": "11", "entry_order_id": "10",
             "qty": 2, "price": 101, "entry_price": 100, "original_side": 1,
             "time": recorded_exit, "pnl_authoritative": False},
        ]

        result = self.loop.run_until_complete(bot.reconciled_public_state())

        self.assertEqual(result["verified_exit_count"], 1)
        self.assertAlmostEqual(result["verified_realized_pnl_usd"], 1.8)
        order_lookups = [call for call in client.calls if "orderId" in call]
        self.assertEqual(order_lookups, [{"symbol": "BTCUSDT", "orderId": "10"}])


if __name__ == "__main__":
    unittest.main()
