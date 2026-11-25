"""Persistent paper runtime for the causal Lighter microstructure strategy.

The runtime deliberately keeps alpha evaluation and execution state separate:
every accepted market snapshot is evaluated and every qualifying event is
retained in ``entry_signals`` even when a paper position already consumes all
capacity.  Paper fills, closed trades, and live-execution safeguards are
separate streams.

No exchange order method is called by this module.  ``arm_live`` and the live
intent returned by ``tick`` form a fail-closed hand-off contract for a future
authenticated executor; they are not an order submission implementation.
"""

from __future__ import annotations

import asyncio
import copy
import json
import math
import os
import time
from collections import deque
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, Mapping, Optional, Sequence, Tuple, Type, TypeVar

from .lighter_microstructure import (
    BookLevel,
    ExecutionSafeguardConfig,
    ExecutionSafeguardInputs,
    MicrostructureEntryConfig,
    MicrostructureExitConfig,
    OFF,
    OrderBookSnapshot,
    PositionState,
    TradePrint,
    UNAVAILABLE,
    evaluate_entry,
    evaluate_execution_safeguards,
    evaluate_exit,
)


STATE_VERSION = 1
LIVE_CONFIRMATION = "ENABLE LIGHTER MICRO LIVE"
SUPPORTED_MARKETS = {"BTC": 1}
ENTRY_SIGNAL_LIMIT = 1_000
PAPER_HISTORY_LIMIT = 1_000
PERSIST_INTERVAL_SECONDS = 5.0
MAX_REPLAY_LIMIT = 2_000
MAX_RAW_SNAPSHOT_HISTORY = 1_000
MAX_TRADE_PRINTS_PER_SNAPSHOT = 1_000


@dataclass(frozen=True)
class MicroRuntimeConfig:
    """Recorder and paper-execution settings, all exposed in public config."""

    symbol: str = "BTC"
    market_id: int = 1
    book_depth: int = 20
    paper_enabled: bool = True
    paper_order_notional_usd: float = 10.0
    paper_max_open_positions: int = 1
    paper_max_slippage_bps: float = 5.0
    paper_taker_fee_bps: float = 1.0
    paper_initial_equity_usd: float = 10_000.0
    max_quote_age_ms: int = 500
    # At 4 Hz this retains 2.5 minutes, enough for the 5-60 second strategy
    # without duplicating an unbounded public trade tape under a 400 MB daemon.
    raw_snapshot_history_limit: int = 600
    max_trade_prints_per_snapshot: int = 250
    live_min_recorded_snapshots: int = 1_000

    def __post_init__(self) -> None:
        symbol = str(self.symbol).upper()
        if symbol not in SUPPORTED_MARKETS:
            raise ValueError(f"unsupported symbol: {self.symbol}")
        if int(self.market_id) != SUPPORTED_MARKETS[symbol]:
            raise ValueError(f"{symbol} must use market {SUPPORTED_MARKETS[symbol]}")
        if int(self.book_depth) < 1 or int(self.book_depth) > 200:
            raise ValueError("book_depth must be between 1 and 200")
        if int(self.paper_max_open_positions) < 1:
            raise ValueError("paper_max_open_positions must be positive")
        if int(self.max_quote_age_ms) < 0:
            raise ValueError("max_quote_age_ms must be non-negative")
        if not 2 <= int(self.raw_snapshot_history_limit) <= MAX_RAW_SNAPSHOT_HISTORY:
            raise ValueError(
                "raw_snapshot_history_limit must be between 2 and "
                f"{MAX_RAW_SNAPSHOT_HISTORY}"
            )
        if not 1 <= int(self.max_trade_prints_per_snapshot) <= MAX_TRADE_PRINTS_PER_SNAPSHOT:
            raise ValueError(
                "max_trade_prints_per_snapshot must be between 1 and "
                f"{MAX_TRADE_PRINTS_PER_SNAPSHOT}"
            )
        if int(self.live_min_recorded_snapshots) < 1:
            raise ValueError("live_min_recorded_snapshots must be positive")
        for name in (
            "paper_order_notional_usd",
            "paper_initial_equity_usd",
        ):
            _positive(getattr(self, name), name)
        _nonnegative(self.paper_max_slippage_bps, "paper_max_slippage_bps")
        _nonnegative(self.paper_taker_fee_bps, "paper_taker_fee_bps")


T = TypeVar("T")


def _positive(value: Any, name: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"{name} must be a finite positive number")
    return number


