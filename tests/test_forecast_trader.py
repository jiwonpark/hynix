import asyncio
import json
import math
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import causal_ridge
from backend.forecast_bot import ForecastTraderBot
from backend.server import app


def _synthetic_4h_bars(count: int = 420):
    start = 1_700_000_000
    step = 14_400
    bars = []
    for i in range(count):
        center = 2000.0 + i * 1.4 + math.sin(i / 14.0) * 38.0 + math.sin(i / 5.0) * 11.0
        o = center - math.sin(i / 4.0) * 3.5
        c = center + math.cos(i / 5.0) * 4.2
        bars.append(
            {
                "time": start + i * step,
                "close_time": start + (i + 1) * step,
                "open": o,
                "high": max(o, c) + 6.5,
                "low": min(o, c) - 6.5,
                "close": c,
                "value": c,
                "volume": 500.0 + (i % 29),
            }
        )
    return bars


def _synthetic_1d_bars_from_4h(bars_4h, bias: str = "up"):
    first_day = (bars_4h[0]["time"] // 86400 - 30) * 86400
    last_day = (bars_4h[-1]["close_time"] // 86400 + 2) * 86400
    daily = []
    idx = 0
    t = first_day
    while t <= last_day:
        if bias == "up":
            c = 1800.0 + idx * 8.0
        elif bias == "down":
            c = 3200.0 - idx * 8.0
        else:
            c = 2200.0 + math.sin(idx / 7.0) * 120.0
        daily.append(
            {
                "time": t,
                "close_time": t + 86400,
                "open": c - 5.0,
                "high": c + 12.0,
                "low": c - 12.0,
                "close": c,
                "value": c,
                "volume": 3000.0,
            }
        )
        t += 86400
        idx += 1
    return daily


class _FakeBinanceClient:
    def __init__(self, equity=900.0, available=780.0, positions=None, bid=2500.0, ask=2501.0):
        self.equity = equity
        self.available = available
        self.positions = positions or []
        self.bid = bid
        self.ask = ask
        self.orders = []
        self.klines_4h = []
        self.klines_1d = []
        self.user_trades = []
        self.dual = False

    async def get_detailed_account_overview(self):
        return {
            "authenticated": True,
            "can_trade": True,
            "summary": {
                "total_equity_usd": self.equity,
                "available_margin_usd": self.available,
            },
            "positions": list(self.positions),
        }

    async def set_margin_type(self, symbol, margin_type):
        return {"code": 200}

    async def set_leverage(self, symbol, leverage):
        return {"leverage": leverage}

    async def request(self, method, endpoint, params=None, signed=False):
        params = params or {}
        if endpoint == "/fapi/v1/positionSide/dual":
            return {"dualSidePosition": self.dual}
        if endpoint == "/fapi/v2/positionRisk":
            return list(self.positions)
        if endpoint == "/fapi/v1/exchangeInfo":
            return {
                "symbols": [
                    {
                        "symbol": "ETHUSDT",
                        "status": "TRADING",
                        "filters": [
                            {"filterType": "MARKET_LOT_SIZE", "stepSize": "0.001", "minQty": "0.001"},
                            {"filterType": "MIN_NOTIONAL", "notional": "20"},
                        ],
                    },
                    {
                        "symbol": "BTCUSDT",
                        "status": "TRADING",
                        "filters": [
                            {"filterType": "MARKET_LOT_SIZE", "stepSize": "0.001", "minQty": "0.001"},
                            {"filterType": "MIN_NOTIONAL", "notional": "20"},
                        ],
                    },
                ]
            }
        if endpoint == "/fapi/v1/ticker/bookTicker":
            return {"bidPrice": str(self.bid), "askPrice": str(self.ask)}
        if endpoint == "/fapi/v1/klines":
            return list(self.klines_1d if params.get("interval") == "1d" else self.klines_4h)
        if endpoint == "/fapi/v1/userTrades":
            return list(self.user_trades)
        raise AssertionError(f"Unexpected endpoint {endpoint}")

    async def create_order(self, symbol, side, quantity, order_type="MARKET", reduce_only=False, client_order_id=None):
        oid = str(1000 + len(self.orders) + 1)
        px = self.ask if side == "BUY" else self.bid
        qty_f = float(quantity)
        self.orders.append({"orderId": oid, "symbol": symbol, "side": side, "qty": qty_f, "reduce_only": reduce_only, "client_order_id": client_order_id})
        # Update simulated exchange position
        cur = next((p for p in self.positions if p["symbol"] == symbol), None)
        signed_qty = qty_f if side == "BUY" else -qty_f
        if cur is None:
            cur = {"symbol": symbol, "positionAmt": "0", "markPrice": str(px), "positionSide": "BOTH"}
            self.positions.append(cur)
        new_amt = float(cur["positionAmt"]) + signed_qty
        cur["positionAmt"] = f"{new_amt:.6f}"
        return {"orderId": oid, "status": "FILLED", "executedQty": str(quantity), "avgPrice": str(px)}


class ForecastTraderTests(unittest.TestCase):
    def test_python_matches_js_causal_ridge_bit_for_bit(self):
        bars = _synthetic_4h_bars(320)
        settings_raw = {
            "symbol": "ETHUSDT",
            "interval": "4h",
            "horizon_bars": 1,
            "neutral_bps": 8,
            "confidence_pct": 49,
            "ridge_lambda": 400,
            "train_window": 200,
            "min_train_samples": 100,
        }
        source_idx = 295
        norm = causal_ridge.normalize_settings(settings_raw)
        indicators, rows = causal_ridge.build_feature_rows(bars, norm)
        samples = causal_ridge.make_samples(bars, rows, indicators, norm)
        eligible = [s for s in samples if s["target_index"] <= source_idx][-norm["train_window"]:]
        py_step = causal_ridge.forecast_step_from_eligible(bars, indicators, rows[source_idx], eligible, norm, source_idx)
        self.assertIsNotNone(py_step)

        pure_model = causal_ridge._fit_ridge_pure(eligible, norm["ridge_lambda"])
        if causal_ridge.np is not None:
            np_model = causal_ridge._fit_ridge_numpy(eligible, norm["ridge_lambda"])
            self.assertIsNotNone(np_model)
            self.assertAlmostEqual(pure_model["amplitude"], np_model["amplitude"], places=10)
            self.assertAlmostEqual(pure_model["norm_center"], np_model["norm_center"], places=10)
            self.assertAlmostEqual(pure_model["norm_sigma"], np_model["norm_sigma"], places=10)
            for w1, w2 in zip(pure_model["weights"], np_model["weights"]):
                self.assertAlmostEqual(w1, w2, places=10)

        script = (
            "const f = require('./price-forecast-tab.js');"
            "const payload = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
            "const out = f.forecastAtIndex(payload.bars, payload.settings, payload.idx);"
            "console.log(JSON.stringify(out));"
        )
        proc = subprocess.run(
            ["node", "-e", script],
            input=json.dumps({"bars": bars, "settings": settings_raw, "idx": source_idx}),
            text=True,
            capture_output=True,
            cwd=str(Path(__file__).resolve().parents[1]),
            check=True,
        )
        js_step = json.loads(proc.stdout.strip())
        self.assertAlmostEqual(py_step["expected_bps"], js_step["expected_bps"], places=8)
        self.assertAlmostEqual(py_step["confidence"], js_step["confidence"], places=8)
        self.assertEqual(py_step["direction"], js_step["direction"])
        self.assertEqual(py_step["feature_names"], js_step["feature_names"])

    def test_python_matches_js_full_replay_and_trades(self):
        bars = _synthetic_4h_bars(360)
        daily = _synthetic_1d_bars_from_4h(bars, bias="cycle")
        cfg = {
            "symbol": "ETHUSDT",
            "interval": "4h",
            "horizon_bars": 1,
            "neutral_bps": 8,
            "confidence_pct": 44,
            "ridge_lambda": 400,
            "train_window": 200,
            "min_train_samples": 100,
            "cost_bps": 10,
            "use_daily_trend_filter": True,
            "daily_ma_period": 20,
            "hold_same_direction": True,
            "use_stop_loss": True,
            "stop_loss_pct": 2.5,
            "notional_usd": 200.0,
            "leverage": 2.0,
        }
        py_rep = causal_ridge.run_causal_replay(
            bars, daily, cfg, notional_usd=200.0, leverage=2.0, max_eval_bars=120, initial_equity_usd=200.0,
        )
        self.assertIsNone(py_rep["error"])
        script = (
            "const f = require('./price-forecast-tab.js');"
            "const p = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
            "const out = f.runCausalReplayWithDaily(p.bars, p.daily, p.settings, { notional_usd: 200, leverage: 2, max_eval_bars: 120, initial_equity_usd: 200 });"
            "console.log(JSON.stringify(out));"
        )
        proc = subprocess.run(
            ["node", "-e", script],
            input=json.dumps({"bars": bars, "daily": daily, "settings": cfg}),
            text=True,
            capture_output=True,
            cwd=str(Path(__file__).resolve().parents[1]),
            check=True,
        )
        js_rep = json.loads(proc.stdout.strip())
        self.assertIsNone(js_rep["error"])
        self.assertEqual(len(py_rep["entry_signals"]), len(js_rep["entry_signals"]))
        for py_sig, js_sig in zip(py_rep["entry_signals"], js_rep["entry_signals"]):
            self.assertEqual(py_sig["time"], js_sig["time"])
            self.assertEqual(py_sig["side"], js_sig["side"])
            self.assertEqual(py_sig["entry_allowed"], js_sig["entry_allowed"])
            self.assertAlmostEqual(py_sig["expected_bps"], js_sig["expected_bps"], places=8)
            self.assertAlmostEqual(py_sig["confidence_pct"], js_sig["confidence_pct"], places=8)
        self.assertEqual(len(py_rep["trades"]), len(js_rep["trades"]))
        for py_t, js_t in zip(py_rep["trades"], js_rep["trades"]):
            self.assertEqual(py_t["entry_time"], js_t["entry_time"])
            self.assertEqual(py_t["exit_time"], js_t["exit_time"])
            self.assertEqual(py_t["reason"], js_t["reason"])
            self.assertAlmostEqual(py_t["net_pnl_usd"], js_t["net_pnl_usd"], places=8)
            self.assertAlmostEqual(py_t["roe_pct"], js_t["roe_pct"], places=8)
        self.assertAlmostEqual(py_rep["summary"]["return_on_initial_pct"], js_rep["summary"]["return_on_initial_pct"], places=8)
        self.assertAlmostEqual(py_rep["summary"]["max_drawdown_pct"], js_rep["summary"]["max_drawdown_pct"], places=8)
        self.assertAlmostEqual(py_rep["summary"]["worst_trade_pct"], js_rep["summary"]["worst_trade_pct"], places=8)
        self.assertEqual(py_rep["latest_evaluation"]["entry_allowed"], js_rep["latest_evaluation"]["entry_allowed"])
        self.assertAlmostEqual(py_rep["latest_evaluation"]["expected_bps"], js_rep["latest_evaluation"]["expected_bps"], places=8)

    def test_daily_filter_causality_and_position_independence(self):
        bars = _synthetic_4h_bars(340)
        d_up = _synthetic_1d_bars_from_4h(bars, bias="up")
        d_down = _synthetic_1d_bars_from_4h(bars, bias="down")
        base_cfg = {
            "min_train_samples": 100,
            "train_window": 200,
            "confidence_pct": 45,
            "use_daily_trend_filter": True,
            "daily_ma_period": 20,
        }

        r_up = causal_ridge.run_causal_replay(bars, d_up, base_cfg, notional_usd=200.0, leverage=1.0, max_eval_bars=120)
        self.assertIsNone(r_up["error"])
        allowed_sides_up = {s["side"] for s in r_up["entry_signals"] if s["entry_allowed"]}
        self.assertFalse(-1 in allowed_sides_up, "Shorts must never fire when completed 1d Close > MA20")

        r_down = causal_ridge.run_causal_replay(bars, d_down, base_cfg, notional_usd=200.0, leverage=1.0, max_eval_bars=120)
        allowed_sides_down = {s["side"] for s in r_down["entry_signals"] if s["entry_allowed"]}
        self.assertFalse(1 in allowed_sides_down, "Longs must never fire when completed 1d Close < MA20")

        # Mutating future 1d and 4h candles must not affect prior entry signals
        bars_fut = list(bars)
        d_fut = list(d_up)
        d_fut[-1] = {**d_fut[-1], "close": 1.0}
        d_fut[-2] = {**d_fut[-2], "close": 1.0}
        r_mut = causal_ridge.run_causal_replay(bars_fut, d_fut, base_cfg, notional_usd=200.0, leverage=1.0, max_eval_bars=120)
        self.assertEqual(r_up["entry_signals"][:50], r_mut["entry_signals"][:50])

        # Position size / leverage / stop-loss must NEVER alter entry_signals
        r_lev = causal_ridge.run_causal_replay(
            bars, d_up, {**base_cfg, "use_stop_loss": True, "stop_loss_pct": 1.5},
            notional_usd=4000.0, leverage=5.0, max_eval_bars=120,
        )
        self.assertEqual(r_up["entry_signals"], r_lev["entry_signals"])

    def test_forecast_bot_conflict_margin_pause_and_trade_lifecycle(self):
        async def _scenario():
            with tempfile.TemporaryDirectory() as tmpdir:
                state_file = Path(tmpdir) / "state.json"
                client = _FakeBinanceClient(
                    equity=880.0,
                    available=750.0,
                    positions=[{"symbol": "BTCUSDT", "positionAmt": "0.002", "markPrice": "61600", "notional": "123.2", "positionSide": "BOTH"}],
                )
                bars = _synthetic_4h_bars(320)
                d_up = _synthetic_1d_bars_from_4h(bars, bias="up")
                client.klines_4h = [[b["time"] * 1000, str(b["open"]), str(b["high"]), str(b["low"]), str(b["close"]), str(b["volume"]), b["close_time"] * 1000] for b in bars]
                client.klines_1d = [[d["time"] * 1000, str(d["open"]), str(d["high"]), str(d["low"]), str(d["close"]), str(d["volume"]), d["close_time"] * 1000] for d in d_up]

                def conflict(venue, symbol):
                    if venue == "binance_futures" and symbol == "BTCUSDT":
                        return "Tab 4 crypto_bot already owns Binance Futures BTCUSDT"
                    return None

                bot = ForecastTraderBot(client, state_path=state_file, conflict_checker=conflict)
                await bot.configure({
                    "selected_symbol": "ETHUSDT",
                    "notional_usd": 200.0,
                    "min_train_samples": 100,
                    "train_window": 200,
                    "confidence_pct": 40.0,
                })

                # Conflict must block switching onto Tab 4's symbol
                with self.assertRaisesRegex(ValueError, "already owns"):
                    await bot.configure({"selected_symbol": "BTCUSDT"})

                # Enable succeeds cleanly on ETHUSDT
                armed = await bot.toggle(True)
                self.assertTrue(armed["enabled"])

                # Configuring while armed must fail closed
                with self.assertRaisesRegex(ValueError, "Pause the live bot"):
                    await bot.configure({"notional_usd": 250.0})

                # Force next run_once to treat the newest bar as freshly closed within grace window
                latest_bar = bars[-1]
                bot.state["last_evaluated_candle"] = latest_bar["time"] - 14400
                bot._save()

                close_edge = latest_bar["close_time"]
                with patch("backend.forecast_bot.time.time", return_value=close_edge + 5.0), \
                     patch("backend.forecast_bot.evaluate_live_signal", return_value=(True, 1, False, {"time": latest_bar["time"], "close_time": close_edge, "entry_allowed": True, "direction": "up", "raw_side": 1, "confidence_pct": 55.0, "min_confidence_pct": 40.0, "confidence_pass": True, "expected_bps": 12.0, "probabilities": {"up": 0.55, "neutral": 0.25, "down": 0.20}, "train_samples": 200, "use_daily_trend_filter": True, "daily_ready": True, "daily_trend": 1, "daily_close": 2500.0, "daily_ma": 2400.0, "daily_ma_period": 20, "daily_close_time": close_edge, "side_allowed_by_daily": True, "symbol": "ETHUSDT", "venue": "binance_futures", "interval": "4h"})):
                    await bot.run_once()

                self.assertEqual(len(client.orders), 1)
                self.assertEqual(client.orders[0]["symbol"], "ETHUSDT")
                self.assertEqual(client.orders[0]["side"], "BUY")
                self.assertEqual(len(bot.state["tranches"]), 1)

                # Consecutive same-direction signal with hold_same_direction=True must hold without extra trade!
                next_bar_t = latest_bar["time"] + 14400
                client.klines_4h.append([next_bar_t * 1000, "2500", "2510", "2495", "2505", "500", (next_bar_t + 14400) * 1000])
                with patch("backend.forecast_bot.time.time", return_value=next_bar_t + 14405.0), \
                     patch("backend.forecast_bot.evaluate_live_signal", return_value=(True, 1, False, {"time": next_bar_t, "close_time": next_bar_t + 14400, "entry_allowed": True, "direction": "up", "raw_side": 1, "confidence_pct": 54.0, "min_confidence_pct": 40.0, "confidence_pass": True, "expected_bps": 10.0, "probabilities": {"up": 0.54, "neutral": 0.26, "down": 0.20}, "train_samples": 200, "use_daily_trend_filter": True, "daily_ready": True, "daily_trend": 1, "daily_close": 2510.0, "daily_ma": 2400.0, "daily_ma_period": 20, "daily_close_time": next_bar_t + 14400, "side_allowed_by_daily": True, "symbol": "ETHUSDT", "venue": "binance_futures", "interval": "4h"})):
                    await bot.run_once()
                self.assertEqual(len(client.orders), 1, "Hold streaks must skip needless exit+reentry churn")

                # Opposite signal must exit existing long then enter short
                rev_bar_t = next_bar_t + 14400
                client.klines_4h.append([rev_bar_t * 1000, "2505", "2515", "2480", "2485", "600", (rev_bar_t + 14400) * 1000])
                with patch("backend.forecast_bot.time.time", return_value=rev_bar_t + 14405.0), \
                     patch("backend.forecast_bot.evaluate_live_signal", return_value=(True, -1, False, {"time": rev_bar_t, "close_time": rev_bar_t + 14400, "entry_allowed": True, "direction": "down", "raw_side": -1, "confidence_pct": 53.0, "min_confidence_pct": 40.0, "confidence_pass": True, "expected_bps": -11.0, "probabilities": {"up": 0.20, "neutral": 0.27, "down": 0.53}, "train_samples": 200, "use_daily_trend_filter": True, "daily_ready": True, "daily_trend": -1, "daily_close": 2350.0, "daily_ma": 2400.0, "daily_ma_period": 20, "daily_close_time": rev_bar_t + 14400, "side_allowed_by_daily": True, "symbol": "ETHUSDT", "venue": "binance_futures", "interval": "4h"})):
                    await bot.run_once()
                self.assertEqual(len(client.orders), 3)
                self.assertTrue(client.orders[1]["reduce_only"])
                self.assertEqual(client.orders[1]["side"], "SELL")
                self.assertFalse(client.orders[2]["reduce_only"])
                self.assertEqual(client.orders[2]["side"], "SELL")
                self.assertEqual(bot.state["tranches"][-1]["side"], -1)

                # Flatten safely closes inventory and pauses bot
                flat = await bot.flatten()
                self.assertFalse(flat["enabled"])
                self.assertEqual(flat["tranches"], [])

        asyncio.run(_scenario())

    def test_forecast_api_mutations_require_terminal_unlock(self):
        client = TestClient(app)
        for route in ("/api/forecast-trader/config", "/api/forecast-trader/toggle", "/api/forecast-trader/reconcile", "/api/forecast-trader/flatten"):
            resp = client.post(route, json={})
            self.assertEqual(resp.status_code, 401, f"{route} must require terminal authorization")


if __name__ == "__main__":
    unittest.main()
