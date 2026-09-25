import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from backend.lighter_bot import LighterPairBot, classify_trend


class TestLighterTrend(unittest.TestCase):
    def test_classifies_up_and_down_without_future_values(self):
        self.assertEqual(classify_trend([100 + index for index in range(30)])["direction"], "UPTREND")
        self.assertEqual(classify_trend([130 - index for index in range(30)])["direction"], "DOWNTREND")
        self.assertEqual(classify_trend([100] * 30)["direction"], "SIDEWAYS")
        self.assertEqual(classify_trend([100] * 10)["direction"], "UNKNOWN")


class TestLighterPairBot(unittest.TestCase):
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

    def test_disabled_worker_never_touches_exchange(self):
        async def run():
            with tempfile.TemporaryDirectory() as directory:
                client = Mock()
                bot = LighterPairBot(client, Path(directory) / "state.json")
                await bot.run_once()
                client.account_status.assert_not_called()
                client.create_market_order.assert_not_called()

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

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
