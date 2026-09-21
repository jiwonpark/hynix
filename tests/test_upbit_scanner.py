import unittest

from backend.upbit_scanner import coin_factors, rank_universe


class UpbitScannerTests(unittest.TestCase):
    def test_rising_liquid_coin_ranks_above_falling_coin(self):
        def row(market, closes, liquidity):
            factors = coin_factors({"acc_trade_price_24h": liquidity},
                                   [{"close": close} for close in closes])
            return {"market": market, **factors}

        rising = row("KRW-UP", [100 + i for i in range(49)], 10_000_000_000)
        falling = row("KRW-DOWN", [200 - i for i in range(49)], 1_000_000_000)
        ranked = rank_universe([falling, rising])
        self.assertEqual(ranked[0]["market"], "KRW-UP")
        self.assertEqual([item["rank"] for item in ranked], [1, 2])
        self.assertGreaterEqual(ranked[0]["score"], ranked[1]["score"])

    def test_factor_values_use_completed_series(self):
        result = coin_factors({"acc_trade_price_24h": 123},
                              [{"close": 100 + i} for i in range(49)])
        self.assertGreater(result["momentum_24h_pct"], 0)
        self.assertEqual(result["trend_consistency_pct"], 100)
        self.assertEqual(result["trade_value_24h_krw"], 123)


if __name__ == "__main__":
    unittest.main()
