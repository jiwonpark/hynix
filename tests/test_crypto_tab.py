import asyncio
import pathlib
import unittest
from unittest.mock import AsyncMock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]

class TestCryptoTab(unittest.TestCase):
    def test_navigation_ordering_and_dom_elements(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        common = (ROOT / "terminal-common.js").read_text(encoding="utf-8")
        script = (ROOT / "crypto-tab.js").read_text(encoding="utf-8")

        # Ordering invariant: trading < lighter < crypto < pairs
        trading = html.index('id="navTabTrading"')
        lighter = html.index('id="navTabLighter"')
        crypto = html.index('id="navTabCrypto"')
        pairs = html.index('id="navTabPairs"')
        self.assertLess(trading, lighter)
        self.assertLess(lighter, crypto)
        self.assertLess(crypto, pairs)

        # Container in index.html
        self.assertIn('id="tabContentCrypto"', html)
        self.assertIn('switchMainTab("crypto")', html)
        self.assertIn("crypto-tab.js", html)

        # Common mount logic mounts crypto_
        self.assertIn('venue: "crypto"', common)
        self.assertIn('prefix: "crypto_"', common)

        # Tab 4 script exports window.cryptoEngine
        self.assertIn("window.cryptoEngine", script)
        self.assertIn("crypto_btnRerunDynamicBacktest", script)

    def test_crypto_backtest_endpoints(self):
        from backend.server import get_crypto_backtest

        fake_bars = [
            {"time": 1000 + i * 900, "value": 60000.0 + (50.0 if i % 10 > 5 else -50.0) + (i * 2.0)}
            for i in range(120)
        ]

        async def _run():
            with patch("backend.server.get_crypto_candles") as mock_candles:
                mock_candles.return_value = {"success": True, "bars": fake_bars}
                for mode in ("grid", "ou_quant", "ma_stack", "multi_factor", "trend_pullback"):
                    res = await get_crypto_backtest(symbol="BTCUSDT", interval="15m", limit=120, strategy_mode=mode)
                    self.assertTrue(res.get("success"))
                    self.assertEqual(res.get("strategy_mode"), mode)
                    self.assertEqual(res.get("symbol"), "BTCUSDT")
                    self.assertIn("summary", res)
                    self.assertIn("trades", res)

        asyncio.run(_run())

    def test_crypto_fail_closed_and_auth(self):
        script = (ROOT / "crypto-tab.js").read_text(encoding="utf-8")
        server = (ROOT / "backend/server.py").read_text(encoding="utf-8")

        self.assertIn("fail-closed", script.lower())
        self.assertIn("/api/crypto/bot/", server)
        self.assertIn("/api/crypto/step_tranche", server)
        self.assertIn("/api/crypto/flatten", server)

    def test_crypto_price_and_status_endpoints(self):
        from backend.server import get_crypto_price, get_crypto_status

        async def _run():
            with patch("backend.server.get_klines") as mock_klines:
                mock_klines.return_value = [
                    [1000000, "68000.0", "68500.0", "67900.0", "68200.0", "150.0"],
                    [1060000, "68200.0", "68600.0", "68100.0", "68450.0", "120.0"]
                ]
                status_res = await get_crypto_status(symbol="BTCUSDT")
                self.assertTrue(status_res.get("success"))
                self.assertEqual(status_res.get("symbol"), "BTCUSDT")
                self.assertEqual(status_res.get("mark_price"), 68450.0)
                self.assertEqual(status_res.get("price_ratio"), 68450.0)

                price_res = await get_crypto_price(symbol="BTCUSDT", interval="15m", limit=2)
                self.assertTrue(price_res.get("success"))
                self.assertEqual(price_res.get("symbol"), "BTCUSDT")
                self.assertEqual(len(price_res.get("bars", [])), 2)
                self.assertEqual(price_res["bars"][-1]["value"], 68450.0)

        asyncio.run(_run())

    def test_crypto_tab_single_leg_features(self):
        script = (ROOT / "crypto-tab.js").read_text(encoding="utf-8")
        self.assertIn("selectedSymbol", script)
        self.assertIn("renderSymbolSelector", script)
        self.assertIn("formatCryptoPrice", script)
        self.assertIn("formatCryptoQty", script)
        self.assertNotIn("BTCUSDTNIXUSD", script)

if __name__ == "__main__":
    unittest.main()
