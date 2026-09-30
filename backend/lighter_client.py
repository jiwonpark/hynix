import asyncio
import copy
import json
import logging
from pathlib import Path
import time
from typing import Any, Dict, List, Optional

import aiohttp

logger = logging.getLogger("skhynix-daemon")


class LighterClient:
    """Client for Lighter market data and guarded signer execution.

    Trading enables when credentials (l1_address, api_key_private, account_index)
    are configured in backend/lighter_credentials.json.
    """

    BASE_URL = "https://mainnet.zklighter.elliot.ai"
    ADR_MARKET_ID = 216
    DOMESTIC_MARKET_ID = 161
    CREDENTIALS_FILE = Path(__file__).with_name("lighter_credentials.json")
    MAX_CLIENT_ORDER_INDEX = (1 << 48) - 1

    def __init__(self, base_url: Optional[str] = None):
        self.base_url = base_url or self.BASE_URL
        self._session: Optional[aiohttp.ClientSession] = None
        self._signer: Optional[Any] = None
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._cache_locks: Dict[str, asyncio.Lock] = {}
        self._ws_task: Optional[asyncio.Task] = None
        self._ws_books: Dict[int, Dict[str, Any]] = {}
        self._ws_book_times: Dict[int, float] = {}
        self._ws_account: Optional[Dict[str, Any]] = None
        self._ws_account_time = 0.0
        self._ws_connected = False
        self._ws_last_error: Optional[str] = None

    @staticmethod
    def _clone(value: Any) -> Any:
        return copy.deepcopy(value)

    async def _cached(self, key: str, ttl: float, loader: Any, *, allow_stale: bool = True) -> Any:
        """Coalesce identical REST reads and retain the last good value on transient failures."""
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached and now < float(cached["expires"]):
            return self._clone(cached["value"])
        lock = self._cache_locks.setdefault(key, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            cached = self._cache.get(key)
            if cached and now < float(cached["expires"]):
                return self._clone(cached["value"])
            try:
                value = await loader()
            except Exception:
                if allow_stale and cached:
                    logger.warning("Using stale cached Lighter data for %s", key)
                    return self._clone(cached["value"])
                raise
            self._cache[key] = {"value": self._clone(value), "expires": now + max(0.1, ttl)}
            return self._clone(value)

    def stream_status(self) -> Dict[str, Any]:
        now = time.monotonic()
        fresh_books = [market_id for market_id, updated in self._ws_book_times.items() if now - updated <= 15.0]
        return {
            "connected": self._ws_connected,
            "fresh_order_books": sorted(fresh_books),
            "account_live": bool(self._ws_connected and self._ws_account),
            "last_error": self._ws_last_error,
        }

    async def start_streams(self) -> None:
        if self._ws_task is None or self._ws_task.done():
            # Resolve and persist a missing account index before constructing subscriptions.
            try:
                await self.account_status()
            except Exception as error:
                logger.warning("Lighter account bootstrap unavailable; starting public streams: %s", error)
            self._ws_task = asyncio.create_task(self._stream_loop(), name="lighter-market-stream")

    async def _stream_loop(self) -> None:
        delay = 1.0
        ws_url = self.base_url.replace("https://", "wss://").replace("http://", "ws://").rstrip("/") + "/stream"
        while True:
            try:
                session = await self.get_session()
                async with session.ws_connect(ws_url, heartbeat=20, receive_timeout=45) as ws:
                    self._ws_connected = True
                    self._ws_account = None
                    self._ws_account_time = 0.0
                    self._ws_last_error = None
                    delay = 1.0
                    subscribed = False
                    async for message in ws:
                        if message.type == aiohttp.WSMsgType.TEXT:
                            payload = json.loads(message.data)
                            if payload.get("type") == "connected" and not subscribed:
                                await ws.send_json({"type": "subscribe", "channel": f"order_book/{self.ADR_MARKET_ID}"})
                                await ws.send_json({"type": "subscribe", "channel": f"order_book/{self.DOMESTIC_MARKET_ID}"})
                                creds = self.get_credentials() or {}
                                if creds.get("account_index") is not None:
                                    await ws.send_json({"type": "subscribe", "channel": f"account_all/{creds['account_index']}"})
                                subscribed = True
                            elif payload.get("type") == "ping":
                                await ws.send_json({"type": "pong"})
                            else:
                                self._handle_stream_message(payload)
                        elif message.type in {aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR}:
                            break
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self._ws_last_error = str(error)[:300]
                logger.warning("Lighter websocket reconnecting after error: %s", error)
            finally:
                self._ws_connected = False
            await asyncio.sleep(delay)
            delay = min(30.0, delay * 2.0)

    @staticmethod
    def _channel_id(channel: Any) -> Optional[int]:
        text = str(channel or "")
        for separator in (":", "/"):
            if separator in text:
                try:
                    return int(text.rsplit(separator, 1)[-1])
                except ValueError:
                    return None
        return None

    def _handle_stream_message(self, payload: Dict[str, Any]) -> None:
        message_type = str(payload.get("type") or "")
        if message_type in {"subscribed/order_book", "update/order_book"}:
            market_id = self._channel_id(payload.get("channel"))
            update = payload.get("order_book") or {}
            if market_id not in {self.ADR_MARKET_ID, self.DOMESTIC_MARKET_ID} or not isinstance(update, dict):
                return
            if message_type == "subscribed/order_book" or market_id not in self._ws_books:
                self._ws_books[market_id] = self._clone(update)
            else:
                book = self._ws_books[market_id]
                for side in ("asks", "bids"):
                    levels = {str(row.get("price")): dict(row) for row in book.get(side, [])}
                    for row in update.get(side, []):
                        price = str(row.get("price"))
                        if float(row.get("size", 0) or 0) <= 0:
                            levels.pop(price, None)
                        else:
                            levels[price] = dict(row)
                    book[side] = list(levels.values())
            self._ws_book_times[market_id] = time.monotonic()
        elif message_type in {"subscribed/account_all", "update/account_all"}:
            self._ws_account = self._clone(payload)
            self._ws_account_time = time.monotonic()

    def _stream_positions(self) -> Optional[List[Dict[str, Any]]]:
        if not self._ws_connected or not self._ws_account:
            return None
        positions = self._ws_account.get("positions")
        if isinstance(positions, dict):
            positions = list(positions.values())
        return self._clone(positions) if isinstance(positions, list) else None

    async def _account_snapshot(self) -> Optional[Dict[str, Any]]:
        creds = self.get_credentials() or {}
        address = creds.get("l1_address")
        if not address:
            return None

        async def load() -> Optional[Dict[str, Any]]:
            payload = await self.request("/api/v1/account", {"by": "l1_address", "value": address})
            accounts = payload.get("accounts") or []
            return accounts[0] if accounts else None

        return await self._cached(f"account:{address}", 3.0, load)

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
            acc = await self._account_snapshot()
            if acc:
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
        except Exception as error:
            return {
                "configured": True,
                "l1_address": address,
                "account_index": creds.get("account_index"),
                "collateral": 0.0,
                "authenticated": False,
                "execution_enabled": False,
                "message": "Lighter account status is temporarily unavailable.",
                "error": str(error),
            }

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
        if self._ws_task is not None:
            self._ws_task.cancel()
            await asyncio.gather(self._ws_task, return_exceptions=True)
            self._ws_task = None
        if self._signer is not None:
            try:
                await self._signer.close()
            except Exception as error:
                logger.warning("Could not close Lighter signer: %s", error)
            self._signer = None
        if self._session and not self._session.closed:
            await self._session.close()

    async def positions(self) -> List[Dict[str, Any]]:
        """Return the configured account's open positions without exposing credentials."""
        streamed = self._stream_positions()
        if streamed is not None:
            return streamed
        creds = self.get_credentials() or {}
        address = creds.get("l1_address")
        if not address:
            return []
        account = await self._account_snapshot()
        return list((account or {}).get("positions") or [])

    async def create_market_order(
        self, market_id: int, base_amount: float, reference_price: float,
        is_ask: bool, *, reduce_only: bool = False, max_slippage: float = 0.006,
    ) -> Dict[str, Any]:
        """Submit one IOC market order using explicit size/price precision guards."""
        if base_amount <= 0 or reference_price <= 0:
            raise ValueError("Lighter order size and reference price must be positive")
        signer = self.get_signer()
        if signer is None:
            raise RuntimeError("Lighter signer is not configured")
        check_error = signer.check_client()
        if check_error:
            raise RuntimeError(f"Lighter signer validation failed: {check_error}")
        detail = await self.market_detail(market_id)
        size_decimals = int(detail["supported_size_decimals"])
        price_decimals = int(detail["supported_price_decimals"])
        minimum = float(detail.get("min_base_amount") or 0)
        quantized_size = int(base_amount * (10 ** size_decimals))
        if quantized_size <= 0 or quantized_size < int(minimum * (10 ** size_decimals)):
            raise ValueError(f"Lighter market {market_id} order is below its minimum size")
        protected_price = reference_price * (1 - max_slippage if is_ask else 1 + max_slippage)
        price_int = int(round(protected_price * (10 ** price_decimals)))
        client_order_index = int(time.time_ns() % self.MAX_CLIENT_ORDER_INDEX) or 1
        _, response, error = await signer.create_market_order(
            market_id, client_order_index, quantized_size, price_int, is_ask,
            reduce_only=reduce_only,
        )
        if error:
            raise RuntimeError(f"Lighter order rejected: {error}")
        accepted = {
            "market_id": market_id,
            "client_order_index": client_order_index,
            "base_amount": quantized_size / (10 ** size_decimals),
            "is_ask": is_ask,
            "reduce_only": reduce_only,
            "tx_hash": getattr(response, "tx_hash", None),
            "reference_price": reference_price,
            "limit_price": protected_price,
            "fee_rate": float(detail.get("taker_fee") or 0.0),
            "fee_usd": quantized_size / (10 ** size_decimals) * reference_price * float(detail.get("taker_fee") or 0.0),
        }
        fill = await self.execution_fill(client_order_index, market_id, accepted["base_amount"])
        return {**accepted, **fill}

    async def execution_fill(
        self, client_order_index: int, market_id: int, expected_size: float,
    ) -> Dict[str, Any]:
        """Return authoritative exchange fills for an accepted client order."""
        creds = self.get_credentials() or {}
        account_index = creds.get("account_index")
        signer = self.get_signer()
        if account_index is None or signer is None:
            return {"fill_confirmed": False}
        auth, error = signer.create_auth_token_with_expiry(
            api_key_index=int(creds.get("api_key_index", 0))
        )
        if error:
            logger.warning("Could not authenticate Lighter fill lookup: %s", error)
            return {"fill_confirmed": False}

        expected_key = str(client_order_index)
        for attempt in range(12):
            try:
                payload = await self.request(
                    "/api/v1/trades",
                    {
                        "account_index": int(account_index),
                        "market_id": int(market_id),
                        "sort_by": "timestamp",
                        "sort_dir": "desc",
                        "limit": 100,
                    },
                    headers={"authorization": auth},
                )
                matches = [
                    trade for trade in (payload.get("trades") or [])
                    if str(trade.get("ask_client_id_str") or trade.get("ask_client_id") or "") == expected_key
                    or str(trade.get("bid_client_id_str") or trade.get("bid_client_id") or "") == expected_key
                ]
                filled_size = sum(abs(float(trade.get("size", 0.0) or 0.0)) for trade in matches)
                fill_tolerance = max(0.0002 if int(market_id) == 216 else 0.0011, expected_size * 0.005)
                if matches and filled_size >= expected_size - fill_tolerance:
                    usd_amount = sum(abs(float(trade.get("usd_amount", 0.0) or 0.0)) for trade in matches)
                    realized_pnl = 0.0
                    fee_usd = 0.0
                    latest_timestamp = 0
                    for trade in matches:
                        is_ask = int(trade.get("ask_account_id", -1) or -1) == int(account_index)
                        pnl_field = "ask_account_pnl" if is_ask else "bid_account_pnl"
                        realized_pnl += float(trade.get(pnl_field, 0.0) or 0.0)
                        raw_fee = float(trade.get("taker_fee", 0.0) or 0.0)
                        fee_rate = raw_fee / 1_000_000.0 if raw_fee >= 1.0 else raw_fee
                        fee_usd += abs(float(trade.get("usd_amount", 0.0) or 0.0)) * fee_rate
                        latest_timestamp = max(latest_timestamp, int(trade.get("timestamp", 0) or 0))
                    return {
                        "fill_confirmed": True,
                        "base_amount": filled_size,
                        "filled_size": filled_size,
                        "fill_price": usd_amount / filled_size if filled_size else 0.0,
                        "filled_usd": usd_amount,
                        "fee_rate": fee_usd / usd_amount if usd_amount else 0.0,
                        "fee_usd": fee_usd,
                        "realized_pnl_usd": realized_pnl,
                        "fill_time_ms": latest_timestamp,
                        "fill_count": len(matches),
                        "fills": matches,
                    }
            except Exception as lookup_error:
                logger.warning("Lighter fill lookup attempt %s failed: %s", attempt + 1, lookup_error)
            if attempt < 11:
                await asyncio.sleep(0.25)
        return {"fill_confirmed": False}

    async def request(
        self, endpoint: str, params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        session = await self.get_session()
        for attempt in range(3):
            try:
                async with session.get(
                    f"{self.base_url}{endpoint}",
                    params=params or {},
                    headers={"User-Agent": "SKHynix-QuantEngine/1.0", **(headers or {})},
                ) as response:
                    payload = await response.json(content_type=None)
                    if response.status == 200 and payload.get("code") == 200:
                        return payload
                    retryable = response.status == 429 or response.status >= 500
                    if retryable and attempt < 2:
                        retry_after = response.headers.get("Retry-After")
                        delay = float(retry_after) if retry_after and retry_after.replace(".", "", 1).isdigit() else 0.5 * (2 ** attempt)
                        await asyncio.sleep(min(4.0, max(0.1, delay)))
                        continue
                    raise RuntimeError(f"Lighter API error ({response.status})")
            except asyncio.TimeoutError:
                if attempt < 2:
                    await asyncio.sleep(0.5 * (2 ** attempt))
                    continue
                raise TimeoutError(f"Lighter GET {endpoint} timed out") from None
        raise RuntimeError("Lighter API retry loop exhausted")

    async def market_detail(self, market_id: int) -> Dict[str, Any]:
        async def load() -> Dict[str, Any]:
            payload = await self.request("/api/v1/orderBookDetails", {"market_id": market_id})
            details = payload.get("order_book_details") or []
            if not details:
                raise RuntimeError(f"Lighter market {market_id} is unavailable")
            return details[0]

        return await self._cached(f"market-detail:{market_id}", 3600.0, load)

    async def order_book(self, market_id: int, limit: int = 20) -> Dict[str, Any]:
        bounded_limit = min(100, max(1, limit))
        updated = self._ws_book_times.get(market_id, 0.0)
        if time.monotonic() - updated <= 15.0 and market_id in self._ws_books:
            book = self._clone(self._ws_books[market_id])
            book["asks"] = sorted(book.get("asks") or [], key=lambda row: float(row["price"]))[:bounded_limit]
            book["bids"] = sorted(book.get("bids") or [], key=lambda row: float(row["price"]), reverse=True)[:bounded_limit]
            return book

        async def load() -> Dict[str, Any]:
            return await self.request(
                "/api/v1/orderBookOrders", {"market_id": market_id, "limit": bounded_limit}
            )

        return await self._cached(f"order-book:{market_id}:{bounded_limit}", 2.0, load)

    async def candles(
        self, market_id: int, resolution: str, count: int, end_timestamp: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        interval_ms = {
            "1m": 60_000, "5m": 300_000, "15m": 900_000,
            "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
        }[resolution]
        end_ms = end_timestamp or int(time.time() * 1000)
        bounded_count = min(500, max(20, count))
        fetch_count = 500 if end_timestamp is None else bounded_count
        start_ms = end_ms - interval_ms * (fetch_count + 4)

        async def load() -> List[Dict[str, Any]]:
            payload = await self.request("/api/v1/candles", {
                "market_id": market_id,
                "resolution": resolution,
                "start_timestamp": start_ms,
                "end_timestamp": end_ms,
                "count_back": fetch_count,
            })
            return payload.get("c") or []

        # Historical requests are immutable. Live requests refresh just after the next bar closes.
        if end_timestamp is not None:
            ttl = 3600.0
            cache_suffix = str(end_timestamp)
        else:
            ttl = max(1.0, ((end_ms // interval_ms + 1) * interval_ms - end_ms) / 1000.0 + 1.0)
            cache_suffix = "latest"
        rows = await self._cached(
            f"candles:{market_id}:{resolution}:{fetch_count}:{cache_suffix}", ttl, load
        )
        return rows[-bounded_count:]
