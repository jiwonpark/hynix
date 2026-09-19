import unittest

from backend.strategy_lab import run_ma_stack_backtest


def candles(start, count, step, prices):
    rows = []
    for index in range(count):
        close = float(prices[index])
        rows.append({
            "time": start + (index + 1) * step,
            "open": close - 0.25,
            "high": close + 1,
            "low": close - 1,
            "close": close,
            "volume": 1,
        })
    return rows


class StrategyLabTests(unittest.TestCase):
    def test_dual_stack_enters_at_next_five_minute_open(self):
        five_prices = list(range(180, 100, -1))
        hour_prices = list(range(180, 100, -1))
        five = candles(0, len(five_prices), 300, five_prices)
        hourly = candles(-60 * 3600, len(hour_prices), 3600, hour_prices)
        result = run_ma_stack_backtest(five, hourly, fee_bps=5)
        entries = [marker for marker in result["markers"] if marker["is_entry"]]
        self.assertTrue(entries)
        signal_index = next(i for i, row in enumerate(result["bars"]) if row["bearish"])
        expected_fill = result["bars"][signal_index + 1]
        self.assertEqual(entries[0]["time"], expected_fill["time"])
        self.assertEqual(entries[0]["entry_price"], expected_fill["open"])
        self.assertEqual(entries[0]["shape"], "arrowUp")

    def test_hourly_stack_is_required_when_enabled(self):
        five = candles(0, 80, 300, list(range(180, 100, -1)))
        rising_hours = candles(-60 * 3600, 80, 3600, list(range(100, 180)))
        blocked = run_ma_stack_backtest(five, rising_hours, entry_1h=True)
        allowed = run_ma_stack_backtest(five, rising_hours, entry_1h=False)
        self.assertFalse(any(marker["is_entry"] for marker in blocked["markers"]))
        self.assertTrue(any(marker["is_entry"] for marker in allowed["markers"]))

    def test_dual_stack_exits_on_bullish_stack(self):
        five_prices = list(range(180, 100, -1)) + list(range(100, 200))
        hour_prices = list(range(180, 100, -1)) + list(range(100, 200))
        five = candles(0, len(five_prices), 300, five_prices)
        hourly = candles(-60 * 3600, len(hour_prices), 3600, hour_prices)
        result = run_ma_stack_backtest(five, hourly, fee_bps=5)
        exits = [marker for marker in result["markers"] if not marker["is_entry"]]
        self.assertTrue(exits)
        self.assertEqual(exits[0]["shape"], "arrowDown")

    def test_multi_tranche_lifo_queue(self):
        # 100 bars falling (multiple dip entries up to capacity 3), then 100 bars rising (LIFO exits)
        five_prices = list(range(200, 100, -1)) + list(range(100, 200))
        hour_prices = list(range(200, 100, -1)) + list(range(100, 200))
        five = candles(0, len(five_prices), 300, five_prices)
        hourly = candles(-60 * 3600, len(hour_prices), 3600, hour_prices)
        result = run_ma_stack_backtest(five, hourly, max_tranches=3, fee_bps=5)
        entries = [m for m in result["markers"] if m["is_entry"]]
        exits = [m for m in result["markers"] if not m["is_entry"]]
        self.assertEqual(len(entries), 3)
        self.assertEqual(len(exits), 3)
        self.assertEqual(len(result["trades"]), 3)
        # Verify LIFO: newest entry was T3, so first exit should close T3
        self.assertEqual(result["trades"][0]["id"], "T3")
        self.assertEqual(result["trades"][1]["id"], "T2")
        self.assertEqual(result["trades"][2]["id"], "T1")

    def test_bollinger_zscore_framework(self):
        # Generate range-bound price with a sharp dip below lower band
        prices = [100.0] * 30 + [92.0, 90.0, 88.0, 91.0] + [100.0] * 30
        five = candles(0, len(prices), 300, prices)
        hourly = candles(-60 * 3600, 60, 3600, [100.0] * 60)
        result = run_ma_stack_backtest(five, hourly, strategy_mode="bollinger_zscore")
        self.assertEqual(result["strategy"], "bollinger_zscore")
        self.assertIn("BOLLINGER", result["strategy_badge"])
        self.assertTrue(any(m["is_entry"] for m in result["markers"]))

    def test_rsi_momentum_framework(self):
        # Generate selloff dropping RSI < 30
        prices = [150.0] * 20 + list(range(150, 90, -2)) + list(range(90, 150, 2))
        five = candles(0, len(prices), 300, prices)
        hourly_prices = [150.0] * 20 + [140, 130, 120, 110, 100, 90, 95, 110, 130]
        hourly = candles(-20 * 3600, len(hourly_prices), 3600, hourly_prices)
        result = run_ma_stack_backtest(five, hourly, strategy_mode="rsi_momentum")
        self.assertEqual(result["strategy"], "rsi_momentum")
        self.assertIn("RSI", result["strategy_badge"])
        self.assertTrue(any(m["is_entry"] for m in result["markers"]))

    def test_multi_factor_voting_framework(self):
        prices = list(range(160, 100, -1)) + list(range(100, 160))
        five = candles(0, len(prices), 300, prices)
        hourly = candles(-60 * 3600, 60, 3600, list(range(100, 160)))
        result = run_ma_stack_backtest(five, hourly, strategy_mode="multi_factor")
        self.assertEqual(result["strategy"], "multi_factor")
        self.assertIn("VOTING", result["strategy_badge"])
        self.assertTrue("presets" in result)
        self.assertEqual(len(result["presets"]), 5)

    def test_ou_quant_framework(self):
        prices = [100.0] * 50 + [85.0, 84.0, 83.0] + [100.0] * 40
        five = candles(0, len(prices), 300, prices)
        hourly = candles(-60 * 3600, 60, 3600, [100.0] * 60)
        result = run_ma_stack_backtest(five, hourly, strategy_mode="ou_quant")
        self.assertEqual(result["strategy"], "ou_quant")
        self.assertIn("OU", result["strategy_badge"])


if __name__ == "__main__":
    unittest.main()
