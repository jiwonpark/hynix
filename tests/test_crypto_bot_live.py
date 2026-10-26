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
            if params.get("interval") == "1h":
                latest_close_ms = int(self.klines[-1][6])
                return [
                    [latest_close_ms - (124 - index) * 3600_000 - 3600_000 + 1,
                     "100", "100", "100", "100", "1",
                     latest_close_ms - (124 - index) * 3600_000]
                    for index in range(125)
                ]
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

    async def test_config_is_persisted_and_all_testable_strategies_deployable(self):
        await self.bot.configure({"entry_z": 2.0, "selected_symbol": "BTCUSDT"})
        restored = CryptoBot(self.client, self.path)
        self.assertEqual(restored.state["entry_z"], 2.0)
        self.assertFalse(restored.state["enabled"])
        for strat in ["adaptive_tranche", "ou_quant", "ma_stack", "multi_factor", "trend_pullback", "custom", "grid"]:
            await self.bot.configure({"strategy_mode": strat})
            self.assertEqual(self.bot.state["strategy_mode"], strat)
        with self.assertRaisesRegex(ValueError, "Unsupported live strategy"):
            await self.bot.configure({"strategy_mode": "unsupported_unknown"})

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
        self.assertTrue(restored.state["enabled"])
        self.assertTrue(restored.state["execution_blocked"])
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

    async def test_startup_auto_reconciles_filled_exit_after_lost_response(self):
        await self.bot.manual_entry(1, 50)
        self.client.fail_after_fill = True
        with self.assertRaisesRegex(TimeoutError, "response lost after fill"):
            await self.bot.manual_reduce()

        restored = CryptoBot(self.client, self.path)
        self.assertIsNotNone(restored.state["pending_order"])
        await restored.verify_startup()

        self.assertIsNone(restored.state["pending_order"])
        self.assertEqual(restored.state["tranches"], [])
        self.assertFalse(restored.state["recovery_required"])
        self.assertFalse(restored.state["execution_blocked"])
        self.assertEqual(restored.state["execution_history"][-1]["event"], "EXIT")
        self.assertEqual(len(self.client.orders), 2)

    async def test_startup_keeps_ambiguous_pending_order_blocked(self):
        self.bot.state["enabled"] = True
        self.bot.state["pending_order"] = {
            "client_order_id": "hxcryptoambiguous", "symbol": "BTCUSDT",
            "side": 1, "qty": "0.500", "reduce_only": False,
            "reason": "closed_bar_signal", "created_at": 1,
        }
        self.bot._save()
        self.client.last_order = {
            "status": "PARTIALLY_FILLED", "executedQty": "0.100",
            "avgPrice": "100.01", "orderId": 99,
        }

        restored = CryptoBot(self.client, self.path)
        await restored.verify_startup()

        self.assertTrue(restored.state["recovery_required"])
        self.assertTrue(restored.state["execution_blocked"])
        self.assertIsNotNone(restored.state["pending_order"])

    async def test_create_order_polls_if_initial_response_not_filled(self):
        # Initial response has status NEW and 0 avgPrice, polling returns FILLED
        orig_create = self.client.create_order
        async def create_new(symbol, side, qty, order_type, **options):
            await orig_create(symbol, side, qty, order_type, **options)
            return {"status": "NEW", "executedQty": "0.0", "avgPrice": "0.0", "orderId": 999}
        self.client.create_order = create_new
        event = await self.bot.manual_entry(1, 50)
        self.assertEqual(event["event"], "ENTRY")
        self.assertEqual(len(self.bot.state["tranches"]), 1)
        self.assertFalse(self.bot.state["recovery_required"])

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
            "backend.crypto_bot.evaluate_strategy_signal",
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
            "backend.crypto_bot.evaluate_strategy_signal",
            return_value=(True, 1, False, {"mean": 100, "z": -2, "ratio": 100}),
        ):
            await self.bot.run_once()
            await self.bot.run_once()
        self.assertEqual(len(self.client.orders), 1)
        self.assertEqual(self.bot.state["last_evaluated_candle"], last_open)

    async def test_opposite_signal_closes_then_reverses_instead_of_blocking(self):
        now = 1000030
        last_open = 999960
        self.client.klines = [
            [int((last_open - (24 - i) * 60) * 1000), "100", "100", "100", "100", "1",
             int((last_open - (24 - i) * 60 + 60) * 1000 - 1)]
            for i in range(25)
        ]
        self.client.amount = 0.5
        self.bot.state.update(
            enabled=True, strategy_interval="1m", strategy_mode="grid",
            tranches=[{"side": 1, "qty": 0.5, "price": 100.0, "order_id": "old", "time": 1}],
        )
        evaluation = {"strategy": "grid", "condition_pass": {}}
        with patch("backend.crypto_bot.time.time", return_value=now), patch(
            "backend.crypto_bot.evaluate_strategy_signal",
            side_effect=[(True, -1, False, evaluation), (True, -1, False, evaluation)],
        ):
            await self.bot.run_once()

        self.assertEqual(len(self.client.orders), 2)
        self.assertTrue(self.client.orders[0][3]["reduce_only"])
        self.assertFalse(self.client.orders[1][3]["reduce_only"])
        self.assertEqual(self.bot.state["tranches"][-1]["side"], -1)
        self.assertEqual(self.bot.state["execution_history"][-2]["reason"], "opposite_signal_reversal")
        self.assertEqual(self.bot.state["execution_history"][-1]["reason"], "reversal_entry")

    async def test_all_strategies_evaluate_in_live_worker(self):
        now = 1000030
        last_open = 999960
        # 70 candles to satisfy 65 candle requirement for ma_stack and ou_quant
        self.client.klines = [
            [int((last_open - (69 - i) * 60) * 1000), "100", "100", "100", "100", "1",
             int((last_open - (69 - i) * 60 + 60) * 1000 - 1)]
            for i in range(70)
        ]
        self.bot.state["enabled"] = True
        self.bot.state["strategy_interval"] = "1m"
        for strat in ["adaptive_tranche", "ou_quant", "ma_stack", "multi_factor", "trend_pullback", "custom", "grid"]:
            self.bot.state["strategy_mode"] = strat
            self.bot.state["last_evaluated_candle"] = 0
            with patch("backend.crypto_bot.time.time", return_value=now):
                await self.bot.run_once()
            self.assertEqual(self.bot.state["last_evaluated_candle"], last_open)
            self.assertIsNotNone(self.bot.state["last_evaluation"])
            self.assertEqual(self.bot.state["last_evaluation"]["strategy"], strat)

    async def test_grid_respects_user_condition_switches(self):
        from backend.lighter_strategy import evaluate_strategy_signal
        prices = [100.0 + (i % 3 - 1) * 0.5 for i in range(30)]
        prices[-1] = 90.0
        # When use_base_spacing is True and spacing distance not satisfied, entry is blocked
        entry, side, exit_sig, eval_info = evaluate_strategy_signal(
            "adaptive_tranche", prices,
            {"entry_z": 1.5, "exit_z": 0.25, "use_base_spacing": True, "use_peak": False, "base_spacing_pct": 5.0},
            position_side=1, entry_price=92.0, held_bars=1,
        )
        self.assertFalse(entry)
        self.assertFalse(eval_info["condition_pass"]["entry_spacing"])

        # When use_base_spacing is False, spacing is bypassed
        entry, side, exit_sig, eval_info = evaluate_strategy_signal(
            "adaptive_tranche", prices,
            {"entry_z": 1.5, "exit_z": 0.25, "use_base_spacing": False, "use_peak": False, "base_spacing_pct": 5.0},
            position_side=1, entry_price=92.0, held_bars=1,
        )
        self.assertTrue(entry)
        self.assertTrue(eval_info["condition_pass"]["entry_spacing"])

    async def test_adaptive_tranche_grid_uses_full_chart_ma_stack(self):
        from backend.lighter_strategy import evaluate_strategy_signal

        prices = [160.0 - i for i in range(60)]
        entry, side, _, evaluation = evaluate_strategy_signal(
            "adaptive_tranche", prices,
            {"entry_z": 1.5, "exit_z": 0.25,
             "use_ma_stretch": False, "use_base_spacing": False,
             "use_peak": False, "use_ma_stack": True,
             "use_ma_stack_1h": False, "use_convergence": False,
             "use_dwell": False, "use_bottoming": False},
        )

        self.assertTrue(entry)
        self.assertEqual(side, 1)
        self.assertTrue(evaluation["bearish_stack"])
        self.assertTrue(
            prices[-1] < evaluation["ma7"] < evaluation["ma24"] < evaluation["ma60"]
        )
        self.assertTrue(evaluation["condition_pass"]["entry_ma_stack"])


if __name__ == "__main__":
    unittest.main()
