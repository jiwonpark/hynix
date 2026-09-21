import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.forecast_validation import update_forward_validation


class ForwardValidationTests(unittest.TestCase):
    def test_persists_then_settles_without_overlapping_forecast(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.json"
            base = 1_800_000_000
            rows = [{"market": "KRW-TEST", "forecast_probability_pct": 70.0,
                     "forecast_confidence_pct": 60.0, "score": 62.0}]
            candles = [{"time": base, "open": 100, "high": 100, "low": 100, "close": 100}]
            with patch("backend.forecast_validation.time.time", return_value=base + 3600):
                summary = update_forward_validation(rows, {"KRW-TEST": candles}, path)
            self.assertEqual(summary["pending_forecasts"], 1)
            self.assertEqual(summary["resolved_forecasts"], 0)
            future = candles + [{"time": base + 3600, "open": 100, "high": 103, "low": 100, "close": 102}]
            rows2 = [{"market": "KRW-TEST", "forecast_probability_pct": 70.0,
                      "forecast_confidence_pct": 60.0, "score": 62.0}]
            with patch("backend.forecast_validation.time.time", return_value=base + 7200):
                summary = update_forward_validation(rows2, {"KRW-TEST": future}, path)
            self.assertEqual(summary["resolved_forecasts"], 1)
            self.assertEqual(summary["qualified_signals"], 1)
            self.assertAlmostEqual(summary["average_net_return_pct"], 1.8)
            ledger = json.loads(path.read_text())
            self.assertEqual(ledger["forecasts"][0]["exit_reason"], "TARGET")

    def test_same_bar_target_and_stop_is_conservative_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.json"
            base = 1_800_000_000
            row = {"market": "KRW-TEST", "forecast_probability_pct": 70.0,
                   "forecast_confidence_pct": 60.0, "score": 62.0}
            first = [{"time": base, "open": 100, "high": 100, "low": 100, "close": 100}]
            with patch("backend.forecast_validation.time.time", return_value=base + 3600):
                update_forward_validation([dict(row)], {"KRW-TEST": first}, path)
            both = first + [{"time": base + 3600, "open": 100, "high": 103, "low": 98, "close": 100}]
            with patch("backend.forecast_validation.time.time", return_value=base + 7200):
                update_forward_validation([dict(row)], {"KRW-TEST": both}, path)
            ledger = json.loads(path.read_text())
            self.assertEqual(ledger["forecasts"][0]["exit_reason"], "STOP")
            self.assertEqual(ledger["forecasts"][0]["target_hit"], 0)
