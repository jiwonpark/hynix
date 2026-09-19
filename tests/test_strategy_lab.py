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


if __name__ == "__main__":
    unittest.main()
