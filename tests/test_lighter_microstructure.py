"""Focused unit tests for the isolated Lighter microstructure strategy."""

from dataclasses import replace

import pytest

from backend.lighter_microstructure import (
    BookLevel,
    ExecutionSafeguardConfig,
    ExecutionSafeguardInputs,
    MicrostructureEntryConfig,
    MicrostructureExitConfig,
    OrderBookSnapshot,
    PositionState,
    TradePrint,
    build_entry_signal_stream,
    evaluate_entry,
    evaluate_execution_safeguards,
    evaluate_exit,
)


def snapshot(
    timestamp_ms,
    *,
    mid=100.0,
    bid_sizes=(20.0, 15.0),
    ask_sizes=(2.0, 3.0),
    trades=True,
):
    bids = tuple(
        BookLevel(mid - 0.01 - index * 0.01, size)
        for index, size in enumerate(bid_sizes)
    )
    asks = tuple(
        BookLevel(mid + 0.01 + index * 0.01, size)
        for index, size in enumerate(ask_sizes)
    )
    trade_rows = ()
    if trades:
        trade_rows = (
            TradePrint(timestamp_ms - 300, mid, 9.0, "buy"),
            TradePrint(timestamp_ms - 200, mid, 1.0, "sell"),
        )
    return OrderBookSnapshot(
        timestamp_ms=timestamp_ms,
        bids=bids,
        asks=asks,
        trades=trade_rows,
        source="LIGHTER_TEST_FEED",
        instrument="SKHY-USDT",
        sequence=timestamp_ms,
    )


def permissive_config(**overrides):
    config = MicrostructureEntryConfig(
        depth_levels=2,
        max_spread_bps=3.0,
        min_depth_imbalance=0.20,
        min_microprice_displacement_bps=0.20,
        min_trade_flow_imbalance=0.20,
        min_price_momentum_bps=0.20,
        min_expected_edge_bps=0.25,
        depth_imbalance_edge_scale_bps=4.0,
        trade_flow_edge_scale_bps=3.0,
        price_momentum_weight=0.50,
        taker_fee_bps_per_side=0.05,
        slippage_bps_per_side=0.05,
    )
    return replace(config, **overrides)


def test_default_expected_edge_costs_are_nonzero_and_serialized():
    entry = MicrostructureEntryConfig()
    exit_config = MicrostructureExitConfig()
    assert entry.taker_fee_bps_per_side > 0
    assert entry.slippage_bps_per_side > 0
    assert exit_config.exit_fee_bps > 0
    assert exit_config.exit_slippage_bps > 0


def test_long_entry_exposes_real_condition_values_and_source_timestamp():
    history = [snapshot(1_000, mid=99.98), snapshot(2_000, mid=100.0)]
    result = evaluate_entry(history, permissive_config())

    assert result["entry_signal"] is True
    assert result["candidate_side"] == 1
    assert result["source_timestamp_ms"] == 2_000
    assert result["source"] == {
        "name": "LIGHTER_TEST_FEED",
        "instrument": "SKHY-USDT",
        "timestamp_ms": 2_000,
        "sequence": 2_000,
    }
    assert all(value is True for value in result["condition_pass"].values())
    assert result["conditions"]["entry_depth_imbalance"]["measured_value"] == pytest.approx(0.75)
    assert result["conditions"]["entry_trade_flow"]["raw_value"] == pytest.approx(0.8)
    assert result["conditions"]["entry_price_momentum"]["reference_timestamp_ms"] == 1_000
    assert result["metrics"]["round_trip_cost_bps"] == pytest.approx(2.2)
    assert result["metrics"]["expected_net_edge_bps"] >= 0.25


