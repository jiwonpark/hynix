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

    def test_old_queue_label_is_removed(self):
        self.assertNotIn('LIFO Queue:', self.html)
        self.assertNotIn('Queue Empty', self.html)
