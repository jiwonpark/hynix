import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

if "aiohttp" not in sys.modules:
    try:
        import aiohttp
    except ImportError:
        sys.modules["aiohttp"] = MagicMock()

if "jwt" not in sys.modules:
    try:
        import jwt
    except ImportError:
        sys.modules["jwt"] = MagicMock()

from backend.upbit_client import UpbitClient
from backend.strategy_lab import UpbitStrategyExecutionEngine, STRATEGY_PRESETS


class TestUpbitLiveStrategy(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.state_file = Path(self.temp_dir) / "test_strategy_state.json"
        self.engine = UpbitStrategyExecutionEngine(state_file=self.state_file)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_default_state_initialization(self):
        status = self.engine.get_status(current_price=100000000.0)
        self.assertFalse(status["enabled"])
        self.assertEqual(status["mode"], "paper")
        self.assertEqual(status["active_strategy"], "multi_factor")
        self.assertEqual(status["tranche_size_krw"], 2000000.0)
        self.assertEqual(status["max_tranches"], 5)
        self.assertEqual(status["active_tranches_count"], 0)

    def test_set_strategy_and_options(self):
        async def run():
            status = await self.engine.set_strategy("rsi_momentum", {"entry_rsi_dual": True})
            self.assertEqual(status["active_strategy"], "rsi_momentum")
            self.assertEqual(status["strategy_badge"], "RSI MOMENTUM")
            self.assertTrue(status["strategy_options"]["entry_rsi_dual"])

            # Switch to OU Quant
            status2 = await self.engine.set_strategy("ou_quant")
            self.assertEqual(status2["active_strategy"], "ou_quant")
            self.assertEqual(status2["strategy_badge"], "OU SDE QUANT")
        asyncio.run(run())

    def test_set_mode_and_sizing(self):
        async def run():
            status = await self.engine.set_mode("live")
            self.assertEqual(status["mode"], "live")

            status = await self.engine.set_sizing(tranche_size_krw=3000000.0, max_tranches=4, min_profit_pct=0.35)
            self.assertEqual(status["tranche_size_krw"], 3000000.0)
            self.assertEqual(status["max_tranches"], 4)
            self.assertEqual(status["min_profit_pct"], 0.35)
        asyncio.run(run())

    def test_toggle_enabled(self):
        async def run():
            status = await self.engine.toggle_enabled()
            self.assertTrue(status["enabled"])
            status = await self.engine.toggle_enabled(False)
            self.assertFalse(status["enabled"])
        asyncio.run(run())

    def test_paper_execution_flow(self):
        async def run():
            # Arm engine with dual MA stack
            await self.engine.set_strategy("ma_stack")
            await self.engine.set_mode("paper")
            await self.engine.set_sizing(tranche_size_krw=1000000.0, max_tranches=3)
            await self.engine.toggle_enabled(True)

            # Generate synthetic 5m candles with dip and recovery
            base_time = 1726700000
            candles = []
            price = 100000.0
            for i in range(70):
                t = base_time + (i * 300)
                if i < 40:
                    price += 100.0
                elif i < 55:
                    price -= 200.0  # Dip below MA
                else:
                    price += 300.0  # Recovery
                candles.append({
                    "time": t,
                    "open": price - 50.0,
                    "high": price + 100.0,
                    "low": price - 100.0,
                    "close": price,
                    "volume": 10.0,
                })

            mock_client = MagicMock()
            status = await self.engine.execute_step(mock_client, candles[:60], [])
            state = self.engine.load_state()
            self.assertIsNotNone(state)

            # Now test emergency flatten
            flatten_status = await self.engine.emergency_flatten(mock_client, current_price=105000.0)
            self.assertFalse(flatten_status["enabled"])
            self.assertEqual(flatten_status["active_tranches_count"], 0)
        asyncio.run(run())

    def test_upbit_client_order_methods(self):
        async def run():
            client = UpbitClient(access_key="test_access", secret_key="test_secret", base_url="https://api.upbit.com")
            
            with patch.object(client, "request", new_callable=AsyncMock) as mock_req:
                mock_req.return_value = {"uuid": "test-uuid-1234", "side": "bid", "ord_type": "price", "state": "wait"}

                res = await client.create_order(market="KRW-BTC", side="bid", price="2000000", ord_type="price")
                self.assertEqual(res["uuid"], "test-uuid-1234")
                mock_req.assert_called_once()
                args, kwargs = mock_req.call_args
                self.assertEqual(args[0], "POST")
                self.assertEqual(args[1], "/v1/orders")
                self.assertEqual(kwargs.get("params", {}).get("side"), "bid")
                self.assertEqual(kwargs.get("params", {}).get("ord_type"), "price")
                self.assertEqual(kwargs.get("params", {}).get("price"), "2000000")
                self.assertTrue(kwargs.get("signed"))

            with patch.object(client, "request", new_callable=AsyncMock) as mock_req:
                mock_req.return_value = {"uuid": "test-uuid-1234", "state": "done", "executed_volume": "0.018"}
                res = await client.get_order(uuid="test-uuid-1234")
                self.assertEqual(res["executed_volume"], "0.018")
                args, kwargs = mock_req.call_args
                self.assertEqual(args[0], "GET")
                self.assertEqual(args[1], "/v1/order")

            with patch.object(client, "request", new_callable=AsyncMock) as mock_req:
                mock_req.return_value = {"uuid": "test-uuid-1234", "state": "cancel"}
                res = await client.cancel_order(uuid="test-uuid-1234")
                self.assertEqual(res["state"], "cancel")
                args, kwargs = mock_req.call_args
                self.assertEqual(args[0], "DELETE")
                self.assertEqual(args[1], "/v1/order")

            with patch.object(client, "request", new_callable=AsyncMock) as mock_req:
                mock_req.return_value = {"bid_fee": "0.0005", "ask_fee": "0.0005"}
                res = await client.get_orders_chance("KRW-BTC")
                self.assertEqual(res["bid_fee"], "0.0005")
                args, kwargs = mock_req.call_args
                self.assertEqual(args[0], "GET")
                self.assertEqual(args[1], "/v1/orders_chance")

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