def test_each_adjustable_threshold_changes_the_actual_verdict():
    history = [snapshot(1_000, mid=99.98), snapshot(2_000)]
    baseline = permissive_config()
    assert evaluate_entry(history, baseline)["entry_signal"] is True

    cases = {
        "max_spread_bps": (0.5, "entry_max_spread"),
        "min_depth_imbalance": (0.9, "entry_depth_imbalance"),
        "min_microprice_displacement_bps": (2.0, "entry_microprice_displacement"),
        "min_trade_flow_imbalance": (0.9, "entry_trade_flow"),
        "min_price_momentum_bps": (3.0, "entry_price_momentum"),
        "min_expected_edge_bps": (20.0, "entry_min_expected_edge"),
    }
    for field_name, (strict_value, condition_name) in cases.items():
        result = evaluate_entry(history, replace(baseline, **{field_name: strict_value}))
        assert result["entry_signal"] is False
        assert result["condition_pass"][condition_name] is False
        assert result["conditions"][condition_name]["status"] == "WAITING"


def test_optional_missing_data_is_unavailable_and_disabled_features_are_off():
    current = snapshot(2_000, trades=False)
    required = evaluate_entry([current], permissive_config())
    assert required["entry_signal"] is False
    assert required["condition_pass"]["entry_trade_flow"] is None
    assert required["condition_pass"]["entry_price_momentum"] is None
    assert required["conditions"]["entry_trade_flow"]["status"] == "UNAVAILABLE"
    assert required["conditions"]["entry_price_momentum"]["status"] == "UNAVAILABLE"

    disabled = evaluate_entry(
        [current],
        permissive_config(use_trade_flow=False, use_price_momentum=False),
    )
    assert disabled["entry_signal"] is True
    assert disabled["condition_pass"]["entry_trade_flow"] is None
    assert disabled["condition_pass"]["entry_price_momentum"] is None
    assert disabled["conditions"]["entry_trade_flow"]["status"] == "OFF"
    assert disabled["conditions"]["entry_price_momentum"]["status"] == "OFF"
    assert disabled["metrics"]["expected_move_components_bps"]["trade_flow_bps"] == 0
    assert disabled["metrics"]["expected_move_components_bps"]["price_momentum_bps"] == 0


def test_entry_stream_keeps_second_signal_and_is_causal():
    config = permissive_config(use_price_momentum=False)
    snapshots = [snapshot(1_000), snapshot(1_100), snapshot(1_200)]
    prefix = build_entry_signal_stream(snapshots[:2], config)
    full = build_entry_signal_stream(snapshots, config)

    assert [row["timestamp_ms"] for row in full["entry_signals"]] == [1_000, 1_100, 1_200]
    assert full["evaluations"][:2] == prefix["evaluations"]
    assert full["entry_signals"][:2] == prefix["entry_signals"]


def test_future_trade_is_ignored_instead_of_creating_lookahead_signal():
    current = snapshot(2_000, trades=False)
    future_trade = TradePrint(2_001, 100.0, 100.0, "buy")
    current = replace(current, trades=(future_trade,))
    result = evaluate_entry(
        [current],
        permissive_config(use_price_momentum=False),
    )
    assert result["entry_signal"] is False
    assert result["condition_pass"]["entry_trade_flow"] is None
    assert result["metrics"]["future_trade_count_ignored"] == 1


def test_short_entry_uses_directional_values():
    history = [
        snapshot(1_000, mid=100.02, bid_sizes=(2, 3), ask_sizes=(20, 15)),
        snapshot(2_000, mid=100.0, bid_sizes=(2, 3), ask_sizes=(20, 15)),
    ]
    current = history[-1]
    sell_trades = (
        TradePrint(1_700, 100.0, 9.0, "sell"),
        TradePrint(1_800, 100.0, 1.0, "buy"),
    )
    history[-1] = replace(current, trades=sell_trades)
    result = evaluate_entry(history, permissive_config())

    assert result["entry_signal"] is True
    assert result["candidate_side"] == -1
    assert result["conditions"]["entry_depth_imbalance"]["raw_value"] == pytest.approx(-0.75)
    assert result["conditions"]["entry_depth_imbalance"]["measured_value"] == pytest.approx(0.75)


