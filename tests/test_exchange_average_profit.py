import unittest

from backend.tranche_accounting import estimate_exchange_average_exit


class ExchangeAverageProfitGuardTests(unittest.TestCase):
    def test_profitable_exchange_reduction_passes(self):
        result = estimate_exchange_average_exit(196, 5.6, 193.2, 5.7)
        self.assertTrue(result['available'])
        self.assertTrue(result['profitable'])
        self.assertGreater(result['net_pnl_usd'], result['threshold_usd'])

    def test_profitable_lifo_prices_cannot_hide_average_cost_loss(self):
        result = estimate_exchange_average_exit(190, 5.6, 193.2, 5.7)
        self.assertTrue(result['available'])
        self.assertFalse(result['profitable'])
        self.assertLess(result['net_pnl_usd'], 0)

    def test_missing_exchange_entry_price_fails_closed(self):
        result = estimate_exchange_average_exit(0, 5.6, 193.2, 5.7)
        self.assertFalse(result['available'])
        self.assertFalse(result['profitable'])


if __name__ == '__main__':
    unittest.main()
