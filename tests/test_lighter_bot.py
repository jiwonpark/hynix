import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from backend.lighter_bot import LighterPairBot, classify_trend
from backend.lighter_client import LighterClient


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
            self.assertEqual(capacity["remaining_tranches"], 9)
            self.assertEqual(capacity["max_tranches"], 12)
            self.assertTrue(capacity["can_add_tranche"])
            self.assertGreater(capacity["required_margin_buffer_usd"], 5.0)
            self.assertLess(capacity["required_margin_buffer_usd"], 6.0)

    def test_dynamic_capacity_blocks_entry_before_exceeding_safe_headroom(self):
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterPairBot(Mock(), Path(directory) / "state.json")
            bot.state["tranches"] = [{"side": 1}] * 12
            capacity = bot._risk_capacity(
                {"collateral": 187.55},
                [{"market_id": 216, "position_value": "1400", "allocated_margin": "140"}],
                {"mid": 191.0}, {"mid": 1340.0}, 25.0,
            )
            self.assertEqual(capacity["remaining_tranches"], 0)
            self.assertEqual(capacity["max_tranches"], 12)
            self.assertFalse(capacity["can_add_tranche"])

    def test_legacy_fixed_three_tranche_state_migrates_to_dynamic_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            state_file = Path(directory) / "state.json"
            state_file.write_text(json.dumps({"max_tranches": 3, "tranches": []}))
            bot = LighterPairBot(Mock(), state_file)
            self.assertEqual(bot.state["capacity_mode"], "DYNAMIC_SAFE_LEVERAGE")
            self.assertEqual(bot.state["max_tranches"], 12)
            self.assertEqual(bot.state["gross_leverage_cap"], 8.0)

    def test_mixed_campaign_reconciles_to_actual_net_position_without_order(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Mock()
            bot = LighterPairBot(client, Path(directory) / "state.json")
            longs = [{"side": 1, "adr_qty": 0.1303, "domestic_qty": 0.013, "time": i} for i in range(3)]
            shorts = [{"side": -1, "adr_qty": 0.1303, "domestic_qty": 0.013, "time": 10 + i} for i in range(9)]
            bot.state["tranches"] = longs + shorts
            changed = bot._reconcile_mixed_campaign([
                {"market_id": 216, "position": "0.7818", "sign": -1},
                {"market_id": 161, "position": "0.078", "sign": 1},
            ])
            self.assertTrue(changed)
            self.assertEqual(len(bot.state["tranches"]), 6)
            self.assertEqual({row["side"] for row in bot.state["tranches"]}, {-1})
            self.assertEqual(bot.state["last_reconciliation"]["removed_offset_records"], 6)
            client.create_market_order.assert_not_called()

    def test_existing_campaign_blocks_opposite_direction_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterPairBot(Mock(), Path(directory) / "state.json")
            bot.state["tranches"] = [{"side": -1}]
            self.assertTrue(bot._campaign_allows_side(-1))
            self.assertFalse(bot._campaign_allows_side(1))

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
            result = await client.create_market_order(216, 0.04, 180.0, True)
            order_index = signer.create_market_order.await_args.args[1]
            self.assertGreater(order_index, 0)
            self.assertLessEqual(order_index, LighterClient.MAX_CLIENT_ORDER_INDEX)
            self.assertEqual(result["client_order_index"], order_index)

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


if __name__ == "__main__":
    unittest.main()