def test_round_trip_cost_is_part_of_the_expected_edge_predicate():
    history = [snapshot(1_000, mid=99.98), snapshot(2_000)]
    low_cost = evaluate_entry(history, permissive_config())
    high_cost = evaluate_entry(
        history,
        permissive_config(taker_fee_bps_per_side=5.0),
    )
    assert low_cost["condition_pass"]["entry_min_expected_edge"] is True
    assert high_cost["condition_pass"]["entry_min_expected_edge"] is False
    assert high_cost["metrics"]["round_trip_cost_bps"] > low_cost["metrics"]["round_trip_cost_bps"]


def test_exit_predicates_cover_profit_stop_time_and_reversal():
    entry_config = permissive_config(use_price_momentum=False)
    exit_config = MicrostructureExitConfig(
        take_profit_bps=3,
        stop_loss_bps=3,
        max_holding_ms=500,
        reversal_expected_move_bps=0.25,
    )

    profit = evaluate_exit(
        [snapshot(2_000, mid=100.10)],
        PositionState(side=1, entry_price=100.0, entry_timestamp_ms=1_800),
        entry_config,
        exit_config,
    )
    assert profit["condition_pass"]["exit_take_profit"] is True
    assert profit["should_exit"] is True

    stopped_and_timed = evaluate_exit(
        [snapshot(3_000, mid=99.90, bid_sizes=(2, 3), ask_sizes=(20, 15), trades=False)],
        PositionState(side=1, entry_price=100.0, entry_timestamp_ms=2_000),
        replace(entry_config, use_trade_flow=False),
        exit_config,
    )
    assert stopped_and_timed["condition_pass"]["exit_stop_loss"] is True
    assert stopped_and_timed["condition_pass"]["exit_max_holding_time"] is True
    assert stopped_and_timed["condition_pass"]["exit_signal_reversal"] is True
    assert stopped_and_timed["source_timestamp_ms"] == 3_000


def test_exit_reversal_is_unavailable_without_enabled_feature_data():
    result = evaluate_exit(
        [snapshot(2_000, trades=False)],
        PositionState(side=1, entry_price=100.0, entry_timestamp_ms=1_900),
        permissive_config(),
        MicrostructureExitConfig(
            take_profit_bps=50,
            stop_loss_bps=50,
            max_holding_ms=5_000,
            reversal_expected_move_bps=0.25,
        ),
    )
    assert result["condition_pass"]["exit_signal_reversal"] is None
    assert result["conditions"]["exit_signal_reversal"]["status"] == "UNAVAILABLE"
    assert result["should_exit"] is False


def test_execution_safeguards_are_separate_and_cannot_erase_entry_signal():
    config = permissive_config(use_price_momentum=False)
    stream = build_entry_signal_stream([snapshot(1_000)], config)
    assert len(stream["entry_signals"]) == 1

    gate = evaluate_execution_safeguards(
        ExecutionSafeguardInputs(
            evaluated_at_ms=2_000,
            quote_timestamp_ms=1_000,
            book_valid=True,
            exchange_order_valid=True,
            reconciliation_clear=True,
            account_capacity_ok=False,
            kill_switch_clear=True,
        ),
        ExecutionSafeguardConfig(max_quote_age_ms=100),
    )
    assert gate["execution_allowed"] is False
    assert gate["safeguard_pass"]["quote_fresh"] is False
    assert gate["safeguard_pass"]["account_capacity_ok"] is False
    assert "condition_pass" not in gate
    assert len(stream["entry_signals"]) == 1


def test_invalid_or_noncausal_books_are_rejected():
    with pytest.raises(ValueError, match="strictly increasing"):
        evaluate_entry([snapshot(2_000), snapshot(1_000)], permissive_config())

    crossed = OrderBookSnapshot(
        timestamp_ms=1_000,
        bids=(BookLevel(100.0, 1.0),),
        asks=(BookLevel(99.0, 1.0),),
    )
    with pytest.raises(ValueError, match="locked or crossed"):
        evaluate_entry([crossed], permissive_config())
