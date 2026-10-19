import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock
from backend.lighter_strategy import (
    evaluate_ma_stack_signals,
)
from backend.lighter_crypto_bot import LighterCryptoBot
from backend.crypto_bot import CryptoBot


class TestMADiff(unittest.TestCase):
    def test_ma_diff_hook_entry_trigger(self):
        # 5 consecutive bars of increasingly negative diff (-9.40 -> -14.17)
        # followed by the first bar that turns less negative (-13.54).
        # All while staying in full bearish stack (cp < ma7 < ma24 < ma60).
        test_prices = [100.0] * 36 + [80.0] * 17 + [60.0] * 7 + [58.0]

        entry, side, exit_sig, details = evaluate_ma_stack_signals(
            test_prices,
            use_ma_stack=True,
            use_ma_diff_hook=True,
            use_opposite_stack_exit=False,
            use_ma_diff_exit=False,
            ma_stack_opposite_only=True,
            min_diff_bars=2,
        )

        conds = details.get("condition_pass", {})
        assert "entry_ma_diff_hook" in conds
        assert "exit_ma_diff_hook" in conds
        assert "ma_diff" in details
        assert details["bearish_stack"] is True
        assert details["diff_entry_hook"] is True
        assert conds["entry_ma_stack"] is True
        assert conds["entry_ma_diff_hook"] is True
        assert entry is True
        assert side == 1


    def test_ma_diff_hook_no_trigger_when_continuing_down(self):
        # Continue down without hook: [100]*36 + [80]*17 + [60]*7 + [50.0]
        # where diff continues to become more negative
        test_prices = [100.0] * 36 + [80.0] * 17 + [60.0] * 7 + [50.0]

        entry, side, exit_sig, details = evaluate_ma_stack_signals(
            test_prices,
            use_ma_stack=True,
            use_ma_diff_hook=True,
            ma_stack_opposite_only=True,
            min_diff_bars=2,
        )

        conds = details.get("condition_pass", {})
        assert conds["entry_ma_diff_hook"] is False
        assert entry is False


    def test_ma_diff_exit_trigger(self):
        # Bullish stack with diff increasing (+9.40 -> +14.17)
        # then turning less positive (+13.54) for the first time
        test_prices = [50.0] * 36 + [70.0] * 17 + [90.0] * 7 + [92.0]

        entry, side, exit_sig, details = evaluate_ma_stack_signals(
            test_prices,
            position_side=1,
            entry_price=60.0,
            use_ma_stack=False,
            use_opposite_stack_exit=False,
            use_ma_diff_exit=True,
            ma_stack_opposite_only=True,
            min_diff_bars=2,
        )

        conds = details.get("condition_pass", {})
        assert details["diff_exit_hook"] is True
        assert conds["exit_ma_diff_hook"] is True
        assert exit_sig is True


    def test_ma_stack_toggle_controls(self):
        # Continuing down without hook
        test_prices = [100.0] * 36 + [80.0] * 17 + [60.0] * 7 + [50.0]

        # When use_ma_diff_hook is disabled (False), bearish stack alone triggers
        entry, side, exit_sig, details = evaluate_ma_stack_signals(
            test_prices,
            use_ma_stack=True,
            use_ma_diff_hook=False,
            ma_stack_opposite_only=True,
        )
        assert details["bearish_stack"] is True
        assert entry is True

        # But when use_ma_diff_hook is enabled (True), it blocks entry because diff did not hook
        entry_hook, _, _, details_hook = evaluate_ma_stack_signals(
            test_prices,
            use_ma_stack=True,
            use_ma_diff_hook=True,
            ma_stack_opposite_only=True,
        )
        assert details_hook["diff_entry_hook"] is False
        assert entry_hook is False


    def test_diff_only_replay_keeps_live_long_direction(self):
        from backend.server import _run_crypto_backtest_sync
        prices = [100.0] * 36 + [80.0] * 17 + [60.0] * 8
        config = dict(ma_stack_opposite_only=True, use_ma_stack=False,
                      use_ma_diff_hook=True, min_diff_bars=2)
        entry, side, _, details = evaluate_ma_stack_signals(prices, **config)
        assert entry and side == 1 and not details["bearish_stack"]
        result = _run_crypto_backtest_sync(
            [{"time": i * 300, "value": p} for i, p in enumerate(prices)],
            True, strategy_mode="ma_stack", **config,
        )
        assert result["entry_signals"][-1]["side"] == side
        assert result["open_positions"][-1]["side"] == side


class TestMABotConfig(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.tmp_path = Path(temporary.name)

    async def test_lighter_bot_ma_diff_params(self):
        bot = LighterCryptoBot(client=MagicMock(), state_path=self.tmp_path / "lighter.json")
        config = {
            "strategy_mode": "ma_stack",
            "use_ma_stack": True,
            "use_ma_diff_hook": True,
            "use_ma_diff_exit": True,
            "min_diff_bars": 3,
        }
        await bot.configure(config)
        assert bot.state["strategy_mode"] == "ma_stack"
        assert bot.state["use_ma_diff_hook"] is True
        assert bot.state["use_ma_diff_exit"] is True
        assert bot.state["min_diff_bars"] == 3
        for invalid in (0, 11):
            with self.assertRaises(ValueError):
                await bot.configure({"min_diff_bars": invalid})


    async def test_crypto_bot_ma_diff_params(self):
        bot = CryptoBot(client=MagicMock(), state_path=self.tmp_path / "crypto.json")
        config = {
            "strategy_mode": "ma_stack",
            "use_ma_stack": True,
            "use_ma_diff_hook": True,
            "use_ma_diff_exit": True,
            "min_diff_bars": 3,
        }
        await bot.configure(config)
        assert bot.state["strategy_mode"] == "ma_stack"
        assert bot.state["use_ma_diff_hook"] is True
        assert bot.state["use_ma_diff_exit"] is True
        assert bot.state["min_diff_bars"] == 3
        for invalid in (0, 11):
            with self.assertRaises(ValueError):
                await bot.configure({"min_diff_bars": invalid})


if __name__ == "__main__":
    unittest.main()
