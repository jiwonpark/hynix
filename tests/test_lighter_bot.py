import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from backend.lighter_bot import LighterPairBot, classify_trend
from backend.lighter_client import LighterClient
from backend.lighter_strategy import evaluate_ou_signals


class TestLighterTrend(unittest.TestCase):
    def test_classifies_up_and_down_without_future_values(self):
        up = classify_trend([100 + index for index in range(30)])
        down = classify_trend([130 - index for index in range(30)])
        self.assertEqual(up["direction"], "UPTREND")
        self.assertGreater(up["score"], 0.35)
        self.assertEqual(down["direction"], "DOWNTREND")
        self.assertLess(down["score"], -0.35)
        self.assertEqual(classify_trend([100] * 30)["direction"], "SIDEWAYS")
        self.assertEqual(classify_trend([100] * 10)["direction"], "UNKNOWN")

    def test_noise_stays_neutral_and_transitions_require_confirmation(self):
        noisy = classify_trend([100 + (0.1 if index % 2 else -0.1) for index in range(40)])
        two_bar_spike = classify_trend(([100] * 38) + [102, 103])
        self.assertEqual(noisy["direction"], "SIDEWAYS")
        self.assertLess(abs(noisy["score"]), 0.15)
        self.assertEqual(two_bar_spike["direction"], "SIDEWAYS")


