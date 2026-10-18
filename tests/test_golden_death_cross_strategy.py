import unittest
from pathlib import Path
import tempfile
from unittest.mock import MagicMock
from backend.lighter_strategy import (
    evaluate_golden_death_cross_signals,
    evaluate_strategy_signal,
    LIVE_STRATEGIES,
)
from backend.crypto_bot import CryptoBot
from backend.lighter_crypto_bot import LighterCryptoBot


class TestGoldenDeathCrossStrategy(unittest.TestCase):
    def test_golden_death_cross_live_strategies_registration(self):
        self.assertIn("golden_death_cross", LIVE_STRATEGIES)

    def test_golden_cross_long_entry_and_exit(self):
        # Fast MA = 3, Slow MA = 5
        # Bar t-1:
        # Fast MA: average of last 3 excluding latest: prices[-4:-1]
        # Slow MA: average of last 5 excluding latest: prices[-6:-1]
        # We want fast_prev <= slow_prev, then fast_curr > slow_curr
        # prices = [100.0, 100.0, 100.0, 95.0, 95.0, 110.0]
        # For fast=3:
        # fast_prev = (100.0 + 95.0 + 95.0) / 3 = 96.6667
        # fast_curr = (95.0 + 95.0 + 110.0) / 3 = 100.0
        # For slow=5:
        # slow_prev = (100.0 + 100.0 + 100.0 + 95.0 + 95.0) / 5 = 98.0
        # slow_curr = (100.0 + 100.0 + 95.0 + 95.0 + 110.0) / 5 = 100.0
        # Wait, here fast_curr == slow_curr. Let prices[-1] = 115.0:
        # fast_curr = (95 + 95 + 115) / 3 = 101.6667
        # slow_curr = (100 + 100 + 95 + 95 + 115) / 5 = 101.0
        # fast_prev = 96.6667 <= slow_prev = 98.0 -> Golden Cross!
        prices = [100.0, 100.0, 100.0, 95.0, 95.0, 115.0]
        entry, side, exit_sig, details = evaluate_golden_death_cross_signals(
            prices,
            fast_ma_period=3,
            slow_ma_period=5,
            min_cross_spread_bps=0.0,
            use_golden_cross=True,
            use_death_cross=True,
            use_cross_spread=True,
            use_cross_exit=True,
            use_ma_stack_1h=False,
        )
        self.assertTrue(entry)
        self.assertEqual(side, 1)
        self.assertTrue(details["golden_cross"])
        self.assertFalse(details["death_cross"])
        self.assertTrue(details["condition_pass"]["entry_golden_cross"])

        # Now test long exit when Death Cross occurs:
        # prices drop sharply: [100.0, 100.0, 105.0, 105.0, 105.0, 80.0]
        # fast_prev = (105 + 105 + 105) / 3 = 105.0
        # slow_prev = (100 + 105 + 105 + 105 + 105) / 5 = 104.0 (fast_prev > slow_prev)
        # fast_curr = (105 + 105 + 80) / 3 = 96.667
        # slow_curr = (105 + 105 + 105 + 105 + 80) / 5 = 100.0 (fast_curr < slow_curr) -> Death cross!
        exit_prices = [100.0, 105.0, 105.0, 105.0, 105.0, 80.0]
        _, _, exit_sig_hit, details_exit = evaluate_golden_death_cross_signals(
            exit_prices,
            fast_ma_period=3,
            slow_ma_period=5,
            position_side=1,
            entry_price=115.0,
            use_cross_exit=True,
            use_ma_stack_1h=False,
        )
        self.assertTrue(exit_sig_hit)
        self.assertTrue(details_exit["condition_pass"]["exit_cross"])

    def test_death_cross_short_entry_and_exit(self):
        # Short setup: Fast crosses below Slow
        prices = [100.0, 105.0, 105.0, 105.0, 105.0, 80.0]
        entry, side, exit_sig, details = evaluate_golden_death_cross_signals(
            prices,
            fast_ma_period=3,
            slow_ma_period=5,
            min_cross_spread_bps=0.0,
            use_golden_cross=True,
            use_death_cross=True,
            use_cross_spread=True,
            use_cross_exit=True,
            use_ma_stack_1h=False,
        )
        self.assertTrue(entry)
        self.assertEqual(side, -1)
        self.assertTrue(details["death_cross"])
        self.assertFalse(details["golden_cross"])
        self.assertTrue(details["condition_pass"]["entry_death_cross"])

        # Short exit on Golden Cross
        cover_prices = [100.0, 100.0, 100.0, 95.0, 95.0, 115.0]
        _, _, exit_sig_hit, details_exit = evaluate_golden_death_cross_signals(
            cover_prices,
            fast_ma_period=3,
            slow_ma_period=5,
            position_side=-1,
            entry_price=80.0,
            use_cross_exit=True,
            use_ma_stack_1h=False,
        )
        self.assertTrue(exit_sig_hit)
        self.assertTrue(details_exit["condition_pass"]["exit_cross"])

    def test_spread_threshold_filtering(self):
        # Spread is: fast_curr = 101.6667, slow_curr = 101.0 => spread_bps = 66 bps
        prices = [100.0, 100.0, 100.0, 95.0, 95.0, 115.0]
        # With min_cross_spread_bps = 100 bps: blocked
        entry_blocked, _, _, details_blocked = evaluate_golden_death_cross_signals(
            prices,
            fast_ma_period=3,
            slow_ma_period=5,
            min_cross_spread_bps=100.0,
            use_cross_spread=True,
            use_ma_stack_1h=False,
        )
        self.assertFalse(entry_blocked)
        self.assertFalse(details_blocked["condition_pass"]["entry_cross_spread"])

        # With min_cross_spread_bps = 50 bps: allowed
        entry_allowed, _, _, details_allowed = evaluate_golden_death_cross_signals(
            prices,
            fast_ma_period=3,
            slow_ma_period=5,
            min_cross_spread_bps=50.0,
            use_cross_spread=True,
            use_ma_stack_1h=False,
        )
        self.assertTrue(entry_allowed)
        self.assertTrue(details_allowed["condition_pass"]["entry_cross_spread"])

    def test_condition_toggles(self):
        prices = [100.0, 100.0, 100.0, 95.0, 95.0, 115.0]
        # Golden cross occurs, but use_golden_cross=False: entry must be blocked
        entry_disabled, _, _, _ = evaluate_golden_death_cross_signals(
            prices,
            fast_ma_period=3,
            slow_ma_period=5,
            use_golden_cross=False,
            use_ma_stack_1h=False,
        )
        self.assertFalse(entry_disabled)

    def test_evaluate_strategy_signal_dispatch(self):
        config = {
            "fast_ma_period": 3,
            "slow_ma_period": 5,
            "min_cross_spread_bps": 0.0,
            "use_golden_cross": True,
            "use_death_cross": True,
            "use_cross_exit": True,
            "use_ma_stack_1h": False,
        }
        prices = [100.0, 100.0, 100.0, 95.0, 95.0, 115.0]
        entry, side, exit_sig, details = evaluate_strategy_signal("golden_death_cross", prices, config)
        self.assertTrue(entry)
        self.assertEqual(side, 1)
        self.assertEqual(details["strategy"], "golden_death_cross")

    async def async_test_crypto_bots_golden_death_cross_state_and_config(self):
        with tempfile.NamedTemporaryFile() as tmp4, tempfile.NamedTemporaryFile() as tmp5:
            client4 = MagicMock()
            bot4 = CryptoBot(client4, Path(tmp4.name))
            state4 = bot4.public_state()
            self.assertEqual(state4["fast_ma_period"], 9)
            self.assertEqual(state4["slow_ma_period"], 21)
            self.assertTrue(state4["use_golden_cross"])
            self.assertTrue(state4["use_death_cross"])
            self.assertTrue(state4["use_cross_exit"])

            cfg4 = await bot4.configure({
                "strategy_mode": "golden_death_cross",
                "fast_ma_period": 12,
                "slow_ma_period": 26,
                "min_cross_spread_bps": 5.0,
                "use_death_cross": False,
            })
            self.assertEqual(cfg4["strategy_mode"], "golden_death_cross")
            self.assertEqual(cfg4["fast_ma_period"], 12)
            self.assertEqual(cfg4["slow_ma_period"], 26)
            self.assertEqual(cfg4["min_cross_spread_bps"], 5.0)
            self.assertFalse(cfg4["use_death_cross"])

            client5 = MagicMock()
            bot5 = LighterCryptoBot(client5, Path(tmp5.name))
            state5 = bot5.public_state()
            self.assertEqual(state5["fast_ma_period"], 9)
            self.assertEqual(state5["slow_ma_period"], 21)

            cfg5 = await bot5.configure({
                "strategy_mode": "golden_death_cross",
                "fast_ma_period": 7,
                "slow_ma_period": 25,
                "use_cross_exit": False,
            })
            self.assertEqual(cfg5["strategy_mode"], "golden_death_cross")
            self.assertEqual(cfg5["fast_ma_period"], 7)
            self.assertEqual(cfg5["slow_ma_period"], 25)
            self.assertFalse(cfg5["use_cross_exit"])

    def test_crypto_bots_golden_death_cross_state_and_config(self):
        import asyncio
        asyncio.run(self.async_test_crypto_bots_golden_death_cross_state_and_config())


if __name__ == "__main__":
    unittest.main()
