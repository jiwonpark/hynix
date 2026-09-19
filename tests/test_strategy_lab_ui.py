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
        for control in ("chkCondEntryMaStack5m", "chkCondEntryMaStack1h", "chkCondExitMaStack5m", "chkCondExitMaStack1h"):
            self.assertIn(control, self.js)
        self.assertIn("new StrategyExecutionChartController", self.js)
        self.assertNotIn('cloneNode(', self.js)
        self.assertIn('id="lab_shortTermExecutionSection"', self.html)
        self.assertIn('id="lab_chkCondEntryMaStack5m"', self.html)
        self.assertIn("api/strategy-lab/upbit-ma-stack", self.js)
        self.assertNotIn("fetch(`/api/strategy-lab", self.js)
        self.assertIn("NET +${target}%", self.js)

    def test_actual_trade_indicators_enabled(self):
        self.assertIn('actual: { label: "Actual", onToggle: () => this.toggleActual() }', self.js)
        self.assertIn("toggleActual()", self.js)
        self.assertIn("getActualTradeMarkers()", self.js)
        self.assertIn("Actual</span>", self.js)
        self.assertNotIn('actual: { label: "Actual", enabled: false, visible: false }', self.js)

    def test_x_axis_kst_formatting(self):
        self.assertIn("tickMarkFormatter:", self.js)
        self.assertIn('timeZone: "Asia/Seoul"', self.js)
        self.assertIn('locale: "ko-KR"', self.js)

    def test_no_literal_escape_characters_in_markup(self):
        # Ensure no raw literal \n or \t outside script and style blocks
        markup = self.html.split("<script")[0]
        self.assertNotIn(r"\n", markup)
        self.assertNotIn(r"\t", markup)


if __name__ == "__main__":
    unittest.main()
