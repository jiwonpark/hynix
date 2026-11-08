import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

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
        self.min_base_amount = "0.001"
        self.min_quote_amount = "10"

    async def market_detail(self, market_id, *, fresh=False):
        return {"market_id": market_id, "symbol": "BTC", "market_type": "perp",
                "status": "active", "supported_size_decimals": 3,
                "min_base_amount": self.min_base_amount,
                "min_quote_amount": self.min_quote_amount}

    async def account_status(self):
        return {"authenticated": True, "execution_enabled": True,
                "collateral": self.collateral}

    async def positions(self, *, fresh=False):
        rows = copy.deepcopy(self.extra_positions)
        if self.amount:
            rows.append({"market_id": 1, "position": str(abs(self.amount)),
                         "sign": 1 if self.amount > 0 else -1,
                         "position_value": str(abs(self.amount) * 100),
                         "allocated_margin": str(abs(self.amount) * 10)})
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

    async def account_trades(self, market_id, limit=100, *, strict=False):
        return getattr(self, "trades", [])

    async def candles(self, market_id, interval, limit, *, fresh=False):
        if interval == "1h":
            latest_open_ms = int(self.candle_rows[-1]["t"])
            return [{"t": latest_open_ms - (124 - index) * 3600_000, "c": 100.0}
                    for index in range(125)]
        return self.candle_rows[-limit:]

    async def execution_fill(self, index, market_id, expected_size):
        return self.orders.get(index, {"fill_confirmed": False})


