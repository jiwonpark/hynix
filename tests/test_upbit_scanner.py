import unittest

from backend.upbit_scanner import forecast_coin, rank_universe


def candles(count=200, drift=0.001, volume_boost=False):
    rows = []
    price = 100.0
    for index in range(count):
        cycle = ((index % 9) - 4) * 0.0006
        price *= 1 + drift + cycle
        volume = 100.0 * (2.0 if volume_boost and index >= count - 3 else 1.0)
        rows.append({"time": index * 3600, "open": price * .999, "high": price * 1.012,
                     "low": price * .994, "close": price, "volume": volume})
    return rows


class UpbitScannerTests(unittest.TestCase):
    def test_forecast_is_causal_and_bounded(self):
        result = forecast_coin({"acc_trade_price_24h": 123}, candles(volume_boost=True))
        self.assertGreaterEqual(result["forecast_probability_pct"], 0)
        self.assertLessEqual(result["forecast_probability_pct"], 100)
        self.assertGreater(result["historical_samples"], 100)
        self.assertEqual(result["analogue_samples"], 25)
        self.assertGreater(result["volume_acceleration"], 1.7)
        self.assertEqual(result["trade_value_24h_krw"], 123)
        self.assertGreater(result["backtest"]["predictions"], 0)
        self.assertGreaterEqual(result["backtest"]["brier_score"], 0)
        self.assertLessEqual(result["backtest"]["brier_score"], 1)

    def test_ranking_prefers_confidence_adjusted_probability(self):
        rows = [
            {"market": "KRW-LOW", "score": 51, "expected_return_6h_pct": 0.1, "trade_value_24h_krw": 10},
            {"market": "KRW-HIGH", "score": 62, "expected_return_6h_pct": 0.5, "trade_value_24h_krw": 5},
        ]
        ranked = rank_universe(rows)
        self.assertEqual(ranked[0]["market"], "KRW-HIGH")
        self.assertEqual([row["rank"] for row in ranked], [1, 2])

    def test_future_candles_do_not_change_past_feature_snapshot(self):
        base = candles(100)
        first = forecast_coin({}, base)
        extended = base + [{"time": 100 * 3600, "open": 100, "high": 1000, "low": 1, "close": 500, "volume": 99999}]
        second = forecast_coin({}, extended[:-1])
        self.assertEqual(first["momentum_1h_pct"], second["momentum_1h_pct"])


if __name__ == "__main__":
    unittest.main()
