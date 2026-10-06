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

if __name__ == "__main__":
    unittest.main()
