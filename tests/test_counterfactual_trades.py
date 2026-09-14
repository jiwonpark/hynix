import unittest

from backend.counterfactual_trades import chart_markers, update_counterfactual_trades


class CounterfactualTradeTests(unittest.TestCase):
    def criteria(self, **overrides):
        values = {
            "scale_in_setup": True,
            "scale_in_blocked_reason": "POSITION_CAPACITY",
            "current_spread": 141.0,
            "is_bottoming_out": False,
            "is_exit_ma_aligned": False,
        }
        values.update(overrides)
        return values

    def test_records_only_capital_blocked_strategy_setups(self):
        state = {}
        self.assertTrue(update_counterfactual_trades(state, self.criteria(), 200, 5, now=1001))
        trade = state["counterfactual_trades"][0]
        self.assertEqual(trade["blocked_reason"], "POSITION_CAPACITY")
        self.assertEqual(trade["status"], "OPEN")
        self.assertFalse(update_counterfactual_trades(state, self.criteria(), 200, 5, now=1002),
                         "the worker must record at most one missed entry per strategy candle")
        self.assertFalse(update_counterfactual_trades(
            {}, self.criteria(scale_in_blocked_reason=None), 200, 5, now=1001))
        self.assertFalse(update_counterfactual_trades(
            {}, self.criteria(scale_in_setup=False), 200, 5, now=1001))

    def test_exit_uses_virtual_trade_profit_and_all_live_gates(self):
        state = {}
        update_counterfactual_trades(state, self.criteria(), 200, 5, now=1001)
        profitable = self.criteria(
            scale_in_setup=False,
            scale_in_blocked_reason=None,
            current_spread=140.5,
            is_bottoming_out=True,
            is_exit_ma_aligned=True,
        )
        self.assertFalse(update_counterfactual_trades(state, profitable, 190, 6, now=1100),
                         "the same two-minute dwell used by live exits must apply")
        self.assertTrue(update_counterfactual_trades(state, profitable, 190, 6, now=1301))
        trade = state["counterfactual_trades"][0]
        self.assertEqual(trade["status"], "CLOSED")
        self.assertGreater(trade["estimated_net_pnl_usd"], 0.02)

    def test_chart_markers_are_outline_entry_and_exit_pairs(self):
        state = {}
        update_counterfactual_trades(state, self.criteria(), 200, 5, now=1001)
        exit_criteria = self.criteria(
            scale_in_setup=False,
            scale_in_blocked_reason=None,
            current_spread=140.5,
            is_bottoming_out=True,
            is_exit_ma_aligned=True,
        )
        update_counterfactual_trades(state, exit_criteria, 190, 6, now=1301)
        bars = [{"time": 900}, {"time": 1200}, {"time": 1500}]
        markers = chart_markers(state["counterfactual_trades"], bars, 300000)
        self.assertEqual([marker["outlineGlyph"] for marker in markers], ["⇩", "⇧"])
        self.assertTrue(all(marker["hypothetical"] for marker in markers))
        self.assertIn("POSITION CAPACITY", markers[0]["hoverText"])
        self.assertIn("est. net", markers[1]["hoverText"])
        self.assertIn("pnl_model", markers[0])


if __name__ == "__main__":
    unittest.main()
