import asyncio
import json
import logging
from pathlib import Path
import time
from typing import Any, Dict, List, Optional

import aiohttp

logger = logging.getLogger("skhynix-daemon")


class LighterClient:
    """Client for Lighter's market-data API and live signer execution.

    Trading enables when credentials (l1_address, api_key_private, account_index)
    are configured in backend/lighter_credentials.json.
    """

    BASE_URL = "https://mainnet.zklighter.elliot.ai"
    ADR_MARKET_ID = 216
    DOMESTIC_MARKET_ID = 161
    CREDENTIALS_FILE = Path(__file__).with_name("lighter_credentials.json")

    def __init__(self, base_url: Optional[str] = None):
        self.base_url = base_url or self.BASE_URL
        self._session: Optional[aiohttp.ClientSession] = None
        self._signer: Optional[Any] = None

    def get_credentials(self) -> Optional[Dict[str, Any]]:
        if not self.CREDENTIALS_FILE.exists():
            return None
        try:
            return json.loads(self.CREDENTIALS_FILE.read_text())
        except Exception as error:
            logger.warning("Error reading lighter_credentials.json: %s", error)
            return None

    async def account_status(self) -> Dict[str, Any]:
        creds = self.get_credentials()
        if not creds or not creds.get("l1_address"):
            return {
                "configured": False,
                "l1_address": None,
                "account_index": None,
                "collateral": 0.0,
                "authenticated": False,
                "execution_enabled": False,
                "message": "No Lighter credentials configured."
            }

        address = creds["l1_address"]
        try:
            payload = await self.request("/api/v1/account", {"by": "l1_address", "value": address})
            accounts = payload.get("accounts") or []
            if accounts:
                acc = accounts[0]
                acc_idx = acc.get("account_index")
                collateral = float(acc.get("collateral", 0.0))
                if acc_idx and creds.get("account_index") != acc_idx:
                    creds["account_index"] = acc_idx
                    try:
                        self.CREDENTIALS_FILE.write_text(json.dumps(creds, indent=2))
                    except Exception:
                        pass
                return {
                    "configured": True,
                    "l1_address": address,
                    "account_index": acc_idx,
                    "collateral": collateral,
                    "authenticated": True,
                    "execution_enabled": collateral > 0,
                    "message": f"Account #{acc_idx} active · ${collateral:.2f} Collateral"
                }
        except Exception:
            pass

        return {
            "configured": True,
            "l1_address": address,
            "account_index": creds.get("account_index"),
            "collateral": 0.0,
            "authenticated": False,
            "execution_enabled": False,
            "message": f"Bot wallet ready ({address[:6]}...{address[-4:]}). Awaiting initial deposit on Arbitrum/Lighter."
        }

    def get_signer(self) -> Optional[Any]:
        creds = self.get_credentials()
        if not creds:
            return None
        acc_idx = creds.get("account_index")
        api_priv = creds.get("api_private_key")
        key_idx = creds.get("api_key_index", 0)
        if acc_idx is None or not api_priv:
            return None
        try:
            import lighter
            if self._signer is None:
                self._signer = lighter.SignerClient(
                    url=self.base_url,
                    api_private_keys={key_idx: api_priv},
                    account_index=acc_idx
                )
            return self._signer
        except Exception as error:
            logger.warning("Could not initialize lighter.SignerClient: %s", error)
            return None

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

