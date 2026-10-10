import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.lighter_crypto_bot import LighterCryptoBot


class FakeLighter:
    MAX_CLIENT_ORDER_INDEX = (1 << 48) - 1

    def __init__(self):
        import asyncio
        self.execution_lock = asyncio.Lock()
        self.amount = 0.0
        self.orders = {}
        self.fail_after_fill = False
        self.book_ask = 100.01
        self.collateral = 1000.0
        self.extra_positions = []

    async def market_detail(self, market_id, *, fresh=False):
        return {"market_id": market_id, "symbol": "BTC", "market_type": "perp",
                "status": "active", "supported_size_decimals": 3,
                "min_base_amount": "0.001", "min_quote_amount": "10"}

    async def account_status(self):
        return {"authenticated": True, "execution_enabled": True,
                "collateral": self.collateral}

    async def positions(self, *, fresh=False):
        rows = copy.deepcopy(self.extra_positions)
        if self.amount:
            rows.append({"market_id": 1, "position": str(abs(self.amount)),
                         "sign": 1 if self.amount > 0 else -1,
                         "position_value": str(abs(self.amount) * 100),
                         "allocated_margin": str(abs(self.amount) * 100)})
        return rows

    async def order_book(self, market_id, limit, *, fresh=False):
        return {"bids": [{"price": "100"}], "asks": [{"price": str(self.book_ask)}]}

    async def create_market_order(self, market_id, qty, price, is_ask, *, reduce_only,
                                  client_order_index):
        self.amount += (-1 if is_ask else 1) * qty
        order = {"market_id": market_id, "client_order_index": client_order_index,
                 "status": "filled", "filled_size": qty, "fill_price": price,
                 "fill_confirmed": True, "fee_usd": 0, "fill_time_ms": 0}
        self.orders[client_order_index] = order
        if self.fail_after_fill:
            raise TimeoutError("lost order response")
        return order

    async def account_order(self, index):
        return self.orders.get(index)

    async def execution_fill(self, index, market_id, expected_size):
        return self.orders.get(index, {"fill_confirmed": False})


class TestLighterCryptoBot(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "lighter_crypto_bot_state.json"
        self.client = FakeLighter()
        self.bot = LighterCryptoBot(self.client, self.path)

    async def test_independent_paused_state_and_config(self):
        self.assertFalse(self.bot.state["enabled"])
        self.assertEqual(self.bot.state["selected_symbol"], "BTC")
        await self.bot.configure({"entry_z": 2.0, "max_tranches": 3})
        restored = LighterCryptoBot(self.client, self.path)
        self.assertEqual(restored.state["entry_z"], 2.0)
        for strat in ["ou_quant", "ma_stack", "multi_factor", "trend_pullback", "custom", "grid"]:
            await self.bot.configure({"strategy_mode": strat})
            self.assertEqual(self.bot.state["strategy_mode"], strat)
        with self.assertRaisesRegex(ValueError, "Unsupported live strategy"):
            await self.bot.configure({"strategy_mode": "unsupported_unknown"})

    async def test_foreign_same_market_position_blocks_entry(self):
        self.client.amount = 0.5
        with self.assertRaisesRegex(ValueError, "differs"):
            await self.bot.manual_entry(1, 50)
        self.assertEqual(self.client.orders, {})

    async def test_account_wide_exposure_blocks_entry(self):
        self.client.extra_positions = [{"market_id": 216, "position": "5", "sign": 1,
                                        "position_value": "970", "allocated_margin": "970"}]
        with self.assertRaisesRegex(ValueError, "Account-wide"):
            await self.bot.manual_entry(1, 50)
        self.assertEqual(self.client.orders, {})

    async def test_buffer_applies_to_estimated_margin_not_order_notional(self):
        self.client.collateral = 170.0
        entry = await self.bot.manual_entry(1, 150.0)
        self.assertEqual(entry["event"], "ENTRY")
        self.assertAlmostEqual(entry["notional_usd"], 150.015)
        self.assertEqual(len(self.client.orders), 1)

    async def test_projected_account_wide_gross_cap_blocks_entry(self):
        self.client.collateral = 140.0
        with self.assertRaisesRegex(ValueError, "gross exposure"):
            await self.bot.manual_entry(1, 150.0)
        self.assertEqual(self.client.orders, {})

    async def test_buffered_initial_margin_still_blocks_low_free_margin(self):
        self.client.extra_positions = [{"market_id": 216, "position": "1", "sign": 1,
                                        "position_value": "100", "allocated_margin": "990"}]
        with self.assertRaisesRegex(ValueError, "buffered initial-margin estimate"):
            await self.bot.manual_entry(1, 150.0)
        self.assertEqual(self.client.orders, {})

    async def test_enable_checks_actual_next_order_capacity(self):
        self.client.collateral = 140.0
        with self.assertRaisesRegex(ValueError, "gross exposure"):
            await self.bot.toggle(True)
        self.assertFalse(self.bot.state["enabled"])
        self.client.collateral = 170.0
        enabled = await self.bot.toggle(True)
        self.assertTrue(enabled["enabled"])
        self.assertEqual(self.client.orders, {})

    async def test_current_executable_quote_must_still_support_signal(self):
        with patch("backend.lighter_crypto_bot.evaluate_strategy_signal",
                   return_value=(False, 1, False, {})):
            with self.assertRaisesRegex(ValueError, "quote no longer supports"):
                await self.bot._submit(1, 50, reduce_only=False, reason="closed_bar_signal",
                                       signal_values=[100.0] * 25)
        self.assertEqual(self.client.orders, {})

    async def test_entry_and_reduce_are_tracked_separately(self):
        entry = await self.bot.manual_entry(1, 50)
        self.assertEqual(entry["event"], "ENTRY")
        self.assertEqual(len(self.bot.state["tranches"]), 1)
        restored = LighterCryptoBot(self.client, self.path)
        await restored.verify_startup()
        self.assertFalse(restored.state["recovery_required"])
        exit_event = await restored.manual_reduce()
        self.assertEqual(exit_event["event"], "EXIT")
        self.assertEqual(restored.state["tranches"], [])
        self.assertAlmostEqual(self.client.amount, 0)

    async def test_uncertain_fill_pauses_and_reconciles_by_client_index(self):
        self.client.fail_after_fill = True
        with self.assertRaisesRegex(TimeoutError, "lost order response"):
            await self.bot.manual_entry(1, 50)
        self.assertTrue(self.bot.state["recovery_required"])
        self.assertFalse(self.bot.state["enabled"])
        restored = LighterCryptoBot(self.client, self.path)
        self.assertTrue(restored.state["recovery_required"])
        result = await restored.reconcile()
        self.assertEqual(result["event"]["event"], "ENTRY")
        self.assertFalse(restored.state["recovery_required"])
        self.assertEqual(len(self.client.orders), 1)


if __name__ == "__main__":
    unittest.main()
