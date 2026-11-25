import asyncio
from bisect import bisect_left, insort
import copy
import json
import logging
import math
from pathlib import Path
import time
from collections import deque
from decimal import Decimal, ROUND_DOWN
from typing import Any, Deque, Dict, Iterable, List, Optional

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
    MICRO_BOOK_MAX_AGE_MS = 500
    MICRO_SUBSCRIPTION_TIMEOUT_SECONDS = 5.0
    MICRO_STREAM_FAIRNESS_MESSAGES = 32
    MICRO_STREAM_FAIRNESS_SECONDS = 0.005
    MICRO_TRADE_BUFFER_LIMIT = 5_000
    MICRO_TRADE_ID_LIMIT = 20_000
    MICRO_DEFAULT_TRADE_LOOKBACK_MS = 1_000

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
        # Seconds-level strategies use a dedicated read-only socket.  Keeping
        # this separate prevents recorder/feature work from delaying account
        # updates or the existing pair engine's two order books.
        self._micro_ws_task: Optional[asyncio.Task] = None
        self._micro_market_ids: set[int] = set()
        # Validated full-depth books are kept as price-keyed maps with a
        # separate ascending price index.  Lighter sends small deltas against a
        # potentially very deep book; reparsing and deep-copying the whole book
        # for every delta can monopolize the asyncio event loop for hundreds of
        # milliseconds.  The indexed representation makes an existing-level
        # update O(1), an insert/delete O(n) in C, and a top-N read O(depth).
        self._micro_books: Dict[int, Dict[str, Any]] = {}
        self._micro_book_prices: Dict[int, Dict[str, List[Decimal]]] = {}
        self._micro_book_times: Dict[int, float] = {}
        self._micro_book_received_ms: Dict[int, int] = {}
        self._micro_book_exchange_ms: Dict[int, int] = {}
        self._micro_book_nonces: Dict[int, int] = {}
        self._micro_book_valid: Dict[int, bool] = {}
        self._micro_book_acknowledged: Dict[int, bool] = {}
        self._micro_book_connection_ids: Dict[int, int] = {}
        self._micro_trades: Dict[int, Deque[Dict[str, Any]]] = {}
        self._micro_trade_ids: Dict[int, set[str]] = {}
        self._micro_trade_id_order: Dict[int, Deque[str]] = {}
        self._micro_trade_nonces: Dict[int, int] = {}
        self._micro_tape_acknowledged: Dict[int, bool] = {}
        self._micro_tape_valid: Dict[int, bool] = {}
        self._micro_tape_connection_ids: Dict[int, int] = {}
        self._micro_tape_times: Dict[int, float] = {}
        self._micro_last_trade_times: Dict[int, float] = {}
        self._micro_warmup_started: Dict[int, float] = {}
        self._micro_trade_lookback_ms: Dict[int, int] = {}
        self._micro_duplicate_counts: Dict[int, int] = {}
        self._micro_malformed_counts: Dict[int, int] = {}
        self._micro_overflow_counts: Dict[int, int] = {}
        self._micro_last_overflow_ms: Dict[int, int] = {}
        self._micro_liquidation_counts: Dict[int, int] = {}
        self._micro_pre_ack_trade_counts: Dict[int, int] = {}
        self._micro_connected = False
        self._micro_connection_id = 0
        self._micro_connection_started_ms: Optional[int] = None
        self._micro_connection_started_monotonic: Optional[float] = None
        self._micro_gap_count = 0
        self._micro_malformed_count = 0
        self._micro_last_error: Optional[str] = None
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

    async def start_micro_streams(self, market_ids: Iterable[int]) -> None:
        """Start a dedicated public L2/trade stream for microstructure research.

        Calling again with a new market set reconnects so every requested
        subscription receives an authoritative full-book snapshot first.
        """
        requested = {int(market_id) for market_id in market_ids}
        if not requested:
            raise ValueError("At least one Lighter microstructure market is required")
        changed = not requested.issubset(self._micro_market_ids)
        self._micro_market_ids.update(requested)
        if changed and self._micro_ws_task is not None and not self._micro_ws_task.done():
            self._micro_ws_task.cancel()
            await asyncio.gather(self._micro_ws_task, return_exceptions=True)
            self._micro_ws_task = None
        if self._micro_ws_task is None or self._micro_ws_task.done():
            self._micro_ws_task = asyncio.create_task(
                self._micro_stream_loop(), name="lighter-microstructure-stream"
            )

    @staticmethod
    def _message_int(payload: Dict[str, Any], nested: Dict[str, Any], key: str) -> Optional[int]:
        value = nested.get(key, payload.get(key))
        return value if type(value) is int else None

    @staticmethod
    def _epoch_ms(value: Optional[int]) -> Optional[int]:
        if value is None or value <= 0:
            return None
        # Lighter payloads have historically mixed seconds, milliseconds and
        # microseconds across channels.  Normalize without presenting a local
        # receipt timestamp as an exchange timestamp.
        if value < 100_000_000_000:
            return value * 1000
        if value > 10_000_000_000_000:
            return value // 1000
        return value

    def _reset_micro_market_epoch(self, market_id: int) -> None:
        """Discard every datum that could have come from an older socket."""
        for mapping in (
            self._micro_books,
            self._micro_book_prices,
            self._micro_book_times,
            self._micro_book_received_ms,
            self._micro_book_exchange_ms,
            self._micro_book_nonces,
            self._micro_book_connection_ids,
            self._micro_trade_nonces,
            self._micro_tape_connection_ids,
            self._micro_tape_times,
            self._micro_last_trade_times,
            self._micro_warmup_started,
            self._micro_last_overflow_ms,
        ):
            mapping.pop(market_id, None)
        self._micro_book_valid[market_id] = False
        self._micro_book_acknowledged[market_id] = False
        self._micro_tape_acknowledged[market_id] = False
        self._micro_tape_valid[market_id] = False
        self._micro_trades[market_id] = deque(maxlen=self.MICRO_TRADE_BUFFER_LIMIT)
        self._micro_trade_ids[market_id] = set()
        self._micro_trade_id_order[market_id] = deque()
        self._micro_trade_lookback_ms.setdefault(
            market_id, self.MICRO_DEFAULT_TRADE_LOOKBACK_MS
        )

    def _begin_micro_connection(self) -> int:
        self._micro_connection_id += 1
        self._micro_connected = True
        self._micro_connection_started_ms = int(time.time() * 1000)
        self._micro_connection_started_monotonic = time.monotonic()
        for market_id in self._micro_market_ids:
            self._reset_micro_market_epoch(market_id)
        return self._micro_connection_id

    def _end_micro_connection(self) -> None:
        self._micro_connected = False
        for market_id in self._micro_market_ids:
            self._micro_book_valid[market_id] = False
            self._micro_book_acknowledged[market_id] = False
            self._micro_tape_valid[market_id] = False
            self._micro_tape_acknowledged[market_id] = False
            self._micro_warmup_started.pop(market_id, None)

    def _micro_payload_failure(
        self,
        market_id: Optional[int],
        message: str,
        *,
        book: bool = False,
        tape: bool = False,
        gap: bool = False,
    ) -> None:
        self._micro_malformed_count += 1
        if market_id is not None:
            self._micro_malformed_counts[market_id] = (
                self._micro_malformed_counts.get(market_id, 0) + 1
            )
            if book:
                self._micro_book_valid[market_id] = False
            if tape:
                self._micro_tape_valid[market_id] = False
            self._micro_warmup_started.pop(market_id, None)
        else:
            for item in self._micro_market_ids:
                self._micro_book_valid[item] = False
                self._micro_tape_valid[item] = False
                self._micro_warmup_started.pop(item, None)
        if gap:
            self._micro_gap_count += 1
        self._micro_last_error = message[:300]
        raise RuntimeError(message)

    @staticmethod
    def _micro_error_envelope(payload: Dict[str, Any]) -> Optional[str]:
        message_type = str(payload.get("type") or "").lower()
        error = payload.get("error")
        if "error" in payload and error is not None:
            return f"Lighter websocket error envelope: {error}"
        if message_type in {"error", "subscription_error", "subscribe/error"}:
            detail = payload.get("message") or payload.get("reason") or message_type
            return f"Lighter websocket error envelope: {detail}"
        if payload.get("success") is False:
            detail = payload.get("message") or payload.get("reason") or "success=false"
            return f"Lighter websocket rejected request: {detail}"
        return None

    @staticmethod
    def _micro_decimal(value: Any, label: str, *, allow_zero: bool) -> Decimal:
        try:
            parsed = Decimal(str(value))
        except Exception as error:
            raise ValueError(f"{label} is not numeric") from error
        try:
            float_value = float(parsed)
        except (OverflowError, ValueError) as error:
            raise ValueError(f"{label} is outside the supported numeric range") from error
        if (
            not parsed.is_finite()
            or not math.isfinite(float_value)
            or (parsed != 0 and float_value == 0)
            or parsed < 0
            or (not allow_zero and parsed == 0)
        ):
            qualifier = "non-negative" if allow_zero else "positive"
            raise ValueError(f"{label} must be finite and {qualifier}")
        return parsed

    @classmethod
    def _validated_micro_ladders(
        cls, update: Dict[str, Any], *, allow_zero_size: bool
    ) -> Dict[str, Dict[Decimal, Dict[str, Any]]]:
        result: Dict[str, Dict[Decimal, Dict[str, Any]]] = {}
        for side in ("bids", "asks"):
            raw = update.get(side)
            if not isinstance(raw, list):
                raise ValueError(f"order book {side} must be a list")
            levels: Dict[Decimal, Dict[str, Any]] = {}
            for index, row in enumerate(raw):
                if not isinstance(row, dict):
                    raise ValueError(f"order book {side}[{index}] must be an object")
                price = cls._micro_decimal(
                    row.get("price"), f"order book {side}[{index}].price", allow_zero=False
                )
                cls._micro_decimal(
                    row.get("size"),
                    f"order book {side}[{index}].size",
                    allow_zero=allow_zero_size,
                )
                if price in levels:
                    raise ValueError(f"order book {side} contains duplicate price {price}")
                levels[price] = dict(row)
            result[side] = levels
        return result

    @staticmethod
    def _validate_micro_book_shape(
        levels: Dict[str, Dict[Decimal, Dict[str, Any]]]
    ) -> None:
        if not levels["bids"] or not levels["asks"]:
            raise ValueError("full order book must contain at least one bid and ask")
        best_bid = max(levels["bids"])
        best_ask = min(levels["asks"])
        if best_bid >= best_ask:
            raise ValueError(
                f"order book is crossed or locked: best_bid={best_bid}, best_ask={best_ask}"
            )

    @staticmethod
    def _micro_price_index(
        levels: Dict[str, Dict[Decimal, Dict[str, Any]]]
    ) -> Dict[str, List[Decimal]]:
        """Build the canonical ascending price index for a full snapshot."""

        return {
            "bids": sorted(levels["bids"]),
            "asks": sorted(levels["asks"]),
        }

    @staticmethod
    def _validate_indexed_micro_book_shape(
        levels: Dict[str, Dict[Decimal, Dict[str, Any]]],
        prices: Dict[str, List[Decimal]],
    ) -> None:
        """Validate the merged book using the maintained O(1) best prices."""

        if not prices["bids"] or not prices["asks"]:
            raise ValueError("full order book must contain at least one bid and ask")
        if (
            len(prices["bids"]) != len(levels["bids"])
            or len(prices["asks"]) != len(levels["asks"])
        ):
            raise ValueError("order book price index is inconsistent")
        best_bid = prices["bids"][-1]
        best_ask = prices["asks"][0]
        if best_bid >= best_ask:
            raise ValueError(
                f"order book is crossed or locked: best_bid={best_bid}, best_ask={best_ask}"
            )

    def _apply_micro_book_delta(
        self,
        levels: Dict[str, Dict[Decimal, Dict[str, Any]]],
        prices: Dict[str, List[Decimal]],
        incoming: Dict[str, Dict[Decimal, Dict[str, Any]]],
    ) -> None:
        """Apply one validated delta and roll it back if shape checks fail.

        No awaits occur while a websocket message is handled, so this in-place
        update remains atomic to other asyncio tasks.  The undo log preserves
        the last valid book for direct callers/tests as well as the normal
        reconnect path after a malformed or crossed delta.
        """

        undo: list[tuple[str, Decimal, bool, Optional[Dict[str, Any]]]] = []
        try:
            for side in ("asks", "bids"):
                side_levels = levels[side]
                side_prices = prices[side]
                for price, row in incoming[side].items():
                    existed = price in side_levels
                    previous = side_levels.get(price)
                    undo.append((side, price, existed, previous))
                    size = self._micro_decimal(
                        row.get("size"), "order book delta size", allow_zero=True
                    )
                    if size == 0:
                        if not existed:
                            continue
                        side_levels.pop(price)
                        index = bisect_left(side_prices, price)
                        if index >= len(side_prices) or side_prices[index] != price:
                            raise ValueError("order book price index is inconsistent")
                        side_prices.pop(index)
                    else:
                        side_levels[price] = dict(row)
                        if not existed:
                            insort(side_prices, price)
            self._validate_indexed_micro_book_shape(levels, prices)
        except Exception:
            for side, price, existed, previous in reversed(undo):
                side_levels = levels[side]
                side_prices = prices[side]
                index = bisect_left(side_prices, price)
                indexed = index < len(side_prices) and side_prices[index] == price
                if existed:
                    assert previous is not None
                    side_levels[price] = previous
                    if not indexed:
                        side_prices.insert(index, price)
                else:
                    side_levels.pop(price, None)
                    if indexed:
                        side_prices.pop(index)
            raise

    def _refresh_micro_warmup(self, market_id: int) -> None:
        current = self._micro_connection_id
        ready = (
            self._micro_connected
            and self._micro_book_acknowledged.get(market_id, False)
            and self._micro_tape_acknowledged.get(market_id, False)
            and self._micro_book_valid.get(market_id, False)
            and self._micro_tape_valid.get(market_id, False)
            and self._micro_book_connection_ids.get(market_id) == current
            and self._micro_tape_connection_ids.get(market_id) == current
        )
        if ready:
            self._micro_warmup_started.setdefault(market_id, time.monotonic())
        else:
            self._micro_warmup_started.pop(market_id, None)

    def _micro_warmup_remaining_ms(self, market_id: int, now: Optional[float] = None) -> int:
        configured = max(
            1,
            int(self._micro_trade_lookback_ms.get(
                market_id, self.MICRO_DEFAULT_TRADE_LOOKBACK_MS
            )),
        )
        started = self._micro_warmup_started.get(market_id)
        if started is None:
            return configured
        elapsed_ms = int(((now if now is not None else time.monotonic()) - started) * 1000)
        return max(0, configured - max(0, elapsed_ms))

    def _micro_subscriptions_ready(self) -> bool:
        current = self._micro_connection_id
        return self._micro_connected and bool(self._micro_market_ids) and all(
            self._micro_book_acknowledged.get(market_id, False)
            and self._micro_tape_acknowledged.get(market_id, False)
            and self._micro_book_connection_ids.get(market_id) == current
            and self._micro_tape_connection_ids.get(market_id) == current
            for market_id in self._micro_market_ids
        )

    def _micro_subscription_timeout_reason(
        self, subscribed: bool, deadline: float, *, now: Optional[float] = None
    ) -> Optional[str]:
        if (time.monotonic() if now is None else now) <= deadline:
            return None
        if not subscribed:
            return "Lighter websocket connected-envelope timeout"
        missing = []
        for market_id in sorted(self._micro_market_ids):
            if not self._micro_book_acknowledged.get(market_id, False):
                missing.append(f"order_book/{market_id}")
            if not self._micro_tape_acknowledged.get(market_id, False):
                missing.append(f"trade/{market_id}")
        if missing:
            return "Lighter subscription acknowledgement timeout: " + ", ".join(missing)
        return None

    def _micro_deadline_after_valid_message(
        self,
        payload: Dict[str, Any],
        deadline: float,
        *,
        acknowledged_before: bool,
        now: Optional[float] = None,
    ) -> float:
        """Renew once when a successfully handled channel becomes acknowledged."""

        if acknowledged_before or not self._micro_message_acknowledged(payload):
            return deadline
        return (time.monotonic() if now is None else now) + float(
            self.MICRO_SUBSCRIPTION_TIMEOUT_SECONDS
        )

    def _micro_message_acknowledged(self, payload: Dict[str, Any]) -> bool:
        market_id = self._channel_id(payload.get("channel"))
        if market_id not in self._micro_market_ids:
            return False
        if payload.get("type") == "subscribed/order_book":
            return bool(
                self._micro_book_acknowledged.get(market_id, False)
                and self._micro_book_connection_ids.get(market_id)
                == self._micro_connection_id
            )
        if payload.get("type") == "subscribed/trade":
            return bool(
                self._micro_tape_acknowledged.get(market_id, False)
                and self._micro_tape_connection_ids.get(market_id)
                == self._micro_connection_id
            )
        return False

    def _micro_stream_fairness_due(
        self, messages_since_yield: int, elapsed_seconds: float
    ) -> bool:
        return (
            messages_since_yield
            >= max(1, int(self.MICRO_STREAM_FAIRNESS_MESSAGES))
            or elapsed_seconds >= max(
                0.001, float(self.MICRO_STREAM_FAIRNESS_SECONDS)
            )
        )

    def _remember_micro_trade_id(self, market_id: int, trade_id: str) -> bool:
        known = self._micro_trade_ids.setdefault(market_id, set())
        if trade_id in known:
            return False
        order = self._micro_trade_id_order.setdefault(market_id, deque())
        if len(order) >= self.MICRO_TRADE_ID_LIMIT:
            known.discard(order.popleft())
        order.append(trade_id)
        known.add(trade_id)
        return True

    def _validate_micro_trade_identity(
        self, trade: Any, market_id: int
    ) -> tuple[Dict[str, Any], str]:
        if not isinstance(trade, dict):
            raise ValueError("trade row must be an object")
        row_market_id = self._message_int(trade, {}, "market_id")
        if row_market_id != market_id:
            raise ValueError(
                f"trade market_id must be {market_id}, received {trade.get('market_id')!r}"
            )
        trade_id = trade.get("trade_id_str")
        if not isinstance(trade_id, str) or not trade_id.strip():
            raise ValueError("trade_id_str is required")
        return trade, trade_id.strip()

    def _normalize_micro_trade(
        self, trade: Any, market_id: int, received_at_ms: int
    ) -> Dict[str, Any]:
        row, trade_id = self._validate_micro_trade_identity(trade, market_id)
        if row.get("type") != "trade":
            raise ValueError("ordinary trade row requires type='trade'")
        if type(row.get("is_maker_ask")) is not bool:
            raise ValueError("trade is_maker_ask must be a JSON boolean")
        timestamp = self._epoch_ms(self._message_int(row, {}, "timestamp"))
        if timestamp is None:
            raise ValueError("trade timestamp is required")
        price_decimal = self._micro_decimal(
            row.get("price"), "trade price", allow_zero=False
        )
        size_decimal = self._micro_decimal(
            row.get("size"), "trade size", allow_zero=False
        )
        price = float(price_decimal)
        size = float(size_decimal)
        if not math.isfinite(price) or not math.isfinite(size):
            raise ValueError("trade price and size must be finite floats")
        return {
            "timestamp_ms": received_at_ms,
            "received_at_ms": received_at_ms,
            "exchange_timestamp_ms": timestamp,
            "price": price,
            "size": size,
            "aggressor_side": "buy" if row["is_maker_ask"] else "sell",
            "trade_id": trade_id,
            "trade_id_str": trade_id,
            "connection_id": self._micro_connection_id,
        }

    async def _micro_stream_loop(self) -> None:
        delay = 1.0
        base = self.base_url.replace("https://", "wss://").replace("http://", "ws://").rstrip("/")
        ws_url = base + "/stream?readonly=true"
        while True:
            try:
                session = await self.get_session()
                async with session.ws_connect(ws_url, heartbeat=20, receive_timeout=None) as ws:
                    self._begin_micro_connection()
                    subscribed = False
                    messages_since_yield = 0
                    last_yield_at = time.monotonic()
                    deadline = time.monotonic() + self.MICRO_SUBSCRIPTION_TIMEOUT_SECONDS
                    while True:
                        try:
                            message = await asyncio.wait_for(ws.receive(), timeout=1.0)
                        except asyncio.TimeoutError:
                            reason = self._micro_subscription_timeout_reason(
                                subscribed, deadline
                            )
                            if reason:
                                raise TimeoutError(reason)
                            continue
                        if message.type == aiohttp.WSMsgType.TEXT:
                            try:
                                payload = json.loads(message.data)
                            except (TypeError, json.JSONDecodeError) as error:
                                self._micro_payload_failure(
                                    None, f"Lighter websocket sent invalid JSON: {error}"
                                )
                            if not isinstance(payload, dict):
                                self._micro_payload_failure(
                                    None, "Lighter websocket payload must be an object"
                                )
                            envelope_error = self._micro_error_envelope(payload)
                            if envelope_error:
                                self._micro_payload_failure(None, envelope_error)
                            if payload.get("type") == "connected" and not subscribed:
                                for market_id in sorted(self._micro_market_ids):
                                    await ws.send_json({
                                        "type": "subscribe",
                                        "channel": f"order_book/{market_id}",
                                    })
                                    await ws.send_json({
                                        "type": "subscribe",
                                        "channel": f"trade/{market_id}",
                                    })
                                subscribed = True
                                deadline = (
                                    time.monotonic()
                                    + self.MICRO_SUBSCRIPTION_TIMEOUT_SECONDS
                                )
                            elif payload.get("type") == "ping":
                                await ws.send_json({"type": "pong"})
                            else:
                                acknowledged_before = (
                                    self._micro_message_acknowledged(payload)
                                )
                                self._handle_micro_stream_message(payload)
                                deadline = self._micro_deadline_after_valid_message(
                                    payload,
                                    deadline,
                                    acknowledged_before=acknowledged_before,
                                )
                            if self._micro_subscriptions_ready():
                                self._micro_last_error = None
                                delay = 1.0
                            reason = self._micro_subscription_timeout_reason(
                                subscribed, deadline
                            )
                            if reason:
                                raise TimeoutError(reason)
                            # aiohttp may satisfy receive() immediately from its
                            # internal buffer during a burst.  Yield explicitly
                            # at a bounded cadence so account/API/runtime tasks
                            # cannot be starved by a continuously readable tape.
                            messages_since_yield += 1
                            fairness_now = time.monotonic()
                            if self._micro_stream_fairness_due(
                                messages_since_yield,
                                fairness_now - last_yield_at,
                            ):
                                messages_since_yield = 0
                                await asyncio.sleep(0)
                                last_yield_at = time.monotonic()
                        elif message.type in {
                            aiohttp.WSMsgType.CLOSE,
                            aiohttp.WSMsgType.CLOSED,
                            aiohttp.WSMsgType.CLOSING,
                            aiohttp.WSMsgType.ERROR,
                        }:
                            detail = ws.exception() if message.type == aiohttp.WSMsgType.ERROR else None
                            raise ConnectionError(
                                f"Lighter microstructure websocket closed{f': {detail}' if detail else ''}"
                            )
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self._micro_last_error = str(error)[:300]
                logger.warning("Lighter microstructure stream reconnecting after error: %s", error)
            finally:
                self._end_micro_connection()
            await asyncio.sleep(delay)
            delay = min(30.0, delay * 2.0)

    def _handle_micro_stream_message(self, payload: Dict[str, Any]) -> None:
        if not isinstance(payload, dict):
            self._micro_payload_failure(None, "Lighter websocket payload must be an object")
        envelope_error = self._micro_error_envelope(payload)
        if envelope_error:
            self._micro_payload_failure(None, envelope_error)
        message_type = str(payload.get("type") or "")
        market_id = self._channel_id(payload.get("channel"))
        if market_id not in self._micro_market_ids:
            return
        received_at_ms = int(time.time() * 1000)

        if message_type in {"subscribed/order_book", "update/order_book"}:
            update = payload.get("order_book") or {}
            if not isinstance(update, dict):
                self._micro_payload_failure(
                    market_id, "Lighter order_book payload must be an object", book=True
                )
            try:
                code = self._message_int(payload, update, "code")
                if code != 0:
                    raise ValueError(f"order book code must be 0, received {code!r}")
                nonce = self._message_int(payload, update, "nonce")
                if nonce is None or nonce < 0:
                    raise ValueError("order book nonce is required and non-negative")
                begin_nonce = self._message_int(payload, update, "begin_nonce")
                exchange_timestamp_ms = self._epoch_ms(
                    self._message_int(payload, update, "timestamp")
                    or self._message_int(payload, update, "last_updated_at")
                )
                incoming = self._validated_micro_ladders(
                    update, allow_zero_size=message_type == "update/order_book"
                )
            except ValueError as error:
                self._micro_payload_failure(
                    market_id, f"Lighter market {market_id} malformed order book: {error}",
                    book=True,
                )

            if message_type == "subscribed/order_book":
                if begin_nonce is not None and (begin_nonce < 0 or begin_nonce > nonce):
                    self._micro_payload_failure(
                        market_id,
                        f"Lighter market {market_id} invalid snapshot begin_nonce={begin_nonce}, nonce={nonce}",
                        book=True,
                    )
                try:
                    self._validate_micro_book_shape(incoming)
                except ValueError as error:
                    self._micro_payload_failure(
                        market_id, f"Lighter market {market_id} malformed snapshot: {error}",
                        book=True,
                    )
                self._micro_books[market_id] = incoming
                self._micro_book_prices[market_id] = self._micro_price_index(incoming)
                self._micro_book_acknowledged[market_id] = True
                self._micro_book_connection_ids[market_id] = self._micro_connection_id
            else:
                previous_nonce = self._micro_book_nonces.get(market_id)
                if (
                    not self._micro_book_acknowledged.get(market_id, False)
                    or self._micro_book_connection_ids.get(market_id)
                    != self._micro_connection_id
                    or previous_nonce is None
                    or begin_nonce is None
                    or begin_nonce != previous_nonce
                    or nonce < begin_nonce
                ):
                    self._micro_payload_failure(
                        market_id,
                        f"Lighter market {market_id} order-book nonce gap: "
                        f"expected begin_nonce {previous_nonce}, received "
                        f"begin_nonce={begin_nonce}, nonce={nonce}",
                        book=True,
                        gap=True,
                    )
                current = self._micro_books.get(market_id)
                prices = self._micro_book_prices.get(market_id)
                if current is None or prices is None:
                    self._micro_payload_failure(
                        market_id,
                        f"Lighter market {market_id} cached book is unavailable",
                        book=True,
                    )
                try:
                    self._apply_micro_book_delta(current, prices, incoming)
                except (KeyError, TypeError, ValueError) as error:
                    self._micro_payload_failure(
                        market_id, f"Lighter market {market_id} malformed merged book: {error}",
                        book=True,
                    )
            self._micro_book_nonces[market_id] = nonce
            self._micro_book_valid[market_id] = True
            self._micro_book_times[market_id] = time.monotonic()
            self._micro_book_received_ms[market_id] = received_at_ms
            if exchange_timestamp_ms is not None:
                self._micro_book_exchange_ms[market_id] = exchange_timestamp_ms
            self._refresh_micro_warmup(market_id)
            return

        if message_type in {"subscribed/trade", "update/trade"}:
            nonce = self._message_int(payload, {}, "nonce")
            raw = payload.get("trades")
            liquidations = payload.get("liquidation_trades", [])
            if nonce is None or nonce < 0:
                self._micro_payload_failure(
                    market_id, f"Lighter market {market_id} trade nonce is required",
                    tape=True,
                )
            if not isinstance(raw, list) or not isinstance(liquidations, list):
                self._micro_payload_failure(
                    market_id,
                    f"Lighter market {market_id} trades and liquidation_trades must be lists",
                    tape=True,
                )
            self._micro_liquidation_counts[market_id] = (
                self._micro_liquidation_counts.get(market_id, 0) + len(liquidations)
            )

            if message_type == "subscribed/trade":
                try:
                    identities = [
                        self._validate_micro_trade_identity(trade, market_id)[1]
                        for trade in raw
                    ]
                except ValueError as error:
                    self._micro_payload_failure(
                        market_id,
                        f"Lighter market {market_id} malformed trade bootstrap: {error}",
                        tape=True,
                    )
                for trade_id in identities:
                    if not self._remember_micro_trade_id(market_id, trade_id):
                        self._micro_duplicate_counts[market_id] = (
                            self._micro_duplicate_counts.get(market_id, 0) + 1
                        )
                self._micro_trade_nonces[market_id] = nonce
                self._micro_tape_acknowledged[market_id] = True
                self._micro_tape_valid[market_id] = True
                self._micro_tape_connection_ids[market_id] = self._micro_connection_id
                self._micro_tape_times[market_id] = time.monotonic()
                self._refresh_micro_warmup(market_id)
                return

            previous_nonce = self._micro_trade_nonces.get(market_id)
            if previous_nonce is not None and nonce < previous_nonce:
                self._micro_payload_failure(
                    market_id,
                    f"Lighter market {market_id} trade nonce moved backward: "
                    f"previous={previous_nonce}, received={nonce}",
                    tape=True,
                )
            try:
                normalized = [
                    self._normalize_micro_trade(trade, market_id, received_at_ms)
                    for trade in raw
                ]
            except ValueError as error:
                self._micro_payload_failure(
                    market_id, f"Lighter market {market_id} malformed live trade: {error}",
                    tape=True,
                )
            acknowledged = (
                self._micro_book_acknowledged.get(market_id, False)
                and self._micro_tape_acknowledged.get(market_id, False)
                and self._micro_book_connection_ids.get(market_id)
                == self._micro_connection_id
                and self._micro_tape_connection_ids.get(market_id)
                == self._micro_connection_id
            )
            if not acknowledged:
                self._micro_pre_ack_trade_counts[market_id] = (
                    self._micro_pre_ack_trade_counts.get(market_id, 0) + len(normalized)
                )
                return
            bucket = self._micro_trades.setdefault(
                market_id, deque(maxlen=self.MICRO_TRADE_BUFFER_LIMIT)
            )
            for row in normalized:
                trade_id = row["trade_id_str"]
                if not self._remember_micro_trade_id(market_id, trade_id):
                    self._micro_duplicate_counts[market_id] = (
                        self._micro_duplicate_counts.get(market_id, 0) + 1
                    )
                    continue
                if len(bucket) >= self.MICRO_TRADE_BUFFER_LIMIT:
                    bucket.popleft()
                    self._micro_overflow_counts[market_id] = (
                        self._micro_overflow_counts.get(market_id, 0) + 1
                    )
                    self._micro_last_overflow_ms[market_id] = received_at_ms
                bucket.append(row)
                self._micro_last_trade_times[market_id] = time.monotonic()
            self._micro_trade_nonces[market_id] = nonce
            self._micro_tape_times[market_id] = time.monotonic()
            self._refresh_micro_warmup(market_id)

    def micro_stream_status(self, market_id: Optional[int] = None) -> Dict[str, Any]:
        now = time.monotonic()
        market_ids = [int(market_id)] if market_id is not None else sorted(self._micro_market_ids)
        markets = {}
        for item in market_ids:
            updated = self._micro_book_times.get(item)
            tape_updated = self._micro_tape_times.get(item)
            last_trade = self._micro_last_trade_times.get(item)
            warmup_started = self._micro_warmup_started.get(item)
            warmup_remaining_ms = self._micro_warmup_remaining_ms(item, now)
            current_book = bool(
                self._micro_connected
                and self._micro_book_connection_ids.get(item) == self._micro_connection_id
            )
            current_tape = bool(
                self._micro_connected
                and self._micro_tape_connection_ids.get(item) == self._micro_connection_id
            )
            markets[str(item)] = {
                "book_valid": bool(
                    self._micro_connected
                    and current_book
                    and self._micro_book_valid.get(item, False)
                ),
                "book_acknowledged": bool(
                    self._micro_connected
                    and current_book
                    and self._micro_book_acknowledged.get(item, False)
                ),
                "tape_valid": bool(
                    self._micro_connected
                    and current_tape
                    and self._micro_tape_valid.get(item, False)
                ),
                "tape_acknowledged": bool(
                    self._micro_connected
                    and current_tape
                    and self._micro_tape_acknowledged.get(item, False)
                ),
                "tape_ready": bool(
                    current_book
                    and current_tape
                    and self._micro_book_valid.get(item, False)
                    and self._micro_tape_valid.get(item, False)
                    and self._micro_book_acknowledged.get(item, False)
                    and self._micro_tape_acknowledged.get(item, False)
                    and warmup_started is not None
                    and warmup_remaining_ms == 0
                ),
                "quote_age_ms": (max(0, int((now - updated) * 1000)) if updated else None),
                "tape_age_ms": (
                    max(0, int((now - tape_updated) * 1000)) if tape_updated else None
                ),
                "last_trade_age_ms": (
                    max(0, int((now - last_trade) * 1000)) if last_trade else None
                ),
                "warmup_lookback_ms": int(self._micro_trade_lookback_ms.get(
                    item, self.MICRO_DEFAULT_TRADE_LOOKBACK_MS
                )),
                "warmup_elapsed_ms": (
                    max(0, int((now - warmup_started) * 1000))
                    if warmup_started is not None else 0
                ),
                "warmup_remaining_ms": warmup_remaining_ms,
                "nonce": self._micro_book_nonces.get(item) if current_book else None,
                "trade_nonce": self._micro_trade_nonces.get(item) if current_tape else None,
                "trade_count_buffered": len(self._micro_trades.get(item, ())),
                "duplicate_trade_count": self._micro_duplicate_counts.get(item, 0),
                "malformed_message_count": self._micro_malformed_counts.get(item, 0),
                "trade_overflow_count": self._micro_overflow_counts.get(item, 0),
                "ignored_liquidation_count": self._micro_liquidation_counts.get(item, 0),
                "ignored_pre_ack_trade_count": self._micro_pre_ack_trade_counts.get(item, 0),
                "book_connection_id": (
                    self._micro_book_connection_ids.get(item) if current_book else None
                ),
                "tape_connection_id": (
                    self._micro_tape_connection_ids.get(item) if current_tape else None
                ),
            }
        return {
            "connected": self._micro_connected,
            "connection_id": self._micro_connection_id,
            "connection_started_at_ms": self._micro_connection_started_ms,
            "connection_age_ms": (
                max(0, int((now - self._micro_connection_started_monotonic) * 1000))
                if self._micro_connected and self._micro_connection_started_monotonic is not None
                else None
            ),
            "subscriptions_ready": self._micro_subscriptions_ready(),
            "subscription_timeout_seconds": self.MICRO_SUBSCRIPTION_TIMEOUT_SECONDS,
            "gap_count": self._micro_gap_count,
            "malformed_message_count": self._micro_malformed_count,
            "last_error": self._micro_last_error,
            "markets": markets,
        }

    async def micro_market_snapshot(
        self, market_id: int, depth: int = 20, trade_lookback_ms: int = 5_000,
    ) -> Dict[str, Any]:
        """Return one atomic, JSON-safe view of the validated live L2 and tape."""
        market_id = int(market_id)
        lookback_ms = max(1, int(trade_lookback_ms))
        self._micro_trade_lookback_ms[market_id] = lookback_ms
        if market_id not in self._micro_market_ids:
            await self.start_micro_streams([market_id])
        book = self._micro_books.get(market_id)
        prices = self._micro_book_prices.get(market_id)
        received_at_ms = self._micro_book_received_ms.get(market_id)
        updated = self._micro_book_times.get(market_id)
        current_connection = self._micro_connection_id
        current_book = self._micro_book_connection_ids.get(market_id) == current_connection
        current_tape = self._micro_tape_connection_ids.get(market_id) == current_connection
        self._refresh_micro_warmup(market_id)
        if (
            not self._micro_connected
            or not current_book
            or not current_tape
            or not self._micro_book_valid.get(market_id, False)
            or not self._micro_tape_valid.get(market_id, False)
            or not self._micro_book_acknowledged.get(market_id, False)
            or not self._micro_tape_acknowledged.get(market_id, False)
        ):
            raise RuntimeError(
                f"Lighter market {market_id} microstructure streams are disconnected, "
                "unacknowledged, invalid, or from an older connection"
            )
        if not book or not prices or received_at_ms is None or updated is None:
            raise RuntimeError(f"Lighter market {market_id} microstructure snapshot is not ready")
        quote_age_ms = max(0, int((time.monotonic() - updated) * 1000))
        if quote_age_ms > self.MICRO_BOOK_MAX_AGE_MS:
            raise RuntimeError(
                f"Lighter market {market_id} microstructure book is stale: "
                f"{quote_age_ms}ms > {self.MICRO_BOOK_MAX_AGE_MS}ms"
            )
        remaining_ms = self._micro_warmup_remaining_ms(market_id)
        if remaining_ms > 0:
            raise RuntimeError(
                f"Lighter market {market_id} tape is warming up for {remaining_ms}ms"
            )
        bounded_depth = min(100, max(1, int(depth)))
        bid_prices = reversed(prices["bids"][-bounded_depth:])
        ask_prices = prices["asks"][:bounded_depth]
        try:
            bids = [self._clone(book["bids"][price]) for price in bid_prices]
            asks = [self._clone(book["asks"][price]) for price in ask_prices]
        except (KeyError, TypeError) as error:
            self._micro_book_valid[market_id] = False
            raise RuntimeError(
                f"Lighter market {market_id} microstructure price index is invalid"
            ) from error
        cutoff = int(time.time() * 1000) - lookback_ms
        overflow_at_ms = self._micro_last_overflow_ms.get(market_id)
        if overflow_at_ms is not None and overflow_at_ms >= cutoff:
            raise RuntimeError(
                f"Lighter market {market_id} trade buffer overflowed inside the configured lookback"
            )
        trades_reversed = []
        for row in reversed(self._micro_trades.get(market_id, ())):
            if int(row.get("received_at_ms", 0)) < cutoff:
                break
            if row.get("connection_id") == current_connection:
                trades_reversed.append(dict(row))
        trades = list(reversed(trades_reversed))
        return {
            "market_id": market_id,
            "timestamp_ms": received_at_ms,
            "received_at_ms": received_at_ms,
            "exchange_timestamp_ms": self._micro_book_exchange_ms.get(market_id),
            "source": "LIGHTER_PUBLIC_WS_ORDER_BOOK_TRADE",
            "connection_id": current_connection,
            "connection_started_at_ms": self._micro_connection_started_ms,
            "book_connection_id": self._micro_book_connection_ids.get(market_id),
            "tape_connection_id": self._micro_tape_connection_ids.get(market_id),
            "sequence": self._micro_book_nonces.get(market_id),
            "trade_sequence": self._micro_trade_nonces.get(market_id),
            "book_valid": bool(self._micro_book_valid.get(market_id, False)),
            "nonce_contiguous": True,
            "quote_age_ms": quote_age_ms,
            "bids": bids,
            "asks": asks,
            "trades": trades,
            "stream": self.micro_stream_status(market_id),
        }

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
        if self._micro_ws_task is not None:
            self._micro_ws_task.cancel()
            await asyncio.gather(self._micro_ws_task, return_exceptions=True)
            self._micro_ws_task = None
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

    async def create_protection_orders(self, market_id, quantity, side, children, *, on_signed=None):
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
        # The Go signer expands -1 separately for each child. Crossing a
        # millisecond boundary then violates OCO's identical-expiry invariant.
        order_expiry = int(time.time() * 1000) + 28 * 24 * 60 * 60 * 1000
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
                OrderExpiry=order_expiry))
        if on_signed is not None:
            # Use the SDK's nonce lifecycle, but journal the signed deadline and
            # hash BEFORE send_tx. A lost HTTP response must remain recoverable.
            from lighter.signer_client import process_api_key_and_nonce

            @process_api_key_and_nonce
            async def submit(self, nonce=-1, api_key_index=255):
                if len(orders) == 2:
                    tx_type, tx_info, tx_hash, sign_error = self.sign_create_grouped_orders(
                        self.GROUPING_TYPE_ONE_CANCELS_THE_OTHER, orders,
                        nonce=nonce, api_key_index=api_key_index)
                elif len(orders) == 1:
                    o = orders[0]
                    tx_type, tx_info, tx_hash, sign_error = self.sign_create_order(
                        o.MarketIndex, o.ClientOrderIndex, o.BaseAmount, o.Price, o.IsAsk,
                        o.Type, o.TimeInForce, o.ReduceOnly, o.TriggerPrice, o.OrderExpiry,
                        nonce=nonce, api_key_index=api_key_index)
                else:
                    raise ValueError("Native protection requires one or two enabled exits")
                if sign_error:
                    return None, None, sign_error
                info = json.loads(tx_info)
                deadline = int(info["ExpiredAt"])
                if deadline <= int(time.time() * 1000) or not tx_hash:
                    raise ValueError("Native signed transaction has no valid deadline or hash")
                on_signed({"submission_tx_hash": tx_hash,
                           "submission_expires_at_ms": deadline,
                           "submission_nonce": nonce, "submission_api_key_index": api_key_index})
                response = await self.send_tx(tx_type=tx_type, tx_info=tx_info)
                return None, response, None

            _, response, error = await submit(signer)
        else:
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

    async def modify_protection_order(self, market_id, order_index, quantity, side,
                                      trigger_ticks, *, order_version=0):
        """Tighten an existing reduce-only conditional without replacing its OCO group."""
        signer = self.get_signer()
        if signer is None or not hasattr(signer, "modify_order"):
            raise RuntimeError("Installed Lighter SDK does not support conditional-order modification")
        error = signer.check_client()
        if error:
            raise ValueError(f"Lighter signer validation failed: {error}")
        detail = await self.market_detail(market_id, fresh=True)
        scale = 10 ** int(detail["supported_size_decimals"])
        size = int(Decimal(str(quantity)) * scale)
        trigger = int(trigger_ticks)
        limit = int(trigger * (0.994 if side > 0 else 1.006))
        if size <= 0 or not 0 < min(trigger, limit) <= max(trigger, limit) < 2 ** 32:
            raise ValueError("Modified native protection size or price is invalid")
        _, response, error = await signer.modify_order(
            int(market_id), int(order_index), size, limit, trigger,
            order_version=int(order_version or 0))
        if error or getattr(response, "code", 200) != 200:
            raise RuntimeError(f"Native protection modification failed: {error or response.code}")
        return {"tx_hash": getattr(response, "tx_hash", None)}

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
        orders = payload.get("orders")
        if not isinstance(orders, list):
            raise RuntimeError("Lighter order lookup returned no valid order list")
        return orders

    async def account_active_orders(self, market_id: int) -> List[Dict[str, Any]]:
        """Return authenticated active orders for one market.

        This is used as an execution safeguard before opening inventory that
        requires native TP/SL children.  It intentionally includes orders not
        created by this bot because the venue cap is account-wide.
        """
        creds = self.get_credentials() or {}
        signer = self.get_signer()
        if creds.get("account_index") is None or signer is None:
            raise RuntimeError("Lighter account authentication is unavailable")
        auth, error = signer.create_auth_token_with_expiry(
            api_key_index=int(creds.get("api_key_index", 0))
        )
        if error:
            raise RuntimeError(f"Lighter active-order authentication failed: {error}")
        payload = await self.request(
            "/api/v1/accountActiveOrders",
            {"account_index": int(creds["account_index"]), "market_id": int(market_id)},
            headers={"authorization": auth},
        )
        orders = payload.get("orders")
        if not isinstance(orders, list):
            raise RuntimeError("Lighter active-order lookup returned no valid order list")
        return orders

    async def account_limits(self) -> Dict[str, Any]:
        """Return the authenticated account tier used for venue order caps."""
        creds = self.get_credentials() or {}
        signer = self.get_signer()
        if creds.get("account_index") is None or signer is None:
            raise RuntimeError("Lighter account authentication is unavailable")
        auth, error = signer.create_auth_token_with_expiry(
            api_key_index=int(creds.get("api_key_index", 0))
        )
        if error:
            raise RuntimeError(f"Lighter account-limit authentication failed: {error}")
        payload = await self.request(
            "/api/v1/accountLimits",
            {"account_index": int(creds["account_index"])},
            headers={"authorization": auth},
        )
        if (not isinstance(payload, dict)
                or int(payload.get("code", 0) or 0) not in {0, 200}
                or not (payload.get("user_tier_name") or payload.get("user_tier"))):
            raise RuntimeError("Lighter account-limit lookup returned no valid limits")
        return payload

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
        self, market_id: int, limit: int = 100, *, strict: bool = False,
    ) -> List[Dict[str, Any]]:
        """Return authoritative trades from Lighter exchange for an account."""
        creds = self.get_credentials() or {}
        account_index = creds.get("account_index")
        signer = self.get_signer()
        if account_index is None or signer is None:
            if strict:
                raise RuntimeError("Authenticated Lighter trade history is unavailable")
            return []
        auth, error = signer.create_auth_token_with_expiry(
            api_key_index=int(creds.get("api_key_index", 0))
        )
        if error:
            if strict:
                raise RuntimeError("Lighter trade history authentication failed")
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
            if strict and not isinstance(payload.get("trades"), list):
                raise RuntimeError("Lighter trade history returned no valid trade list")
            return payload.get("trades") or []
        except Exception as exc:
            if strict:
                raise
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
