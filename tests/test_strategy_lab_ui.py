import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class StrategyLabUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.js = (ROOT / "strategy-lab.js").read_text(encoding="utf-8")

    def test_strategy_lab_is_a_primary_destination(self):
        self.assertIn('id="navTabStrategyLab"', self.html)
        self.assertIn('id="tabContentStrategyLab"', self.html)
        self.assertIn('switchMainTab("strategyLab")', self.html)

    def test_dual_timeframe_conditions_and_common_chart(self):
        for control in ("labEntry5m", "labEntry1h", "labExit5m", "labExit1h"):
            self.assertIn(f'id="{control}"', self.html)
        self.assertIn("new StrategyExecutionChartController", self.js)
        self.assertIn("StrategyExecutionChartFrame.mount", self.js)
        self.assertIn('class="shortTermExecutionSection" id="strategyLabExecutionSection"', self.html)
        self.assertIn('class="shortTermCriteriaGrid"', self.html)
        self.assertIn("api/strategy-lab/upbit-ma-stack", self.js)
        self.assertNotIn("fetch(`/api/strategy-lab", self.js)
        self.assertIn("NET +${target}%", self.js)


if __name__ == "__main__":
    unittest.main()
