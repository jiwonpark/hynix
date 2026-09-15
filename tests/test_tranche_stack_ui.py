import pathlib
import unittest


class TrancheStackUITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (pathlib.Path(__file__).parent.parent / 'index.html').read_text()

    def test_stack_panel_and_top_exit_are_visible(self):
        self.assertIn('id="lifoTrancheStack"', self.html)
        self.assertIn('LIFO TRANCHE STACK', self.html)
        self.assertIn('TOP · NEXT EXIT', self.html)
        self.assertIn('newest exits first', self.html)

    def test_stack_shows_pair_prices_orders_targets_and_profit(self):
        for field in ('estimated_net_pnl_usd', 'paired_stock_order_id',
                      'entry_price', 'stock_entry_price', 'target_out_spread'):
            self.assertIn(field, self.html)
        self.assertNotIn('<span>Min profit', self.html)

    def test_old_queue_label_is_removed(self):
        self.assertNotIn('LIFO Queue:', self.html)
        self.assertNotIn('Queue Empty', self.html)

    def test_account_strip_starts_in_neutral_sync_state(self):
        self.assertIn('id="badgeEquitySource"', self.html)
        self.assertIn('>SYNCING</span>', self.html)
        self.assertIn('accountSyncPending: true', self.html)
        self.assertNotIn('id="valAccountEquity" style="color: #0284c7; font-size: 16px;">$10,000.00', self.html)

    def test_entry_and_exit_condition_checklists_are_visible(self):
        # Entry conditions
        self.assertIn('id="entryConditionsChecklist"', self.html)
        self.assertIn('1. MA-24 Stretch', self.html)
        self.assertIn('2. Base Entry Spread', self.html)
        self.assertIn('3. 5m Peak Rollover Filter', self.html)
        self.assertIn('4. Dynamic Tranche Capacity', self.html)
        self.assertIn('5. Gross Leverage Cap', self.html)
        self.assertIn('6. Buffered Margin Check', self.html)
        self.assertIn('7. Worker State & Cooldown', self.html)

        # Exit conditions
        self.assertIn('id="exitConditionsChecklist"', self.html)
        self.assertIn('1. Active Speculative Tranche', self.html)
        self.assertIn('2. Spread Convergence Target', self.html)
        self.assertIn('3. Net Profit (> +$0.02 USD)', self.html)
        self.assertIn('4. Anti-Churn Dwell (≥ 120s)', self.html)
        self.assertIn('5. Bearish MA Stack (5m + 1h)', self.html)
        self.assertIn('6. Bottoming-Out Filter', self.html)
        self.assertIn('7. Position Sufficiency Check', self.html)