class TestLighterPairBot(unittest.TestCase):
    def test_event_exposure_reports_both_usdt_legs_and_one_x_margin(self):
        exposure = LighterPairBot._event_exposure({
            "adr_qty": 0.13,
            "domestic_qty": 0.013,
            "adr_price": 192.0,
            "domestic_price": 1360.0,
            "notional_usd": 25.0,
        })
        self.assertAlmostEqual(exposure["adr_notional_usd"], 24.96)
        self.assertAlmostEqual(exposure["domestic_notional_usd"], 17.68)
        self.assertAlmostEqual(exposure["gross_notional_usd"], 42.64)
        self.assertAlmostEqual(exposure["margin_usd"], 42.64)

    def test_event_exposure_accepts_legacy_order_list(self):
        exposure = LighterPairBot._event_exposure({
            "orders": [
                {"base_amount": 0.05, "reference_price": 200.0},
                {"base_amount": 0.5, "reference_price": 20.0},
            ]
        })
        self.assertEqual(exposure["adr_notional_usd"], 10.0)
        self.assertEqual(exposure["domestic_notional_usd"], 10.0)
        self.assertEqual(exposure["gross_notional_usd"], 20.0)

    def test_dynamic_capacity_uses_tab_two_leverage_and_margin_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterPairBot(Mock(), Path(directory) / "state.json")
            bot.state["tranches"] = [{"side": 1}] * 3
            capacity = bot._risk_capacity(
                {"collateral": 187.55},
                [
                    {"market_id": 216, "position_value": "75", "allocated_margin": "7.5"},
                    {"market_id": 161, "position_value": "54", "allocated_margin": "5.4"},
                ],
                {"mid": 191.0}, {"mid": 1340.0}, 25.0,
            )
            self.assertEqual(capacity["gross_leverage_cap"], 8.0)
            self.assertEqual(capacity["margin_leverage_assumption"], 10.0)
            self.assertEqual(capacity["active_tranches"], 3)
            self.assertEqual(capacity["remaining_tranches"], 27)
            self.assertEqual(capacity["max_tranches"], 30)
            self.assertIsNone(capacity["hard_max_tranches"])
            self.assertTrue(capacity["can_add_tranche"])
            self.assertGreater(capacity["required_margin_buffer_usd"], 6.0)
            self.assertLess(capacity["required_margin_buffer_usd"], 7.0)

    def test_dollar_neutral_sizing_matches_leg_notionals(self):
        adr_qty, domestic_qty = LighterPairBot._dollar_neutral_quantities(25.0, 183.67, 1306.56)
        self.assertEqual(adr_qty, 0.1361)
        self.assertEqual(domestic_qty, 0.019)
        adr_notional = adr_qty * 183.67
        domestic_notional = domestic_qty * 1306.56
        self.assertLess(abs(adr_notional - domestic_notional) / adr_notional, 0.02)

    def test_dynamic_capacity_blocks_entry_before_exceeding_safe_headroom(self):
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterPairBot(Mock(), Path(directory) / "state.json")
            bot.state["tranches"] = [{"side": 1}] * 3
            capacity = bot._risk_capacity(
                {"collateral": 187.55},
                [{"market_id": 216, "position_value": "1480", "allocated_margin": "148"}],
                {"mid": 191.0}, {"mid": 1340.0}, 25.0,
            )
            self.assertEqual(capacity["remaining_tranches"], 0)
            self.assertFalse(capacity["can_add_tranche"])
            self.assertEqual(capacity["blocked_reason"], "GROSS_LEVERAGE_CAP")

    def test_legacy_fixed_three_tranche_state_migrates_to_dynamic_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            state_file = Path(directory) / "state.json"
            state_file.write_text(json.dumps({"max_tranches": 3, "tranches": []}))
            bot = LighterPairBot(Mock(), state_file)
            self.assertEqual(bot.state["capacity_mode"], "DYNAMIC_SAFE_LEVERAGE")
            self.assertIsNone(bot.state["max_tranches"])
            self.assertEqual(bot.state["gross_leverage_cap"], 8.0)

    def test_user_configured_campaign_slot_cap_is_respected(self):
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterPairBot(Mock(), Path(directory) / "state.json")
            bot.state["tranches"] = [{"side": 1}] * 3
            bot.state["max_tranches"] = 5
            capacity = bot._risk_capacity(
                {"collateral": 187.55},
                [
                    {"market_id": 216, "position_value": "75", "allocated_margin": "7.5"},
                    {"market_id": 161, "position_value": "54", "allocated_margin": "5.4"},
                ],
                {"mid": 191.0}, {"mid": 1340.0}, 25.0,
            )
            self.assertEqual(capacity["remaining_tranches"], 2)
            self.assertEqual(capacity["max_tranches"], 5)
            self.assertEqual(capacity["hard_max_tranches"], 5)
            self.assertTrue(capacity["can_add_tranche"])

    def test_mixed_campaign_reconciles_to_actual_net_position_without_order(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Mock()
            bot = LighterPairBot(client, Path(directory) / "state.json")
            longs = [{"side": 1, "adr_qty": 0.1303, "domestic_qty": 0.013, "time": i} for i in range(3)]
            shorts = [{"side": -1, "adr_qty": 0.1303, "domestic_qty": 0.013, "time": 10 + i} for i in range(9)]
            bot.state["tranches"] = longs + shorts
            changed = bot._reconcile_mixed_campaign([
                {"market_id": 216, "position": "0.7818", "sign": -1, "avg_entry_price": "190"},
                {"market_id": 161, "position": "0.078", "sign": 1, "avg_entry_price": "1340"},
            ])
            self.assertTrue(changed)
            self.assertEqual(len(bot.state["tranches"]), 1)
            self.assertEqual({row["side"] for row in bot.state["tranches"]}, {-1})
            self.assertAlmostEqual(bot.state["tranches"][0]["adr_qty"], 0.7818)
            self.assertEqual(bot.state["last_reconciliation"]["removed_offset_records"], 12)
            client.create_market_order.assert_not_called()

    def test_mixed_campaign_reconciles_unequal_sizes_and_flat_state(self):
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterPairBot(Mock(), Path(directory) / "state.json")
            bot.state["tranches"] = [
                {"side": 1, "adr_qty": 0.10, "domestic_qty": 0.010},
                {"side": -1, "adr_qty": 0.20, "domestic_qty": 0.020},
            ]
            self.assertTrue(bot._reconcile_mixed_campaign([
                {"market_id": 216, "position": "0.10", "sign": -1, "avg_entry_price": "190"},
                {"market_id": 161, "position": "0.010", "sign": 1, "avg_entry_price": "1340"},
            ]))
            self.assertEqual(len(bot.state["tranches"]), 1)
            self.assertAlmostEqual(bot.state["tranches"][0]["adr_qty"], 0.10)

            bot.state["tranches"] = [
                {"side": 1, "adr_qty": 0.10, "domestic_qty": 0.010},
                {"side": -1, "adr_qty": 0.10, "domestic_qty": 0.010},
            ]
            self.assertTrue(bot._reconcile_mixed_campaign([]))
            self.assertEqual(bot.state["tranches"], [])
            self.assertEqual(bot.state["last_reconciliation"]["net_side"], 0)

    def test_existing_campaign_blocks_opposite_direction_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterPairBot(Mock(), Path(directory) / "state.json")
            bot.state["tranches"] = [{"side": -1}]
            self.assertTrue(bot._campaign_allows_side(-1))
            self.assertFalse(bot._campaign_allows_side(1))

    def test_manual_entry_rejects_opposite_campaign_before_order(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.account_status = AsyncMock(return_value={
                    "authenticated": True, "execution_enabled": True, "collateral": 200.0,
                })
                client.positions = AsyncMock(return_value=[])
                client.order_book = AsyncMock(side_effect=[
                    {"asks": [{"price": "190", "size": "1"}], "bids": [{"price": "189", "size": "1"}]},
                    {"asks": [{"price": "1341", "size": "1"}], "bids": [{"price": "1340", "size": "1"}]},
                ])
                bot = LighterPairBot(client, Path(directory) / "state.json")
                bot.state["tranches"] = [{"side": -1}]
                bot._trade_pair = AsyncMock()
                with self.assertRaisesRegex(RuntimeError, "conflicts with the existing"):
                    await bot.execute_manual_tranche(1, 25.0)
                bot._trade_pair.assert_not_awaited()

        asyncio.run(run())

    def test_execution_helpers_use_exchange_fill_values(self):
        execution = {
            "first_leg": {"fill_price": 190.0, "fee_usd": 0.007, "realized_pnl_usd": 0.12},
            "second_leg": {"fill_price": 1340.0, "fee_usd": 0.005, "realized_pnl_usd": -0.08},
        }
        self.assertAlmostEqual(LighterPairBot._execution_ratio(execution, 0.0), 141.7910447761)
        self.assertAlmostEqual(LighterPairBot._execution_fees(execution), 0.012)
        self.assertAlmostEqual(LighterPairBot._execution_realized_pnl(execution), 0.04)

    def test_legacy_active_tranche_is_hydrated_from_exchange_fills(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.execution_fill = AsyncMock(side_effect=[
                    {"fill_confirmed": True, "filled_size": 0.13, "fill_price": 191.0,
                     "fee_usd": 0.007, "realized_pnl_usd": 0.0},
                    {"fill_confirmed": True, "filled_size": 0.013, "fill_price": 1350.0,
                     "fee_usd": 0.005, "realized_pnl_usd": 0.0},
                ])
                bot = LighterPairBot(client, Path(directory) / "state.json")
                bot.state["tranches"] = [{
                    "side": -1, "adr_qty": 0.13, "domestic_qty": 0.013,
                    "entry_ratio": 141.0, "notional_usd": 25.0, "fee_usd": 0.0,
                    "orders": {
                        "first_leg": {"client_order_index": 1, "base_amount": 0.13},
                        "second_leg": {"client_order_index": 2, "base_amount": 0.013},
                    },
                }]
                self.assertTrue(await bot._hydrate_active_tranche_fills())
                tranche = bot.state["tranches"][0]
                self.assertEqual(tranche["execution_source"], "LIGHTER_FILLS")
                self.assertAlmostEqual(tranche["entry_ratio"], 141.4814814815)
                self.assertAlmostEqual(tranche["fee_usd"], 0.012)

        asyncio.run(run())

    def test_configure_persists_ten_per_minute_order_interval(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                state_file = Path(directory) / "state.json"
                bot = LighterPairBot(Mock(), state_file)
                result = await bot.configure({"min_seconds_between_orders": 6})
                self.assertEqual(result["min_seconds_between_orders"], 6)
                self.assertEqual(json.loads(state_file.read_text())["min_seconds_between_orders"], 6)
                with self.assertRaisesRegex(ValueError, "min_seconds_between_orders"):
                    await bot.configure({"min_seconds_between_orders": 5})

        asyncio.run(run())

    def test_pending_execution_always_recovers_disabled(self):
        with tempfile.TemporaryDirectory() as directory:
            state_file = Path(directory) / "state.json"
            state_file.write_text(json.dumps({"enabled": True, "pending_execution": {"first_leg": {}}}))
            bot = LighterPairBot(Mock(), state_file)
            self.assertFalse(bot.public_state()["enabled"])
            self.assertTrue(bot.public_state()["recovery_required"])

    def test_unsubmitted_pending_intent_clears_only_when_positions_match(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.positions = AsyncMock(return_value=[
                    {"market_id": 216, "position": "0.1345", "sign": 1},
                    {"market_id": 161, "position": "0.013", "sign": -1},
                ])
                bot = LighterPairBot(client, Path(directory) / "state.json")
                bot.state.update({
                    "tranches": [{"side": 1, "adr_qty": 0.1345, "domestic_qty": 0.013}],
                    "pending_execution": {
                        "side": -1, "adr_qty": 0.1345, "domestic_qty": 0.013,
                        "reduce_only": True, "first_leg": None,
                    },
                })

                self.assertTrue(await bot._reconcile_unsubmitted_pending_intent())
                self.assertIsNone(bot.state["pending_execution"])
                self.assertEqual(bot.state["recovery_log"][-1]["event"], "CLEARED_UNSUBMITTED_PAIR_INTENT")

        asyncio.run(run())

    def test_confirmed_pending_reduction_reconciles_latest_tranche(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.execution_fill = AsyncMock(side_effect=[
                    {"fill_confirmed": True, "filled_size": 0.1345, "fill_price": 185.59,
                     "fee_usd": 0.0, "realized_pnl_usd": 0.11},
                    {"fill_confirmed": True, "filled_size": 0.013, "fill_price": 1314.847,
                     "fee_usd": 0.0, "realized_pnl_usd": -0.02},
                ])
                bot = LighterPairBot(client, Path(directory) / "state.json")
                bot.state.update({
                    "tranches": [{"side": 1, "adr_qty": 0.1346, "domestic_qty": 0.013,
                                  "entry_ratio": 141.18, "notional_usd": 25.0,
                                  "fee_usd": 0.01, "time": 1000}],
                    "pending_execution": {
                        "completed": True, "reduce_only": True, "side": -1,
                        "adr_qty": 0.1345, "domestic_qty": 0.013, "time": 1100,
                        "first_leg": {"client_order_index": 11},
                        "second_leg": {"client_order_index": 12},
                    },
                    "last_error": "Unresolved paired execution; manual reconciliation required",
                })
                self.assertTrue(await bot._reconcile_confirmed_pending_reduction())
                self.assertIsNone(bot.state["pending_execution"])
                self.assertEqual(bot.state["tranches"], [])
                self.assertEqual(bot.state["last_action"], "RECOVERED_CONFIRMED_REDUCTION")
                self.assertTrue(bot.state["history"][-1]["reconciled"])

        asyncio.run(run())

    def test_confirmed_pending_reduction_accepts_lot_rounding_tolerance(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.execution_fill = AsyncMock(side_effect=[
                    {"fill_confirmed": True, "filled_size": 0.1354, "fill_price": 184.11,
                     "fee_usd": 0.0, "realized_pnl_usd": 0.05},
                    {"fill_confirmed": True, "filled_size": 0.019, "fill_price": 1310.998,
                     "fee_usd": 0.0, "realized_pnl_usd": 0.02},
                ])
                bot = LighterPairBot(client, Path(directory) / "state.json")
                bot.state.update({
                    "tranches": [{"side": -1, "adr_qty": 0.1355, "domestic_qty": 0.019,
                                  "entry_ratio": 140.54, "notional_usd": 25.0,
                                  "fee_usd": 0.0, "time": 1000}],
                    "pending_execution": {
                        "completed": True, "reduce_only": True, "side": 1,
                        "adr_qty": 0.1355, "domestic_qty": 0.019, "time": 1100,
                        "first_leg": {"client_order_index": 214887462420857},
                        "second_leg": {"client_order_index": 214890596971538},
                    },
                    "last_error": "Paired execution accepted but authoritative fills are not yet confirmed",
                })
                self.assertTrue(await bot._reconcile_confirmed_pending_reduction())
                self.assertIsNone(bot.state["pending_execution"])
                self.assertEqual(bot.state["tranches"], [])
                self.assertEqual(bot.state["last_action"], "RECOVERED_CONFIRMED_REDUCTION")
                self.assertTrue(bot.state["history"][-1]["reconciled"])

        asyncio.run(run())

    def test_one_leg_pending_reduction_retries_missing_leg_and_reconciles(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.execution_fill = AsyncMock(side_effect=[
                    {"fill_confirmed": True, "filled_size": 0.1345, "fill_price": 185.59,
                     "fee_usd": 0.0, "realized_pnl_usd": 0.11},
                    {"fill_confirmed": False},
                ])
                client.positions = AsyncMock(return_value=[
                    {"market_id": 161, "position": "0.013", "sign": -1},
                ])
                client.order_book = AsyncMock(return_value={
                    "bids": [{"price": "1314", "size": "1"}],
                    "asks": [{"price": "1315", "size": "1"}],
                })
                client.create_market_order = AsyncMock(return_value={
                    "market_id": 161, "client_order_index": 13,
                    "fill_confirmed": True, "filled_size": 0.013,
                    "fill_price": 1314.8, "fee_usd": 0.0, "realized_pnl_usd": -0.02,
                })
                bot = LighterPairBot(client, Path(directory) / "state.json")
                bot.state.update({
                    "tranches": [{"side": 1, "adr_qty": 0.1345, "domestic_qty": 0.013,
                                  "entry_ratio": 141.18, "notional_usd": 25.0,
                                  "fee_usd": 0.01, "time": 1000}],
                    "pending_execution": {
                        "completed": True, "reduce_only": True, "side": -1,
                        "adr_qty": 0.1345, "domestic_qty": 0.013, "time": 1100,
                        "first_leg": {"client_order_index": 11},
                        "second_leg": {"client_order_index": 12},
                    },
                })

                self.assertTrue(await bot._reconcile_confirmed_pending_reduction())
                self.assertIsNone(bot.state["pending_execution"])
                self.assertEqual(bot.state["tranches"], [])
                client.create_market_order.assert_awaited_once()
                self.assertTrue(client.create_market_order.await_args.kwargs["reduce_only"])

        asyncio.run(run())

    def test_one_leg_pending_entry_is_repaired_once_and_reconciled(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.execution_fill = AsyncMock(side_effect=[
                    {"fill_confirmed": True, "filled_size": 0.1361, "fill_price": 183.72, "fee_usd": 0.0},
                    {"fill_confirmed": False},
                ])
                client.positions = AsyncMock(return_value=[
                    {"market_id": 216, "position": "0.2706", "sign": 1},
                    {"market_id": 161, "position": "0.013", "sign": -1},
                ])
                client.order_book = AsyncMock(return_value={
                    "bids": [{"price": "1305", "size": "1"}],
                    "asks": [{"price": "1306", "size": "1"}],
                })
                client.create_market_order = AsyncMock(return_value={
                    "market_id": 161, "client_order_index": 13,
                    "fill_confirmed": True, "filled_size": 0.013,
                    "fill_price": 1305.5, "fee_usd": 0.0,
                })
                bot = LighterPairBot(client, Path(directory) / "state.json")
                bot.state.update({
                    "tranches": [{"side": 1, "adr_qty": 0.1345, "domestic_qty": 0.013}],
                    "pending_execution": {
                        "completed": True, "reduce_only": False, "side": 1,
                        "adr_qty": 0.1361, "domestic_qty": 0.013, "time": 1100,
                        "first_leg": {"client_order_index": 11},
                        "second_leg": {"client_order_index": 12},
                    },
                })

                self.assertTrue(await bot._repair_pending_entry())
                self.assertIsNone(bot.state["pending_execution"])
                self.assertEqual(len(bot.state["tranches"]), 2)
                self.assertEqual(bot.state["last_action"], "RECOVERED_CONFIRMED_ENTRY")
                self.assertTrue(bot.state["history"][-1]["reconciled"])
                client.create_market_order.assert_awaited_once()
                self.assertEqual(client.create_market_order.await_args.args[:2], (161, 0.013))

        asyncio.run(run())

    def test_failed_entry_repair_rolls_back_confirmed_leg_instead_of_retrying_twice(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.execution_fill = AsyncMock(side_effect=[
                    {"fill_confirmed": True, "filled_size": 0.1361},
                    {"fill_confirmed": False},
                ])
                client.positions = AsyncMock(return_value=[
                    {"market_id": 216, "position": "0.1361", "sign": 1},
                ])
                client.order_book = AsyncMock(return_value={
                    "bids": [{"price": "183", "size": "1"}],
                    "asks": [{"price": "184", "size": "1"}],
                })
                client.create_market_order = AsyncMock(return_value={
                    "market_id": 216, "fill_confirmed": True,
                    "filled_size": 0.1361, "fill_price": 183.0,
                })
                bot = LighterPairBot(client, Path(directory) / "state.json")
                bot.state["pending_execution"] = {
                    "completed": True, "reduce_only": False, "side": 1,
                    "adr_qty": 0.1361, "domestic_qty": 0.013,
                    "repair_attempted_at": 1234,
                    "first_leg": {"client_order_index": 11},
                    "second_leg": {"client_order_index": 12},
                }

                self.assertTrue(await bot._repair_pending_entry())
                self.assertIsNone(bot.state["pending_execution"])
                self.assertGreater(bot.state["margin_blocked_until"], 0)
                self.assertEqual(bot.state["last_action"], "ROLLED_BACK_ONE_LEGGED_ENTRY")
                client.create_market_order.assert_awaited_once()
                self.assertTrue(client.create_market_order.await_args.kwargs["reduce_only"])

        asyncio.run(run())

    def test_enable_requires_funded_authenticated_account_and_signer(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.account_status = AsyncMock(return_value={"authenticated": True, "execution_enabled": True})
                client.positions = AsyncMock(return_value=[])
                signer = Mock()
                signer.check_client.return_value = None
                client.get_signer.return_value = signer
                bot = LighterPairBot(client, Path(directory) / "state.json")
                result = await bot.set_enabled(True)
                self.assertTrue(result["enabled"])
                saved = json.loads((Path(directory) / "state.json").read_text())
                self.assertTrue(saved["enabled"])

        asyncio.run(run())

    def test_client_order_index_respects_lighter_48_bit_limit(self):
        async def run():
            client = LighterClient()
            signer = Mock()
            signer.check_client.return_value = None
            signer.create_market_order = AsyncMock(return_value=(Mock(), Mock(tx_hash="ok"), None))
            client.get_signer = Mock(return_value=signer)
            client.market_detail = AsyncMock(return_value={
                "supported_size_decimals": 4,
                "supported_price_decimals": 2,
                "min_base_amount": "0.0300",
            })
            client.execution_fill = AsyncMock(return_value={
                "fill_confirmed": True, "filled_size": 0.04, "base_amount": 0.04,
                "fill_price": 180.1, "filled_usd": 7.204, "fee_rate": 0.00028,
                "fee_usd": 0.00201712, "realized_pnl_usd": 0.0,
            })
            result = await client.create_market_order(216, 0.04, 180.0, True)
            order_index = signer.create_market_order.await_args.args[1]
            self.assertGreater(order_index, 0)
            self.assertLessEqual(order_index, LighterClient.MAX_CLIENT_ORDER_INDEX)
            self.assertEqual(result["client_order_index"], order_index)
            self.assertEqual(result["fill_price"], 180.1)

        asyncio.run(run())

    def test_lighter_client_aggregates_actual_split_fills_fees_and_realized_pnl(self):
        async def run():
            client = LighterClient()
            client.get_credentials = Mock(return_value={"account_index": 42, "api_key_index": 3})
            signer = Mock()
            signer.create_auth_token_with_expiry.return_value = ("token", None)
            client.get_signer = Mock(return_value=signer)
            client.request = AsyncMock(return_value={
                "trades": [
                    {"market_id": 216, "size": "0.02", "usd_amount": "3.60",
                     "ask_account_id": 42, "ask_account_pnl": "0.04", "taker_fee": 280,
                     "ask_client_id_str": "99", "timestamp": 1000},
                    {"market_id": 216, "size": "0.02", "usd_amount": "3.64",
                     "ask_account_id": 42, "ask_account_pnl": "0.03", "taker_fee": 280,
                     "ask_client_id_str": "99", "timestamp": 1001},
                ]
            })
            fill = await client.execution_fill(99, 216, 0.04)
            self.assertTrue(fill["fill_confirmed"])
            self.assertAlmostEqual(fill["fill_price"], 181.0)
            self.assertAlmostEqual(fill["fee_usd"], 7.24 * 0.00028)
            self.assertAlmostEqual(fill["realized_pnl_usd"], 0.07)
            self.assertEqual(fill["fill_count"], 2)

        asyncio.run(run())

    def test_lighter_client_retries_rate_limit_before_succeeding(self):
        class FakeResponse:
            def __init__(self, status, payload):
                self.status = status
                self.payload = payload
                self.headers = {}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def json(self, content_type=None):
                return self.payload

        class FakeSession:
            def __init__(self):
                self.responses = [
                    FakeResponse(429, {"code": 429}),
                    FakeResponse(200, {"code": 200, "ok": True}),
                ]

            def get(self, *_args, **_kwargs):
                return self.responses.pop(0)

        async def run():
            client = LighterClient()
            client.get_session = AsyncMock(return_value=FakeSession())
            with patch("backend.lighter_client.asyncio.sleep", new=AsyncMock()) as sleep:
                result = await client.request("/test")
            self.assertTrue(result["ok"])
            sleep.assert_awaited_once()

        asyncio.run(run())

    def test_lighter_client_coalesces_live_candles_and_returns_requested_tail(self):
        async def run():
            client = LighterClient()
            rows = [{"t": index * 300_000, "c": str(index)} for index in range(500)]
            client.request = AsyncMock(return_value={"c": rows})
            first, second = await asyncio.gather(
                client.candles(216, "5m", 80),
                client.candles(216, "5m", 90),
            )
            self.assertEqual(len(first), 80)
            self.assertEqual(len(second), 90)
            self.assertEqual(first[-1]["c"], "499")
            client.request.assert_awaited_once()

        asyncio.run(run())

    def test_lighter_client_uses_and_merges_fresh_websocket_book(self):
        async def run():
            client = LighterClient()
            client.request = AsyncMock()
            client._handle_stream_message({
                "type": "subscribed/order_book", "channel": "order_book:216",
                "order_book": {
                    "asks": [{"price": "101", "size": "2"}],
                    "bids": [{"price": "99", "size": "3"}],
                },
            })
            client._handle_stream_message({
                "type": "update/order_book", "channel": "order_book:216",
                "order_book": {
                    "asks": [{"price": "101", "size": "0"}, {"price": "102", "size": "1"}],
                    "bids": [{"price": "100", "size": "4"}],
                },
            })
            book = await client.order_book(216, 20)
            self.assertEqual(book["asks"], [{"price": "102", "size": "1"}])
            self.assertEqual(book["bids"][0], {"price": "100", "size": "4"})
            client.request.assert_not_awaited()

        asyncio.run(run())

    def test_lighter_client_reads_dictionary_positions_from_account_stream(self):
        client = LighterClient()
        client._ws_connected = True
        client._handle_stream_message({
            "type": "subscribed/account_all", "channel": "account_all:42",
            "account": 42,
            "positions": {
                "216": {"market_id": 216, "position": "0.04", "sign": -1},
                "161": {"market_id": 161, "position": "0.004", "sign": 1},
            },
        })
        positions = client._stream_positions()
        self.assertEqual({row["market_id"] for row in positions}, {161, 216})
        self.assertTrue(client.stream_status()["account_live"])

    def test_lighter_client_does_not_expire_quiet_connected_account_snapshot(self):
        client = LighterClient()
        client._ws_connected = True
        client._ws_account_time = 1.0
        client._ws_account = {"positions": {"216": {"market_id": 216, "position": "0.04"}}}
        self.assertEqual(client._stream_positions()[0]["market_id"], 216)
        self.assertTrue(client.stream_status()["account_live"])

    def test_lighter_client_returns_stale_candles_after_transient_failure(self):
        async def run():
            client = LighterClient()
            client.request = AsyncMock(return_value={"c": [{"t": 1, "c": "100"}]})
            await client.candles(216, "5m", 80)
            cache = next(value for key, value in client._cache.items() if key.startswith("candles:"))
            cache["expires"] = 0
            client.request = AsyncMock(side_effect=RuntimeError("Lighter API error (429)"))
            rows = await client.candles(216, "5m", 80)
            self.assertEqual(rows, [{"t": 1, "c": "100"}])

        asyncio.run(run())

    def test_disabled_worker_never_touches_exchange(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                bot = LighterPairBot(client, Path(directory) / "state.json")
                await bot.run_once()
                client.account_status.assert_not_called()
                client.create_market_order.assert_not_called()

        asyncio.run(run())

    def test_transient_read_error_retries_without_disabling_persisted_bot(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                state_file = Path(directory) / "state.json"
                bot = LighterPairBot(Mock(), state_file)
                bot.state["enabled"] = True
                bot._evaluate = AsyncMock(side_effect=RuntimeError("Lighter API error (429)"))
                await bot.run_once()
                self.assertTrue(bot.state["enabled"])
                self.assertEqual(bot.state["last_action"], "RETRYING_TRANSIENT_ERROR")
                self.assertEqual(bot.state["transient_error_count"], 1)
                self.assertTrue(json.loads(state_file.read_text())["enabled"])

        asyncio.run(run())

    def test_transient_account_status_error_retries_without_disabling(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.account_status = AsyncMock(return_value={
                    "execution_enabled": False,
                    "error": "Lighter API error (429)",
                })
                bot = LighterPairBot(client, Path(directory) / "state.json")
                bot.state["enabled"] = True
                await bot.run_once()
                self.assertTrue(bot.state["enabled"])
                self.assertEqual(bot.state["last_action"], "RETRYING_TRANSIENT_ERROR")
                client.positions.assert_not_called()

        asyncio.run(run())

    def test_transient_error_with_pending_execution_still_fails_closed(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                bot = LighterPairBot(Mock(), Path(directory) / "state.json")
                bot.state.update(enabled=True, pending_execution={"first_leg": {"client_order_index": 1}})
                bot._evaluate = AsyncMock(side_effect=RuntimeError("Lighter API error (429)"))
                await bot.run_once()
                self.assertFalse(bot.state["enabled"])
                self.assertEqual(bot.state["last_action"], "FAIL_CLOSED")

        asyncio.run(run())

    def test_non_transient_evaluation_error_still_fails_closed(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                bot = LighterPairBot(Mock(), Path(directory) / "state.json")
                bot.state["enabled"] = True
                bot._evaluate = AsyncMock(side_effect=RuntimeError("Invalid account configuration"))
                await bot.run_once()
                self.assertFalse(bot.state["enabled"])
                self.assertEqual(bot.state["last_action"], "FAIL_CLOSED")

        asyncio.run(run())

    def test_second_leg_failure_keeps_durable_recovery_intent(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.create_market_order = AsyncMock(side_effect=[{"client_order_index": 1}, TimeoutError("unknown")])
                state_file = Path(directory) / "state.json"
                bot = LighterPairBot(client, state_file)
                with self.assertRaises(TimeoutError):
                    await bot._trade_pair(
                        -1, 0.04, 0.004,
                        {"mid": 180.0}, {"mid": 1300.0}, reduce_only=False,
                    )
                saved = json.loads(state_file.read_text())
                self.assertEqual(saved["pending_execution"]["first_leg"]["client_order_index"], 1)
                self.assertNotIn("second_leg", saved["pending_execution"])

    def test_trends_supports_custom_small_and_big_intervals(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.candles = AsyncMock(return_value=[
                    {"t": 1000 + i * 300_000, "c": 180 + i * 0.1} for i in range(40)
                ])
                bot = LighterPairBot(client, Path(directory) / "state.json")
                trends = await bot.trends(small="1m", big="4h")
                self.assertEqual(trends["small_interval"], "1m")
                self.assertEqual(trends["big_interval"], "4h")
                self.assertIn("1m", trends)
                self.assertIn("4h", trends)
                self.assertIn("small", trends)
                self.assertIn("big", trends)

        asyncio.run(run())

    def test_enable_rejects_single_leg_or_same_direction_positions(self):
        async def run(positions):
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.account_status = AsyncMock(return_value={"authenticated": True, "execution_enabled": True})
                client.positions = AsyncMock(return_value=positions)
                signer = Mock()
                signer.check_client.return_value = None
                client.get_signer.return_value = signer
                bot = LighterPairBot(client, Path(directory) / "state.json")
                with self.assertRaisesRegex(RuntimeError, "Unreconciled"):
                    await bot.set_enabled(True)
                self.assertFalse(bot.public_state()["enabled"])

        asyncio.run(run([{"market_id": 216, "position": "0.04", "sign": -1}]))
        asyncio.run(run([
            {"market_id": 216, "position": "0.04", "sign": 1},
            {"market_id": 161, "position": "0.004", "sign": 1},
        ]))

    def test_manual_order_rejects_unsafe_parameters_before_exchange_access(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                bot = LighterPairBot(client, Path(directory) / "state.json")
                with self.assertRaisesRegex(ValueError, "side"):
                    await bot.execute_manual_tranche(0, 25.0)
                with self.assertRaisesRegex(ValueError, "notional_usd"):
                    await bot.execute_manual_tranche(-1, 501.0)
                client.account_status.assert_not_called()

        asyncio.run(run())

    def test_rejected_manual_reduce_keeps_tranche_tracked(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.order_book = AsyncMock(return_value={
                    "asks": [{"price": "101"}], "bids": [{"price": "99"}],
                })
                client.create_market_order = AsyncMock(side_effect=RuntimeError("Lighter order rejected: test"))
                state_file = Path(directory) / "state.json"
                bot = LighterPairBot(client, state_file)
                tranche = {"side": -1, "adr_qty": 0.04, "domestic_qty": 0.004, "entry_ratio": 141.0}
                bot.state["tranches"] = [tranche]
                bot.save()
                with self.assertRaisesRegex(RuntimeError, "rejected"):
                    await bot.execute_manual_reduce()
                self.assertEqual(bot.state["tranches"], [tranche])
                self.assertEqual(json.loads(state_file.read_text())["tranches"], [tranche])

        asyncio.run(run())

    def test_reduce_without_tranches_flattens_without_lock_deadlock(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                positions = [
                    {"market_id": 216, "position": "0.04", "sign": -1},
                    {"market_id": 161, "position": "0.004", "sign": 1},
                ]
                client.positions = AsyncMock(return_value=positions)
                client.order_book = AsyncMock(return_value={
                    "asks": [{"price": "101"}], "bids": [{"price": "99"}],
                })
                client.create_market_order = AsyncMock(return_value={"client_order_index": 1})
                bot = LighterPairBot(client, Path(directory) / "state.json")
                result = await asyncio.wait_for(bot.execute_manual_reduce(), timeout=0.5)
                self.assertEqual(len(result["closed"]), 2)

        asyncio.run(run())

    def test_execution_history_links_entries_and_exits_with_return_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterPairBot(Mock(), Path(directory) / "state.json")
            bot.state["history"] = [
                {"side": -1, "adr_qty": 0.13, "domestic_qty": 0.013,
                 "entry_ratio": 141.0, "time": 100, "notional_usd": 25.0,
                 "fee_usd": 0.01},
                {"side": 1, "adr_qty": 0.13, "domestic_qty": 0.013,
                 "ratio": 140.0, "time": 200, "notional_usd": 25.0,
                 "is_exit": True, "pnl": 0.17, "fee_usd": 0.01},
            ]
            history = bot.public_state()["execution_history"]
            self.assertEqual(len(history), 2)
            self.assertEqual(history[0]["event"], "ENTRY")
            self.assertEqual(history[0]["status"], "CLOSED")
            self.assertEqual(history[1]["event"], "EXIT")
            self.assertEqual(history[1]["original_side"], -1)
            self.assertEqual(history[1]["entry_ratio"], 141.0)
            self.assertEqual(history[1]["exit_ratio"], 140.0)
            self.assertAlmostEqual(history[1]["fee_usd"], 0.02)
            self.assertAlmostEqual(history[1]["net_pnl_usd"], 0.15)
            expected_margin = 25.0 + (25.0 * 100.0 / 140.0)
            self.assertAlmostEqual(history[1]["pnl_pct"], 0.15 / expected_margin * 100)

    def test_execution_history_does_not_label_old_unmatched_entry_as_open(self):
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterPairBot(Mock(), Path(directory) / "state.json")
            bot.state["history"] = [{
                "side": 1, "adr_qty": 0.13, "domestic_qty": 0.013,
                "entry_ratio": 140.0, "time": 100, "notional_usd": 25.0,
            }]
            self.assertEqual(
                bot.public_state()["execution_history"][0]["status"],
                "LEGACY — EXIT NOT RECORDED",
            )

    def test_configure_and_evaluate_strategy_modes(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                bot = LighterPairBot(Mock(), Path(directory) / "state.json")
                res = await bot.configure({
                    "strategy_mode": "ou_quant",
                    "strategy_interval": "15m",
                    "ou_halflife_max": 12.0,
                    "ou_stop_z": 4.0,
                })
                self.assertEqual(res["strategy_mode"], "ou_quant")
                self.assertEqual(res["strategy_interval"], "15m")
                self.assertEqual(res["strategy_params"]["ou_halflife_max"], 12.0)
                self.assertEqual(res["strategy_params"]["ou_stop_z"], 4.0)

                with self.assertRaises(ValueError):
                    await bot.configure({"strategy_mode": "non_existent"})

                ratios = [140.0 + (i * 0.05) for i in range(40)]
                entry_sig, side, exit_sig, eval_info = bot._evaluate_strategy_signals(ratios)
                self.assertEqual(eval_info["strategy"], "ou_quant")

                await bot.configure({"strategy_mode": "grid"})
                entry_sig, side, exit_sig, eval_info = bot._evaluate_strategy_signals(ratios)
                self.assertEqual(eval_info["strategy"], "grid")

                await bot.configure({"strategy_mode": "ma_stack"})
                entry_sig, side, exit_sig, eval_info = bot._evaluate_strategy_signals(ratios)
                self.assertEqual(eval_info["strategy"], "ma_stack")

                await bot.configure({"strategy_mode": "multi_factor"})
                entry_sig, side, exit_sig, eval_info = bot._evaluate_strategy_signals(ratios)
                self.assertEqual(eval_info["strategy"], "multi_factor")

                await bot.configure({"strategy_mode": "trend_pullback"})
                entry_sig, side, exit_sig, eval_info = bot._evaluate_strategy_signals(ratios)
                self.assertEqual(eval_info["strategy"], "trend_pullback")

                await bot.configure({"strategy_mode": "ou_quant", "ou_stop_z": 1.5})
                _, _, exit_sig, eval_info = bot._evaluate_strategy_signals(ratios)
                self.assertEqual(eval_info["stop_z"], 1.5)
                self.assertEqual(exit_sig, abs(eval_info["z"]) <= bot.state["exit_z"] or abs(eval_info["z"]) >= 1.5)

                await bot.configure({"strategy_mode": "ma_stack", "ma_trailing_stop": 0.2})
                _, _, _, eval_info = bot._evaluate_strategy_signals(ratios, side_if_open=-1)
                self.assertEqual(eval_info["trailing_stop"], 0.2)

        asyncio.run(run())

    def test_live_ou_evaluation_uses_shared_signal_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterPairBot(Mock(), Path(directory) / "state.json")
            bot.state.update({
                "strategy_mode": "ou_quant", "entry_z": 1.8, "exit_z": 0.2,
                "ou_halflife_max": 8.0, "ou_stop_z": 3.5,
            })
            ratios = [140.0 + ((index % 7) - 3) * 0.04 for index in range(40)]
            live = bot._evaluate_strategy_signals(ratios)
            replay = evaluate_ou_signals(
                ratios, entry_z=1.8, exit_z=0.2,
                ou_halflife_max=8.0, ou_stop_z=3.5,
                evaluation_time=live[3]["time"],
            )
            self.assertEqual(live, replay)

    def test_live_entry_records_strategy_evaluation_after_execution(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                client.account_status = AsyncMock(return_value={
                    "authenticated": True, "execution_enabled": True, "collateral": 100.0,
                })
                client.positions = AsyncMock(return_value=[])
                timestamps = [1_700_000_000_000 + index * 300_000 for index in range(80)]
                adr_rows = [
                    {"t": timestamp, "c": str(140.0 + (0.1 if index % 2 else -0.1))}
                    for index, timestamp in enumerate(timestamps)
                ]
                adr_rows[-1]["c"] = "145"
                domestic_rows = [{"t": timestamp, "c": "1000"} for timestamp in timestamps]

                async def candles(market_id, _interval, _count):
                    return adr_rows if market_id == 216 else domestic_rows

                client.candles = AsyncMock(side_effect=candles)
                client.order_book = AsyncMock(return_value={
                    "bids": [{"price": "100", "size": "10"}],
                    "asks": [{"price": "100.01", "size": "10"}],
                })
                bot = LighterPairBot(client, Path(directory) / "state.json")
                bot.state["min_seconds_between_orders"] = 0
                bot._trade_pair = AsyncMock(return_value={
                    "first_leg": {
                        "filled_size": 0.17, "fill_price": 145.0, "fee_usd": 0.0,
                    },
                    "second_leg": {
                        "filled_size": 0.017, "fill_price": 1000.0, "fee_usd": 0.0,
                    },
                })

                await bot._evaluate()

                self.assertEqual(len(bot.state["tranches"]), 1)
                self.assertEqual(bot.state["tranches"][0]["entry_strategy"], "grid")
                self.assertEqual(bot.state["tranches"][0]["entry_z"], bot.state["last_evaluation"]["z"])
                self.assertEqual(bot.state["last_entry_signal_bar_time"], timestamps[-1])
                bot._trade_pair.assert_awaited_once()

                # The same completed candle may remain actionable across many worker
                # ticks, but it must create at most one automated tranche.
                await bot._evaluate()
                self.assertEqual(len(bot.state["tranches"]), 1)
                self.assertEqual(bot.state["last_action"], "WAITING_FOR_NEXT_SIGNAL_BAR")
                bot._trade_pair.assert_awaited_once()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
