"""Pure causal microstructure strategy primitives for Lighter research/live use.

This module deliberately has no exchange, account, inventory, or clock access.
Entry evaluation consumes only an ordered prefix of order-book snapshots, so the
same function can be used by a recorder replay and by a live strategy process.
Execution/account safeguards are evaluated through a separate contract and must
gate fills without deleting or fabricating ``entry_signals``.

Public contract
---------------
``evaluate_entry``
    Returns a JSON-safe dict containing ``condition_pass``, detailed measured
    values, source timestamps, and a position-independent entry verdict.
``build_entry_signal_stream``
    Evaluates every causal snapshot prefix and preserves every qualifying entry
    signal, regardless of simulated/live position state.
``evaluate_exit``
    Evaluates position-aware profit, stop, time, and signal-reversal predicates.
``evaluate_execution_safeguards``
    Returns a separate ``safeguard_pass`` namespace for fill-time checks.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Sequence, Tuple


PASS = "PASS"
WAITING = "WAITING"
OFF = "OFF"
UNAVAILABLE = "UNAVAILABLE"


def _finite_positive(value: float, name: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"{name} must be a finite positive number")
    return number


def _finite_nonnegative(value: float, name: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError(f"{name} must be a finite non-negative number")
    return number


@dataclass(frozen=True)
class BookLevel:
    """One price level. ``size`` is base-asset quantity, never notional."""

    price: float
    size: float

    def __post_init__(self) -> None:
        _finite_positive(self.price, "price")
        _finite_positive(self.size, "size")


@dataclass(frozen=True)
class TradePrint:
    """A causally observed aggressive trade included in a snapshot window."""

    timestamp_ms: int
    price: float
    size: float
    aggressor_side: str

    def __post_init__(self) -> None:
        if int(self.timestamp_ms) < 0:
            raise ValueError("timestamp_ms must be non-negative")
        _finite_positive(self.price, "price")
        _finite_positive(self.size, "size")
        if self.aggressor_side not in {"buy", "sell"}:
            raise ValueError("aggressor_side must be 'buy' or 'sell'")


@dataclass(frozen=True)
class OrderBookSnapshot:
    """Atomic L2 snapshot plus any trades observed no later than its timestamp."""

    timestamp_ms: int
    bids: Tuple[BookLevel, ...]
    asks: Tuple[BookLevel, ...]
    trades: Tuple[TradePrint, ...] = field(default_factory=tuple)
    source: str = "LIGHTER_ORDER_BOOK"
    instrument: str = ""
    sequence: Optional[int] = None

    def __post_init__(self) -> None:
        if int(self.timestamp_ms) < 0:
            raise ValueError("timestamp_ms must be non-negative")
        if not self.bids or not self.asks:
            raise ValueError("snapshot requires at least one bid and one ask")
        if not self.source:
            raise ValueError("source is required")


@dataclass(frozen=True)
class MicrostructureEntryConfig:
    """Every entry threshold and feature switch used by the pure evaluator.

    Edge is a transparent linear research estimate, not a guaranteed return:

    ``microprice displacement``
    ``+ depth imbalance * depth_imbalance_edge_scale_bps``
    ``+ trade flow * trade_flow_edge_scale_bps``
    ``+ price momentum * price_momentum_weight``

    Disabled features are removed from both their predicate and the edge model,
    preventing an OFF condition from retaining a hidden influence on entries.
    """

    depth_levels: int = 5
    use_max_spread: bool = True
    max_spread_bps: float = 3.0
    use_depth_imbalance: bool = True
    min_depth_imbalance: float = 0.20
    use_microprice_displacement: bool = True
    min_microprice_displacement_bps: float = 0.25
    use_trade_flow: bool = True
    trade_flow_lookback_ms: int = 1_000
    min_trade_flow_imbalance: float = 0.15
    use_price_momentum: bool = True
    momentum_lookback_ms: int = 1_000
    min_price_momentum_bps: float = 0.25
    use_min_expected_edge: bool = True
    min_expected_edge_bps: float = 0.50
    depth_imbalance_edge_scale_bps: float = 3.0
    trade_flow_edge_scale_bps: float = 2.0
    price_momentum_weight: float = 0.50
    # Conservative paper assumptions until authenticated per-market execution
    # cost telemetry is wired into this evaluator. They are serialized in the
    # shared config and included in every expected-net-edge verdict.
    taker_fee_bps_per_side: float = 1.0
    slippage_bps_per_side: float = 0.5
    extra_round_trip_cost_bps: float = 0.0

    def __post_init__(self) -> None:
        if int(self.depth_levels) < 1:
            raise ValueError("depth_levels must be at least 1")
        if int(self.trade_flow_lookback_ms) < 1:
            raise ValueError("trade_flow_lookback_ms must be positive")
        if int(self.momentum_lookback_ms) < 1:
            raise ValueError("momentum_lookback_ms must be positive")
        for name in (
            "max_spread_bps",
            "min_depth_imbalance",
            "min_microprice_displacement_bps",
            "min_trade_flow_imbalance",
            "min_price_momentum_bps",
            "min_expected_edge_bps",
            "depth_imbalance_edge_scale_bps",
            "trade_flow_edge_scale_bps",
            "price_momentum_weight",
            "taker_fee_bps_per_side",
            "slippage_bps_per_side",
            "extra_round_trip_cost_bps",
        ):
            _finite_nonnegative(getattr(self, name), name)
        if self.min_depth_imbalance > 1 or self.min_trade_flow_imbalance > 1:
            raise ValueError("imbalance thresholds must be between 0 and 1")


@dataclass(frozen=True)
class MicrostructureExitConfig:
    """Position-aware exit predicates. Any enabled predicate may trigger exit."""

    use_take_profit: bool = True
    take_profit_bps: float = 5.0
    use_stop_loss: bool = True
    stop_loss_bps: float = 5.0
    use_max_holding_time: bool = True
    max_holding_ms: int = 5_000
    use_signal_reversal: bool = True
    reversal_expected_move_bps: float = 0.50
    exit_fee_bps: float = 1.0
    exit_slippage_bps: float = 0.5

    def __post_init__(self) -> None:
        if int(self.max_holding_ms) < 1:
            raise ValueError("max_holding_ms must be positive")
        for name in (
            "take_profit_bps",
            "stop_loss_bps",
            "reversal_expected_move_bps",
            "exit_fee_bps",
            "exit_slippage_bps",
        ):
            _finite_nonnegative(getattr(self, name), name)


@dataclass(frozen=True)
class PositionState:
    """Minimal fill state used only by exit evaluation, never by entry logic."""

    side: int
    entry_price: float
    entry_timestamp_ms: int

    def __post_init__(self) -> None:
        if self.side not in {-1, 1}:
            raise ValueError("side must be 1 (long) or -1 (short)")
        _finite_positive(self.entry_price, "entry_price")
        if int(self.entry_timestamp_ms) < 0:
            raise ValueError("entry_timestamp_ms must be non-negative")


@dataclass(frozen=True)
class ExecutionSafeguardConfig:
    """Mandatory fill-time safeguard thresholds, separate from alpha rules."""

    max_quote_age_ms: int = 500

    def __post_init__(self) -> None:
        if int(self.max_quote_age_ms) < 0:
            raise ValueError("max_quote_age_ms must be non-negative")


@dataclass(frozen=True)
class ExecutionSafeguardInputs:
    """External execution/account facts that must never affect entry markers."""

    evaluated_at_ms: int
    quote_timestamp_ms: int
    book_valid: Optional[bool]
    exchange_order_valid: Optional[bool]
    reconciliation_clear: Optional[bool]
    account_capacity_ok: Optional[bool]
    kill_switch_clear: Optional[bool]

    def __post_init__(self) -> None:
        if int(self.evaluated_at_ms) < 0 or int(self.quote_timestamp_ms) < 0:
            raise ValueError("execution timestamps must be non-negative")


def _condition(
    *,
    enabled: bool,
    measured_value: Optional[float],
    threshold: Optional[float],
    operator: str,
    unit: str,
    source_timestamp_ms: int,
    passed: Optional[bool],
    raw_value: Optional[float] = None,
    reference_timestamp_ms: Optional[int] = None,
) -> Dict[str, Any]:
    if not enabled:
        status = OFF
        verdict = None
    elif measured_value is None or passed is None:
        status = UNAVAILABLE
        verdict = None
    else:
        verdict = bool(passed)
        status = PASS if verdict else WAITING
    result: Dict[str, Any] = {
        "enabled": bool(enabled),
        "available": measured_value is not None,
        "pass": verdict,
        "status": status,
        "measured_value": measured_value,
        "threshold": threshold,
        "operator": operator,
        "unit": unit,
        "source_timestamp_ms": int(source_timestamp_ms),
    }
    if raw_value is not None:
        result["raw_value"] = raw_value
    if reference_timestamp_ms is not None:
        result["reference_timestamp_ms"] = int(reference_timestamp_ms)
    return result


def _boolean_safeguard(
    value: Optional[bool], source_timestamp_ms: int
) -> Dict[str, Any]:
    status = UNAVAILABLE if value is None else (PASS if value else WAITING)
    return {
        "available": value is not None,
        "pass": None if value is None else bool(value),
        "status": status,
        "source_timestamp_ms": int(source_timestamp_ms),
    }


def _ordered_levels(snapshot: OrderBookSnapshot) -> Tuple[Tuple[BookLevel, ...], Tuple[BookLevel, ...]]:
    bids = tuple(sorted(snapshot.bids, key=lambda level: level.price, reverse=True))
    asks = tuple(sorted(snapshot.asks, key=lambda level: level.price))
    if bids[0].price >= asks[0].price:
        raise ValueError("order book is locked or crossed")
    return bids, asks


def _validate_history(snapshots: Sequence[OrderBookSnapshot]) -> None:
    if not snapshots:
        raise ValueError("at least one snapshot is required")
    previous_timestamp = -1
    for snapshot in snapshots:
        if snapshot.timestamp_ms <= previous_timestamp:
            raise ValueError("snapshot timestamps must be strictly increasing")
        _ordered_levels(snapshot)
        previous_timestamp = snapshot.timestamp_ms


def _mid_price(snapshot: OrderBookSnapshot) -> float:
    bids, asks = _ordered_levels(snapshot)
    return (bids[0].price + asks[0].price) / 2.0


def _book_metrics(snapshot: OrderBookSnapshot, depth_levels: int) -> Dict[str, Optional[float]]:
    bids, asks = _ordered_levels(snapshot)
    best_bid = bids[0]
    best_ask = asks[0]
    mid = (best_bid.price + best_ask.price) / 2.0
    spread_bps = (best_ask.price - best_bid.price) / mid * 10_000.0
    microprice = (
        best_ask.price * best_bid.size + best_bid.price * best_ask.size
    ) / (best_bid.size + best_ask.size)
    microprice_displacement_bps = (microprice - mid) / mid * 10_000.0

    has_depth = len(bids) >= depth_levels and len(asks) >= depth_levels
    bid_depth = sum(level.size for level in bids[:depth_levels]) if has_depth else None
    ask_depth = sum(level.size for level in asks[:depth_levels]) if has_depth else None
    depth_imbalance = None
    if bid_depth is not None and ask_depth is not None:
        depth_imbalance = (bid_depth - ask_depth) / (bid_depth + ask_depth)
    return {
        "best_bid": best_bid.price,
        "best_ask": best_ask.price,
        "mid_price": mid,
        "spread_bps": spread_bps,
        "microprice": microprice,
        "microprice_displacement_bps": microprice_displacement_bps,
        "top_n_bid_size": bid_depth,
        "top_n_ask_size": ask_depth,
        "depth_imbalance": depth_imbalance,
    }


def _trade_flow(
    snapshot: OrderBookSnapshot, lookback_ms: int
) -> Tuple[Optional[float], int, int]:
    earliest = snapshot.timestamp_ms - lookback_ms
    eligible = [
        trade
        for trade in snapshot.trades
        if earliest <= trade.timestamp_ms <= snapshot.timestamp_ms
    ]
    future_count = sum(trade.timestamp_ms > snapshot.timestamp_ms for trade in snapshot.trades)
    total_size = sum(trade.size for trade in eligible)
    if total_size <= 0:
        return None, 0, future_count
    signed_size = sum(
        trade.size if trade.aggressor_side == "buy" else -trade.size
        for trade in eligible
    )
    return signed_size / total_size, len(eligible), future_count


def _price_momentum(
    snapshots: Sequence[OrderBookSnapshot], lookback_ms: int
) -> Tuple[Optional[float], Optional[int]]:
    current = snapshots[-1]
    cutoff = current.timestamp_ms - lookback_ms
    references = [snapshot for snapshot in snapshots[:-1] if snapshot.timestamp_ms <= cutoff]
    if not references:
        return None, None
    reference = references[-1]
    current_mid = _mid_price(current)
    reference_mid = _mid_price(reference)
    return (current_mid / reference_mid - 1.0) * 10_000.0, reference.timestamp_ms


def evaluate_entry(
    snapshots: Sequence[OrderBookSnapshot],
    config: MicrostructureEntryConfig,
) -> Dict[str, Any]:
    """Evaluate one entry from the latest causal snapshot prefix.

    There is intentionally no position, tranche, balance, capacity, margin, or
    recovery argument. An enabled condition with unavailable input returns
    ``None`` in ``condition_pass`` and blocks the signal rather than defaulting
    to PASS.
    """

    _validate_history(snapshots)
    current = snapshots[-1]
    metrics = _book_metrics(current, config.depth_levels)
    flow_imbalance, trade_count, future_trade_count = _trade_flow(
        current, config.trade_flow_lookback_ms
    )
    momentum_bps, momentum_reference_ms = _price_momentum(
        snapshots, config.momentum_lookback_ms
    )

    depth_imbalance = metrics["depth_imbalance"]
    microprice_displacement = metrics["microprice_displacement_bps"]
    components = {
        "microprice_bps": (
            microprice_displacement
            if config.use_microprice_displacement and microprice_displacement is not None
            else 0.0
        ),
        "depth_imbalance_bps": (
            depth_imbalance * config.depth_imbalance_edge_scale_bps
            if config.use_depth_imbalance and depth_imbalance is not None
            else 0.0
        ),
        "trade_flow_bps": (
            flow_imbalance * config.trade_flow_edge_scale_bps
            if config.use_trade_flow and flow_imbalance is not None
            else 0.0
        ),
        "price_momentum_bps": (
            momentum_bps * config.price_momentum_weight
            if config.use_price_momentum and momentum_bps is not None
            else 0.0
        ),
    }
    expected_move_bps = sum(components.values())
    candidate_side = 1 if expected_move_bps > 0 else (-1 if expected_move_bps < 0 else 0)
    round_trip_cost_bps = (
        float(metrics["spread_bps"])
        + 2.0 * config.taker_fee_bps_per_side
        + 2.0 * config.slippage_bps_per_side
        + config.extra_round_trip_cost_bps
    )
    expected_gross_edge_bps = candidate_side * expected_move_bps
    expected_net_edge_bps = expected_gross_edge_bps - round_trip_cost_bps

    timestamp = current.timestamp_ms
    direction_available = candidate_side != 0
    direction_condition = _condition(
        enabled=True,
        measured_value=abs(expected_move_bps),
        threshold=0.0,
        operator=">",
        unit="bps",
        source_timestamp_ms=timestamp,
        passed=direction_available,
        raw_value=expected_move_bps,
    )
    spread_condition = _condition(
        enabled=config.use_max_spread,
        measured_value=float(metrics["spread_bps"]),
        threshold=config.max_spread_bps,
        operator="<=",
        unit="bps",
        source_timestamp_ms=timestamp,
        passed=float(metrics["spread_bps"]) <= config.max_spread_bps,
    )

    directional_depth = (
        candidate_side * depth_imbalance if candidate_side and depth_imbalance is not None else None
    )
    depth_condition = _condition(
        enabled=config.use_depth_imbalance,
        measured_value=directional_depth,
        threshold=config.min_depth_imbalance,
        operator=">=",
        unit="ratio",
        source_timestamp_ms=timestamp,
        passed=(
            directional_depth >= config.min_depth_imbalance
            if directional_depth is not None
            else None
        ),
        raw_value=depth_imbalance,
    )

    directional_microprice = (
        candidate_side * microprice_displacement
        if candidate_side and microprice_displacement is not None
        else None
    )
    microprice_condition = _condition(
        enabled=config.use_microprice_displacement,
        measured_value=directional_microprice,
        threshold=config.min_microprice_displacement_bps,
        operator=">=",
        unit="bps",
        source_timestamp_ms=timestamp,
        passed=(
            directional_microprice >= config.min_microprice_displacement_bps
            if directional_microprice is not None
            else None
        ),
        raw_value=microprice_displacement,
    )

    directional_flow = (
        candidate_side * flow_imbalance if candidate_side and flow_imbalance is not None else None
    )
    flow_condition = _condition(
        enabled=config.use_trade_flow,
        measured_value=directional_flow,
        threshold=config.min_trade_flow_imbalance,
        operator=">=",
        unit="ratio",
        source_timestamp_ms=timestamp,
        passed=(
            directional_flow >= config.min_trade_flow_imbalance
            if directional_flow is not None
            else None
        ),
        raw_value=flow_imbalance,
    )

    directional_momentum = (
        candidate_side * momentum_bps if candidate_side and momentum_bps is not None else None
    )
    momentum_condition = _condition(
        enabled=config.use_price_momentum,
        measured_value=directional_momentum,
        threshold=config.min_price_momentum_bps,
        operator=">=",
        unit="bps",
        source_timestamp_ms=timestamp,
        passed=(
            directional_momentum >= config.min_price_momentum_bps
            if directional_momentum is not None
            else None
        ),
        raw_value=momentum_bps,
        reference_timestamp_ms=momentum_reference_ms,
    )
    edge_condition = _condition(
        enabled=config.use_min_expected_edge,
        measured_value=expected_net_edge_bps,
        threshold=config.min_expected_edge_bps,
        operator=">=",
        unit="bps",
        source_timestamp_ms=timestamp,
        passed=expected_net_edge_bps >= config.min_expected_edge_bps,
    )

    conditions = {
        "entry_direction": direction_condition,
        "entry_max_spread": spread_condition,
        "entry_depth_imbalance": depth_condition,
        "entry_microprice_displacement": microprice_condition,
        "entry_trade_flow": flow_condition,
        "entry_price_momentum": momentum_condition,
        "entry_min_expected_edge": edge_condition,
    }
    condition_pass = {name: detail["pass"] for name, detail in conditions.items()}
    entry_signal = all(
        (not detail["enabled"]) or detail["pass"] is True
        for detail in conditions.values()
    )

    metrics.update(
        {
            "trade_flow_imbalance": flow_imbalance,
            "eligible_trade_count": trade_count,
            "future_trade_count_ignored": future_trade_count,
            "price_momentum_bps": momentum_bps,
            "momentum_reference_timestamp_ms": momentum_reference_ms,
            "expected_move_components_bps": components,
            "expected_move_bps": expected_move_bps,
            "expected_gross_edge_bps": expected_gross_edge_bps,
            "round_trip_cost_bps": round_trip_cost_bps,
            "expected_net_edge_bps": expected_net_edge_bps,
        }
    )
    return {
        "strategy": "lighter_microstructure",
        "entry_signal": bool(entry_signal),
        "candidate_side": candidate_side,
        "signal_price": metrics["mid_price"],
        "executable_entry_price": (
            metrics["best_ask"] if candidate_side > 0 else metrics["best_bid"]
            if candidate_side < 0
            else None
        ),
        "condition_pass": condition_pass,
        "conditions": conditions,
        "metrics": metrics,
        "source": {
            "name": current.source,
            "instrument": current.instrument,
            "timestamp_ms": timestamp,
            "sequence": current.sequence,
        },
        "source_timestamp_ms": timestamp,
    }


def build_entry_signal_stream(
    snapshots: Sequence[OrderBookSnapshot],
    config: MicrostructureEntryConfig,
) -> Dict[str, Any]:
    """Return every qualifying causal snapshot as a distinct entry signal.

    The prefix loop is intentional: later snapshots cannot alter an earlier
    evaluation. No position state is accepted, so an open simulated/live fill
    cannot suppress the second or subsequent qualifying signal.
    """

    _validate_history(snapshots)
    evaluations = []
    entry_signals = []
    for index in range(len(snapshots)):
        evaluation = evaluate_entry(snapshots[: index + 1], config)
        evaluations.append(evaluation)
        if not evaluation["entry_signal"]:
            continue
        entry_signals.append(
            {
                "time": evaluation["source_timestamp_ms"] / 1_000.0,
                "timestamp_ms": evaluation["source_timestamp_ms"],
                "price": evaluation["signal_price"],
                "side": evaluation["candidate_side"],
                "conditions": dict(evaluation["condition_pass"]),
                "condition_details": evaluation["conditions"],
                "source": dict(evaluation["source"]),
                "expected_net_edge_bps": evaluation["metrics"]["expected_net_edge_bps"],
            }
        )
    return {
        "strategy": "lighter_microstructure",
        "entry_signals": entry_signals,
        "evaluations": evaluations,
    }


def evaluate_exit(
    snapshots: Sequence[OrderBookSnapshot],
    position: PositionState,
    entry_config: MicrostructureEntryConfig,
    exit_config: MicrostructureExitConfig,
) -> Dict[str, Any]:
    """Evaluate position-aware exits without changing the entry signal stream."""

    entry_evaluation = evaluate_entry(snapshots, entry_config)
    current = snapshots[-1]
    if position.entry_timestamp_ms > current.timestamp_ms:
        raise ValueError("position entry timestamp cannot be after the snapshot")
    metrics = entry_evaluation["metrics"]
    exit_price = metrics["best_bid"] if position.side > 0 else metrics["best_ask"]
    gross_pnl_bps = position.side * (exit_price / position.entry_price - 1.0) * 10_000.0
    exit_cost_bps = exit_config.exit_fee_bps + exit_config.exit_slippage_bps
    net_pnl_bps = gross_pnl_bps - exit_cost_bps
    held_ms = current.timestamp_ms - position.entry_timestamp_ms
    directional_expected_move = position.side * metrics["expected_move_bps"]
    reversal_dependencies = (
        "entry_depth_imbalance",
        "entry_microprice_displacement",
        "entry_trade_flow",
        "entry_price_momentum",
    )
    reversal_available = all(
        entry_evaluation["conditions"][name]["status"] != UNAVAILABLE
        for name in reversal_dependencies
    )

    conditions = {
        "exit_take_profit": _condition(
            enabled=exit_config.use_take_profit,
            measured_value=net_pnl_bps,
            threshold=exit_config.take_profit_bps,
            operator=">=",
            unit="bps",
            source_timestamp_ms=current.timestamp_ms,
            passed=net_pnl_bps >= exit_config.take_profit_bps,
        ),
        "exit_stop_loss": _condition(
            enabled=exit_config.use_stop_loss,
            measured_value=-net_pnl_bps,
            threshold=exit_config.stop_loss_bps,
            operator=">=",
            unit="bps_loss",
            source_timestamp_ms=current.timestamp_ms,
            passed=net_pnl_bps <= -exit_config.stop_loss_bps,
            raw_value=net_pnl_bps,
        ),
        "exit_max_holding_time": _condition(
            enabled=exit_config.use_max_holding_time,
            measured_value=float(held_ms),
            threshold=float(exit_config.max_holding_ms),
            operator=">=",
            unit="ms",
            source_timestamp_ms=current.timestamp_ms,
            passed=held_ms >= exit_config.max_holding_ms,
        ),
        "exit_signal_reversal": _condition(
            enabled=exit_config.use_signal_reversal,
            measured_value=-directional_expected_move if reversal_available else None,
            threshold=exit_config.reversal_expected_move_bps,
            operator=">=",
            unit="bps_against_position",
            source_timestamp_ms=current.timestamp_ms,
            passed=(
                directional_expected_move <= -exit_config.reversal_expected_move_bps
                if reversal_available
                else None
            ),
            raw_value=directional_expected_move,
        ),
    }
    condition_pass = {name: detail["pass"] for name, detail in conditions.items()}
    exit_reasons = [
        name for name, detail in conditions.items() if detail["enabled"] and detail["pass"] is True
    ]
    return {
        "strategy": "lighter_microstructure",
        "should_exit": bool(exit_reasons),
        "exit_reasons": exit_reasons,
        "condition_pass": condition_pass,
        "conditions": conditions,
        "metrics": {
            "exit_price": exit_price,
            "gross_pnl_bps": gross_pnl_bps,
            "estimated_exit_cost_bps": exit_cost_bps,
            "net_pnl_bps": net_pnl_bps,
            "held_ms": held_ms,
            "position_directional_expected_move_bps": directional_expected_move,
        },
        "source": dict(entry_evaluation["source"]),
        "source_timestamp_ms": current.timestamp_ms,
    }


def evaluate_execution_safeguards(
    inputs: ExecutionSafeguardInputs,
    config: ExecutionSafeguardConfig,
) -> Dict[str, Any]:
    """Evaluate fill-time checks in a namespace separate from strategy rules.

    Callers may reject an order when ``execution_allowed`` is false, but must not
    remove the originating strategy event from ``entry_signals``.
    """

    quote_age_ms = inputs.evaluated_at_ms - inputs.quote_timestamp_ms
    quote_fresh = 0 <= quote_age_ms <= config.max_quote_age_ms
    safeguards = {
        "quote_fresh": {
            "available": True,
            "pass": quote_fresh,
            "status": PASS if quote_fresh else WAITING,
            "measured_value": quote_age_ms,
            "threshold": config.max_quote_age_ms,
            "operator": "between 0 and <=",
            "unit": "ms",
            "source_timestamp_ms": inputs.quote_timestamp_ms,
        },
        "book_valid": _boolean_safeguard(inputs.book_valid, inputs.quote_timestamp_ms),
        "exchange_order_valid": _boolean_safeguard(
            inputs.exchange_order_valid, inputs.quote_timestamp_ms
        ),
        "reconciliation_clear": _boolean_safeguard(
            inputs.reconciliation_clear, inputs.quote_timestamp_ms
        ),
        "account_capacity_ok": _boolean_safeguard(
            inputs.account_capacity_ok, inputs.quote_timestamp_ms
        ),
        "kill_switch_clear": _boolean_safeguard(
            inputs.kill_switch_clear, inputs.quote_timestamp_ms
        ),
    }
    safeguard_pass = {name: detail["pass"] for name, detail in safeguards.items()}
    return {
        "execution_allowed": all(value is True for value in safeguard_pass.values()),
        "safeguard_pass": safeguard_pass,
        "safeguards": safeguards,
        "source_timestamp_ms": inputs.quote_timestamp_ms,
        "evaluated_at_ms": inputs.evaluated_at_ms,
    }
