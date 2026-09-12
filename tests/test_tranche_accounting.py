import unittest
from backend.tranche_accounting import estimate_tranche_exit


class TrancheAccountingTests(unittest.TestCase):
    def trade(self, symbol, order, side, qty, price, time, fee=.001, fill=None):
        return dict(symbol=symbol, order_id=str(order), id=str(fill if fill is not None else order),
                    side=side, qty=qty, price=price, time=time, commission=fee, commission_asset='USDT')

    def entries(self, adr_price=196, etf_price=5.6, order=1, time=1000000):
        return [self.trade('SKHYUSDT', order, 'SELL', .08, adr_price, time),
                self.trade('CSOPSKHYNIX2LUSDT', order, 'BUY', 1.4, etf_price, time+1000)]

    def estimate(self, trades, target='1', pairs=None):
        return estimate_tranche_exit({'trade_id': target, 'trim_qty': .07}, trades,
                                     195, 5.7, 'CSOPSKHYNIX2LUSDT', pairs or [], 2000)

    def test_latest_losing_entry_cannot_borrow_profit_from_older_entry(self):
        trades = self.entries(210, 4, 1) + self.entries(190, 6, 2, 1100000)
        result = self.estimate(trades, '2')
        self.assertTrue(result['available'])
        self.assertFalse(result['profitable'])
        self.assertAlmostEqual(result['gross_pnl_usd'], .07*(190-195)+1.2*(5.7-6))
        self.assertEqual(result['stock_order_id'], '2')

    def test_uses_exact_trim_quantities_and_all_cost_reserves(self):
        result = self.estimate(self.entries())
        self.assertTrue(result['profitable'])
        self.assertEqual(result['threshold_usd'], .02)
        self.assertAlmostEqual(result['gross_pnl_usd'], .19)
        self.assertAlmostEqual(result['entry_fees_usd'], .001*.07/.08 + .001*1.2/1.4)
        self.assertAlmostEqual(result['net_pnl_usd'], result['gross_pnl_usd'] - sum(result[k] for k in
                               ['entry_fees_usd', 'estimated_exit_fee_usd', 'slippage_reserve_usd', 'funding_reserve_usd']))

    def test_small_gross_gain_is_blocked_after_costs(self):
        result = self.estimate(self.entries(195.1, 5.69))
        self.assertGreater(result['gross_pnl_usd'], 0)
        self.assertFalse(result['profitable'])

    def test_missing_pair_is_blocked(self):
        self.assertFalse(self.estimate(self.entries()[:1])['available'])

    def test_rapid_sequential_entries_restore_from_account_history(self):
        trades = []
        for order, timestamp in [(1, 1000000), (2, 1001000), (3, 1002000)]:
            trades.extend(self.entries(order=order, time=timestamp))
        result = self.estimate(trades, '3')
        self.assertTrue(result['available'])
        self.assertEqual(result['stock_order_id'], '3')
        self.assertEqual(result['pairing'], 'restored_from_account_history_sequence')

    def test_multiple_hedges_before_next_adr_is_ambiguous(self):
        trades = self.entries() + [self.trade('CSOPSKHYNIX2LUSDT', 3, 'BUY', 1.4, 5.6, 1001500)]
        self.assertFalse(self.estimate(trades)['available'])

    def test_recorded_pair_ids_resolve_legacy_ambiguity(self):
        trades = self.entries() + [self.trade('CSOPSKHYNIX2LUSDT', 3, 'BUY', 1.4, 5.6, 1002000)]
        result = self.estimate(trades, pairs=[{'adr_order_id': '1', 'stock_order_id': '3'}])
        self.assertTrue(result['available'])
        self.assertEqual(result['pairing'], 'recorded_order_ids')

    def test_missing_or_non_usdt_commission_blocks(self):
        trades = self.entries()
        trades[0]['commission'] = None
        self.assertFalse(self.estimate(trades)['available'])
        trades[0]['commission'] = .001
        trades[0]['commission_asset'] = 'BNB'
        self.assertFalse(self.estimate(trades)['available'])

    def test_partial_fills_use_weighted_entry_and_deduplicate(self):
        trades = [self.trade('SKHYUSDT', 1, 'SELL', .03, 198, 1000000, fill=11),
                  self.trade('SKHYUSDT', 1, 'SELL', .05, 196, 1000001, fill=12),
                  self.entries()[1]]
        trades.append(trades[0])
        result = self.estimate(trades)
        self.assertTrue(result['available'])
        self.assertAlmostEqual(result['adr_entry_price'], (.03*198+.05*196)/.08)

    def test_hedge_exit_cannot_be_matched_to_unrelated_older_hedge(self):
        trades = self.entries(order=1) + self.entries(order=2, time=1100000)
        trades += [self.trade('CSOPSKHYNIX2LUSDT', 3, 'SELL', 1.2, 5.7, 1200000)]
        self.assertFalse(self.estimate(trades, '2')['available'])

    def test_split_hedge_exit_leaves_older_pair_available(self):
        trades = self.entries(order=1) + self.entries(order=2, time=1100000)
        trades += [self.trade('CSOPSKHYNIX2LUSDT', 3, 'SELL', .5, 5.7, 1200000, fill=31),
                   self.trade('CSOPSKHYNIX2LUSDT', 3, 'SELL', .7, 5.7, 1200001, fill=32)]
        self.assertTrue(self.estimate(trades, '1')['available'])
