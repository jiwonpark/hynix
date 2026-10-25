import asyncio
import unittest
from unittest.mock import AsyncMock
from backend.chart_cache import ChartResponseCache


class ChartCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_cold_reads_share_work_and_caller_cancellation_does_not_cancel_load(self):
        cache = ChartResponseCache()
        gate = asyncio.Event()
        async def load():
            await gate.wait()
            return {"bars": [{"time": 1, "value": 5}]}
        loader = AsyncMock(side_effect=load)
        first = asyncio.create_task(cache.get("btc", loader, 15))
        second = asyncio.create_task(cache.get("btc", loader, 15))
        await asyncio.sleep(0)
        first.cancel()
        gate.set()
        with self.assertRaises(asyncio.CancelledError):
            await first
        result = await second
        self.assertEqual(len(result["bars"]), 1)
        self.assertFalse(result["stale"])
        self.assertEqual(loader.await_count, 1)

    async def test_stale_chart_returns_without_waiting_for_refresh(self):
        cache = ChartResponseCache(timeout=.01)
        cache.values["btc"] = (1, {"bars": [{"time": 1}]})
        async def slow():
            await asyncio.Event().wait()
        result = await cache.get("btc", slow, 15)
        self.assertTrue(result["stale"])
        self.assertEqual(result["fetched_at"], 1)
        task = cache.tasks["btc"]
        with self.assertRaises(asyncio.TimeoutError):
            await task
        self.assertNotIn("btc", cache.tasks)
        self.assertGreater(cache.retry_after["btc"], 0)

    async def test_cold_timeout_is_bounded_and_backed_off(self):
        cache = ChartResponseCache(timeout=.01)
        async def slow():
            await asyncio.Event().wait()
        loader = AsyncMock(side_effect=slow)
        with self.assertRaises(asyncio.TimeoutError):
            await cache.get("btc", loader, 15)
        with self.assertRaisesRegex(RuntimeError, "retrying"):
            await cache.get("btc", loader, 15)
        self.assertEqual(loader.await_count, 1)

    async def test_empty_refresh_does_not_replace_good_bars(self):
        cache = ChartResponseCache()
        cache.values["btc"] = (1, {"bars": [{"time": 1}]})
        await cache.get("btc", AsyncMock(return_value={"bars": []}), 15)
        await asyncio.sleep(.01)
        self.assertEqual(cache.values["btc"][0], 1)
