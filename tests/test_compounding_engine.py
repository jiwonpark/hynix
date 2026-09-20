import math
import os
import unittest
from unittest.mock import AsyncMock, patch

class TestCompoundingEngine(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.html_path = os.path.join(os.path.dirname(__file__), "..", "index.html")
        with open(self.html_path, "r", encoding="utf-8") as f:
            self.html = f.read()

    def test_frontend_compound_tab_elements(self):
        """Verify all primary navigation and panel DOM elements for micro-compounding engine exist."""
        self.assertIn('id="navTabCompound"', self.html)
        self.assertIn('id="lblNavCompound"', self.html)
        self.assertIn('id="tabContentCompound"', self.html)
        self.assertIn('id="compWealthChartHost"', self.html)
        self.assertIn('id="tblCompMilestones"', self.html)
        self.assertIn('id="tbodyCompMilestones"', self.html)
        self.assertIn('id="tblCompQueue"', self.html)
        self.assertIn('id="tbodyCompQueue"', self.html)
        self.assertIn('id="compSliderCapital"', self.html)
        self.assertIn('id="compSliderProfit"', self.html)
        self.assertIn('id="compSliderFreq"', self.html)
        self.assertIn('id="compSliderDays"', self.html)
        self.assertIn('id="compStrategyMode"', self.html)
        self.assertIn('id="compTargetHurdle"', self.html)
        self.assertIn('id="compReinvestPolicy"', self.html)
        self.assertIn('id="btnCompoundRefresh"', self.html)
        self.assertIn('id="badgeCompStatus"', self.html)
        self.assertIn('id="cntActiveTranchesQueue"', self.html)
        self.assertIn('id="cntReadyHarvestQueue"', self.html)

    def test_navigation_switch_compound_support(self):
        """Verify switchMainTab and savedTab logic handles 'compound'."""
        self.assertIn('const isCompound = normalized === "compound";', self.html)
        self.assertIn('$("tabContentCompound").style.display = isCompound ? "block" : "none"', self.html)
        self.assertIn('switchMainTab("compound")', self.html)
        self.assertIn('savedTab === "compound"', self.html)
        self.assertIn('compoundingEngine.onTabActivated()', self.html)

    def test_bilingual_translations(self):
        """Verify English and Korean translations for micro-compounding engine exist."""
        self.assertIn('lblNavCompound: "Micro-Compounding Engine"', self.html)
        self.assertIn('lblNavCompound: "마이크로 복리 엔진"', self.html)
        self.assertIn('if ($("lblNavCompound")) $("lblNavCompound").textContent = dict.lblNavCompound;', self.html)

    def test_five_safety_invariants_text(self):
        """Verify all 5 safety invariants are documented in tab 4."""
        self.assertIn("1. Strict Delta Neutrality", self.html)
        self.assertIn("2. Zero-Loss Invariant", self.html)
        self.assertIn("3. Asymmetric Core Ratchet", self.html)
        self.assertIn("4. Anti-Churn LIFO Isolation", self.html)
        self.assertIn("5. Liquidation Headroom Shield", self.html)

    def test_compounding_math_integrity(self):
        """Verify geometric compounding formulas: W_N = W_0 * (1 + r)^N."""
        W0 = 1000.0
        profit_per_turn = 0.00065  # 6.5 bps
        daily_turns = 35
        days = 180

        daily_factor = math.pow(1.0 + profit_per_turn, daily_turns)
        self.assertGreater(daily_factor, 1.02)  # ~2.3% per day

        W_180 = W0 * math.pow(daily_factor, days)
        self.assertGreater(W_180, W0)

        W_linear_180 = W0 + days * (W0 * profit_per_turn * daily_turns)
        self.assertGreater(W_180, W_linear_180)

    async def test_backend_compounding_stats_endpoint(self):
        """Verify /api/trade/compounding_stats returns correct structure and calculations."""
        from backend.server import get_compounding_stats

        mock_hedged = {
            "equity_usd": 1500.0,
            "margin_ratio_percent": 15.0,
            "gross_leverage": 1.25,
            "active_tranches_queue": [
                {
                    "trade_id": "T1",
                    "time": 1000.0,
                    "profit_estimate_available": True,
                    "estimated_net_pnl_usd": 0.045,
                    "minimum_net_profit_usd": 0.02
                },
                {
                    "trade_id": "T2",
                    "time": 1200.0,
                    "profit_estimate_available": True,
                    "estimated_net_pnl_usd": 0.010,
                    "minimum_net_profit_usd": 0.02
                }
            ]
        }

        with patch("backend.server.get_hedged_status_endpoint", new=AsyncMock(return_value=mock_hedged)):
            stats = await get_compounding_stats()
            self.assertEqual(stats["status"], "ok")
            self.assertTrue(stats["zero_loss_invariant"])
            self.assertEqual(stats["active_tranches_count"], 2)
            self.assertEqual(stats["ready_to_harvest_count"], 1)
            self.assertIn("micro_churn_stats", stats)
            churn = stats["micro_churn_stats"]
            self.assertEqual(churn["scale_in_unit"], "0.08 SKHY + 1.40 CSOP")
            self.assertEqual(churn["scale_out_unit"], "0.07 SKHY + 1.20 CSOP")
            self.assertIn("core_retention_per_turn", churn)
            self.assertGreater(churn["projected_daily_compound_pct"], 0.0)
            self.assertGreater(churn["projected_annual_apy_pct"], 0.0)
            self.assertAlmostEqual(churn["free_margin_headroom_pct"], 85.0)

if __name__ == "__main__":
    unittest.main()
