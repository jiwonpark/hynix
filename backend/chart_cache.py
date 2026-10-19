"""Bounded, coalesced reads for display/replay data, never for order execution."""
import asyncio
import time


class ChartResponseCache:
    def __init__(self, timeout=12.0):
        self.timeout = timeout
        self.values = {}
        self.tasks = {}
        self.retry_after = {}

    async def get(self, key, loader, ttl):
        now = time.time()
        cached = self.values.get(key)
        if cached and now - cached[0] < ttl:
            return dict(cached[1], stale=False, fetched_at=cached[0])
        task = self.tasks.get(key)
        if task is None and now >= self.retry_after.get(key, 0):
            async def refresh():
                try:
                    result = await asyncio.wait_for(loader(), self.timeout)
                    if not result.get("bars"):
                        raise ValueError(result.get("error") or "No candle data returned")
                    self.values[key] = (time.time(), result)
                    return result
                except Exception:
                    self.retry_after[key] = time.time() + 5
                    raise
                finally:
                    self.tasks.pop(key, None)
            task = self.tasks[key] = asyncio.create_task(refresh())
            # Background refresh failures must be consumed even when serving cache.
            task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        if cached:
            return dict(cached[1], stale=True, fetched_at=cached[0])
        if task is None:
            raise RuntimeError("Candle source unavailable; retrying shortly")
        result = await asyncio.shield(task)
        return dict(result, stale=False, fetched_at=self.values[key][0])