def _nonnegative(value: Any, name: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError(f"{name} must be a finite non-negative number")
    return number


def _finite(value: Any, name: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def _strict_dataclass(
    cls: Type[T], values: Mapping[str, Any], *, base: Optional[T] = None
) -> T:
    allowed = {field.name for field in fields(cls)}
    unknown = set(values) - allowed
    if unknown:
        raise ValueError(f"unsupported {cls.__name__} fields: {sorted(unknown)}")
    template = asdict(base) if base is not None else asdict(cls())
    merged = dict(template)
    for name, value in values.items():
        expected = template[name]
        if isinstance(expected, bool):
            if not isinstance(value, bool):
                raise ValueError(f"{name} must be a boolean")
            merged[name] = value
        elif isinstance(expected, int) and not isinstance(expected, bool):
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not float(value).is_integer()
            ):
                raise ValueError(f"{name} must be an integer")
            merged[name] = int(value)
        elif isinstance(expected, float):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{name} must be a number")
            merged[name] = float(value)
        elif isinstance(expected, str):
            if not isinstance(value, str):
                raise ValueError(f"{name} must be a string")
            merged[name] = value
        else:
            merged[name] = value
    return cls(**merged)


def _timestamp_ms(value: Any) -> int:
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError("snapshot timestamp must be finite and non-negative")
    # Lighter payloads may encode Unix seconds with a fractional component.
    if number < 100_000_000_000:
        number *= 1_000
    return int(number)


def _first(mapping: Mapping[str, Any], names: Iterable[str]) -> Any:
    for name in names:
        value = mapping.get(name)
        if value is not None:
            return value
    return None


def _level(row: Any) -> BookLevel:
    if isinstance(row, Mapping):
        price = _first(row, ("price", "px"))
        size = _first(
            row,
            ("size", "quantity", "qty", "amount", "remaining_base_amount"),
        )
    elif isinstance(row, Sequence) and not isinstance(row, (str, bytes)) and len(row) >= 2:
        price, size = row[0], row[1]
    else:
        raise ValueError("book levels must be objects or [price, size] pairs")
    return BookLevel(float(price), float(size))


def _trade(row: Mapping[str, Any], fallback_timestamp_ms: int) -> TradePrint:
    raw_timestamp = _first(row, ("timestamp_ms", "timestamp", "time", "transaction_time"))
    timestamp_ms = (
        fallback_timestamp_ms if raw_timestamp is None else _timestamp_ms(raw_timestamp)
    )
    side = str(_first(row, ("aggressor_side", "side")) or "").lower()
    if side not in {"buy", "sell"} and "is_maker_ask" in row:
        # A resting ask is lifted by an aggressive buy.
        side = "buy" if bool(row["is_maker_ask"]) else "sell"
    size = _first(row, ("size", "quantity", "qty", "amount", "base_amount"))
    return TradePrint(
        timestamp_ms=timestamp_ms,
        price=float(_first(row, ("price", "px"))),
        size=float(size),
        aggressor_side=side,
    )


def _placeholder_condition(enabled: bool) -> Dict[str, Any]:
    return {
        "enabled": bool(enabled),
        "available": False,
        "pass": None,
        "status": UNAVAILABLE if enabled else OFF,
        "measured_value": None,
        "threshold": None,
        "operator": None,
        "unit": None,
        "source_timestamp_ms": None,
    }


class LighterMicroRuntime:
    """Causal recorder, paper IOC simulator, and fail-closed live hand-off."""

    def __init__(self, client: Any, state_path: Optional[Path] = None):
        self.client = client
        self.state_path = state_path or Path(__file__).with_name(
            "lighter_micro_runtime_state.json"
        )
        self.lock = asyncio.Lock()
        self.entry_config = MicrostructureEntryConfig()
        self.exit_config = MicrostructureExitConfig()
        self.runtime_config = MicroRuntimeConfig()
        self._snapshots: Deque[OrderBookSnapshot] = deque(
            maxlen=self.runtime_config.raw_snapshot_history_limit
        )
        self._snapshot_metadata: Deque[Dict[str, Any]] = deque(
            maxlen=self.runtime_config.raw_snapshot_history_limit
        )
        self._latest_snapshot_metadata: Dict[str, Any] = {}
        self._latest_entry_evaluation: Optional[Dict[str, Any]] = None
        self._latest_exit_evaluation: Optional[Dict[str, Any]] = None
        self._latest_safeguards: Dict[str, Any] = self._empty_safeguards()
        self._latest_live_gates: Dict[str, Any] = self._empty_live_gates()
        self._latest_live_intent: Optional[Dict[str, Any]] = None
        self._live_armed = False
        self._dirty = False
        self._last_persist_monotonic = time.monotonic()
        self._state = self._default_state()
        self._load()

    def _default_state(self) -> Dict[str, Any]:
        return {
            "entry_signals": [],
            "exit_signals": [],
            "paper_positions": [],
            "paper_fills": [],
            "paper_trades": [],
            "paper_realized_pnl_usd": 0.0,
            "paper_fees_paid_usd": 0.0,
            "paper_win_count": 0,
            "paper_loss_count": 0,
            "recorder_total_snapshots": 0,
            "recorder_dropped_snapshots": 0,
            "recorder_invalid_snapshots": 0,
            "recorder_total_trade_prints": 0,
            "recorder_truncated_trade_prints": 0,
            "recorder_first_timestamp_ms": None,
            "recorder_latest_timestamp_ms": None,
            "recorder_latest_rejection": None,
            "next_fill_id": 1,
            "state_recovery_error": None,
            "last_error": None,
            "last_error_timestamp_ms": None,
            "live_blocked_reason": "Live execution is not armed",
        }

    @property
    def config(self) -> Dict[str, Any]:
        """Return lossless JSON-safe serialization of every runtime setting."""

        return {
            "entry": asdict(self.entry_config),
            "exit": asdict(self.exit_config),
            "runtime": asdict(self.runtime_config),
        }

    def _persistent_document(self) -> Dict[str, Any]:
        # Raw snapshots, the latest ladder, and derived evaluations are
        # intentionally omitted.  They can be large and stale after restart.
        return {
            "version": STATE_VERSION,
            "config": self.config,
            "state": copy.deepcopy(self._state),
            "live_armed": False,
        }

    def _load(self) -> None:
        if not self.state_path.exists():
            return
        try:
            saved = json.loads(self.state_path.read_text(encoding="utf-8"))
            if not isinstance(saved, Mapping):
                raise ValueError("state file must contain an object")
            config = saved.get("config") or {}
            if not isinstance(config, Mapping):
                raise ValueError("saved config must be an object")
            self.entry_config = _strict_dataclass(
                MicrostructureEntryConfig, config.get("entry") or {}
            )
            self.exit_config = _strict_dataclass(
                MicrostructureExitConfig, config.get("exit") or {}
            )
            self.runtime_config = _strict_dataclass(
                MicroRuntimeConfig, config.get("runtime") or {}
            )
            self._snapshots = deque(
                maxlen=self.runtime_config.raw_snapshot_history_limit
            )
            self._snapshot_metadata = deque(
                maxlen=self.runtime_config.raw_snapshot_history_limit
            )
            loaded_state = saved.get("state") or {}
            if not isinstance(loaded_state, Mapping):
                raise ValueError("saved runtime state must be an object")
            self._state.update(copy.deepcopy(dict(loaded_state)))
            self._validate_loaded_state()
            for name in ("entry_signals", "exit_signals"):
                self._state[name] = self._state[name][-ENTRY_SIGNAL_LIMIT:]
            for name in ("paper_fills", "paper_trades"):
                self._state[name] = self._state[name][-PAPER_HISTORY_LIMIT:]
            if saved.get("live_armed"):
                self._state["live_blocked_reason"] = (
                    "Process restarted; live confirmation and gates are required again"
                )
        except Exception as exc:
            # Continue recording in paper mode, but retain an explicit recovery
            # fault and make live arming impossible until state is repaired.
            self.entry_config = MicrostructureEntryConfig()
            self.exit_config = MicrostructureExitConfig()
            self.runtime_config = MicroRuntimeConfig()
            self._snapshots = deque(
                maxlen=self.runtime_config.raw_snapshot_history_limit
            )
            self._snapshot_metadata = deque(
                maxlen=self.runtime_config.raw_snapshot_history_limit
            )
            self._state = self._default_state()
            self._state["state_recovery_error"] = f"Cannot load runtime state: {exc}"
            self._state["last_error"] = self._state["state_recovery_error"]
            self._state["live_blocked_reason"] = self._state["state_recovery_error"]

    def _validate_loaded_state(self) -> None:
        for name in (
            "entry_signals",
            "exit_signals",
            "paper_positions",
            "paper_fills",
            "paper_trades",
        ):
            if not isinstance(self._state.get(name), list):
                raise ValueError(f"{name} must be a list")
        for position in self._state["paper_positions"]:
            if int(position["side"]) not in {-1, 1}:
                raise ValueError("saved paper position has an invalid side")
            _positive(position["quantity"], "saved paper position quantity")
            _positive(position["entry_price"], "saved paper position entry price")
        _finite(
            self._state.get("paper_realized_pnl_usd", 0),
            "paper_realized_pnl_usd",
        )
        for name in (
            "paper_fees_paid_usd",
            "recorder_total_snapshots",
            "recorder_dropped_snapshots",
            "recorder_invalid_snapshots",
            "recorder_total_trade_prints",
            "recorder_truncated_trade_prints",
        ):
            _nonnegative(self._state.get(name, 0), name)

    def _save(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_name(f"{self.state_path.name}.tmp")
        with open(temporary, "w", encoding="utf-8") as stream:
            json.dump(
                self._persistent_document(),
                stream,
                indent=2,
                sort_keys=True,
                allow_nan=False,
            )
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(self.state_path)
        self._dirty = False
        self._last_persist_monotonic = time.monotonic()

    def _persist_if_due(self) -> None:
        """Batch high-frequency tick state writes to protect the event loop/disk."""

        self._dirty = True
        if time.monotonic() - self._last_persist_monotonic >= PERSIST_INTERVAL_SECONDS:
            self._save()

    def flush(self) -> None:
        """Persist pending batched state, intended for graceful shutdown."""

        if self._dirty:
            self._save()

    def update_config(self, updates: Mapping[str, Any]) -> Dict[str, Any]:
        """Validate and atomically persist a partial nested config update."""

        if not isinstance(updates, Mapping):
            raise ValueError("config update must be an object")
        unknown_sections = set(updates) - {"entry", "exit", "runtime"}
        if unknown_sections:
            raise ValueError(f"unsupported config sections: {sorted(unknown_sections)}")
        entry = self.entry_config
        exit_config = self.exit_config
        runtime = self.runtime_config
        if "entry" in updates:
            if not isinstance(updates["entry"], Mapping):
                raise ValueError("entry config must be an object")
            entry = _strict_dataclass(
                MicrostructureEntryConfig, updates["entry"], base=entry
            )
        if "exit" in updates:
            if not isinstance(updates["exit"], Mapping):
                raise ValueError("exit config must be an object")
            exit_config = _strict_dataclass(
                MicrostructureExitConfig, updates["exit"], base=exit_config
            )
        if "runtime" in updates:
            if not isinstance(updates["runtime"], Mapping):
                raise ValueError("runtime config must be an object")
            runtime = _strict_dataclass(
                MicroRuntimeConfig, updates["runtime"], base=runtime
            )

        old_snapshots = list(self._snapshots)
        old_metadata = list(self._snapshot_metadata)
        self.entry_config = entry
        self.exit_config = exit_config
        self.runtime_config = runtime
        self._snapshots = deque(
            old_snapshots[-runtime.raw_snapshot_history_limit :],
            maxlen=runtime.raw_snapshot_history_limit,
        )
        self._snapshot_metadata = deque(
            old_metadata[-runtime.raw_snapshot_history_limit :],
            maxlen=runtime.raw_snapshot_history_limit,
        )
        self._save()
        return self.public_state()

    def _parse_snapshot(self, payload: Mapping[str, Any]) -> Tuple[OrderBookSnapshot, Dict[str, Any]]:
        if not isinstance(payload, Mapping):
            raise ValueError("micro_market_snapshot must return an object")
        raw_timestamp = _first(
            payload,
            (
                "timestamp_ms",
                "book_timestamp_ms",
                "source_timestamp_ms",
                "timestamp",
            ),
        )
        if raw_timestamp is None:
            raise ValueError("micro snapshot requires a source timestamp")
        timestamp_ms = _timestamp_ms(raw_timestamp)
        bids = tuple(_level(row) for row in (payload.get("bids") or ()))
        asks = tuple(_level(row) for row in (payload.get("asks") or ()))
        raw_trades = [
            row
            for row in (payload.get("trades") or ())
            if isinstance(row, Mapping)
        ]
        retained_trade_rows = raw_trades[
            -int(self.runtime_config.max_trade_prints_per_snapshot) :
        ]
        trades = tuple(
            _trade(row, timestamp_ms)
            for row in retained_trade_rows
        )
        raw_sequence = _first(payload, ("sequence", "nonce"))
        snapshot = OrderBookSnapshot(
            timestamp_ms=timestamp_ms,
            bids=bids,
            asks=asks,
            trades=trades,
            source=str(payload.get("source") or "LIGHTER_MICRO_L2_TRADE"),
            instrument=str(payload.get("instrument") or self.runtime_config.symbol),
            sequence=int(raw_sequence) if raw_sequence is not None else None,
        )
        raw_received_at_ms = payload.get("received_at_ms")
        try:
            received_at_ms = (
                _timestamp_ms(raw_received_at_ms)
                if raw_received_at_ms is not None
                else None
            )
        except (TypeError, ValueError):
            received_at_ms = None
        metadata = {
            "market_id": payload.get("market_id"),
            # Do not coerce strings, integers, or missing values into truth.
            "book_valid": payload.get("book_valid"),
            "nonce_contiguous": payload.get("nonce_contiguous"),
            "received_at_ms": received_at_ms,
            "exchange_timestamp_ms": payload.get("exchange_timestamp_ms"),
            "quote_age_ms": payload.get("quote_age_ms"),
            "connection_id": payload.get("connection_id"),
            "sequence": raw_sequence,
            "stream": copy.deepcopy(payload.get("stream")),
            "trade_count": len(trades),
            "raw_trade_count": len(raw_trades),
            "trades_truncated": max(0, len(raw_trades) - len(trades)),
        }
        feed_ready, reasons = self._feed_integrity(snapshot, metadata)
        metadata["feed_ready"] = feed_ready
        metadata["feed_integrity_reasons"] = reasons
        return snapshot, metadata

    def _feed_integrity(
        self,
        snapshot: OrderBookSnapshot,
        metadata: Mapping[str, Any],
    ) -> Tuple[bool, list[str]]:
        """Verify that a book belongs to the connected, current stream epoch."""

        reasons = []
        if metadata.get("book_valid") is not True:
            reasons.append("payload.book_valid is not exactly true")
        if metadata.get("nonce_contiguous") is not True:
            reasons.append("payload nonce continuity is missing or invalid")
        if type(metadata.get("market_id")) is not int or int(
            metadata.get("market_id", -1)
        ) != int(self.runtime_config.market_id):
            reasons.append("payload market_id is missing or does not match")
        if type(metadata.get("connection_id")) is not int or int(
            metadata.get("connection_id", 0)
        ) <= 0:
            reasons.append("payload connection_id is missing or invalid")
        if type(metadata.get("sequence")) is not int or int(
            metadata.get("sequence", -1)
        ) < 0:
            reasons.append("payload sequence is missing or invalid")
        if metadata.get("received_at_ms") != snapshot.timestamp_ms:
            reasons.append("causal receipt timestamp is missing or inconsistent")
        quote_age = metadata.get("quote_age_ms")
        if (
            isinstance(quote_age, bool)
            or not isinstance(quote_age, (int, float))
            or not math.isfinite(float(quote_age))
            or float(quote_age) < 0
        ):
            reasons.append("payload quote_age_ms is missing or invalid")
        elif float(quote_age) > float(self.runtime_config.max_quote_age_ms):
            reasons.append("payload quote is stale")

        stream = metadata.get("stream")
        if not isinstance(stream, Mapping):
            reasons.append("stream readiness metadata is missing")
            return False, reasons
        if stream.get("connected") is not True:
            reasons.append("micro stream is not connected")
        if stream.get("subscriptions_ready") is not True:
            reasons.append("micro stream subscriptions are not ready")
        if "last_error" not in stream:
            reasons.append("micro stream error metadata is missing")
        elif stream.get("last_error") not in (None, ""):
            reasons.append("micro stream reports an error")
        gap_count = stream.get("gap_count")
        if type(gap_count) is not int or gap_count < 0:
            reasons.append("micro stream gap metadata is missing or invalid")
        if stream.get("connection_id") != metadata.get("connection_id"):
            reasons.append("snapshot does not belong to the current connection epoch")
        markets = stream.get("markets")
        market = (
            markets.get(str(self.runtime_config.market_id))
            if isinstance(markets, Mapping)
            else None
        )
        if not isinstance(market, Mapping):
            reasons.append("current market readiness metadata is missing")
            return False, reasons
        if market.get("book_valid") is not True:
            reasons.append("current stream market book is not valid")
        if market.get("book_acknowledged") is not True:
            reasons.append("current stream market book is not acknowledged")
        if market.get("tape_valid") is not True:
            reasons.append("current stream market tape is not valid")
        if market.get("tape_acknowledged") is not True:
            reasons.append("current stream market tape is not acknowledged")
        if market.get("tape_ready") is not True:
            reasons.append("current stream market tape warmup is incomplete")
        if market.get("book_connection_id") != metadata.get("connection_id"):
            reasons.append("book does not belong to the current connection epoch")
        if market.get("tape_connection_id") != metadata.get("connection_id"):
            reasons.append("tape does not belong to the current connection epoch")
        if market.get("nonce") != metadata.get("sequence"):
            reasons.append("snapshot sequence does not match current stream nonce")
        market_age = market.get("quote_age_ms")
        if (
            isinstance(market_age, bool)
            or not isinstance(market_age, (int, float))
            or not math.isfinite(float(market_age))
            or float(market_age) < 0
        ):
            reasons.append("current stream quote age is missing or invalid")
        elif float(market_age) > float(self.runtime_config.max_quote_age_ms):
            reasons.append("current stream quote is stale")
        buffered_trades = market.get("trade_count_buffered")
        if type(buffered_trades) is not int or buffered_trades < 0:
            reasons.append("current stream trade readiness is missing or invalid")
        return not reasons, reasons

    def _unavailable_entry_evaluation(
        self,
        snapshot: Optional[OrderBookSnapshot],
        reasons: Sequence[str],
    ) -> Dict[str, Any]:
        conditions, _ = self._condition_placeholders()
        reason = "; ".join(str(item) for item in reasons if item) or "feed unavailable"
        for detail in conditions.values():
            if detail["enabled"]:
                detail["unavailable_reason"] = reason
                detail["source_timestamp_ms"] = (
                    snapshot.timestamp_ms if snapshot is not None else None
                )
        source = {
            "name": snapshot.source if snapshot is not None else None,
            "instrument": (
                snapshot.instrument if snapshot is not None else self.runtime_config.symbol
            ),
            "timestamp_ms": snapshot.timestamp_ms if snapshot is not None else None,
            "sequence": snapshot.sequence if snapshot is not None else None,
        }
        return {
            "strategy": "lighter_microstructure",
            "entry_signal": False,
            "candidate_side": 0,
            "signal_price": None,
            "executable_entry_price": None,
            "condition_pass": {
                name: detail["pass"] for name, detail in conditions.items()
            },
            "conditions": conditions,
            "metrics": {},
            "source": source,
            "source_timestamp_ms": source["timestamp_ms"],
            "feed_ready": False,
            "unavailable_reason": reason,
        }

    def _reject_feed_snapshot(
        self,
        snapshot: Optional[OrderBookSnapshot],
        metadata: Mapping[str, Any],
        evaluated_at_ms: int,
        reasons: Sequence[str],
    ) -> None:
        reason = "; ".join(str(item) for item in reasons if item) or "feed unavailable"
        self._state["recorder_invalid_snapshots"] += 1
        self._state["recorder_latest_rejection"] = {
            "timestamp_ms": snapshot.timestamp_ms if snapshot is not None else None,
            "evaluated_at_ms": int(evaluated_at_ms),
            "reasons": list(reasons) if reasons else [reason],
            "connection_id": metadata.get("connection_id"),
            "sequence": snapshot.sequence if snapshot is not None else None,
        }
        self._latest_entry_evaluation = self._unavailable_entry_evaluation(
            snapshot, reasons or (reason,)
        )
        self._latest_exit_evaluation = None
        self._latest_live_intent = None
        if snapshot is None:
            self._latest_safeguards = self._empty_safeguards()
            self._latest_live_gates = self._empty_live_gates()
        else:
            capacity_ok = len(self._state["paper_positions"]) < int(
                self.runtime_config.paper_max_open_positions
            )
            self._latest_safeguards = evaluate_execution_safeguards(
                ExecutionSafeguardInputs(
                    evaluated_at_ms=int(evaluated_at_ms),
                    quote_timestamp_ms=snapshot.timestamp_ms,
                    book_valid=False,
                    exchange_order_valid=True,
                    reconciliation_clear=True,
                    account_capacity_ok=capacity_ok,
                    kill_switch_clear=True,
                ),
                ExecutionSafeguardConfig(
                    max_quote_age_ms=self.runtime_config.max_quote_age_ms
                ),
            )
            self._latest_live_gates = self._empty_live_gates()
            self._latest_live_gates["gates"]["book_valid"] = {
                "available": True,
                "pass": False,
                "status": "WAITING",
                "reason": reason,
            }
        self._state["last_error"] = f"Rejected micro snapshot: {reason}"
        self._state["last_error_timestamp_ms"] = int(evaluated_at_ms)
        self._persist_if_due()

    async def tick(
        self,
        *,
        evaluated_at_ms: Optional[int] = None,
        live_gates: Optional[Mapping[str, Optional[bool]]] = None,
    ) -> Dict[str, Any]:
        """Fetch, causally evaluate, paper-simulate, persist, and return state."""

        async with self.lock:
            snapshot: Optional[OrderBookSnapshot] = None
            metadata: Dict[str, Any] = {}
            try:
                payload = await self.client.micro_market_snapshot(
                    self.runtime_config.market_id,
                    self.runtime_config.book_depth,
                    max(
                        self.entry_config.trade_flow_lookback_ms,
                        self.entry_config.momentum_lookback_ms,
                    ),
                )
                now_ms = (
                    int(evaluated_at_ms)
                    if evaluated_at_ms is not None
                    else int(time.time() * 1_000)
                )
                try:
                    snapshot, metadata = self._parse_snapshot(payload)
                except Exception as exc:
                    self._reject_feed_snapshot(
                        None,
                        {},
                        now_ms,
                        (f"invalid snapshot payload: {exc}",),
                    )
                    return self.public_state()
                # Retain the actual causal decision clock so replay applies the
                # same quote-freshness verdict instead of assuming zero age.
                metadata["evaluated_at_ms"] = now_ms
                if metadata.get("feed_ready") is not True:
                    self._reject_feed_snapshot(
                        snapshot,
                        metadata,
                        now_ms,
                        metadata.get("feed_integrity_reasons")
                        or ("feed integrity unavailable",),
                    )
                    return self.public_state()
                if self._snapshots and snapshot.timestamp_ms <= self._snapshots[-1].timestamp_ms:
                    self._state["recorder_dropped_snapshots"] += 1
                    self._state["last_error"] = (
                        "Dropped non-increasing micro snapshot "
                        f"{snapshot.timestamp_ms} <= {self._snapshots[-1].timestamp_ms}"
                    )
                    self._state["last_error_timestamp_ms"] = now_ms
                    self._persist_if_due()
                    return self.public_state()

                self._snapshots.append(snapshot)
                self._snapshot_metadata.append(copy.deepcopy(metadata))
                self._latest_snapshot_metadata = metadata
                self._state["recorder_total_snapshots"] += 1
                self._state["recorder_total_trade_prints"] += len(snapshot.trades)
                self._state["recorder_truncated_trade_prints"] += int(
                    metadata.get("trades_truncated", 0) or 0
                )
                self._state["recorder_first_timestamp_ms"] = (
                    self._state["recorder_first_timestamp_ms"] or snapshot.timestamp_ms
                )
                self._state["recorder_latest_timestamp_ms"] = snapshot.timestamp_ms

                history = list(self._snapshots)
                evaluation = evaluate_entry(history, self.entry_config)
                self._latest_entry_evaluation = evaluation
                if evaluation["entry_signal"]:
                    self._append_entry_signal(evaluation)

                capacity_ok = len(self._state["paper_positions"]) < int(
                    self.runtime_config.paper_max_open_positions
                )
                safeguard_inputs = ExecutionSafeguardInputs(
                    evaluated_at_ms=now_ms,
                    quote_timestamp_ms=snapshot.timestamp_ms,
                    book_valid=metadata["book_valid"],
                    exchange_order_valid=True,
                    reconciliation_clear=True,
                    account_capacity_ok=capacity_ok,
                    kill_switch_clear=True,
                )
                self._latest_safeguards = evaluate_execution_safeguards(
                    safeguard_inputs,
                    ExecutionSafeguardConfig(
                        max_quote_age_ms=self.runtime_config.max_quote_age_ms
                    ),
                )

                had_positions = bool(self._state["paper_positions"])
                if self.runtime_config.paper_enabled and had_positions:
                    self._paper_exit_positions(
                        history,
                        snapshot,
                        execution_allowed=self._exit_execution_allowed(
                            self._latest_safeguards
                        ),
                    )
                if (
                    self.runtime_config.paper_enabled
                    and evaluation["entry_signal"]
                    and self._latest_safeguards["execution_allowed"]
                ):
                    # The capacity verdict above is based on the pre-exit state.
                    # Re-evaluate capacity after exits without changing the signal.
                    if len(self._state["paper_positions"]) < int(
                        self.runtime_config.paper_max_open_positions
                    ):
                        self._paper_open(snapshot, int(evaluation["candidate_side"]), evaluation)

                self._latest_live_gates = self._evaluate_live_gates(
                    snapshot, now_ms, live_gates
                )
                self._latest_live_intent = None
                if (
                    self._live_armed
                    and evaluation["entry_signal"]
                    and self._latest_live_gates["execution_allowed"]
                ):
                    self._latest_live_intent = {
                        "timestamp_ms": snapshot.timestamp_ms,
                        "market_id": self.runtime_config.market_id,
                        "symbol": self.runtime_config.symbol,
                        "side": evaluation["candidate_side"],
                        "signal_price": evaluation["signal_price"],
                        "expected_net_edge_bps": evaluation["metrics"][
                            "expected_net_edge_bps"
                        ],
                        "order_submission_performed": False,
                    }
                self._state["last_error"] = None
                self._state["last_error_timestamp_ms"] = None
                self._persist_if_due()
            except Exception as exc:
                now_ms = int(time.time() * 1_000)
                self._reject_feed_snapshot(
                    snapshot,
                    metadata,
                    now_ms,
                    (f"market feed unavailable: {exc}",),
                )
            return self.public_state()

    run_once = tick

    def _append_entry_signal(self, evaluation: Mapping[str, Any]) -> None:
        signal = {
            "time": evaluation["source_timestamp_ms"] / 1_000.0,
            "timestamp_ms": evaluation["source_timestamp_ms"],
            "price": evaluation["signal_price"],
            "side": evaluation["candidate_side"],
            "conditions": copy.deepcopy(evaluation["condition_pass"]),
            "condition_details": copy.deepcopy(evaluation["conditions"]),
            "source": copy.deepcopy(evaluation["source"]),
            "expected_net_edge_bps": evaluation["metrics"]["expected_net_edge_bps"],
        }
        self._state["entry_signals"].append(signal)
        self._state["entry_signals"] = self._state["entry_signals"][-ENTRY_SIGNAL_LIMIT:]

    @staticmethod
    def _ordered_levels(
        snapshot: OrderBookSnapshot, side: int
    ) -> Tuple[BookLevel, ...]:
        if side > 0:
            return tuple(sorted(snapshot.asks, key=lambda level: level.price))
        return tuple(sorted(snapshot.bids, key=lambda level: level.price, reverse=True))

    def _walk_ioc(
        self,
        snapshot: OrderBookSnapshot,
        side: int,
        *,
        target_notional: Optional[float] = None,
        target_quantity: Optional[float] = None,
    ) -> Optional[Dict[str, Any]]:
        levels = self._ordered_levels(snapshot, side)
        reference = levels[0].price
        slippage = self.runtime_config.paper_max_slippage_bps / 10_000.0
        limit_price = reference * (1.0 + slippage if side > 0 else 1.0 - slippage)
        remaining_notional = float(target_notional) if target_notional is not None else None
        remaining_quantity = float(target_quantity) if target_quantity is not None else None
        filled_quantity = 0.0
        filled_notional = 0.0
        walked_levels = 0
        for level in levels:
            if (side > 0 and level.price > limit_price) or (
                side < 0 and level.price < limit_price
            ):
                break
            if remaining_quantity is not None:
                quantity = min(level.size, remaining_quantity)
            else:
                assert remaining_notional is not None
                quantity = min(level.size, remaining_notional / level.price)
            if quantity <= 0:
                continue
            filled_quantity += quantity
            level_notional = quantity * level.price
            filled_notional += level_notional
            walked_levels += 1
            if remaining_quantity is not None:
                remaining_quantity -= quantity
                if remaining_quantity <= 1e-12:
                    break
            else:
                remaining_notional -= level_notional
                if remaining_notional <= 1e-9:
                    break
        if filled_quantity <= 0:
            return None
        average_price = filled_notional / filled_quantity
        requested = (
            float(target_quantity)
            if target_quantity is not None
            else float(target_notional)
        )
        filled_basis = filled_quantity if target_quantity is not None else filled_notional
        return {
            "quantity": filled_quantity,
            "notional_usd": filled_notional,
            "average_price": average_price,
            "reference_price": reference,
            "limit_price": limit_price,
            "slippage_bps": side * (average_price / reference - 1.0) * 10_000.0,
            "fill_ratio": min(1.0, filled_basis / requested),
            "walked_levels": walked_levels,
        }

    def _next_fill_id(self) -> int:
        fill_id = int(self._state["next_fill_id"])
        self._state["next_fill_id"] = fill_id + 1
        return fill_id

    def _paper_open(
        self,
        snapshot: OrderBookSnapshot,
        side: int,
        evaluation: Mapping[str, Any],
    ) -> None:
        walked = self._walk_ioc(
            snapshot,
            side,
            target_notional=self.runtime_config.paper_order_notional_usd,
        )
        if walked is None:
            return
        fill_id = self._next_fill_id()
        fee = walked["notional_usd"] * self.runtime_config.paper_taker_fee_bps / 10_000.0
        position = {
            "position_id": fill_id,
            "side": side,
            "quantity": walked["quantity"],
            "entry_price": walked["average_price"],
            "entry_timestamp_ms": snapshot.timestamp_ms,
            "entry_notional_usd": walked["notional_usd"],
            "remaining_entry_fee_usd": fee,
            "source_signal_timestamp_ms": evaluation["source_timestamp_ms"],
        }
        self._state["paper_positions"].append(position)
        self._state["paper_fees_paid_usd"] += fee
        self._append_paper_fill(
            {
                "fill_id": fill_id,
                "position_id": fill_id,
                "action": "ENTRY",
                "timestamp_ms": snapshot.timestamp_ms,
                "side": side,
                "fee_usd": fee,
                **walked,
            }
        )

    def _paper_exit_positions(
        self,
        history: Sequence[OrderBookSnapshot],
        snapshot: OrderBookSnapshot,
        *,
        execution_allowed: bool = True,
    ) -> None:
        remaining = []
        for position in self._state["paper_positions"]:
            evaluation = evaluate_exit(
                history,
                PositionState(
                    side=int(position["side"]),
                    entry_price=float(position["entry_price"]),
                    entry_timestamp_ms=int(position["entry_timestamp_ms"]),
                ),
                self.entry_config,
                self.exit_config,
            )
            self._latest_exit_evaluation = evaluation
            if not evaluation["should_exit"]:
                remaining.append(position)
                continue
            self._append_exit_signal(position, evaluation)
            if not execution_allowed:
                remaining.append(position)
                continue
            exit_side = -int(position["side"])
            walked = self._walk_ioc(
                snapshot,
                exit_side,
                target_quantity=float(position["quantity"]),
            )
            if walked is None:
                remaining.append(position)
                continue
            close_quantity = walked["quantity"]
            prior_quantity = float(position["quantity"])
            entry_fee_allocated = float(position["remaining_entry_fee_usd"]) * (
                close_quantity / prior_quantity
            )
            exit_fee = (
                walked["notional_usd"]
                * self.runtime_config.paper_taker_fee_bps
                / 10_000.0
            )
            gross_pnl = int(position["side"]) * (
                walked["average_price"] - float(position["entry_price"])
            ) * close_quantity
            net_pnl = gross_pnl - entry_fee_allocated - exit_fee
            self._state["paper_realized_pnl_usd"] += net_pnl
            self._state["paper_fees_paid_usd"] += exit_fee
            if net_pnl > 0:
                self._state["paper_win_count"] += 1
            elif net_pnl < 0:
                self._state["paper_loss_count"] += 1
            fill_id = self._next_fill_id()
            self._append_paper_fill(
                {
                    "fill_id": fill_id,
                    "position_id": position["position_id"],
                    "action": "EXIT",
                    "timestamp_ms": snapshot.timestamp_ms,
                    "side": exit_side,
                    "fee_usd": exit_fee,
                    "exit_reasons": list(evaluation["exit_reasons"]),
                    **walked,
                }
            )
            self._state["paper_trades"].append(
                {
                    "position_id": position["position_id"],
                    "entry_timestamp_ms": position["entry_timestamp_ms"],
                    "exit_timestamp_ms": snapshot.timestamp_ms,
                    "side": position["side"],
                    "quantity": close_quantity,
                    "entry_price": position["entry_price"],
                    "exit_price": walked["average_price"],
                    "gross_pnl_usd": gross_pnl,
                    "entry_fee_usd": entry_fee_allocated,
                    "exit_fee_usd": exit_fee,
                    "net_pnl_usd": net_pnl,
                    "holding_ms": snapshot.timestamp_ms
                    - int(position["entry_timestamp_ms"]),
                    "exit_reasons": list(evaluation["exit_reasons"]),
                }
            )
            self._state["paper_trades"] = self._state["paper_trades"][
                -PAPER_HISTORY_LIMIT:
            ]
            unfilled_quantity = prior_quantity - close_quantity
            if unfilled_quantity > 1e-12:
                position["quantity"] = unfilled_quantity
                position["remaining_entry_fee_usd"] = (
                    float(position["remaining_entry_fee_usd"])
                    - entry_fee_allocated
                )
                remaining.append(position)
        self._state["paper_positions"] = remaining

    @staticmethod
    def _exit_execution_allowed(safeguards: Mapping[str, Any]) -> bool:
        """Exit fills need valid market/execution data, but not entry capacity."""

        verdicts = safeguards.get("safeguard_pass") or {}
        return all(
            verdicts.get(name) is True
            for name in (
                "quote_fresh",
                "book_valid",
                "exchange_order_valid",
                "reconciliation_clear",
                "kill_switch_clear",
            )
        )

    def _append_exit_signal(
        self, position: Mapping[str, Any], evaluation: Mapping[str, Any]
    ) -> None:
        """Retain exit verdicts independently of whether an IOC can fill."""

        signal = {
            "time": evaluation["source_timestamp_ms"] / 1_000.0,
            "timestamp_ms": evaluation["source_timestamp_ms"],
            "position_id": position["position_id"],
            "side": position["side"],
            "price": evaluation["metrics"]["exit_price"],
            "exit_reasons": list(evaluation["exit_reasons"]),
            "conditions": copy.deepcopy(evaluation["condition_pass"]),
            "condition_details": copy.deepcopy(evaluation["conditions"]),
            "source": copy.deepcopy(evaluation["source"]),
        }
        self._state["exit_signals"].append(signal)
        self._state["exit_signals"] = self._state["exit_signals"][
            -ENTRY_SIGNAL_LIMIT:
        ]

    def _append_paper_fill(self, fill: Mapping[str, Any]) -> None:
        self._state["paper_fills"].append(copy.deepcopy(dict(fill)))
        self._state["paper_fills"] = self._state["paper_fills"][
            -PAPER_HISTORY_LIMIT:
        ]

    def _empty_safeguards(self) -> Dict[str, Any]:
        names = (
            "quote_fresh",
            "book_valid",
            "exchange_order_valid",
            "reconciliation_clear",
            "account_capacity_ok",
            "kill_switch_clear",
        )
        return {
            "execution_allowed": False,
            "safeguard_pass": {name: None for name in names},
            "safeguards": {
                name: {
                    "available": False,
                    "pass": None,
                    "status": UNAVAILABLE,
                    "source_timestamp_ms": None,
                }
                for name in names
            },
            "source_timestamp_ms": None,
            "evaluated_at_ms": None,
        }

    @staticmethod
    def _empty_live_gates() -> Dict[str, Any]:
        names = (
            "validation_passed",
            "recovery_clear",
            "account_capacity_ok",
            "exchange_order_valid",
            "reconciliation_clear",
            "kill_switch_clear",
            "recorder_ready",
            "quote_fresh",
            "book_valid",
        )
        return {
            "execution_allowed": False,
            "gates": {
                name: {"pass": None, "status": UNAVAILABLE, "available": False}
                for name in names
            },
        }

    def _evaluate_live_gates(
        self,
        snapshot: OrderBookSnapshot,
        now_ms: int,
        supplied: Optional[Mapping[str, Optional[bool]]],
    ) -> Dict[str, Any]:
        supplied = supplied or {}
        required = (
            "validation_passed",
            "recovery_clear",
            "account_capacity_ok",
            "exchange_order_valid",
            "reconciliation_clear",
            "kill_switch_clear",
        )
        external = {}
        for name in required:
            value = supplied.get(name)
            external[name] = {
                "available": value is not None,
                "pass": None if value is None else bool(value),
                "status": UNAVAILABLE if value is None else ("PASS" if value else "WAITING"),
            }
        pure = evaluate_execution_safeguards(
            ExecutionSafeguardInputs(
                evaluated_at_ms=now_ms,
                quote_timestamp_ms=snapshot.timestamp_ms,
                book_valid=self._latest_snapshot_metadata.get("book_valid"),
                exchange_order_valid=supplied.get("exchange_order_valid"),
                reconciliation_clear=supplied.get("reconciliation_clear"),
                account_capacity_ok=supplied.get("account_capacity_ok"),
                kill_switch_clear=supplied.get("kill_switch_clear"),
            ),
            ExecutionSafeguardConfig(
                max_quote_age_ms=self.runtime_config.max_quote_age_ms
            ),
        )
        recorder_ready = self._state["recorder_total_snapshots"] >= int(
            self.runtime_config.live_min_recorded_snapshots
        )
        gates = dict(external)
        gates["recorder_ready"] = {
            "available": True,
            "pass": recorder_ready,
            "status": "PASS" if recorder_ready else "WAITING",
            "measured_value": self._state["recorder_total_snapshots"],
            "threshold": self.runtime_config.live_min_recorded_snapshots,
        }
        gates["quote_fresh"] = copy.deepcopy(pure["safeguards"]["quote_fresh"])
        gates["book_valid"] = copy.deepcopy(pure["safeguards"]["book_valid"])
        if self._state.get("state_recovery_error"):
            gates["recovery_clear"] = {
                "available": True,
                "pass": False,
                "status": "WAITING",
                "reason": self._state["state_recovery_error"],
            }
        return {
            "execution_allowed": all(
                detail.get("pass") is True for detail in gates.values()
            ),
            "gates": gates,
            "source_timestamp_ms": snapshot.timestamp_ms,
            "evaluated_at_ms": now_ms,
        }

    def arm_live(
        self,
        confirmation: str,
        *,
        gates: Optional[Mapping[str, Optional[bool]]] = None,
    ) -> Dict[str, Any]:
        """Arm intent generation only after explicit confirmation and all gates.

        Arming is deliberately process-local and is never restored from disk.
        This method never invokes any exchange order API.
        """

        if confirmation != LIVE_CONFIRMATION:
            self._live_armed = False
            self._state["live_blocked_reason"] = "Exact live confirmation is required"
            self._save()
            raise ValueError(self._state["live_blocked_reason"])
        if self._state.get("state_recovery_error"):
            self._live_armed = False
            self._state["live_blocked_reason"] = self._state["state_recovery_error"]
            self._save()
            raise RuntimeError(self._state["live_blocked_reason"])
        required = (
            "validation_passed",
            "recovery_clear",
            "account_capacity_ok",
            "exchange_order_valid",
            "reconciliation_clear",
            "kill_switch_clear",
        )
        gates = gates or {}
        failed = [name for name in required if gates.get(name) is not True]
        if self._state["recorder_total_snapshots"] < int(
            self.runtime_config.live_min_recorded_snapshots
        ):
            failed.append("recorder_ready")
        if failed:
            self._live_armed = False
            self._state["live_blocked_reason"] = (
                "Live gates are missing or false: " + ", ".join(failed)
            )
            self._save()
            raise RuntimeError(self._state["live_blocked_reason"])
        self._live_armed = True
        self._state["live_blocked_reason"] = None
        self._save()
        return self.public_state()

    def disarm_live(self) -> Dict[str, Any]:
        self._live_armed = False
        self._latest_live_intent = None
        self._state["live_blocked_reason"] = "Live execution is not armed"
        self._save()
        return self.public_state()

    def _condition_placeholders(self) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        entry = {
            "entry_direction": _placeholder_condition(True),
            "entry_max_spread": _placeholder_condition(
                self.entry_config.use_max_spread
            ),
            "entry_depth_imbalance": _placeholder_condition(
                self.entry_config.use_depth_imbalance
            ),
            "entry_microprice_displacement": _placeholder_condition(
                self.entry_config.use_microprice_displacement
            ),
            "entry_trade_flow": _placeholder_condition(
                self.entry_config.use_trade_flow
            ),
            "entry_price_momentum": _placeholder_condition(
                self.entry_config.use_price_momentum
            ),
            "entry_min_expected_edge": _placeholder_condition(
                self.entry_config.use_min_expected_edge
            ),
        }
        exit_conditions = {
            "exit_take_profit": _placeholder_condition(
                self.exit_config.use_take_profit
            ),
            "exit_stop_loss": _placeholder_condition(
                self.exit_config.use_stop_loss
            ),
            "exit_max_holding_time": _placeholder_condition(
                self.exit_config.use_max_holding_time
            ),
            "exit_signal_reversal": _placeholder_condition(
                self.exit_config.use_signal_reversal
            ),
        }
        return entry, exit_conditions

    def _ladder(self) -> Dict[str, Any]:
        if not self._snapshots:
            return {
                "bids": [],
                "asks": [],
                "source": None,
                "timestamp_ms": None,
                "sequence": None,
            }
        snapshot = self._snapshots[-1]
        return {
            "bids": [
                {"price": level.price, "size": level.size}
                for level in sorted(snapshot.bids, key=lambda level: level.price, reverse=True)
            ],
            "asks": [
                {"price": level.price, "size": level.size}
                for level in sorted(snapshot.asks, key=lambda level: level.price)
            ],
            "source": snapshot.source,
            "timestamp_ms": snapshot.timestamp_ms,
            "sequence": snapshot.sequence,
            "metadata": copy.deepcopy(self._latest_snapshot_metadata),
        }

    def _paper_mark(self) -> Dict[str, Any]:
        if not self._snapshots:
            return {
                "mark_available": False,
                "unrealized_pnl_usd": None,
                "equity_usd": None,
            }
        snapshot = self._snapshots[-1]
        bids = sorted(snapshot.bids, key=lambda level: level.price, reverse=True)
        asks = sorted(snapshot.asks, key=lambda level: level.price)
        unrealized = 0.0
        for position in self._state["paper_positions"]:
            side = int(position["side"])
            mark = bids[0].price if side > 0 else asks[0].price
            quantity = float(position["quantity"])
            gross = side * (mark - float(position["entry_price"])) * quantity
            estimated_exit_fee = (
                mark
                * quantity
                * self.runtime_config.paper_taker_fee_bps
                / 10_000.0
            )
            unrealized += (
                gross
                - float(position["remaining_entry_fee_usd"])
                - estimated_exit_fee
            )
        equity = (
            self.runtime_config.paper_initial_equity_usd
            + float(self._state["paper_realized_pnl_usd"])
            + unrealized
        )
        return {
            "mark_available": True,
            "mark_timestamp_ms": snapshot.timestamp_ms,
            "unrealized_pnl_usd": unrealized,
            "equity_usd": equity,
        }

    def replay(self, limit: int = 500) -> Dict[str, Any]:
        """Causally rerun retained snapshots using the *current* configuration.

        Replay starts from a clean paper account and never mutates or persists
        live runtime state.  L2 history is prospective and memory-only, so a
        process restart intentionally leaves nothing to replay.
        """

        try:
            requested_limit = int(limit)
        except (TypeError, ValueError) as exc:
            raise ValueError("replay limit must be an integer") from exc
        if requested_limit < 1 or requested_limit > MAX_REPLAY_LIMIT:
            raise ValueError(
                f"replay limit must be between 1 and {MAX_REPLAY_LIMIT}"
            )
        snapshots = list(self._snapshots)[-requested_limit:]
        metadata = list(self._snapshot_metadata)[-requested_limit:]

        simulation = object.__new__(type(self))
        simulation.client = None
        simulation.state_path = self.state_path
        simulation.lock = None
        simulation.entry_config = self.entry_config
        simulation.exit_config = self.exit_config
        simulation.runtime_config = self.runtime_config
        simulation._snapshots = deque(
            maxlen=self.runtime_config.raw_snapshot_history_limit
        )
        simulation._snapshot_metadata = deque(
            maxlen=self.runtime_config.raw_snapshot_history_limit
        )
        simulation._latest_snapshot_metadata = {}
        simulation._latest_entry_evaluation = None
        simulation._latest_exit_evaluation = None
        simulation._latest_safeguards = simulation._empty_safeguards()
        simulation._latest_live_gates = simulation._empty_live_gates()
        simulation._latest_live_intent = None
        simulation._live_armed = False
        simulation._dirty = False
        simulation._last_persist_monotonic = time.monotonic()
        simulation._state = simulation._default_state()

        evaluations = []
        for index, snapshot in enumerate(snapshots):
            snapshot_metadata = metadata[index] if index < len(metadata) else {}
            feed_ready, integrity_reasons = simulation._feed_integrity(
                snapshot, snapshot_metadata
            )
            if not feed_ready:
                entry_evaluation = simulation._unavailable_entry_evaluation(
                    snapshot, integrity_reasons
                )
                simulation._latest_entry_evaluation = entry_evaluation
                simulation._latest_exit_evaluation = None
                evaluated_at = int(
                    snapshot_metadata.get("evaluated_at_ms")
                    or snapshot.timestamp_ms
                )
                capacity_ok = len(simulation._state["paper_positions"]) < int(
                    simulation.runtime_config.paper_max_open_positions
                )
                paper_safeguards = evaluate_execution_safeguards(
                    ExecutionSafeguardInputs(
                        evaluated_at_ms=evaluated_at,
                        quote_timestamp_ms=snapshot.timestamp_ms,
                        book_valid=False,
                        exchange_order_valid=True,
                        reconciliation_clear=True,
                        account_capacity_ok=capacity_ok,
                        kill_switch_clear=True,
                    ),
                    ExecutionSafeguardConfig(
                        max_quote_age_ms=simulation.runtime_config.max_quote_age_ms
                    ),
                )
                _, exit_placeholders = simulation._condition_placeholders()
                for detail in exit_placeholders.values():
                    detail["source_timestamp_ms"] = snapshot.timestamp_ms
                    if detail["enabled"]:
                        detail["unavailable_reason"] = entry_evaluation[
                            "unavailable_reason"
                        ]
                combined_conditions = copy.deepcopy(
                    entry_evaluation["conditions"]
                )
                combined_conditions.update(exit_placeholders)
                evaluations.append(
                    {
                        "timestamp_ms": snapshot.timestamp_ms,
                        "source": copy.deepcopy(entry_evaluation["source"]),
                        "conditions": combined_conditions,
                        "entry": copy.deepcopy(entry_evaluation),
                        "exit": None,
                        "exit_signals": [],
                        "paper_safeguards": paper_safeguards,
                        "feed_ready": False,
                        "unavailable_reason": entry_evaluation[
                            "unavailable_reason"
                        ],
                    }
                )
                continue
            simulation._snapshots.append(snapshot)
            simulation._snapshot_metadata.append(copy.deepcopy(snapshot_metadata))
            simulation._latest_snapshot_metadata = copy.deepcopy(snapshot_metadata)
            history = list(simulation._snapshots)
            entry_evaluation = evaluate_entry(history, simulation.entry_config)
            simulation._latest_entry_evaluation = entry_evaluation
            if entry_evaluation["entry_signal"]:
                simulation._append_entry_signal(entry_evaluation)

            capacity_ok = len(simulation._state["paper_positions"]) < int(
                simulation.runtime_config.paper_max_open_positions
            )
            paper_safeguards = evaluate_execution_safeguards(
                ExecutionSafeguardInputs(
                    evaluated_at_ms=int(
                        snapshot_metadata.get("evaluated_at_ms")
                        or snapshot.timestamp_ms
                    ),
                    quote_timestamp_ms=snapshot.timestamp_ms,
                    book_valid=snapshot_metadata.get("book_valid", True),
                    exchange_order_valid=True,
                    reconciliation_clear=True,
                    account_capacity_ok=capacity_ok,
                    kill_switch_clear=True,
                ),
                ExecutionSafeguardConfig(
                    max_quote_age_ms=simulation.runtime_config.max_quote_age_ms
                ),
            )
            simulation._latest_safeguards = paper_safeguards
            exit_start = len(simulation._state["exit_signals"])
            simulation._latest_exit_evaluation = None
            if (
                simulation.runtime_config.paper_enabled
                and simulation._state["paper_positions"]
            ):
                simulation._paper_exit_positions(
                    history,
                    snapshot,
                    execution_allowed=simulation._exit_execution_allowed(
                        paper_safeguards
                    ),
                )
            if (
                simulation.runtime_config.paper_enabled
                and entry_evaluation["entry_signal"]
                and paper_safeguards["execution_allowed"]
                and len(simulation._state["paper_positions"])
                < int(simulation.runtime_config.paper_max_open_positions)
            ):
                simulation._paper_open(
                    snapshot,
                    int(entry_evaluation["candidate_side"]),
                    entry_evaluation,
                )
            _, exit_placeholders = simulation._condition_placeholders()
            for detail in exit_placeholders.values():
                detail["source_timestamp_ms"] = snapshot.timestamp_ms
            exit_evaluation = copy.deepcopy(simulation._latest_exit_evaluation)
            combined_conditions = copy.deepcopy(entry_evaluation["conditions"])
            combined_conditions.update(
                copy.deepcopy(
                    exit_evaluation["conditions"]
                    if exit_evaluation is not None else exit_placeholders
                )
            )
            evaluations.append(
                {
                    "timestamp_ms": snapshot.timestamp_ms,
                    "source": copy.deepcopy(entry_evaluation["source"]),
                    "conditions": combined_conditions,
                    "entry": copy.deepcopy(entry_evaluation),
                    "exit": exit_evaluation,
                    "exit_signals": copy.deepcopy(
                        simulation._state["exit_signals"][exit_start:]
                    ),
                    "paper_safeguards": copy.deepcopy(paper_safeguards),
                    "feed_ready": True,
                }
            )

        paper_mark = simulation._paper_mark()
        return {
            "strategy": "lighter_microstructure",
            "source": {
                "type": "PROSPECTIVE_IN_MEMORY_L2_TRADES",
                "persisted": False,
                "snapshot_count": len(snapshots),
                "snapshots_available": len(self._snapshots),
                "requested_limit": requested_limit,
                "first_timestamp_ms": (
                    snapshots[0].timestamp_ms if snapshots else None
                ),
                "latest_timestamp_ms": (
                    snapshots[-1].timestamp_ms if snapshots else None
                ),
            },
            "config": self.config,
            "entry_signals": copy.deepcopy(simulation._state["entry_signals"]),
            "exit_signals": copy.deepcopy(simulation._state["exit_signals"]),
            "paper_positions": copy.deepcopy(
                simulation._state["paper_positions"]
            ),
            "paper_fills": copy.deepcopy(simulation._state["paper_fills"]),
            "paper_trades": copy.deepcopy(simulation._state["paper_trades"]),
            "evaluations": evaluations,
            "paper_account": {
                "initial_equity_usd": simulation.runtime_config.paper_initial_equity_usd,
                "realized_pnl_usd": simulation._state["paper_realized_pnl_usd"],
                "fees_paid_usd": simulation._state["paper_fees_paid_usd"],
                "wins": simulation._state["paper_win_count"],
                "losses": simulation._state["paper_loss_count"],
                "open_positions": len(simulation._state["paper_positions"]),
                **paper_mark,
            },
        }

    async def replay_async(self, limit: int = 500) -> Dict[str, Any]:
        """Capture recorder state briefly, then replay off-loop without pausing it."""

        captured = object.__new__(type(self))
        async with self.lock:
            captured.state_path = self.state_path
            captured.entry_config = self.entry_config
            captured.exit_config = self.exit_config
            captured.runtime_config = self.runtime_config
            captured._snapshots = deque(
                self._snapshots,
                maxlen=self.runtime_config.raw_snapshot_history_limit,
            )
            captured._snapshot_metadata = deque(
                (copy.deepcopy(row) for row in self._snapshot_metadata),
                maxlen=self.runtime_config.raw_snapshot_history_limit,
            )
        return await asyncio.to_thread(captured.replay, limit)

    def public_state(self) -> Dict[str, Any]:
        entry_placeholders, exit_placeholders = self._condition_placeholders()
        entry_evaluation = copy.deepcopy(self._latest_entry_evaluation)
        exit_evaluation = copy.deepcopy(self._latest_exit_evaluation)
        return {
            "strategy": "lighter_microstructure",
            "venue": "Lighter",
            "mode": "PAPER" if self.runtime_config.paper_enabled else "SHADOW",
            "config": self.config,
            "entry_conditions": (
                entry_evaluation["conditions"]
                if entry_evaluation is not None
                else entry_placeholders
            ),
            "exit_conditions": (
                exit_evaluation["conditions"]
                if exit_evaluation is not None
                else exit_placeholders
            ),
            "latest_entry_evaluation": entry_evaluation,
            "latest_exit_evaluation": exit_evaluation,
            "source": (
                copy.deepcopy(entry_evaluation["source"])
                if entry_evaluation is not None
                else {
                    "name": None,
                    "instrument": self.runtime_config.symbol,
                    "timestamp_ms": None,
                    "sequence": None,
                }
            ),
            "orderbook": self._ladder(),
            "entry_signals": copy.deepcopy(self._state["entry_signals"]),
            "exit_signals": copy.deepcopy(self._state["exit_signals"]),
            "paper_positions": copy.deepcopy(self._state["paper_positions"]),
            "paper_fills": copy.deepcopy(self._state["paper_fills"]),
            "paper_trades": copy.deepcopy(self._state["paper_trades"]),
            "paper_account": {
                "initial_equity_usd": self.runtime_config.paper_initial_equity_usd,
                "realized_pnl_usd": self._state["paper_realized_pnl_usd"],
                "fees_paid_usd": self._state["paper_fees_paid_usd"],
                "wins": self._state["paper_win_count"],
                "losses": self._state["paper_loss_count"],
                "open_positions": len(self._state["paper_positions"]),
                **self._paper_mark(),
            },
            "paper_safeguards": copy.deepcopy(self._latest_safeguards),
            "recorder": {
                "total_snapshots": self._state["recorder_total_snapshots"],
                "dropped_snapshots": self._state["recorder_dropped_snapshots"],
                "invalid_snapshots": self._state["recorder_invalid_snapshots"],
                "total_trade_prints": self._state["recorder_total_trade_prints"],
                "truncated_trade_prints": self._state[
                    "recorder_truncated_trade_prints"
                ],
                "snapshots_in_memory": len(self._snapshots),
                "snapshot_capacity": self.runtime_config.raw_snapshot_history_limit,
                "max_trade_prints_per_snapshot": (
                    self.runtime_config.max_trade_prints_per_snapshot
                ),
                "raw_history_persisted": False,
                "replay_scope": "PROSPECTIVE_IN_MEMORY_ONLY",
                "max_replay_limit": MAX_REPLAY_LIMIT,
                "first_timestamp_ms": self._state["recorder_first_timestamp_ms"],
                "latest_timestamp_ms": self._state["recorder_latest_timestamp_ms"],
                "latest_rejection": copy.deepcopy(
                    self._state["recorder_latest_rejection"]
                ),
                "state_persist_interval_seconds": PERSIST_INTERVAL_SECONDS,
                "state_write_pending": self._dirty,
            },
            "live": {
                "armed": self._live_armed,
                "confirmation_phrase": LIVE_CONFIRMATION,
                "order_submission_implemented": False,
                "blocked_reason": self._state["live_blocked_reason"],
                "gates": copy.deepcopy(self._latest_live_gates),
                "intent": copy.deepcopy(self._latest_live_intent),
            },
            "state_recovery_error": self._state["state_recovery_error"],
            "last_error": self._state["last_error"],
            "last_error_timestamp_ms": self._state["last_error_timestamp_ms"],
        }


__all__ = [
    "LIVE_CONFIRMATION",
    "LighterMicroRuntime",
    "MicroRuntimeConfig",
]
