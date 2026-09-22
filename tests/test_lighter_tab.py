import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class TestLighterTab(unittest.TestCase):
    def test_tab_is_immediately_after_trading_navigation(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        trading = html.index('id="navTabTrading"')
        lighter = html.index('id="navTabLighter"')
        pairs = html.index('id="navTabPairs"')
        self.assertLess(trading, lighter)
        self.assertLess(lighter, pairs)

    def test_tab_has_unique_execution_surface_and_navigation(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        common = (ROOT / "terminal-common.js").read_text(encoding="utf-8")
        for required in (
            'id="tabContentLighter"', 'id="tradingTerminalTemplate"', 'lighter_btnRerunDynamicBacktest',
            'addVirtualEntry', 'exitVirtual',
            'switchMainTab("lighter")', '/api/lighter/status', '/api/lighter/parity',
            '/api/lighter/backtest',
            'lighter_legendActualTrades', 'lighter_legendVirtualTrades', 'movingAverage',
            'bindResearchConditions', 'use_ma_stretch', 'use_bottoming',
            'element.removeAttribute(attribute)',
        ):
            self.assertIn(required, html + script + common)

    def test_live_mode_is_fail_closed(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn('button,input,select', script)
        self.assertIn('element.disabled = true', script)
        self.assertIn('Live execution is fail-closed', script)

    def test_lighter_uses_tab_two_structure_without_duplicate_ids(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        common = (ROOT / "terminal-common.js").read_text(encoding="utf-8")
        self.assertIn('template.content.cloneNode(true)', common)
        self.assertIn('namespaceFragment', common)
        self.assertIn('venue: "lighter"', common)
        self.assertNotIn('source.children', script)


if __name__ == "__main__":
    unittest.main()
