import asyncio
import time
from typing import Any, Dict, List, Optional

import aiohttp


class LighterClient:
    """Small read-only client for Lighter's public market-data API.

    Trading intentionally remains unavailable until the official signer/account
    credentials are configured; callers can safely expose that state in the UI.
    """

    BASE_URL = "https://mainnet.zklighter.elliot.ai"
    ADR_MARKET_ID = 216
    DOMESTIC_MARKET_ID = 161

    def __init__(self, base_url: Optional[str] = None):
        self.base_url = base_url or self.BASE_URL
        self._session: Optional[aiohttp.ClientSession] = None

    async def get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8, connect=3))
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def request(self, endpoint: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        session = await self.get_session()
        try:
            async with session.get(
                f"{self.base_url}{endpoint}",
                params=params or {},
                headers={"User-Agent": "SKHynix-QuantEngine/1.0"},
            ) as response:
                payload = await response.json(content_type=None)
                if response.status != 200 or payload.get("code") != 200:
                    raise RuntimeError(f"Lighter API error ({response.status})")
                return payload
        except asyncio.TimeoutError:
            raise TimeoutError(f"Lighter GET {endpoint} timed out") from None

    async def market_detail(self, market_id: int) -> Dict[str, Any]:
        payload = await self.request("/api/v1/orderBookDetails", {"market_id": market_id})
        details = payload.get("order_book_details") or []
        if not details:
            raise RuntimeError(f"Lighter market {market_id} is unavailable")
        return details[0]

    async def order_book(self, market_id: int, limit: int = 20) -> Dict[str, Any]:
        return await self.request(
            "/api/v1/orderBookOrders", {"market_id": market_id, "limit": min(100, max(1, limit))}
        )

    async def candles(
        self, market_id: int, resolution: str, count: int, end_timestamp: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        interval_ms = {
            "1m": 60_000, "5m": 300_000, "15m": 900_000,
            "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
        }[resolution]
        end_ms = end_timestamp or int(time.time() * 1000)
        start_ms = end_ms - interval_ms * (count + 4)
        payload = await self.request("/api/v1/candles", {
            "market_id": market_id,
            "resolution": resolution,
            "start_timestamp": start_ms,
            "end_timestamp": end_ms,
            "count_back": min(500, max(20, count)),
        })
        return payload.get("c") or []

