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
        for required in (
            'id="tabContentLighter"', 'id="lighterChart"', 'id="lighterRunBacktest"',
            'id="lighterVirtualEntry"', 'id="lighterVirtualExit"',
            'switchMainTab("lighter")', '/api/lighter/status', '/api/lighter/parity',
            '/api/lighter/backtest',
        ):
            self.assertIn(required, html + script)

    def test_live_mode_is_fail_closed(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="lighterLiveMode"', html)
        self.assertIn('lighterBtn secondary terminal-action-control" type="button" disabled', html)


if __name__ == "__main__":
    unittest.main()
