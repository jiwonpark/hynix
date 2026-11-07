import asyncio
import copy
import json
import logging
from pathlib import Path
import time
from decimal import Decimal, ROUND_DOWN
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
        # Serialize account-wide capacity checks and multi-bot submissions.
        self.execution_lock = asyncio.Lock()

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
            self._cache[key] = {
                "value": self._clone(value),
                "expires": time.monotonic() + max(0.1, ttl),
                "updated_at_ms": int(time.time() * 1000),
            }
            return self._clone(value)

    def account_telemetry_snapshot(self) -> Optional[Dict[str, Any]]:
        """Return the latest account stream/cache without making a network call.

        Dashboard reads must remain responsive when Lighter REST is degraded.
        The caller receives the source timestamp so stale data is never shown as
        a freshly fetched zero or empty account.
        """
        creds = self.get_credentials() or {}
        address = creds.get("l1_address")
        if not address:
            return None
        cached = self._cache.get(f"account:{address}")
        cached_account = (self._clone(cached.get("value"))
                          if cached and isinstance(cached.get("value"), dict) else None)
        if self._ws_account:
            streamed_account = self._ws_account.get("account")
            if not isinstance(streamed_account, dict):
                streamed_account = self._ws_account
            account = {**(cached_account or {}), **streamed_account}
            if "positions" in self._ws_account:
                account["positions"] = self._ws_account.get("positions")
            stream_updated_at_ms = int(
                time.time() * 1000 - max(0.0, time.monotonic() - self._ws_account_time) * 1000)
            # account_all updates can contain positions without collateral. In
            # that case collateral is still sourced from REST and its older
            # timestamp must control the combined snapshot's freshness label.
            stream_has_collateral = streamed_account.get("collateral") not in (None, "")
            cached_updated_at_ms = int((cached or {}).get("updated_at_ms", 0) or 0)
            return {
                "account": self._clone(account),
                "source": ("LIGHTER_ACCOUNT_STREAM" if stream_has_collateral
                           else "LIGHTER_ACCOUNT_STREAM+REST_CACHE"),
                "updated_at_ms": (stream_updated_at_ms if stream_has_collateral
                                   else cached_updated_at_ms),
                "positions_updated_ms": stream_updated_at_ms,
                "collateral_updated_ms": (stream_updated_at_ms if stream_has_collateral
                                           else cached_updated_at_ms),
            }
        if cached_account is None:
            return None
        return {
            "account": cached_account,
            "source": "LIGHTER_ACCOUNT_CACHE",
            "updated_at_ms": int(cached.get("updated_at_ms", 0) or 0),
            "positions_updated_ms": int(cached.get("updated_at_ms", 0) or 0),
            "collateral_updated_ms": int(cached.get("updated_at_ms", 0) or 0),
        }

    def market_detail_snapshot(self, market_id: int) -> Optional[Dict[str, Any]]:
        """Return cached market metadata without waiting on Lighter REST."""
        cached = self._cache.get(f"market-detail:{market_id}")
        value = cached.get("value") if cached else None
        return self._clone(value) if isinstance(value, dict) else None

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

    async def _account_snapshot(self, *, fresh: bool = False) -> Optional[Dict[str, Any]]:
        creds = self.get_credentials() or {}
        address = creds.get("l1_address")
        if not address:
            return None

        async def load() -> Optional[Dict[str, Any]]:
            payload = await self.request("/api/v1/account", {"by": "l1_address", "value": address})
            accounts = payload.get("accounts") or []
            return accounts[0] if accounts else None

        return await load() if fresh else await self._cached(f"account:{address}", 3.0, load)

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
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10, connect=4))
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

    async def positions(self, *, fresh: bool = False) -> List[Dict[str, Any]]:
        """Return the configured account's open positions without exposing credentials."""
        streamed = None if fresh else self._stream_positions()
        if streamed is not None:
            return streamed
        creds = self.get_credentials() or {}
        address = creds.get("l1_address")
        if not address:
            return []
        account = await self._account_snapshot(fresh=fresh)
        return list((account or {}).get("positions") or [])

    async def create_market_order(
        self, market_id: int, base_amount: float, reference_price: float,
        is_ask: bool, *, reduce_only: bool = False, max_slippage: float = 0.006,
        client_order_index: Optional[int] = None,
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
        quantized_size = int((Decimal(str(base_amount)) * (10 ** size_decimals)).to_integral_value(rounding=ROUND_DOWN))
        if quantized_size <= 0 or quantized_size < int(minimum * (10 ** size_decimals)):
            raise ValueError(f"Lighter market {market_id} order is below its minimum size")
        protected_price = reference_price * (1 - max_slippage if is_ask else 1 + max_slippage)
        price_int = int(round(protected_price * (10 ** price_decimals)))
        client_order_index = client_order_index or int(time.time_ns() % self.MAX_CLIENT_ORDER_INDEX) or 1
        try:
            _, response, error = await signer.create_market_order(
                market_id, client_order_index, quantized_size, price_int, is_ask,
                reduce_only=reduce_only,
            )
        finally:
            # A fill can precede the account stream update. The next capacity
            # check must fetch the new account rather than an old snapshot.
            self._ws_account = None
            for key in list(self._cache):
                if key.startswith("account:"):
                    self._cache.pop(key, None)
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

    async def create_protection_orders(self, market_id, quantity, side, children):
        """Submit persisted, reduce-only TP/SL children as native OCO (or one leg)."""
        from lighter.signer_client import CreateOrderTxReq
        signer = self.get_signer()
        if signer is None or not hasattr(signer, "create_grouped_orders"):
            raise ValueError("Installed Lighter SDK does not support native OCO")
        error = signer.check_client()
        if error:
            raise ValueError(f"Lighter signer validation failed: {error}")
        detail = await self.market_detail(market_id, fresh=True)
        scale = 10 ** int(detail["supported_size_decimals"])
        price_scale = 10 ** int(detail["supported_price_decimals"])
        size = int(Decimal(str(quantity)) * scale)
        if size <= 0 or size / scale < float(detail.get("min_base_amount") or 0):
            raise ValueError("Native protection quantity is below minimum size")
        orders = []
        for child in children:
            trigger = int(child["trigger_ticks"])
            # Same bounded IOC tolerance as ordinary bot reductions. This is
            # a trigger, not a guaranteed fill price or maximum realized loss.
            limit = int(trigger * (0.994 if side > 0 else 1.006))
            if not 0 < min(trigger, limit) <= max(trigger, limit) < 2 ** 32:
                raise ValueError("Native protection price is out of exchange range")
            if size / scale * trigger / price_scale < float(detail.get("min_quote_amount") or 0):
                raise ValueError("Native protection is below minimum order notional")
            orders.append(CreateOrderTxReq(
                MarketIndex=market_id, ClientOrderIndex=child["client_order_index"],
                BaseAmount=size, Price=limit, IsAsk=int(side > 0),
                Type=signer.ORDER_TYPE_TAKE_PROFIT if child["kind"] == "take_profit" else signer.ORDER_TYPE_STOP_LOSS,
                TimeInForce=signer.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
                ReduceOnly=1, TriggerPrice=trigger,
                OrderExpiry=signer.DEFAULT_28_DAY_ORDER_EXPIRY))
        if len(orders) == 2:
            _, response, error = await signer.create_grouped_orders(
                signer.GROUPING_TYPE_ONE_CANCELS_THE_OTHER, orders)
        elif len(orders) == 1:
            o = orders[0]
            _, response, error = await signer.create_order(
                o.MarketIndex, o.ClientOrderIndex, o.BaseAmount, o.Price, o.IsAsk,
                o.Type, o.TimeInForce, o.ReduceOnly, o.TriggerPrice, o.OrderExpiry)
        else:
            raise ValueError("Native protection requires one or two enabled exits")
        if error or getattr(response, "code", 200) != 200:
            raise RuntimeError(f"Native protection submission failed: {error or response.code}")
        return {"tx_hash": getattr(response, "tx_hash", None)}

    async def cancel_protection_order(self, market_id, order_index):
        signer = self.get_signer()
        if signer is None:
            raise RuntimeError("Lighter signer is unavailable")
        _, response, error = await signer.cancel_order(market_id, int(order_index))
        if error or getattr(response, "code", 200) != 200:
            raise RuntimeError(f"Native protection cancellation failed: {error or response.code}")

    async def account_order(self, client_order_index: int) -> Optional[Dict[str, Any]]:
        """Read one submitted order by its persisted client index for recovery."""
        orders = await self.account_orders([client_order_index])
        return orders[0] if orders else None

    async def account_orders(self, client_order_indexes):
        """Batch read persisted IDs, including inactive conditional orders."""
        creds = self.get_credentials() or {}
        signer = self.get_signer()
        if creds.get("account_index") is None or signer is None:
            raise RuntimeError("Lighter account authentication is unavailable")
        auth, error = signer.create_auth_token_with_expiry(
            api_key_index=int(creds.get("api_key_index", 0))
        )
        if error:
            raise RuntimeError(f"Lighter order lookup authentication failed: {error}")
        payload = await self.request(
            "/api/v1/accountOrders",
            {"client_order_indexes": ",".join(str(i) for i in client_order_indexes),
             "account_index": int(creds["account_index"])},
            headers={"authorization": auth},
        )
        return payload.get("orders") or []

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
        try:
            detail = await self.market_detail(market_id)
            size_step = 10 ** -int(detail["supported_size_decimals"])
            fill_tolerance = max(size_step / 2, expected_size * 0.00001)
        except Exception:
            # Preserve existing pair-market recovery when metadata is briefly
            # unavailable. New crypto markets must have precision metadata.
            if int(market_id) not in {self.ADR_MARKET_ID, self.DOMESTIC_MARKET_ID}:
                return {"fill_confirmed": False}
            fill_tolerance = max(0.0002 if int(market_id) == self.ADR_MARKET_ID else 0.0011,
                                 expected_size * 0.005)
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

    async def account_trades(
        self, market_id: int, limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Return authoritative trades from Lighter exchange for an account."""
        creds = self.get_credentials() or {}
        account_index = creds.get("account_index")
        signer = self.get_signer()
        if account_index is None or signer is None:
            return []
        auth, error = signer.create_auth_token_with_expiry(
            api_key_index=int(creds.get("api_key_index", 0))
        )
        if error:
            logger.warning("Could not authenticate Lighter trade history: %s", error)
            return []
        try:
            payload = await self.request(
                "/api/v1/trades",
                {
                    "account_index": int(account_index),
                    "market_id": int(market_id),
                    "sort_by": "timestamp",
                    "sort_dir": "desc",
                    "limit": min(100, max(1, limit)),
                },
                headers={"authorization": auth},
            )
            return payload.get("trades") or []
        except Exception as exc:
            logger.warning("Failed to fetch Lighter trades for market %s: %s", market_id, exc)
            return []

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
                    if response.status == 200:
                        try:
                            payload = await response.json(content_type=None)
                        except Exception as json_err:
                            raise RuntimeError(f"Lighter API returned invalid JSON: {json_err}")
                        if isinstance(payload, dict) and payload.get("code") == 200:
                            return payload
                        code = payload.get("code") if isinstance(payload, dict) else None
                        raise RuntimeError(f"Lighter API error: code={code}")
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

    async def market_detail(self, market_id: int, *, fresh: bool = False) -> Dict[str, Any]:
        async def load() -> Dict[str, Any]:
            payload = await self.request("/api/v1/orderBookDetails", {"market_id": market_id})
            details = payload.get("order_book_details") or []
            if not details:
                raise RuntimeError(f"Lighter market {market_id} is unavailable")
            return details[0]

        return await load() if fresh else await self._cached(f"market-detail:{market_id}", 3600.0, load)

    async def order_book(self, market_id: int, limit: int = 20, *, fresh: bool = False) -> Dict[str, Any]:
        bounded_limit = min(100, max(1, limit))
        updated = self._ws_book_times.get(market_id, 0.0)
        if time.monotonic() - updated <= (2.0 if fresh else 15.0) and market_id in self._ws_books:
            book = self._clone(self._ws_books[market_id])
            book["asks"] = sorted(book.get("asks") or [], key=lambda row: float(row["price"]))[:bounded_limit]
            book["bids"] = sorted(book.get("bids") or [], key=lambda row: float(row["price"]), reverse=True)[:bounded_limit]
            return book

        async def load() -> Dict[str, Any]:
            return await self.request(
                "/api/v1/orderBookOrders", {"market_id": market_id, "limit": bounded_limit}
            )

        if fresh:
            # Entries must never use the normal two-second REST cache or its
            # stale-on-error fallback when validating executable prices.
            return await load()
        return await self._cached(f"order-book:{market_id}:{bounded_limit}", 2.0, load)

    async def candles(
        self, market_id: int, resolution: str, count: int, end_timestamp: Optional[int] = None,
        *, fresh: bool = False, allow_stale: bool = True,
    ) -> List[Dict[str, Any]]:
        interval_ms = {
            "1m": 60_000, "5m": 300_000, "15m": 900_000,
            "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
        }[resolution]
        end_ms = end_timestamp or int(time.time() * 1000)
        bounded_count = min(500, max(20, count))
        fetch_count = 500 if end_timestamp is None and not fresh else bounded_count
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

        # Live candles can be revised shortly after closing. Keep the latest
        # response short-lived so a post-close bot evaluation refetches it.
        if end_timestamp is not None:
            ttl = 3600.0
            cache_suffix = str(end_timestamp)
        else:
            ttl = min(15.0, max(5.0, ((end_ms // interval_ms + 1) * interval_ms - end_ms) / 1000.0 + 1.0))
            cache_suffix = "latest"
        rows = await load() if fresh else await self._cached(
            f"candles:{market_id}:{resolution}:{fetch_count}:{cache_suffix}", ttl, load, allow_stale=allow_stale
        )
        return rows[-bounded_count:]
