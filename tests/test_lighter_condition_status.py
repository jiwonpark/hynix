"""Condition verdicts come from completed-candle replay predicates."""
import math
import time
import unittest
from unittest.mock import AsyncMock, patch

from backend import server


class ConditionStatusTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def bars():
        start = int(time.time()) - 132 * 300
        return [
            {"time": start + index * 300,
             "value": 100 + 0.025 * index + 0.12 * math.sin(index / 4)}
            for index in range(130)
        ]

    async def test_tab3_ou_exposes_the_shared_evaluator_verdicts(self):
        bars = self.bars()
        with patch.object(server, "get_lighter_parity", AsyncMock(return_value={"success": True, "bars": bars})):
            result = await server.get_lighter_backtest(
                interval="5m", strategy_mode="ou_quant", entry_z=1.5,
                ou_min_abs_deviation_pp=100.0, ou_use_macro_trend=False)
        evaluation = result["latest_evaluation"]
        checks = evaluation["condition_pass"]
        self.assertEqual(evaluation["time"], bars[-1]["time"])
        self.assertEqual(checks["entry_z"], abs(evaluation["signal_z"]) >= 1.5)
        self.assertFalse(checks["entry_min_deviation"])
        self.assertEqual(checks["exit_emergency_stop"], abs(evaluation["signal_z"]) >= 3.5)

    async def test_tab5_all_research_modes_return_latest_condition_verdicts(self):
        bars = self.bars()
        with patch.object(server, "get_lighter_crypto_candles", AsyncMock(return_value={"success": True, "bars": bars})):
            for mode, key in (("grid", "entry_z"), ("custom", "entry_spacing"),
                              ("ou_quant", "entry_min_deviation"),
                              ("ma_stack", "entry_stretch"),
                              ("multi_factor", "entry_quorum"),
                              ("trend_pullback", "entry_micro_reversal")):
                with self.subTest(mode=mode):
                    result = await server.get_crypto_backtest(
                        symbol="BTC", interval="5m", strategy_mode=mode,
                        market_source="lighter", ou_min_abs_deviation_pp=100.0)
                    self.assertEqual(result["latest_condition_time"], bars[-1]["time"])
                    self.assertIn(key, result["latest_conditions"])
                    self.assertIsInstance(result["latest_conditions"][key], bool)
                    if mode == "ou_quant":
                        self.assertFalse(result["latest_conditions"][key])
