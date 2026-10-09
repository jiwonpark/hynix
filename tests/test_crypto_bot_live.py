import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from backend.crypto_bot import CryptoBot


class FakeBinance:
    def __init__(self):
        self.amount = 0.0
        self.orders = []
        self.fail_order = False
        self.fail_after_fill = False
        self.last_order = None
        self.account = {"authenticated": True, "can_trade": True,
                        "summary": {"total_equity_usd": 1000.0, "available_margin_usd": 900.0},
                        "positions": []}
        self.set_margin_type = AsyncMock()
        self.set_leverage = AsyncMock()

    async def get_detailed_account_overview(self):
        return copy.deepcopy(self.account)

    async def request(self, method, path, params=None, signed=False):
        if path == "/fapi/v1/positionSide/dual":
            return {"dualSidePosition": False}
        if path == "/fapi/v2/positionRisk":
            return [{"symbol": params["symbol"], "positionAmt": str(self.amount), "positionSide": "BOTH"}]
        if path == "/fapi/v1/exchangeInfo":
            return {"symbols": [{"symbol": "BTCUSDT", "status": "TRADING", "filters": [
                {"filterType": "MARKET_LOT_SIZE", "stepSize": "0.001", "minQty": "0.001"},
                {"filterType": "MIN_NOTIONAL", "notional": "5"}]}]}
        if path == "/fapi/v1/ticker/bookTicker":
            return {"bidPrice": "100", "askPrice": "100.01"}
        if path == "/fapi/v1/klines":
            return self.klines
        if path == "/fapi/v1/order":
            return self.last_order
        raise AssertionError(path)

    async def create_order(self, symbol, side, qty, order_type, **options):
        self.orders.append((symbol, side, qty, options))
        if self.fail_order:
            raise TimeoutError("response lost")
        self.amount += (1 if side == "BUY" else -1) * float(qty)
        self.last_order = {"status": "FILLED", "executedQty": qty, "avgPrice": "100.01",
                           "orderId": len(self.orders)}
        if self.fail_after_fill:
            raise TimeoutError("response lost after fill")
        return self.last_order


