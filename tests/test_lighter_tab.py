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
            'use_base_spacing', 'chkCondEntryBase',
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

    def test_lighter_backtest_strategy_modes(self):
        import asyncio
        from unittest.mock import patch
        from backend.server import get_lighter_backtest

        fake_bars = [
            {"time": 1000 + i * 900, "value": 140.0 + (0.5 if i % 10 > 5 else -0.5) + (i * 0.01)}
            for i in range(120)
        ]

        async def _run():
            with patch("backend.server.get_lighter_parity") as mock_parity:
                mock_parity.return_value = {"success": True, "bars": fake_bars}
                for mode in ("grid", "ou_quant", "ma_stack", "multi_factor"):
                    res = await get_lighter_backtest(interval="15m", limit=120, strategy_mode=mode)
                    self.assertTrue(res.get("success"))
                    self.assertEqual(res.get("strategy_mode"), mode)
                    self.assertIn("summary", res)
                    self.assertIn("trades", res)

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
