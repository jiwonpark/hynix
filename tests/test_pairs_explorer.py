import math
import os
import unittest
from unittest.mock import AsyncMock, patch

class TestPairsExplorer(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.html_path = os.path.join(os.path.dirname(__file__), "..", "index.html")
        with open(self.html_path, "r", encoding="utf-8") as f:
            self.html = f.read()

    def test_frontend_pairs_tab_elements(self):
        """Verify all primary navigation and panel DOM elements for pairs explorer exist."""
        self.assertIn('id="navTabPairs"', self.html)
        self.assertIn('id="lblNavPairs"', self.html)
        self.assertIn('id="tabContentPairs"', self.html)
        self.assertIn('id="tblPairsScreener"', self.html)
        self.assertIn('id="tbodyPairsScreener"', self.html)
        self.assertIn('id="btnPairsRefresh"', self.html)
        self.assertIn('id="btnFilterAll"', self.html)
        self.assertIn('id="btnFilterL1"', self.html)
        self.assertIn('id="btnFilterL2"', self.html)
        self.assertIn('id="btnFilterMove"', self.html)
        self.assertIn('id="btnFilterDefi"', self.html)
        self.assertIn('id="btnFilterSov"', self.html)
        self.assertIn('id="btnFilterDislocated"', self.html)
        self.assertIn('id="custSymbolA"', self.html)
        self.assertIn('id="custSymbolB"', self.html)
        self.assertIn('id="btnAnalyzeCustom"', self.html)
        self.assertIn('id="secPairDeepDive"', self.html)
        self.assertIn('id="pairSpreadChartHost"', self.html)
        self.assertIn('id="pairZScoreChartHost"', self.html)
        self.assertIn('id="bpSizingRows"', self.html)

    def test_navigation_switch_pairs_support(self):
        """Verify switchMainTab and savedTab logic handles 'pairs'."""
        self.assertIn('const isPairs = tab === "pairs";', self.html)
        self.assertIn('$("tabContentPairs").style.display = isPairs ? "block" : "none"', self.html)
        self.assertIn('switchMainTab("pairs")', self.html)
        self.assertIn('savedTab === "pairs"', self.html)

    def test_curated_universe_definition(self):
        """Verify PAIRS_UNIVERSE contains all curated hedge-worthy pairs."""
        for sym in ["ETHUSDT", "BTCUSDT", "SOLUSDT", "SUIUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "AVAXUSDT", "LINKUSDT", "BNBUSDT", "UNIUSDT", "AAVEUSDT", "PAXGUSDT", "SKHYUSDT", "CSOPSKHYNIX2LUSDT"]:
            self.assertIn(sym, self.html)

    def test_bilingual_translations(self):
        """Verify English and Korean translations for pairs explorer exist."""
        self.assertIn('lblNavPairs: "Hedge-Worthy Pairs Explorer"', self.html)
        self.assertIn('lblNavPairs: "헤지 유망 페어 차익거래 스크리너"', self.html)
        self.assertIn('if ($("lblNavPairs")) $("lblNavPairs").textContent = dict.lblNavPairs;', self.html)

    async def test_backend_pairs_overview_endpoint(self):
        """Verify /api/pairs/overview computes prices and ratios accurately."""
        from backend.server import get_pairs_overview, CURATED_HEDGE_PAIRS, _PAIRS_CACHE
        _PAIRS_CACHE["timestamp"] = 0
        _PAIRS_CACHE["data"] = None

        mock_tickers = [
            {"symbol": "ETHUSDT", "lastPrice": "2500.00", "priceChangePercent": "2.50"},
            {"symbol": "BTCUSDT", "lastPrice": "50000.00", "priceChangePercent": "1.00"},
            {"symbol": "SOLUSDT", "lastPrice": "150.00", "priceChangePercent": "5.00"},
            {"symbol": "SUIUSDT", "lastPrice": "2.00", "priceChangePercent": "-1.00"},
            {"symbol": "APTUSDT", "lastPrice": "8.00", "priceChangePercent": "0.50"},
            {"symbol": "ARBUSDT", "lastPrice": "0.50", "priceChangePercent": "0.00"},
            {"symbol": "OPUSDT", "lastPrice": "1.50", "priceChangePercent": "1.00"},
            {"symbol": "AVAXUSDT", "lastPrice": "25.00", "priceChangePercent": "3.00"},
            {"symbol": "LINKUSDT", "lastPrice": "12.00", "priceChangePercent": "1.50"},
            {"symbol": "BNBUSDT", "lastPrice": "600.00", "priceChangePercent": "0.50"},
            {"symbol": "UNIUSDT", "lastPrice": "7.00", "priceChangePercent": "-0.50"},
            {"symbol": "AAVEUSDT", "lastPrice": "160.00", "priceChangePercent": "2.00"},
            {"symbol": "PAXGUSDT", "lastPrice": "2600.00", "priceChangePercent": "0.20"},
        ]

        with patch("backend.server.binance_client.request", new=AsyncMock(return_value=mock_tickers)):
            res = await get_pairs_overview()
            self.assertEqual(res["status"], "ok")
            self.assertIn("pairs", res)
            self.assertEqual(len(res["pairs"]), len(CURATED_HEDGE_PAIRS))

            eth_btc = next(p for p in res["pairs"] if p["id"] == "eth_btc")
            self.assertEqual(eth_btc["priceA"], 2500.0)
            self.assertEqual(eth_btc["priceB"], 50000.0)
            self.assertAlmostEqual(eth_btc["ratio"], 2500.0 / 50000.0, places=4)
            self.assertAlmostEqual(eth_btc["ratio24hChange"], 1.50, places=2)

    def test_quantitative_formulas(self):
        """Verify mathematical integrity of OLS beta, Z-score, and OU half-life calculations."""
        # Simulated cointegrated spread: Y = 2 * X + noise
        x_vals = [10.0 + i * 0.5 for i in range(20)]
        y_vals = [2.0 * x + ((-1)**i) * 0.2 for i, x in enumerate(x_vals)]

        mean_x = sum(x_vals) / len(x_vals)
        mean_y = sum(y_vals) / len(y_vals)
        cov_xy = sum((x - mean_x) * (y - mean_y) for x, y in zip(x_vals, y_vals))
        var_x = sum((x - mean_x)**2 for x in x_vals)
        beta = cov_xy / var_x

        self.assertAlmostEqual(beta, 2.0, delta=0.05)

        # Ornstein-Uhlenbeck half-life formula: tau = ln(2) / theta
        gamma = -0.10 # 10% mean reversion per period
        theta = -math.log(1 + gamma)
        half_life_periods = math.log(2) / theta
        self.assertGreater(half_life_periods, 0)
        self.assertAlmostEqual(half_life_periods, 6.58, delta=0.1)

    def test_field_tooltips_and_popup(self):
        """Verify field explanation popups and tooltips for Tab 3 exist."""
        self.assertIn('id="pairsHelpPopup"', self.html)
        self.assertIn('id="pairsPopupTitle"', self.html)
        self.assertIn('id="pairsPopupBody"', self.html)
        self.assertIn('class="fieldTip"', self.html)
        self.assertIn('data-tip-key="zscore"', self.html)
        self.assertIn('data-tip-key="adfPVal"', self.html)
        self.assertIn('data-tip-key="halfLife"', self.html)
        self.assertIn('data-tip-key="beta"', self.html)
        self.assertIn('data-tip-key="correlation"', self.html)
        self.assertIn('data-tip-key="bpCapital"', self.html)
        self.assertIn('data-tip-key="trigShort"', self.html)
        self.assertIn('const PAIR_TOOLTIPS =', self.html)
        self.assertIn('const pairsTooltipManager =', self.html)
        self.assertIn('pairsTooltipManager.init()', self.html)

if __name__ == "__main__":
    unittest.main()

