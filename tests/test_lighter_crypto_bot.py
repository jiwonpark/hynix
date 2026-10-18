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

    def get_credentials(self):
        return {"account_index": 749609, "api_key_index": 0}

    async def account_trades(self, market_id, limit=100):
        return getattr(self, "trades", [])

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
        # Unrelated market position (SKHY market 216) with sufficient free margin does not block BTC 1.0x cap
        self.client.extra_positions = [{"market_id": 216, "position": "5", "sign": 1,
                                        "position_value": "970", "allocated_margin": "97"}]
        entry = await self.bot.manual_entry(1, 50)
        self.assertEqual(entry["event"], "ENTRY")
        # Same-market (BTC market 1) gross exposure exceeding 1.0x collateral cap blocks entry
        self.client.collateral = 80.0
        with self.assertRaisesRegex(ValueError, "Selected-contract gross exposure"):
            await self.bot.manual_entry(1, 50)

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
        toggled = await self.bot.toggle(True)
        self.assertTrue(toggled["enabled"])
        self.assertTrue(toggled["execution_blocked"])
        self.assertIn("gross exposure", toggled["blocked_reason"])
        self.client.collateral = 170.0
        enabled = await self.bot.toggle(True)
        self.assertTrue(enabled["enabled"])
        self.assertFalse(enabled["execution_blocked"])
        self.assertEqual(self.client.orders, {})

    async def test_current_executable_quote_must_still_support_signal(self):
        with patch("backend.lighter_crypto_bot.evaluate_strategy_signal",
                   return_value=(False, 1, False, {})):
            with self.assertRaisesRegex(ValueError, "quote no longer supports"):
                await self.bot._submit(1, 50, reduce_only=False, reason="closed_bar_signal",
                                       signal_values=[100.0] * 25)
        self.assertEqual(self.client.orders, {})

    async def test_use_ma_stack_1h_blocks_short_in_uptrend_range(self):
        from backend.lighter_strategy import evaluate_strategy_signal
        uptrend_prices = [70000.0 + i * 50.0 for i in range(64)] + [73800.0]
        entry_on, side_on, _, eval_on = evaluate_strategy_signal(
            "custom",
            uptrend_prices,
            {"entry_z": 1.2, "exit_z": 0.2, "use_ma_stretch": True, "use_peak": False,
             "use_base_spacing": False, "use_ma_stack": False, "use_ma_stack_1h": True},
        )
        self.assertEqual(side_on, -1)
        self.assertFalse(entry_on)
        self.assertFalse(eval_on["condition_pass"]["entry_ma_stack_1h"])

        entry_off, side_off, _, _ = evaluate_strategy_signal(
            "custom",
            uptrend_prices,
            {"entry_z": 1.2, "exit_z": 0.2, "use_ma_stretch": True, "use_peak": False,
             "use_base_spacing": False, "use_ma_stack": False, "use_ma_stack_1h": False},
        )
        self.assertEqual(side_off, -1)
        self.assertTrue(entry_off)

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

    async def test_position_mismatch_flags_recovery_and_reconciles(self):
        self.client.amount = 0.05
        with self.assertRaisesRegex(ValueError, "Lighter position differs from the bot's persisted fills; reconciliation required"):
            await self.bot.toggle(True)
        self.assertFalse(self.bot.state["enabled"])
        self.assertTrue(self.bot.state["recovery_required"])
        self.assertTrue(self.bot.state["execution_blocked"])
        self.assertIn("reconciliation required", self.bot.state["blocked_reason"])

        reconcile_res = await self.bot.reconcile()
        self.assertFalse(self.bot.state["recovery_required"])
        self.assertFalse(self.bot.state["execution_blocked"])
        self.assertEqual(len(self.bot.state["tranches"]), 1)
        self.assertAlmostEqual(self.bot.state["tranches"][0]["qty"], 0.05)
        # Execution history should now reflect the reconciled entry
        self.assertEqual(len(self.bot.state["execution_history"]), 1)
        entry = self.bot.state["execution_history"][0]
        self.assertEqual(entry["event"], "ENTRY")
        self.assertEqual(entry["side"], 1)
        self.assertAlmostEqual(entry["qty"], 0.05)
        self.assertEqual(entry["reason"], "exchange_reconciliation")

    async def test_reconciled_public_state_parses_exchange_trades(self):
        self.client.trades = [
            {
                "trade_id": 101,
                "trade_id_str": "101",
                "market_id": 1,
                "size": "0.00013",
                "price": "81500.0",
                "usd_amount": "10.595",
                "bid_account_id": 749609,
                "ask_account_id": 27927,
                "timestamp": 1792236000000,
                "taker_fee": "500",
            },
            {
                "trade_id": 102,
                "trade_id_str": "102",
                "market_id": 1,
                "size": "0.00013",
                "price": "81600.0",
                "usd_amount": "10.608",
                "bid_account_id": 27927,
                "ask_account_id": 749609,
                "timestamp": 1792236600000,
                "ask_account_pnl": "0.013",
                "taker_fee": "500",
                "taker_position_size_before": "0.00013",
                "taker_entry_quote_before": "10.595",
            },
        ]
        state = await self.bot.reconciled_public_state()
        history = state["execution_history"]
        self.assertEqual(len(history), 2)
        entry = history[0]
        self.assertEqual(entry["event"], "ENTRY")
        self.assertEqual(entry["side"], 1)
        self.assertEqual(entry["order_id"], "101")
        self.assertAlmostEqual(entry["price"], 81500.0)

        exit_evt = history[1]
        self.assertEqual(exit_evt["event"], "EXIT")
        self.assertEqual(exit_evt["side"], -1)
        self.assertEqual(exit_evt["original_side"], 1)
        self.assertEqual(exit_evt["order_id"], "102")
        self.assertTrue(exit_evt["pnl_authoritative"])
        self.assertAlmostEqual(exit_evt["net_pnl_usd"], 0.013)
        self.assertAlmostEqual(exit_evt["entry_price"], 81500.0)
        self.assertEqual(state["verified_exit_count"], 1)
        self.assertAlmostEqual(state["verified_realized_pnl_usd"], 0.013)


if __name__ == "__main__":
    unittest.main()

