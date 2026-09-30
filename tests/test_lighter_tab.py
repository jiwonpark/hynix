import asyncio
import pathlib
import unittest
from unittest.mock import AsyncMock, patch


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
            '/api/lighter/bot/status', '/api/lighter/bot/toggle', '/api/lighter/trends',
            'lighter_legendActualTrades', 'lighter_legendVirtualTrades', 'movingAverage',
            'bindResearchConditions', 'use_ma_stretch', 'use_bottoming',
            'use_base_spacing', 'chkCondEntryBase',
            'lighter_tabParadigm_trend_pullback', 'trend_pullback',
            'element.removeAttribute(attribute)',
            'lighterSelSmallTrend', 'lighterSelBigTrend', 'lighterMatchPill',
        ):
            self.assertIn(required, html + script + common)

    def test_live_mode_is_fail_closed(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn('button,input,select', script)
        self.assertIn('element.disabled = true', script)
        self.assertIn('Live execution is fail-closed', script)
        self.assertIn('confirm_live_trading', script)
        self.assertIn('SKHY / SKHYNIXUSD (no 2x ETF)', script)
        self.assertIn('skhynix_lighter_selected_strategy', script)
        self.assertIn('REAL EC2 BOT — PRODUCTION RULES', script)
        self.assertIn('Rerun Paper', script)
        self.assertIn('live rules unchanged', script)
        self.assertIn('calculateTrendRanges', script)
        self.assertIn('lighterTrendBandLayer', script)
        self.assertIn('TREND SCORE −1 ← 0 → +1', script)
        self.assertIn('pendingCount >= 3', script)

    def test_lighter_uses_tab_two_structure_without_duplicate_ids(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        common = (ROOT / "terminal-common.js").read_text(encoding="utf-8")
        self.assertIn('template.content.cloneNode(true)', common)
        self.assertIn('namespaceFragment', common)
        self.assertIn('venue: "lighter"', common)
        self.assertNotIn('source.children', script)

    def test_paper_mode_does_not_replace_real_account_collateral(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn('"Lighter Account Collateral"', script)
        self.assertIn('const accountCollateral = Number(this.liveVenue?.collateral)', script)
        self.assertNotIn('this.setText("valAccountEquity", "$10,000.00")', script)
        self.assertIn('resetPaper.textContent = "↺ Reset Paper $10k"', script)

    def test_campaign_slot_cap_is_distinguished_from_leverage_utilization(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn('"Campaign Entry Slots"', script)
        self.assertIn('"Gross Leverage Utilization (separate from campaign slot cap):"', script)
        self.assertIn('ENTRY BLOCKED: ${tranchesCount}/${maxTranches} slot hard cap', script)
        self.assertIn('Campaign Slots`', script)

    def test_strategy_regime_clicks_deploy_exact_visible_parameters(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn('this.setParadigm(mode, { deployLive: true })', script)
        self.assertIn('liveStrategyPayload(mode', script)
        for control_id in (
            "lighter_inpOuEntryZ", "lighter_inpOuExitZ", "lighter_inpMaStretchMin",
            "lighter_inpMaTrailingStop", "lighter_selFactorQuorum",
            "lighter_inpTrendPullbackDist", "lighter_inpTrendTpDist",
            "lighter_inpTrendMacroWindow", "lighter_inpCustomEntryZ", "lighter_inpCustomExitZ",
        ):
            self.assertIn(f'numeric("{control_id}"', script)
        for stale_id in ("inputOuHalfLife", "inputMaStretchMin", "inputFactorVotes", "inputPullbackDist"):
            self.assertNotIn(f'lid("{stale_id}")', script)

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
                for mode in ("grid", "ou_quant", "ma_stack", "multi_factor", "trend_pullback"):
                    res = await get_lighter_backtest(interval="15m", limit=120, strategy_mode=mode)
                    self.assertTrue(res.get("success"))
                    self.assertEqual(res.get("strategy_mode"), mode)
                    self.assertIn("summary", res)
                    self.assertIn("trades", res)
                    if mode == "trend_pullback":
                        self.assertIn("macro_regime", res.get("metrics", {}))
                        self.assertIn("latest_slope", res.get("metrics", {}))

        asyncio.run(_run())

    def test_marker_labels_clean_and_hover_controlled(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn("StrategyExecutionChartController", script)
        self.assertIn("renderTradeMarkerTargets", script)
        self.assertIn("markerTimeAtParam", script)
        self.assertIn("updateMarkerState", script)
        self.assertNotIn("text: `${pName} Entry`", script)
        self.assertNotIn('text: row.action === "EXIT" ? "Grid Rebalance" : "Grid Scale-In"', script)
        self.assertIn('hoverText: `${trade.side < 0 ? "SHORT" : "BUY"}', script)
        self.assertIn('hoverText: `${trade.side < 0 ? "COVER" : "SELL"}', script)

    def test_shared_timestamp_trades_can_be_selected_individually(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn("this.chart.subscribeClick((param) => this.onChartClick(param))", script)
        self.assertIn("executionMarkersAtTime(time)", script)
        self.assertIn("selectedExecutionMarkerKey", script)
        self.assertIn('target.addEventListener("mouseenter"', script)
        self.assertIn('target.addEventListener("mouseleave"', script)
        self.assertIn('target.addEventListener("click"', script)
        self.assertIn("this.series.priceToCoordinate(price)", script)
        self.assertIn("The native crosshair owns x-axis/price inspection", script)
        self.assertNotIn("Trade details are intentionally hover-only", script)

    def test_trade_marker_orientation_and_direction_color(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn("isTradeEntry(marker)", script)
        self.assertIn("isShortTrade(marker)", script)
        self.assertIn("isTradeSell(marker)", script)
        self.assertIn('return this.isTradeSell(marker) ? "#dc2626" : "#16a34a"', script)
        self.assertIn('return isEntry ? "▶" : "◀"', script)
        self.assertIn('overlay.style.borderColor = markerColor === "#dc2626"', script)
        self.assertIn('overlay.style.color = markerColor === "#dc2626"', script)

    def test_trade_entry_exit_triangles_and_diagonals(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn("renderTradeTriangles()", script)
        self.assertIn('lighter_tradeTrianglesLayer', script)
        self.assertIn('aria-label", "Trade entry-exit triangles"', script)
        self.assertIn('document.createElementNS("http://www.w3.org/2000/svg", "polygon")', script)
        self.assertIn('document.createElementNS("http://www.w3.org/2000/svg", "line")', script)
        # Verify upper triangle for short and lower triangle for long
        self.assertIn("if (isShort)", script)
        self.assertIn("y1 <= y2", script)
        self.assertIn("rgba(34, 197, 94,", script)
        self.assertIn("rgba(239, 68, 68,", script)
        # Verify triangles show only on hover / selection
        self.assertIn("Triangles and diagonal connectors should show ONLY on hover", script)
        self.assertIn("this.activeHoveredPairKey = pairKey;", script)
        self.assertIn("if (!isHovered && !isSelected) return;", script)
        # Verify perfect alignment with trade marker targets
        self.assertIn("entry._targetX", script)
        self.assertIn("entry._targetY", script)
        # Verify LIFO matching and direction preservation
        self.assertIn("const entry = stack.pop();", script)
        self.assertIn("isCampaign", script)
        self.assertIn("closedEntries", script)
        # Verify Buy price lower than Sell close is always profit
        self.assertIn("const isProfit = isShort ? (p1 >= p2) : (p2 >= p1);", script)

    def test_multiple_trade_marker_hover_and_range_line_alignment(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        # Verify range line alignment to marker tip
        self.assertIn('line x1="14" y1="${topLocal}" x2="14" y2="${bottomLocal}"', script)
        self.assertIn('polygon points="7,${avgLocal - 4} 14,${avgLocal} 7,${avgLocal + 4}"', script)
        self.assertIn('line x1="2" y1="${topLocal}" x2="2" y2="${bottomLocal}"', script)
        self.assertIn('polygon points="9,${avgLocal - 4} 2,${avgLocal} 9,${avgLocal + 4}"', script)
        # Verify button left alignment coordinates
        self.assertIn('left:${x - 14}px', script)
        self.assertIn('left:${x - 2}px', script)
        # Verify hover triggers triangle rendering and marker state update
        self.assertIn('range.addEventListener("mouseenter"', script)
        self.assertIn('range.addEventListener("mouseleave"', script)
        self.assertIn('range.addEventListener("click"', script)
        self.assertIn('this.updateMarkerState(markerTime, markers[0])', script)
        self.assertIn('this.renderTradeTriangles()', script)
        # Verify target registration for grouped trades
        self.assertIn('targetsByMarkerKey.set(marker.markerKey, range)', script)

    def test_trade_marker_grouping_toggle_and_individual_trade_option(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        chart_script = (ROOT / "strategy-execution-chart.js").read_text(encoding="utf-8")
        index_html = (ROOT / "index.html").read_text(encoding="utf-8")

        # Verify lighter-tab has groupTradesAsRange state and setTradeGrouping method
        self.assertIn("groupTradesAsRange", script)
        self.assertIn("setTradeGrouping(asRange)", script)
        self.assertIn("lighter_group_trades_as_range", script)
        self.assertIn("const denseGroup = this.groupTradesAsRange && markers.length > 1;", script)

        # Verify strategy-execution-chart has grouping toolbar UI and methods
        self.assertIn("executionChartGrouping", chart_script)
        self.assertIn("ids.individualTrades", chart_script)
        self.assertIn("ids.rangeTrades", chart_script)
        self.assertIn("setGrouping(asRange)", chart_script)

        # Verify CSS styling in index.html
        self.assertIn(".executionChartGrouping", index_html)

    def test_parity_markers_direction_and_pairkey_stamped(self):
        from backend.server import get_lighter_parity, lighter_pair_bot, lighter_client

        fake_bars = [
            {"t": 1000000, "c": 141.0},
            {"t": 1060000, "c": 141.5},
            {"t": 1120000, "c": 140.8},
        ]
        fake_tranches = [
            {"time": 1000, "is_exit": False, "side": -1, "adr_qty": 1.0, "notional_usd": 25.0, "entry_ratio": 141.0},
            {"time": 1060, "is_exit": True, "side": 1, "adr_qty": 1.0, "notional_usd": 25.0, "exit_ratio": 140.8, "pnl": 0.05},
        ]

        async def _run():
            with patch.object(lighter_client, "candles", new_callable=AsyncMock) as mock_candles:
                mock_candles.side_effect = [
                    [{"t": 1000000, "c": 141.0}, {"t": 1060000, "c": 141.5}, {"t": 1120000, "c": 140.8}],
                    [{"t": 1000000, "c": 10.0}, {"t": 1060000, "c": 10.0}, {"t": 1120000, "c": 10.0}],
                ]
                with patch.dict(lighter_pair_bot.state, {"tranches": [], "history": fake_tranches}):
                    res = await get_lighter_parity("15m", 100)
                    self.assertTrue(res.get("success"))
                    markers = res.get("markers", [])
                    self.assertEqual(len(markers), 2)
                    entry_m, exit_m = markers[0], markers[1]
                    self.assertTrue(entry_m["is_entry"])
                    self.assertFalse(exit_m["is_entry"])
                    self.assertEqual(entry_m["direction"], "short")
                    self.assertEqual(exit_m["direction"], "short")
                    self.assertTrue(entry_m.get("pairKey"))
                    self.assertEqual(entry_m.get("pairKey"), exit_m.get("pairKey"))

        asyncio.run(_run())

    def test_live_marker_pairing_uses_tranche_id_then_lifo_fallback(self):
        server = (ROOT / "backend" / "server.py").read_text(encoding="utf-8")
        self.assertIn('p_key = f"live:id:{tranche_id}"', server)
        self.assertIn("entries_by_id.get(tranche_id)", server)
        self.assertIn("matched_entry = open_entries[m_dir].pop()", server)
        self.assertNotIn("matched_entry = open_entries[m_dir].pop(0)", server)

    def test_paper_trade_condition_validation_and_toggle_controls(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn("lighter_chkEnforceConditions", script)
        self.assertIn("Enforce Live Conditions", script)
        self.assertIn("validateVirtualEntryConditions", script)
        self.assertIn("validateVirtualExitConditions", script)
        self.assertIn("computeParityMetrics", script)
        self.assertIn("isEnforceConditionsEnabled", script)
        self.assertIn("chkCondEntryMaStretch", script)
        self.assertIn("chkCondEntryBase", script)
        self.assertIn("chkCondEntryPeak", script)
        self.assertIn("chkCondEntryMaStack5m", script)
        self.assertIn("Paper Entry Blocked", script)
        self.assertIn("Paper Exit Blocked", script)

    def test_converging_fan_multi_entry_triangles_and_campaign_tooltip(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn("getTradePairs()", script)
        self.assertIn("SHORT CAMPAIGN", script)
        self.assertIn("${dirLabel} EXIT", script)
        self.assertIn("targetsByMarkerKey", script)
        self.assertIn("isExitHovered", script)
        self.assertIn("isEntryHovered", script)
        self.assertIn("matchedPairs.length > 1", script)
        self.assertIn("trancheRows", script)

    def test_multi_entry_to_single_exit_matching(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        self.assertIn("is_campaign_exit: true", script)
        self.assertIn("isCampaign", script)
        self.assertIn("closedEntries", script)
        self.assertIn("stack.splice(-n)", script)
        self.assertIn("const entry = stack.pop();", script)
        self.assertIn("closedEntries.forEach((entry) => {", script)
        self.assertIn("entry.pairKey = assignedPairKey;", script)
        self.assertIn("exitBucketMap", script)


if __name__ == "__main__":
    unittest.main()