class TestCryptoBotLive(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "crypto_bot_state.json"
        self.client = FakeBinance()
        self.bot = CryptoBot(self.client, self.path)

    async def test_config_is_persisted_and_replay_only_strategy_rejected(self):
        await self.bot.configure({"entry_z": 2.0, "selected_symbol": "BTCUSDT"})
        restored = CryptoBot(self.client, self.path)
        self.assertEqual(restored.state["entry_z"], 2.0)
        self.assertFalse(restored.state["enabled"])
        with self.assertRaisesRegex(ValueError, "replay only"):
            await self.bot.configure({"strategy_mode": "ma_stack"})
        self.assertEqual(self.bot.state["strategy_mode"], "grid")

    async def test_foreign_position_blocks_enable_and_order(self):
        self.client.amount = 0.4
        with self.assertRaisesRegex(ValueError, "differs"):
            await self.bot.toggle(True)
        self.assertFalse(self.bot.state["enabled"])
        self.assertEqual(self.client.orders, [])

    async def test_restart_with_mismatched_exchange_position_halts_before_worker(self):
        await self.bot.toggle(True)
        self.client.amount = 0.001
        restored = CryptoBot(self.client, self.path)
        await restored.verify_startup()
        self.assertFalse(restored.state["enabled"])
        self.assertTrue(restored.state["recovery_required"])
        self.assertEqual(self.client.orders, [])

    async def test_manual_fill_reconciles_after_restart_then_reduces_only_owned_qty(self):
        event = await self.bot.manual_entry(1, 50)
        self.assertEqual(event["event"], "ENTRY")
        self.assertEqual(self.client.orders[0][2], "0.500")
        self.assertTrue(self.client.orders[0][3]["client_order_id"].startswith("hxcrypto"))
        self.assertFalse(self.client.orders[0][3]["reduce_only"])
        self.client.set_margin_type.assert_awaited_once_with("BTCUSDT", "CROSSED")
        self.client.set_leverage.assert_awaited_once_with("BTCUSDT", 1)
        restored = CryptoBot(self.client, self.path)
        self.assertEqual(len(restored.state["tranches"]), 1)
        await restored.manual_reduce()
        self.assertTrue(self.client.orders[1][3]["reduce_only"])
        self.assertEqual(self.client.amount, 0)
        self.assertEqual(restored.state["tranches"], [])

    async def test_uncertain_order_halts_and_survives_restart(self):
        self.client.fail_order = True
        with self.assertRaisesRegex(TimeoutError, "response lost"):
            await self.bot.manual_entry(-1, 50)
        self.assertTrue(self.bot.state["recovery_required"])
        self.assertIsNotNone(self.bot.state["pending_order"])
        restored = CryptoBot(self.client, self.path)
        self.assertFalse(restored.state["enabled"])
        with self.assertRaisesRegex(ValueError, "recovery"):
            await restored.toggle(True)
        self.assertEqual(len(self.client.orders), 1)

    async def test_read_only_reconciliation_records_fill_after_lost_response(self):
        self.client.fail_after_fill = True
        with self.assertRaisesRegex(TimeoutError, "response lost after fill"):
            await self.bot.manual_entry(1, 50)
        self.assertTrue(self.bot.state["recovery_required"])
        restored = CryptoBot(self.client, self.path)
        result = await restored.reconcile()
        self.assertEqual(result["event"]["event"], "ENTRY")
        self.assertFalse(restored.state["recovery_required"])
        self.assertIsNone(restored.state["pending_order"])
        self.assertEqual(len(restored.state["tranches"]), 1)
        self.assertEqual(len(self.client.orders), 1)

    async def test_enabling_never_places_an_order_and_strategy_cannot_change_while_active(self):
        state = await self.bot.toggle(True)
        self.assertTrue(state["enabled"])
        self.assertEqual(self.client.orders, [])
        with self.assertRaisesRegex(ValueError, "Pause"):
            await self.bot.configure({"entry_z": 2.5})
        await self.bot.toggle(False)
        self.assertFalse(CryptoBot(self.client, self.path).state["enabled"])

    async def test_executable_quote_must_still_support_signal(self):
        self.bot.state["enabled"] = True
        self.bot.state["strategy_interval"] = "1m"
        now = 1000030
        last_open = 999960
        self.client.klines = [
            [int((last_open - (24 - i) * 60) * 1000), "100", "100", "100", "100", "1",
             int((last_open - (24 - i) * 60 + 60) * 1000 - 1)]
            for i in range(25)
        ]
        with patch("backend.crypto_bot.time.time", return_value=now), patch(
            "backend.crypto_bot.evaluate_grid_signals",
            side_effect=[(True, 1, False, {"mean": 100, "z": -2, "ratio": 100}),
                         (False, 1, False, {"mean": 100, "z": 0, "ratio": 100.01})],
        ):
            await self.bot.run_once()
        self.assertEqual(self.client.orders, [])
        self.assertIn("executable quote", self.bot.state["last_error"])

    async def test_worker_uses_one_completed_bar_and_never_duplicates(self):
        now = 1000030
        last_open = 999960
        self.client.klines = [
            [int((last_open - (24 - i) * 60) * 1000), "100", "100", "100", "100", "1",
             int((last_open - (24 - i) * 60 + 60) * 1000 - 1)]
            for i in range(25)
        ]
        self.bot.state["enabled"] = True
        self.bot.state["strategy_interval"] = "1m"
        with patch("backend.crypto_bot.time.time", return_value=now), patch(
            "backend.crypto_bot.evaluate_grid_signals",
            return_value=(True, 1, False, {"mean": 100, "z": -2, "ratio": 100}),
        ):
            await self.bot.run_once()
            await self.bot.run_once()
        self.assertEqual(len(self.client.orders), 1)
        self.assertEqual(self.bot.state["last_evaluated_candle"], last_open)


if __name__ == "__main__":
    unittest.main()