class TestLighterCryptoBot(unittest.IsolatedAsyncioTestCase):
    async def test_paused_histogram_strategy_switch_preserves_inventory(self):
        bot = self.bot
        bot.state.update(strategy_mode="macd_zero_cross", enabled=False,
                         tranches=[{"id": "existing", "side": -1, "qty": .0039,
                                    "entry_price": 77078.3, "entry_fee_usd": .01}],
                         execution_history=[{"event": "ENTRY", "id": "existing"}])
        inventory = copy.deepcopy(bot.state["tranches"])
        history = copy.deepcopy(bot.state["execution_history"])
        for mode in ("macd_hist_turn", "macd_zero_cross"):
            await bot.configure({"strategy_mode": mode})
            restored = LighterCryptoBot(self.client, self.path)
            self.assertEqual(restored.state["strategy_mode"], mode)
            self.assertEqual(restored.state["tranches"], inventory)
            self.assertEqual(restored.state["execution_history"], history)
            self.assertFalse(restored.state["enabled"])
        self.assertFalse(self.client.orders)
        for values, message in [({"strategy_mode": "grid"}, "Close tracked inventory"),
                                ({"selected_symbol": "ETH"}, "Close tracked inventory")]:
            with self.assertRaisesRegex(ValueError, message):
                await bot.configure(values)
        for safeguard in ("pending_order", "recovery_required"):
            bot.state[safeguard] = {"id": "unresolved"} if safeguard == "pending_order" else True
            with self.assertRaisesRegex(ValueError, "Resolve pending orders"):
                await bot.configure({"strategy_mode": "macd_hist_turn"})
            bot.state[safeguard] = None if safeguard == "pending_order" else False
        bot.state["enabled"] = True
        with self.assertRaisesRegex(ValueError, "Pause"):
            await bot.configure({"strategy_mode": "macd_hist_turn"})
        self.assertEqual(bot.state["tranches"], inventory)

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "lighter_crypto_bot_state.json"
        self.client = FakeLighter()
        self.bot = LighterCryptoBot(self.client, self.path)
        # These execution tests isolate their existing rules; hourly gate has its own suite.
        self.bot.state["use_hourly_hist"] = False
        self.bot._save()

    async def test_hourly_macro_period_default_and_persistence(self):
        bot = self.bot
        self.assertEqual(bot.public_state()["strategy_params"]["macro_ma_period"], 60)
        await bot.configure({"macro_ma_period": 24})
        restored = LighterCryptoBot(self.client, bot.state_path)
        self.assertEqual(restored.public_state()["strategy_params"]["macro_ma_period"], 24)
        for value in [1, 121, 7.5, True]:
            with self.assertRaises(ValueError):
                await bot.configure({"macro_ma_period": value})

    async def test_paused_macd_bot_refreshes_read_only_conditions_without_orders(self):
        now = 1000030
        last_open = 999960
        self.client.candle_rows = [
            {"t": int((last_open - (129 - index) * 60) * 1000), "c": 100.0}
            for index in range(130)
        ]
        self.bot.state.update(enabled=False, strategy_interval="1m", strategy_mode="macd_hist_turn")
        original_executed_candle = self.bot.state["last_evaluated_candle"]
        evaluation = {"strategy": "macd_hist_turn", "time": last_open, "condition_pass": {}}
        with patch("backend.lighter_crypto_bot.time.time", return_value=now), patch.object(
            self.bot, "refresh_hourly_histogram", AsyncMock(return_value=None)
        ), patch.object(
            self.bot, "refresh_five_minute_macd_signal", AsyncMock(return_value=None)
        ), patch(
            "backend.lighter_crypto_bot.evaluate_strategy_signal",
            return_value=(False, -1, False, evaluation),
        ):
            await self.bot.run_once()
        self.assertTrue(self.bot.state["last_evaluation"]["execution_paused"])
        self.assertEqual(self.bot.state["last_evaluation"]["strategy"], "macd_hist_turn")
        self.assertEqual(self.bot.state["last_evaluated_candle"], original_executed_candle)
        self.assertEqual(self.client.orders, {})

    async def test_macd_replay_draft_is_server_persisted_without_changing_live_config(self):
        live_before = dict(self.bot.public_state()["strategy_params"])
        state = await self.bot.save_strategy_draft("macd_reversal", {
            "macd_fast_period": 7, "macd_slow_period": 19, "macd_signal_period": 4,
        })
        self.assertEqual(state["strategy_drafts"]["macd_reversal"]["macd_fast_period"], 7)
        self.assertEqual(state["strategy_params"], live_before)
        restored = LighterCryptoBot(self.client, self.path)
        self.assertEqual(restored.public_state()["strategy_drafts"]["macd_reversal"], {
            "macd_fast_period": 7, "macd_slow_period": 19, "macd_signal_period": 4,
        })
        with self.assertRaisesRegex(ValueError, "greater than fast"):
            await self.bot.save_strategy_draft("macd_reversal", {
                "macd_fast_period": 19, "macd_slow_period": 7, "macd_signal_period": 4,
            })

    async def test_independent_paused_state_and_config(self):
        self.assertFalse(self.bot.state["enabled"])
        self.assertEqual(self.bot.state["selected_symbol"], "BTC")
        await self.bot.configure({"entry_z": 2.0, "max_tranches": 3})
        restored = LighterCryptoBot(self.client, self.path)
        self.assertEqual(restored.state["entry_z"], 2.0)
        for strat in ["adaptive_tranche", "ou_quant", "ma_stack", "multi_factor", "trend_pullback", "custom", "grid"]:
            await self.bot.configure({"strategy_mode": strat})
            self.assertEqual(self.bot.state["strategy_mode"], strat)
        configured = await self.bot.configure({
            "strategy_mode": "adaptive_tranche", "entry_z": 1.8, "exit_z": 0.2,
            "base_spacing_pct": 0.35, "min_dwell_bars": 6,
        })
        self.assertEqual(configured["strategy_params"]["base_spacing_pct"], 0.35)
        self.assertEqual(configured["strategy_params"]["min_dwell_bars"], 6)
        with self.assertRaisesRegex(ValueError, "Unsupported live strategy"):
            await self.bot.configure({"strategy_mode": "unsupported_unknown"})

    async def test_auto_entry_direction_is_validated_and_persisted(self):
        for mode in ("two_way", "long_only", "short_only"):
            await self.bot.configure({"entry_direction_mode": mode})
            restored = LighterCryptoBot(self.client, self.path)
            self.assertEqual(restored.state["entry_direction_mode"], mode)
        with self.assertRaisesRegex(ValueError, "entry_direction_mode must be one of"):
            await self.bot.configure({"entry_direction_mode": "short_spread_only"})

    async def test_foreign_same_market_position_blocks_entry(self):
        self.client.amount = 0.5
        with self.assertRaisesRegex(ValueError, "differs"):
            await self.bot.manual_entry(1, 50)
        self.assertEqual(self.client.orders, {})

    async def test_account_wide_exposure_blocks_entry(self):
        # Unrelated market position (SKHY market 216) with sufficient free margin does not block BTC 8.0x cap
        self.client.extra_positions = [{"market_id": 216, "position": "5", "sign": 1,
                                        "position_value": "970", "allocated_margin": "97"}]
        entry = await self.bot.manual_entry(1, 50)
        self.assertEqual(entry["event"], "ENTRY")
        # Same-market (BTC market 1) gross exposure exceeding 8.0x collateral cap blocks entry
        self.client.extra_positions = []
        self.client.collateral = 12.0
        with self.assertRaisesRegex(ValueError, "Selected-contract gross exposure"):
            await self.bot.manual_entry(1, 50)

    async def test_buffer_applies_to_estimated_margin_not_order_notional(self):
        self.client.collateral = 170.0
        entry = await self.bot.manual_entry(1, 150.0)
        self.assertEqual(entry["event"], "ENTRY")
        self.assertAlmostEqual(entry["notional_usd"], 150.015)
        self.assertEqual(len(self.client.orders), 1)

    async def test_scaleout_reduces_tracked_inventory_without_popping_it(self):
        await self.bot.configure({"strategy_mode": "macd_strength_scaleout"})
        await self.bot.manual_entry(1, 100)
        original = self.bot.state["tranches"][0]["qty"]
        event = await self.bot._submit(-1, 0, reduce_only=True,
                                       reason="macd_first_peak_exit",
                                       reduce_fraction=0.5, exit_stage_after=1)
        self.assertEqual(event["event"], "EXIT")
        self.assertEqual(self.bot.state["macd_exit_stage"], 1)
        self.assertEqual(len(self.bot.state["tranches"]), 1)
        self.assertAlmostEqual(self.bot.state["tranches"][0]["qty"], original - event["qty"])
        await self.bot._submit(-1, 0, reduce_only=True,
                               reason="macd_final_peak_exit", exit_stage_after=0)
        self.assertEqual(self.bot.state["tranches"], [])
        self.assertEqual(self.bot.state["macd_exit_stage"], 0)

    async def test_projected_account_wide_gross_cap_blocks_entry(self):
        self.client.collateral = 15.0
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
        self.client.collateral = 15.0
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

    async def test_entry_signal_builds_target_position_in_rate_limited_pieces(self):
        last_open = 999960
        self.client.candle_rows = [
            {"t": int((last_open - (24 - index) * 60) * 1000), "c": 100.0}
            for index in range(25)
        ]
        self.bot.state.update(
            enabled=True,
            strategy_interval="1m",
            strategy_mode="grid",
            notional_usd=100.0,
            max_tranches=3,
            min_seconds_between_orders=10,
        )
        evaluation = {"strategy": "grid", "condition_pass": {}}
        with patch("backend.lighter_crypto_bot.time.time", return_value=1000030), patch(
            "backend.lighter_crypto_bot.evaluate_strategy_signal",
            side_effect=[(True, 1, False, evaluation), (True, 1, False, evaluation)],
        ):
            await self.bot.run_once()

        self.assertEqual(len(self.bot.state["tranches"]), 1)
        self.assertEqual(self.bot.state["entry_campaign"]["slices_filled"], 1)
        self.assertEqual(self.bot.state["execution_history"][-1]["reason"], "closed_bar_signal")

        self.bot = LighterCryptoBot(self.client, self.path)
        self.assertEqual(self.bot.state["entry_campaign"]["slices_filled"], 1)
        with patch("backend.lighter_crypto_bot.time.time", return_value=1000040):
            await self.bot.run_once()
        self.assertEqual(len(self.bot.state["tranches"]), 2)
        self.assertEqual(self.bot.state["execution_history"][-1]["reason"], "signal_campaign_slice")

        with patch("backend.lighter_crypto_bot.time.time", return_value=1000050):
            await self.bot.run_once()
        self.assertEqual(len(self.bot.state["tranches"]), 3)
        self.assertIsNone(self.bot.state["entry_campaign"])
        self.assertEqual(self.bot.state["last_entry_campaign"]["status"], "target_reached")
        self.assertEqual(self.bot.state["last_entry_campaign"]["slices_filled"], 3)
        self.assertEqual(len(self.client.orders), 3)

    async def test_pausing_bot_cancels_active_entry_campaign(self):
        self.bot.state.update(
            enabled=True,
            entry_campaign={
                "campaign_id": "signal-1",
                "side": 1,
                "signal_time": 100,
                "started_at": 100,
                "slice_notional_usd": 100.0,
                "target_slices": 5,
                "slices_filled": 1,
                "status": "active",
            },
        )

        state = await self.bot.toggle(False)

        self.assertFalse(state["enabled"])
        self.assertIsNone(state["entry_campaign"])
        self.assertEqual(state["last_entry_campaign"]["status"], "bot_paused")

    async def test_opposite_signal_closes_then_reverses_instead_of_blocking(self):
        now = 1000030
        last_open = 999960
        self.client.candle_rows = [
            {"t": int((last_open - (24 - index) * 60) * 1000), "c": 100.0}
            for index in range(25)
        ]
        self.client.amount = 0.5
        self.bot.state.update(
            enabled=True, strategy_interval="1m", strategy_mode="grid",
            tranches=[{"side": 1, "qty": 0.5, "price": 100.0,
                       "fee_usd": 0.0, "order_id": "old", "time": 1}],
        )
        evaluation = {"strategy": "grid", "condition_pass": {}}
        with patch("backend.lighter_crypto_bot.time.time", return_value=now), patch(
            "backend.lighter_crypto_bot.evaluate_strategy_signal",
            side_effect=[(True, -1, False, evaluation), (True, -1, False, evaluation)],
        ):
            await self.bot.run_once()

        events = self.bot.state["execution_history"]
        self.assertEqual(events[-2]["reason"], "opposite_signal_reversal")
        self.assertEqual(events[-1]["reason"], "reversal_entry")
        self.assertEqual(self.bot.state["tranches"][-1]["side"], -1)

    async def test_worker_preserves_signal_but_blocks_disallowed_entry_direction(self):
        now = 1000030
        last_open = 999960
        self.client.candle_rows = [
            {"t": int((last_open - (24 - index) * 60) * 1000), "c": 100.0}
            for index in range(25)
        ]
        self.bot.state.update(enabled=True, strategy_interval="1m", entry_direction_mode="short_only")
        with patch("backend.lighter_crypto_bot.time.time", return_value=now), patch(
            "backend.lighter_crypto_bot.evaluate_strategy_signal",
            return_value=(True, 1, False, {"mean": 100, "z": -2, "ratio": 100}),
        ):
            await self.bot.run_once()
        self.assertEqual(self.client.orders, {})
        self.assertFalse(self.bot.state["last_evaluation"]["entry_direction_allowed"])
        self.assertEqual(self.bot.state["last_evaluated_candle"], last_open)

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

    async def test_manual_reduce_merges_latest_dust_with_previous_lifo_tranche(self):
        self.client.min_base_amount = "0.01"
        self.client.amount = 0.105
        self.bot.state["tranches"] = [
            {"side": 1, "qty": 0.1, "price": 90.0, "fee_usd": 0.01,
             "order_id": "older", "time": 1},
            {"side": 1, "qty": 0.005, "price": 95.0, "fee_usd": 0.001,
             "order_id": "dust", "time": 2},
        ]

        event = await self.bot.manual_reduce()

        self.assertEqual(event["event"], "EXIT")
        self.assertEqual(event["matched_tranches"], 2)
        self.assertEqual(event["entry_order_ids"], ["dust", "older"])
        self.assertAlmostEqual(event["qty"], 0.105)
        self.assertEqual(self.bot.state["tranches"], [])
        self.assertAlmostEqual(self.client.amount, 0.0)
        self.assertIsNone(self.bot.state["pending_order"])
        self.assertFalse(self.bot.state["recovery_required"])

    async def test_active_bot_is_paused_reconciled_then_manually_reduced(self):
        self.client.amount = 0.5
        self.bot.state["enabled"] = True
        self.bot.state["tranches"] = [
            {"side": 1, "qty": 0.5, "price": 95.0, "fee_usd": 0.0,
             "order_id": "active", "time": 1},
        ]

        result = await self.bot.pause_reconcile_and_reduce()

        self.assertTrue(result["bot_was_paused"])
        self.assertEqual(result["event"]["event"], "EXIT")
        self.assertFalse(self.bot.state["enabled"])
        self.assertFalse(self.bot.state["recovery_required"])
        self.assertIsNone(self.bot.state["pending_order"])
        self.assertEqual(self.bot.state["tranches"], [])
        self.assertAlmostEqual(self.client.amount, 0.0)

    async def test_unreducible_dust_fails_before_pending_order(self):
        self.client.min_base_amount = "0.01"
        self.client.amount = 0.005
        self.bot.state["tranches"] = [
            {"side": 1, "qty": 0.005, "price": 95.0, "fee_usd": 0.0,
             "order_id": "dust", "time": 1},
        ]

        with self.assertRaisesRegex(ValueError, "below the Lighter minimum reduction size"):
            await self.bot.manual_reduce()

        self.assertEqual(self.client.orders, {})
        self.assertIsNone(self.bot.state["pending_order"])
        self.assertFalse(self.bot.state["recovery_required"])
        self.assertFalse(self.bot.state["execution_blocked"])

    async def test_client_minimum_preflight_rejection_does_not_require_recovery(self):
        self.client.amount = 0.1
        self.bot.state["tranches"] = [
            {"side": 1, "qty": 0.1, "price": 95.0, "fee_usd": 0.0,
             "order_id": "latest", "time": 1},
        ]
        self.client.create_market_order = AsyncMock(
            side_effect=ValueError("Lighter market 1 order is below its minimum size")
        )

        with self.assertRaisesRegex(ValueError, "below its minimum size"):
            await self.bot.manual_reduce()

        self.assertIsNone(self.bot.state["pending_order"])
        self.assertFalse(self.bot.state["recovery_required"])
        self.assertFalse(self.bot.state["execution_blocked"])
        self.assertIn("below its minimum size", self.bot.state["last_error"])

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

    async def test_reconciled_history_merges_local_exit_with_authoritative_fill(self):
        self.bot.state["execution_history"] = [{
            "event": "EXIT", "symbol": "BTC", "market_id": 1,
            "side": -1, "original_side": 1, "qty": 0.00064,
            "price": 78311.1, "entry_price": 78150.5,
            "time": 1793608844, "order_id": "145479957454881",
            "client_order_index": 145479957454881,
            "reason": "net_take_profit", "pnl_authoritative": False,
            "pnl_source": "ESTIMATED_EX_FUNDING", "net_pnl_usd": 0.102784,
        }]
        self.client.trades = [{
            "trade_id": 37639943466, "trade_id_str": "37639943466",
            "market_id": 1, "size": "0.00064", "price": "78311.1",
            "usd_amount": "50.119104", "bid_account_id": 27927,
            "ask_account_id": 749609, "timestamp": 1793608844000,
            "ask_account_pnl": "0.102784", "taker_fee": "0",
            "taker_position_size_before": "0.00064",
            "taker_entry_quote_before": "50.01632",
        }]

        state = await self.bot.reconciled_public_state()

        self.assertEqual(len(state["execution_history"]), 1)
        event = state["execution_history"][0]
        self.assertEqual(event["order_id"], "145479957454881")
        self.assertEqual(event["exchange_trade_id"], "37639943466")
        self.assertEqual(event["client_order_index"], 145479957454881)
        self.assertEqual(event["reason"], "net_take_profit")
        self.assertTrue(event["pnl_authoritative"])
        self.assertEqual(event["pnl_source"], "LIGHTER_REALIZED_PNL")
        self.assertEqual(state["verified_exit_count"], 1)

    def test_reconciled_history_fallback_is_strict_and_one_to_one(self):
        exchange = [{
            "event": "EXIT", "symbol": "BTC", "side": -1,
            "qty": 0.001, "price": 100.0, "time": 100,
            "order_id": "trade-1", "pnl_authoritative": True,
        }]
        local = [
            {"event": "EXIT", "symbol": "BTC", "side": -1, "qty": 0.001,
             "price": 100.0, "time": 100, "order_id": "local-1"},
            {"event": "EXIT", "symbol": "BTC", "side": -1, "qty": 0.001,
             "price": 100.0, "time": 100, "order_id": "local-2"},
            {"event": "EXIT", "symbol": "BTC", "side": -1, "qty": 0.002,
             "price": 100.0, "time": 100, "order_id": "different-qty"},
        ]

        merged = self.bot._merge_execution_history(exchange, local)

        self.assertEqual(len(merged), 3)
        self.assertEqual(sum(1 for event in merged if event.get("exchange_trade_id") == "trade-1"), 1)
        self.assertIn("different-qty", {event.get("order_id") for event in merged})

    async def test_native_partial_fills_verify_tranche_basis_by_own_client_ids(self):
        self.bot.state['execution_history'] = [dict(event='EXIT', symbol='BTC', side=-1,
            qty=1, price=110, entry_price=100, entry_order_id='1001', order_id='2001',
            client_order_index=2001, matched_tranches=1, time=200, pnl_authoritative=False)]
        self.client.trades = [dict(trade_id=1, market_id=1, bid_account_id=749609,
            ask_account_id=8, bid_client_id_str='1001', ask_client_id_str='other',
            size='1', price='100', timestamp=100000, taker_fee='0')]
        for i, qty in enumerate((.2,.3,.5)):
            self.client.trades.append(dict(trade_id=10+i, market_id=1, bid_account_id=8,
                ask_account_id=749609, bid_client_id_str='other', ask_client_id_str='2001',
                size=str(qty), price='110', timestamp=200000+i, ask_account_pnl=str(qty*5), taker_fee='0'))
        state = await self.bot.reconciled_public_state()
        exits = [e for e in state['execution_history'] if e['event']=='EXIT']
        self.assertEqual(len(exits),1)
        event=exits[0]
        self.assertEqual(event['qty'],1)
        self.assertEqual(len(event['exchange_trade_ids']),3)
        self.assertEqual(event['entry_price'],100)
        self.assertAlmostEqual(event['net_pnl_usd'],10)
        self.assertAlmostEqual(event['exchange_account_pnl_usd'],5)
        self.assertEqual(event['pnl_source'],'LIGHTER_VERIFIED_TRANCHE_FILLS')

    async def test_trade_history_failure_is_not_a_verified_empty_history(self):
        self.client.account_trades = AsyncMock(side_effect=RuntimeError('history unavailable'))
        with self.assertRaisesRegex(RuntimeError,'history unavailable'):
            await self.bot.reconciled_public_state()

    def test_missing_entry_fills_does_not_substitute_account_average_pnl(self):
        local = [dict(event='EXIT',symbol='BTC',side=-1,qty=1,price=110,entry_price=100,
            entry_order_id='entry',order_id='exit',client_order_index='exit',time=100,
            net_pnl_usd=10,gross_pnl_usd=10,pnl_authoritative=False)]
        exchange = [dict(event='EXIT',symbol='BTC',side=-1,qty=1,price=110,entry_price=105,
            exchange_client_order_index='exit',order_id='trade',time=100,net_pnl_usd=5,
            gross_pnl_usd=5,pnl_authoritative=True)]
        row = self.bot._merge_execution_history(exchange,local)[0]
        self.assertFalse(row['pnl_authoritative'])
        self.assertEqual(row['entry_price'],100)
        self.assertEqual(row['net_pnl_usd'],10)
        self.assertEqual(row['exchange_account_pnl_usd'],5)

    async def test_ma_stack_condition_toggles(self):
        from backend.lighter_strategy import evaluate_strategy_signal
        # 65 bars with bearish stack (Price < MA7 < MA24 < MA60)
        prices = [100.0 - i * 0.1 for i in range(60)] + [93.0, 92.0, 91.0, 90.0, 89.0]
        # With stretch on and use_ma_stack_1h off (macro filter bypassed)
        entry, side, exit_sig, eval_data = evaluate_strategy_signal(
            "ma_stack", prices,
            {"use_ma_stretch": True, "use_ma_stack": True, "use_ma_stack_1h": False,
             "ma_stretch_min": 0.30, "ma_trailing_stop": 0.15,
             "use_convergence": True, "use_dwell": True, "use_bottoming": False}
        )
        self.assertEqual(side, 1)
        self.assertTrue(entry)
        self.assertTrue(eval_data["condition_pass"]["entry_stretch"])
        self.assertTrue(eval_data["condition_pass"]["entry_ma_stack"])

        # When use_ma_stretch is False, stretch is bypassed even if stretch_min is impossibly high
        entry_bypassed, _, _, _ = evaluate_strategy_signal(
            "ma_stack", prices,
            {"use_ma_stretch": False, "use_ma_stack": True, "use_ma_stack_1h": False,
             "ma_stretch_min": 99.0, "use_convergence": True, "use_dwell": True}
        )
        self.assertTrue(entry_bypassed)

        # When use_ma_stretch is True with impossibly high threshold, entry is blocked
        entry_blocked, _, _, _ = evaluate_strategy_signal(
            "ma_stack", prices,
            {"use_ma_stretch": True, "use_ma_stack": True, "use_ma_stack_1h": False,
             "ma_stretch_min": 99.0, "use_convergence": True, "use_dwell": True}
        )
        self.assertFalse(entry_blocked)

        # Exit signal toggles: test dwell exit toggling
        # position_side=1, held_bars=16: with use_dwell=True -> exit=True; with use_dwell=False and use_convergence=False -> exit=False
        _, _, exit_dwell_on, _ = evaluate_strategy_signal(
            "ma_stack", prices,
            {"use_convergence": False, "use_dwell": True, "use_bottoming": False},
            position_side=1, entry_price=90.0, held_bars=16
        )
        self.assertTrue(exit_dwell_on)

        _, _, exit_dwell_off, _ = evaluate_strategy_signal(
            "ma_stack", prices,
            {"use_convergence": False, "use_dwell": False, "use_bottoming": False},
            position_side=1, entry_price=90.0, held_bars=16
        )
        self.assertFalse(exit_dwell_off)

    async def test_ma_stack_uses_same_completed_candle_ma_as_chart(self):
        from backend.lighter_strategy import evaluate_strategy_signal

        # The final completed close creates a bullish Price > MA7 > MA24 > MA60
        # stack only when that same close is included, matching chart overlays.
        prices = [100.0] * 60 + [110.0]
        entry, side, _, evaluation = evaluate_strategy_signal(
            "ma_stack", prices,
            {"use_ma_stretch": False, "use_ma_stack": True, "use_ma_stack_1h": False,
             "use_convergence": False, "use_dwell": False, "use_bottoming": False},
        )
        self.assertTrue(entry)
        self.assertEqual(side, -1)
        self.assertTrue(evaluation["condition_pass"]["entry_ma_stack"])
        self.assertAlmostEqual(evaluation["ma7"], (600.0 + 110.0) / 7, places=4)
        self.assertAlmostEqual(evaluation["ma24"], (2300.0 + 110.0) / 24, places=4)
        self.assertAlmostEqual(evaluation["ma60"], (5900.0 + 110.0) / 60, places=4)

    async def test_tab5_ma_stack_uses_bearish_entry_and_inverse_stack_exit_only(self):
        from backend.lighter_strategy import evaluate_strategy_signal

        bearish = [160.0 - i for i in range(61)]
        entry, side, no_exit, entry_eval = evaluate_strategy_signal(
            "ma_stack", bearish,
            {"ma_stack_opposite_only": True, "use_ma_stack": True,
             "use_opposite_stack_exit": True, "use_ma_stretch": True,
             "use_ma_stack_1h": True, "use_convergence": True,
             "use_dwell": True, "use_bottoming": True},
        )
        self.assertTrue(entry)
        self.assertEqual(side, 1)
        self.assertFalse(no_exit)
        self.assertEqual(set(entry_eval["condition_pass"]),
                         {"entry_ma_stack", "exit_opposite_stack", "entry_ma_diff_hook", "exit_ma_diff_hook"})
        self.assertIsNone(entry_eval["condition_pass"]["entry_ma_diff_hook"])
        self.assertIsNone(entry_eval["condition_pass"]["exit_ma_diff_hook"])

        bullish = [100.0 + i for i in range(61)]
        blocked_short, side, exit_signal, exit_eval = evaluate_strategy_signal(
            "ma_stack", bullish,
            {"ma_stack_opposite_only": True, "use_ma_stack": True,
             "use_opposite_stack_exit": True, "use_dwell": True},
            position_side=1, entry_price=100.0, held_bars=1,
        )
        self.assertFalse(blocked_short)
        self.assertEqual(side, 1)
        self.assertTrue(exit_signal)
        self.assertTrue(exit_eval["condition_pass"]["exit_opposite_stack"])

    async def test_update_config_ma_stack_toggles(self):
        updated = await self.bot.configure({
            "strategy_mode": "ma_stack",
            "use_ma_stretch": False,
            "use_ma_stack": True,
            "use_ma_stack_1h": False,
            "use_convergence": False,
            "use_dwell": True,
            "use_bottoming": True,
            "ma_stretch_min": 0.45,
            "ma_trailing_stop": 0.20,
        })
        self.assertEqual(updated["strategy_mode"], "ma_stack")
        self.assertFalse(updated["use_ma_stretch"])
        self.assertTrue(updated["use_ma_stack"])
        self.assertFalse(updated["use_ma_stack_1h"])
        self.assertFalse(updated["use_convergence"])
        self.assertFalse(updated["use_dwell"])
        self.assertFalse(updated["use_bottoming"])
        self.assertTrue(updated["ma_stack_opposite_only"])
        self.assertTrue(updated["use_opposite_stack_exit"])
        self.assertAlmostEqual(updated["ma_stretch_min"], 0.45)
    async def test_insignificant_dust_position_does_not_block_trading(self):
        # Dust position (-0.0001 BTC, notional $0.01 < $5.0) on exchange does not raise mismatch
        self.client.amount = -0.0001
        self.client.collateral = 200.0
        # toggle(True) should succeed without ValueError
        state = await self.bot.toggle(True)
        self.assertTrue(state["enabled"])
        self.assertFalse(state["recovery_required"])
        self.assertFalse(state["execution_blocked"])

        # manual entry also succeeds without position mismatch error after pausing
        await self.bot.toggle(False)
        entry = await self.bot.manual_entry(1, 20.0)
        self.assertEqual(entry["event"], "ENTRY")

    async def test_reconcile_with_dust_flattens_without_creating_dust_tranche(self):
        # When exchange has dust (-0.0001 BTC), reconcile flattens bot tranches rather than creating a dust tranche
        self.client.amount = -0.0001
        res = await self.bot.reconcile()
        self.assertFalse(self.bot.state["recovery_required"])
        self.assertFalse(self.bot.state["execution_blocked"])
        self.assertEqual(len(self.bot.state["tranches"]), 0)

    async def test_unfilled_cancelled_pending_order_auto_clears(self):
        import time
        self.bot.state["pending_order"] = {
            "client_order_index": 99991,
            "symbol": "BTC",
            "market_id": 1,
            "side": 1,
            "qty": 0.01,
            "size_step": 0.001,
            "reduce_only": False,
            "reason": "test",
            "created_at": int(time.time()),
        }
        self.bot.state["recovery_required"] = True
        self.bot.state["execution_blocked"] = True
        self.bot.state["blocked_reason"] = "Lighter order outcome uncertain"

        # Exchange says order 99991 was cancelled with 0 filled base
        self.client.orders[99991] = {
            "status": "cancelled",
            "filled_base_amount": "0",
            "remaining_base_amount": "0.01",
        }

        # Verify startup or toggle auto-resolves and clears the unfilled order
        await self.bot.verify_startup()
        self.assertIsNone(self.bot.state["pending_order"])
        self.assertFalse(self.bot.state["recovery_required"])
        self.assertFalse(self.bot.state["execution_blocked"])

    async def test_ghost_pending_order_auto_clears(self):
        import time
        # Pending order not found on exchange after 20 seconds
        self.bot.state["pending_order"] = {
            "client_order_index": 88882,
            "symbol": "BTC",
            "market_id": 1,
            "side": 1,
            "qty": 0.01,
            "size_step": 0.001,
            "reduce_only": False,
            "reason": "test",
            "created_at": int(time.time()) - 25,
        }
        self.bot.state["recovery_required"] = True
        self.bot.state["execution_blocked"] = True

        await self.bot.verify_startup()
        self.assertIsNone(self.bot.state["pending_order"])
        self.assertFalse(self.bot.state["recovery_required"])
        self.assertFalse(self.bot.state["execution_blocked"])


if __name__ == "__main__":
    unittest.main()
