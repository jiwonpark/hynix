import asyncio
import math
import pathlib
import unittest
from unittest.mock import AsyncMock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]

class TestCryptoTab(unittest.TestCase):
    def test_macd_is_bidirectional_and_uses_displayed_hourly_regime(self):
        from backend.lighter_strategy import (
            evaluate_macd_reversal_signals,
            hourly_macro_alignment,
        )

        declining_hourly = [100.0 - index * 0.1 for index in range(30)]
        alignment = hourly_macro_alignment(declining_hourly)
        self.assertEqual(alignment, (False, True))

        prices = [100 + 0.03 * index + 4 * math.sin(index / 7 + 2.7)
                  for index in range(120)]
        entry, side, _, evaluation = evaluate_macd_reversal_signals(
            prices, use_ma_stack_1h=True, macro_alignment=alignment)
        self.assertTrue(entry)
        self.assertEqual(side, -1)
        self.assertTrue(evaluation["condition_pass"]["entry_ma_stack_1h"])

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

    def test_ma_stack_paper_entry_matches_chart_candle(self):
        from backend.server import _run_crypto_backtest_sync

        bars = [{"time": 1000 + i * 300, "value": 100.0} for i in range(60)]
        bars.append({"time": 1000 + 60 * 300, "value": 110.0})
        result = _run_crypto_backtest_sync(
            bars, True, strategy_mode="ma_stack", market_source="lighter",
            use_ma_stretch=False, use_ma_stack=True, use_ma_stack_1h=False,
            use_convergence=False, use_dwell=False, use_bottoming=False,
            interval_seconds=300,
        )
        self.assertTrue(result["latest_conditions"]["entry_ma_stack"])
        self.assertEqual(len(result["open_positions"]), 1)
        self.assertEqual(result["open_positions"][0]["entry_time"], bars[-1]["time"])
        self.assertEqual(result["open_positions"][0]["side"], -1)

    def test_tab5_ma_stack_paper_exits_only_on_opposite_full_stack(self):
        from backend.server import _run_crypto_backtest_sync

        values = [160.0 - i for i in range(61)] + [101.0 + i for i in range(60)]
        bars = [{"time": 1000 + i * 300, "value": value}
                for i, value in enumerate(values)]
        result = _run_crypto_backtest_sync(
            bars, True, strategy_mode="ma_stack", market_source="lighter",
            use_ma_stack=True, ma_stack_opposite_only=True,
            use_opposite_stack_exit=True,
            # These legacy switches must not affect Tab 5's simplified rule.
            use_ma_stretch=True, use_ma_stack_1h=True,
            use_convergence=True, use_dwell=True, use_bottoming=True,
            interval_seconds=300,
        )
        self.assertGreaterEqual(len(result["trades"]), 1)
        first = result["trades"][0]
        self.assertEqual(first["side"], 1)
        self.assertEqual(first["reason"], "opposite_stack")
        exit_index = next(i for i, bar in enumerate(bars) if bar["time"] == first["exit_time"])
        price = values[exit_index]
        ma7 = sum(values[exit_index - 6:exit_index + 1]) / 7
        ma24 = sum(values[exit_index - 23:exit_index + 1]) / 24
        ma60 = sum(values[exit_index - 59:exit_index + 1]) / 60
        self.assertTrue(price > ma7 > ma24 > ma60)

    def test_tab5_adaptive_replay_signals_ignore_inventory_and_exits_lifo(self):
        from backend.server import _run_crypto_backtest_sync

        values = [100.0] * 25 + [90.0, 89.0, 88.0] + [100.0] * 30
        bars = [{"time": 1000 + index * 300, "value": value}
                for index, value in enumerate(values)]
        result = _run_crypto_backtest_sync(
            bars, True, strategy_mode="adaptive_tranche", market_source="lighter",
            entry_z=0.5, exit_z=0.3,
            use_ma_stretch=True, use_base_spacing=False, use_peak=False,
            use_ma_stack=False, use_ma_stack_1h=False,
            use_convergence=True, use_dwell=False, use_bottoming=False,
            interval_seconds=300,
        )

        self.assertEqual(len(result["entry_signals"]), 2)
        self.assertEqual(len(result["trades"]), 2)
        # Tab 2 semantics: the later tranche exits first, one tranche per bar.
        self.assertGreater(result["trades"][0]["entry_time"], result["trades"][1]["entry_time"])
        self.assertLess(result["trades"][0]["exit_time"], result["trades"][1]["exit_time"])

    def test_crypto_live_auth_and_paper_distinction(self):
        script = (ROOT / "crypto-tab.js").read_text(encoding="utf-8")
        server = (ROOT / "backend/server.py").read_text(encoding="utf-8")

        self.assertIn("REAL FUTURES", script)
        self.assertIn("confirm_live_trading", script)
        self.assertIn("CryptoBot(binance_client)", server)
        self.assertIn("/api/crypto/bot/", server)
        self.assertIn("/api/crypto/step_tranche", server)
        self.assertIn("/api/crypto/flatten", server)

    def test_crypto_price_and_status_endpoints(self):
        from backend.server import get_crypto_price, get_crypto_status

        async def _run():
            with patch("backend.server.get_klines") as mock_klines, \
                 patch("backend.server.binance_client.get_detailed_account_overview", new_callable=AsyncMock) as mock_account, \
                 patch("backend.server.binance_client.request", new_callable=AsyncMock) as mock_request:
                mock_klines.return_value = [
                    [1000000, "68000.0", "68500.0", "67900.0", "68200.0", "150.0"],
                    [1060000, "68200.0", "68600.0", "68100.0", "68450.0", "120.0"]
                ]
                mock_account.return_value = {"authenticated": True, "summary": {
                    "total_equity_usd": 933.05, "available_margin_usd": 483.5}, "positions": []}
                mock_request.return_value = {"bidPrice": "68449.9", "askPrice": "68450.1"}
                status_res = await get_crypto_status(symbol="BTCUSDT")
                self.assertTrue(status_res.get("success"))
                self.assertEqual(status_res.get("symbol"), "BTCUSDT")
                self.assertEqual(status_res.get("mark_price"), 68450.0)
                self.assertEqual(status_res.get("price_ratio"), 68450.0)
                self.assertEqual(status_res.get("collateral"), 933.05)
                self.assertEqual(status_res.get("available_margin"), 483.5)
                self.assertEqual(status_res.get("bid"), 68449.9)

                price_res = await get_crypto_price(symbol="BTCUSDT", interval="15m", limit=2)
                self.assertTrue(price_res.get("success"))
                self.assertEqual(price_res.get("symbol"), "BTCUSDT")
                self.assertEqual(len(price_res.get("bars", [])), 2)
                self.assertEqual(price_res["bars"][-1]["value"], 68450.0)

        asyncio.run(_run())

    def test_actual_chart_marker_uses_verified_net_after_fees(self):
        from backend.server import get_crypto_candles

        history = [
            {"event": "ENTRY", "symbol": "BTCUSDT", "time": 970, "side": -1,
             "original_side": -1, "price": 100.0, "qty": 1, "order_id": 1},
            {"event": "EXIT", "symbol": "BTCUSDT", "time": 1030, "side": 1,
             "original_side": -1, "price": 99.98, "entry_price": 100.0, "qty": 1,
             "entry_order_id": 1, "order_id": 2, "pnl_authoritative": True,
             "gross_pnl_usd": 0.02, "round_trip_fee_usd": 0.16,
             "net_pnl_usd": -0.14, "pnl_pct": -0.14},
            {"event": "EXIT", "symbol": "BTCUSDT", "time": 1090, "side": 1,
             "original_side": -1, "price": 99.90, "entry_price": 100.0, "qty": 1,
             "entry_order_id": 3, "order_id": 4, "pnl_authoritative": False},
        ]

        async def _run():
            with patch("backend.server.get_klines", new_callable=AsyncMock) as klines, \
                 patch("backend.server.crypto_bot.reconciled_public_state", new_callable=AsyncMock) as state:
                klines.return_value = [
                    [t * 1000, "100", "101", "99", "100", "1"]
                    for t in (960, 1020, 1080)
                ]
                state.return_value = {"execution_history": history}
                result = await get_crypto_candles("BTCUSDT", "1m", 3)
                exits = [marker for marker in result["markers"] if marker["is_exit"]]
                self.assertEqual(exits[0]["pnl"], -0.14)
                self.assertEqual(exits[0]["gross_pnl_usd"], 0.02)
                self.assertEqual(exits[0]["round_trip_fee_usd"], 0.16)
                self.assertTrue(exits[0]["pnl_authoritative"])
                self.assertIn("net -0.1400", exits[0]["hoverText"])
                self.assertIsNone(exits[1]["pnl"])
                self.assertFalse(exits[1]["pnl_authoritative"])

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
