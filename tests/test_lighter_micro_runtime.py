"""Focused tests for the persistent Lighter microstructure paper runtime."""

import asyncio
import json
import threading

import pytest

from backend.lighter_micro_runtime import (
    LIVE_CONFIRMATION,
    LighterMicroRuntime,
)


BASE_TIME = 1_800_000_000_000


def market_snapshot(
    timestamp_ms,
    *,
    mid=100.0,
    bid_sizes=(20.0, 15.0),
    ask_sizes=(2.0, 3.0),
    trades=True,
    book_valid=True,
):
    rows = []
    if trades:
        rows = [
            {
                "timestamp_ms": timestamp_ms - 300,
                "exchange_timestamp_ms": timestamp_ms - 350,
                "price": mid,
                "size": 9.0,
                "aggressor_side": "buy",
            },
            {
                "timestamp_ms": timestamp_ms - 200,
                "exchange_timestamp_ms": timestamp_ms - 250,
                "price": mid,
                "size": 1.0,
                "aggressor_side": "sell",
            },
        ]
    return {
        "market_id": 1,
        "timestamp_ms": timestamp_ms,
        "exchange_timestamp_ms": timestamp_ms - 50,
        "received_at_ms": timestamp_ms,
        "source": "LIGHTER_TEST_STREAM",
        "instrument": "BTC",
        "connection_id": 7,
        "sequence": timestamp_ms,
        "book_valid": book_valid,
        "nonce_contiguous": True,
        "quote_age_ms": 0,
        "stream": {
            "connected": True,
            "connection_id": 7,
            "subscriptions_ready": True,
            "gap_count": 0,
            "last_error": None,
            "markets": {
                "1": {
                    "book_valid": book_valid,
                    "book_acknowledged": True,
                    "tape_valid": True,
                    "tape_acknowledged": True,
                    "tape_ready": True,
                    "book_connection_id": 7,
                    "tape_connection_id": 7,
                    "quote_age_ms": 0,
                    "nonce": timestamp_ms,
                    "trade_count_buffered": len(rows),
                }
            },
        },
        "bids": [
            {"price": mid - 0.01 - index * 0.01, "size": size}
            for index, size in enumerate(bid_sizes)
        ],
        "asks": [
            {"price": mid + 0.01 + index * 0.01, "size": size}
            for index, size in enumerate(ask_sizes)
        ],
        "trades": rows,
    }


class SnapshotClient:
    def __init__(self, snapshots):
        self.snapshots = list(snapshots)
        self.calls = []
        self.exchange_order_calls = 0

    async def micro_market_snapshot(self, market_id, depth, trade_lookback_ms):
        self.calls.append((market_id, depth, trade_lookback_ms))
        if not self.snapshots:
            raise RuntimeError("no more snapshots")
        return self.snapshots.pop(0)

    async def create_market_order(self, *args, **kwargs):
        self.exchange_order_calls += 1
        raise AssertionError("the paper runtime must never submit an exchange order")


def run(coro):
    return asyncio.run(coro)


def configure_for_signals(runtime, **runtime_overrides):
    runtime.update_config(
        {
            "entry": {
                "depth_levels": 2,
                "max_spread_bps": 3.0,
                "min_depth_imbalance": 0.20,
                "min_microprice_displacement_bps": 0.20,
                "min_trade_flow_imbalance": 0.20,
                "use_price_momentum": False,
                "min_expected_edge_bps": 0.25,
                "depth_imbalance_edge_scale_bps": 4.0,
                "trade_flow_edge_scale_bps": 3.0,
                "taker_fee_bps_per_side": 0.05,
                "slippage_bps_per_side": 0.05,
            },
            "runtime": {
                "paper_order_notional_usd": 10.0,
                "paper_taker_fee_bps": 1.0,
                "max_quote_age_ms": 500,
                **runtime_overrides,
            },
        }
    )


def live_gates():
    return {
        "validation_passed": True,
        "recovery_clear": True,
        "account_capacity_ok": True,
        "exchange_order_valid": True,
        "reconciliation_clear": True,
        "kill_switch_clear": True,
    }


def test_config_round_trips_exactly_and_raw_snapshot_history_is_not_persisted(tmp_path):
    state_path = tmp_path / "micro.json"
    client = SnapshotClient([market_snapshot(BASE_TIME)])
    runtime = LighterMicroRuntime(client, state_path)
    runtime.update_config(
        {
            "entry": {
                "use_trade_flow": False,
                "min_depth_imbalance": 0.33,
                "max_spread_bps": 2.5,
            },
            "exit": {
                "use_signal_reversal": False,
                "take_profit_bps": 7.25,
                "max_holding_ms": 12_345,
            },
            "runtime": {
                "book_depth": 12,
                "raw_snapshot_history_limit": 25,
                "paper_max_slippage_bps": 3.5,
            },
        }
    )
    expected = runtime.config
    run(runtime.tick(evaluated_at_ms=BASE_TIME))

    document = json.loads(state_path.read_text())
    assert document["config"] == expected
    assert "snapshots" not in document
    assert "orderbook" not in document
    assert document["live_armed"] is False

    restored = LighterMicroRuntime(SnapshotClient([]), state_path)
    assert restored.config == expected
    assert restored.public_state()["recorder"]["snapshots_in_memory"] == 0
    assert restored.public_state()["recorder"]["raw_history_persisted"] is False
    assert restored.public_state()["entry_conditions"]["entry_trade_flow"]["status"] == "OFF"


def test_entry_signals_continue_when_paper_position_uses_all_capacity(tmp_path):
    client = SnapshotClient(
        [
            market_snapshot(BASE_TIME),
            market_snapshot(BASE_TIME + 100),
        ]
    )
    runtime = LighterMicroRuntime(client, tmp_path / "state.json")
    configure_for_signals(runtime, paper_max_open_positions=1)

    first = run(runtime.tick(evaluated_at_ms=BASE_TIME))
    second = run(runtime.tick(evaluated_at_ms=BASE_TIME + 100))

    assert len(first["entry_signals"]) == 1
    assert len(second["entry_signals"]) == 2
    assert [row["timestamp_ms"] for row in second["entry_signals"]] == [
        BASE_TIME,
        BASE_TIME + 100,
    ]
    assert len(second["paper_positions"]) == 1
    assert len(second["paper_fills"]) == 1
    assert second["paper_safeguards"]["safeguard_pass"]["account_capacity_ok"] is False
    assert client.calls == [(1, 20, 1_000), (1, 20, 1_000)]


def test_paper_ioc_walk_charges_fees_and_realizes_exit_pnl(tmp_path):
    client = SnapshotClient(
        [
            market_snapshot(BASE_TIME),
            market_snapshot(BASE_TIME + 1_000, mid=100.20),
        ]
    )
    runtime = LighterMicroRuntime(client, tmp_path / "state.json")
    configure_for_signals(runtime)
    runtime.update_config(
        {
            "exit": {
                "take_profit_bps": 3.0,
                "stop_loss_bps": 50.0,
                "max_holding_ms": 5_000,
                "use_signal_reversal": False,
            }
        }
    )

    opened = run(runtime.tick(evaluated_at_ms=BASE_TIME))
    closed = run(runtime.tick(evaluated_at_ms=BASE_TIME + 1_000))

    entry_fill = opened["paper_fills"][0]
    assert entry_fill["action"] == "ENTRY"
    assert entry_fill["fill_ratio"] == pytest.approx(1.0)
    assert entry_fill["average_price"] == pytest.approx(100.01)
    assert not closed["paper_positions"]
    assert [row["action"] for row in closed["paper_fills"]] == ["ENTRY", "EXIT"]
    assert len(closed["paper_trades"]) == 1
    trade = closed["paper_trades"][0]
    assert trade["exit_price"] == pytest.approx(100.19)
    assert trade["gross_pnl_usd"] > 0
    assert trade["entry_fee_usd"] > 0
    assert trade["exit_fee_usd"] > 0
    assert trade["net_pnl_usd"] == pytest.approx(
        trade["gross_pnl_usd"] - trade["entry_fee_usd"] - trade["exit_fee_usd"]
    )
    assert closed["paper_account"]["realized_pnl_usd"] == pytest.approx(
        trade["net_pnl_usd"]
    )
    assert closed["paper_account"]["equity_usd"] == pytest.approx(
        10_000.0 + trade["net_pnl_usd"]
    )


def test_public_state_exposes_condition_status_source_ladder_and_streams(tmp_path):
    client = SnapshotClient([market_snapshot(BASE_TIME, trades=False)])
    runtime = LighterMicroRuntime(client, tmp_path / "state.json")
    runtime.update_config(
        {
            "entry": {
                "depth_levels": 2,
                "use_trade_flow": False,
                "use_price_momentum": True,
            }
        }
    )
    state = run(runtime.tick(evaluated_at_ms=BASE_TIME))

    assert state["entry_conditions"]["entry_trade_flow"]["status"] == "OFF"
    assert state["entry_conditions"]["entry_price_momentum"]["status"] == "UNAVAILABLE"
    assert state["entry_conditions"]["entry_max_spread"]["status"] in {"PASS", "WAITING"}
    assert state["source"]["name"] == "LIGHTER_TEST_STREAM"
    assert state["source"]["timestamp_ms"] == BASE_TIME
    assert state["orderbook"]["timestamp_ms"] == BASE_TIME
    assert state["orderbook"]["bids"][0]["price"] == pytest.approx(99.99)
    assert state["orderbook"]["asks"][0]["price"] == pytest.approx(100.01)
    assert state["recorder"] == {
        "total_snapshots": 1,
        "dropped_snapshots": 0,
        "invalid_snapshots": 0,
        "total_trade_prints": 0,
        "truncated_trade_prints": 0,
        "snapshots_in_memory": 1,
        "snapshot_capacity": 600,
        "max_trade_prints_per_snapshot": 250,
        "raw_history_persisted": False,
        "replay_scope": "PROSPECTIVE_IN_MEMORY_ONLY",
        "max_replay_limit": 2_000,
        "first_timestamp_ms": BASE_TIME,
        "latest_timestamp_ms": BASE_TIME,
        "latest_rejection": None,
        "state_persist_interval_seconds": 5.0,
        "state_write_pending": True,
    }
    assert "entry_signals" in state
    assert "exit_signals" in state
    assert "paper_fills" in state
    assert "paper_trades" in state
    assert state["paper_safeguards"]["safeguards"]["quote_fresh"]["status"] == "PASS"


def test_out_of_order_snapshot_is_dropped_without_rewriting_signal_history(tmp_path):
    client = SnapshotClient(
        [market_snapshot(BASE_TIME), market_snapshot(BASE_TIME - 1)]
    )
    runtime = LighterMicroRuntime(client, tmp_path / "state.json")
    configure_for_signals(runtime)
    first = run(runtime.tick(evaluated_at_ms=BASE_TIME))
    second = run(runtime.tick(evaluated_at_ms=BASE_TIME + 10))

    assert second["entry_signals"] == first["entry_signals"]
    assert second["recorder"]["total_snapshots"] == 1
    assert second["recorder"]["dropped_snapshots"] == 1
    assert "Dropped non-increasing" in second["last_error"]


def test_live_arming_requires_confirmation_validation_recovery_and_account_gates(tmp_path):
    client = SnapshotClient(
        [
            market_snapshot(BASE_TIME),
            market_snapshot(BASE_TIME + 100),
        ]
    )
    state_path = tmp_path / "state.json"
    runtime = LighterMicroRuntime(client, state_path)
    configure_for_signals(runtime, live_min_recorded_snapshots=1)
    run(runtime.tick(evaluated_at_ms=BASE_TIME))

    with pytest.raises(ValueError, match="Exact live confirmation"):
        runtime.arm_live("yes", gates=live_gates())
    with pytest.raises(RuntimeError, match="account_capacity_ok"):
        runtime.arm_live(
            LIVE_CONFIRMATION,
            gates=live_gates() | {"account_capacity_ok": False},
        )

    armed = runtime.arm_live(LIVE_CONFIRMATION, gates=live_gates())
    assert armed["live"]["armed"] is True
    state = run(
        runtime.tick(
            evaluated_at_ms=BASE_TIME + 100,
            live_gates=live_gates(),
        )
    )
    assert state["live"]["intent"]["order_submission_performed"] is False
    assert state["live"]["gates"]["execution_allowed"] is True
    assert client.exchange_order_calls == 0

    document = json.loads(state_path.read_text())
    assert document["live_armed"] is False
    restored = LighterMicroRuntime(SnapshotClient([]), state_path)
    assert restored.public_state()["live"]["armed"] is False


def test_tick_state_writes_are_batched_and_flush_is_atomic(tmp_path):
    state_path = tmp_path / "state.json"
    runtime = LighterMicroRuntime(
        SnapshotClient([market_snapshot(BASE_TIME)]), state_path
    )
    configure_for_signals(runtime)
    assert json.loads(state_path.read_text())["state"]["recorder_total_snapshots"] == 0

    run(runtime.tick(evaluated_at_ms=BASE_TIME))
    # A 250 ms strategy loop must not fsync a JSON document every iteration.
    assert json.loads(state_path.read_text())["state"]["recorder_total_snapshots"] == 0
    assert runtime.public_state()["recorder"]["state_write_pending"] is True

    runtime.flush()
    persisted = json.loads(state_path.read_text())
    assert persisted["state"]["recorder_total_snapshots"] == 1
    assert runtime.public_state()["recorder"]["state_write_pending"] is False


def test_exit_signal_survives_failed_ioc_and_remains_distinct_from_trade(tmp_path):
    runtime = LighterMicroRuntime(
        SnapshotClient(
            [
                market_snapshot(BASE_TIME),
                market_snapshot(BASE_TIME + 1_000, mid=100.20),
            ]
        ),
        tmp_path / "state.json",
    )
    configure_for_signals(runtime)
    runtime.update_config(
        {
            "exit": {
                "take_profit_bps": 3.0,
                "use_stop_loss": False,
                "use_max_holding_time": False,
                "use_signal_reversal": False,
            }
        }
    )
    run(runtime.tick(evaluated_at_ms=BASE_TIME))
    runtime._walk_ioc = lambda *args, **kwargs: None
    state = run(runtime.tick(evaluated_at_ms=BASE_TIME + 1_000))

    assert len(state["exit_signals"]) == 1
    assert state["exit_signals"][0]["exit_reasons"] == ["exit_take_profit"]
    assert not state["paper_trades"]
    assert len(state["paper_positions"]) == 1


def test_invalid_book_cannot_emit_strategy_verdict_or_create_fill(tmp_path):
    runtime = LighterMicroRuntime(
        SnapshotClient(
            [
                market_snapshot(BASE_TIME),
                market_snapshot(
                    BASE_TIME + 1_000, mid=100.20, book_valid=False
                ),
            ]
        ),
        tmp_path / "state.json",
    )
    configure_for_signals(runtime)
    runtime.update_config(
        {
            "exit": {
                "take_profit_bps": 3.0,
                "use_stop_loss": False,
                "use_max_holding_time": False,
                "use_signal_reversal": False,
            }
        }
    )
    run(runtime.tick(evaluated_at_ms=BASE_TIME))
    state = run(runtime.tick(evaluated_at_ms=BASE_TIME + 1_000))

    assert len(state["entry_signals"]) == 1
    assert not state["exit_signals"]
    assert [row["action"] for row in state["paper_fills"]] == ["ENTRY"]
    assert not state["paper_trades"]
    assert len(state["paper_positions"]) == 1
    assert state["paper_safeguards"]["safeguard_pass"]["book_valid"] is False
    assert state["latest_entry_evaluation"]["entry_signal"] is False
    assert state["latest_entry_evaluation"]["feed_ready"] is False
    assert all(
        detail["status"] in {"UNAVAILABLE", "OFF"}
        for detail in state["entry_conditions"].values()
    )
    assert state["recorder"]["invalid_snapshots"] == 1

    replay = runtime.replay(limit=2)
    assert len(replay["entry_signals"]) == 1
    assert not replay["exit_signals"]
    assert [row["action"] for row in replay["paper_fills"]] == ["ENTRY"]
    assert not replay["paper_trades"]


def test_negative_realized_pnl_survives_persistent_state_reload(tmp_path):
    state_path = tmp_path / "state.json"
    runtime = LighterMicroRuntime(
        SnapshotClient(
            [
                market_snapshot(BASE_TIME),
                market_snapshot(BASE_TIME + 1_000, mid=99.80),
            ]
        ),
        state_path,
    )
    configure_for_signals(runtime)
    runtime.update_config(
        {
            "exit": {
                "use_take_profit": False,
                "use_stop_loss": True,
                "stop_loss_bps": 3.0,
                "use_max_holding_time": False,
                "use_signal_reversal": False,
            }
        }
    )
    run(runtime.tick(evaluated_at_ms=BASE_TIME))
    state = run(runtime.tick(evaluated_at_ms=BASE_TIME + 1_000))
    assert state["paper_account"]["realized_pnl_usd"] < 0
    runtime.flush()

    restored = LighterMicroRuntime(SnapshotClient([]), state_path)
    restored_state = restored.public_state()
    assert restored_state["state_recovery_error"] is None
    assert restored_state["paper_account"]["realized_pnl_usd"] == pytest.approx(
        state["paper_account"]["realized_pnl_usd"]
    )


def test_replay_reruns_current_config_without_mutating_historical_runtime_state(tmp_path):
    runtime = LighterMicroRuntime(
        SnapshotClient(
            [
                market_snapshot(BASE_TIME),
                market_snapshot(BASE_TIME + 100),
            ]
        ),
        tmp_path / "state.json",
    )
    configure_for_signals(runtime)
    run(runtime.tick(evaluated_at_ms=BASE_TIME))
    run(runtime.tick(evaluated_at_ms=BASE_TIME + 100))
    before = runtime.public_state()

    permissive = runtime.replay(limit=2)
    assert len(permissive["entry_signals"]) == 2
    assert len(permissive["paper_fills"]) == 1
    assert permissive["source"] == {
        "type": "PROSPECTIVE_IN_MEMORY_L2_TRADES",
        "persisted": False,
        "snapshot_count": 2,
        "snapshots_available": 2,
        "requested_limit": 2,
        "first_timestamp_ms": BASE_TIME,
        "latest_timestamp_ms": BASE_TIME + 100,
    }

    runtime.update_config({"entry": {"max_spread_bps": 0.5}})
    strict = runtime.replay(limit=2)
    assert not strict["entry_signals"]
    assert not strict["paper_fills"]
    # Replay is read-only; the historically emitted signal stream is retained.
    assert runtime.public_state()["entry_signals"] == before["entry_signals"]
    with pytest.raises(ValueError, match="between 1 and"):
        runtime.replay(limit=2_001)


def test_replay_preserves_original_quote_freshness_gate(tmp_path):
    runtime = LighterMicroRuntime(
        SnapshotClient([market_snapshot(BASE_TIME)]),
        tmp_path / "state.json",
    )
    configure_for_signals(runtime, max_quote_age_ms=100)
    live_state = run(runtime.tick(evaluated_at_ms=BASE_TIME + 500))
    assert len(live_state["entry_signals"]) == 1
    assert not live_state["paper_fills"]
    assert live_state["paper_safeguards"]["safeguard_pass"]["quote_fresh"] is False

    replay = runtime.replay(limit=1)
    assert len(replay["entry_signals"]) == 1
    assert not replay["paper_fills"]
    assert (
        replay["evaluations"][0]["paper_safeguards"]["safeguard_pass"][
            "quote_fresh"
        ]
        is False
    )


def test_replay_emits_exit_signals_fills_and_closed_trades(tmp_path):
    runtime = LighterMicroRuntime(
        SnapshotClient(
            [
                market_snapshot(BASE_TIME),
                market_snapshot(BASE_TIME + 1_000, mid=100.20),
            ]
        ),
        tmp_path / "state.json",
    )
    configure_for_signals(runtime)
    runtime.update_config(
        {
            "exit": {
                "take_profit_bps": 3.0,
                "stop_loss_bps": 50.0,
                "max_holding_ms": 5_000,
                "use_signal_reversal": False,
            }
        }
    )
    run(runtime.tick(evaluated_at_ms=BASE_TIME))
    run(runtime.tick(evaluated_at_ms=BASE_TIME + 1_000))

    replay = runtime.replay(limit=2)
    assert len(replay["entry_signals"]) == 2
    assert len(replay["exit_signals"]) == 1
    assert [row["action"] for row in replay["paper_fills"]] == ["ENTRY", "EXIT"]
    assert len(replay["paper_trades"]) == 1
    assert len(replay["evaluations"]) == 2


def test_async_replay_releases_recorder_lock_before_cpu_work(tmp_path, monkeypatch):
    runtime = LighterMicroRuntime(SnapshotClient([]), tmp_path / "state.json")
    started = threading.Event()
    release = threading.Event()

    def slow_replay(_captured, _limit):
        started.set()
        assert release.wait(timeout=2)
        return {"captured": True}

    monkeypatch.setattr(LighterMicroRuntime, "replay", slow_replay)

    async def exercise():
        task = asyncio.create_task(runtime.replay_async(5))
        while not started.is_set():
            await asyncio.sleep(0.001)
        acquired = False
        try:
            await asyncio.wait_for(runtime.lock.acquire(), timeout=0.2)
            acquired = True
        finally:
            if acquired:
                runtime.lock.release()
            release.set()
        return await task

    assert run(exercise()) == {"captured": True}


@pytest.mark.parametrize(
    "mutate,reason",
    [
        (lambda row: row.pop("book_valid"), "book_valid"),
        (lambda row: row.update(book_valid="true"), "book_valid"),
        (lambda row: row.pop("nonce_contiguous"), "nonce continuity"),
        (lambda row: row.update(quote_age_ms=501), "quote is stale"),
        (lambda row: row.pop("received_at_ms"), "receipt timestamp"),
        (lambda row: row.pop("market_id"), "market_id"),
        (lambda row: row.pop("connection_id"), "connection_id"),
        (lambda row: row.update(stream=None), "readiness metadata"),
        (
            lambda row: row["stream"].update(connected=False),
            "not connected",
        ),
        (
            lambda row: row["stream"].update(subscriptions_ready=False),
            "subscriptions are not ready",
        ),
        (
            lambda row: row["stream"].pop("last_error"),
            "error metadata",
        ),
        (
            lambda row: row["stream"].update(connection_id=8),
            "connection epoch",
        ),
        (
            lambda row: row["stream"]["markets"]["1"].update(nonce=999),
            "stream nonce",
        ),
        (
            lambda row: row["stream"]["markets"]["1"].update(tape_ready=False),
            "tape warmup",
        ),
        (
            lambda row: row["stream"]["markets"]["1"].update(
                tape_connection_id=8
            ),
            "tape does not belong",
        ),
        (
            lambda row: row["stream"]["markets"]["1"].pop(
                "trade_count_buffered"
            ),
            "trade readiness",
        ),
    ],
)
def test_missing_or_invalid_feed_metadata_is_unavailable_and_never_signals(
    tmp_path, mutate, reason
):
    payload = market_snapshot(BASE_TIME)
    mutate(payload)
    runtime = LighterMicroRuntime(
        SnapshotClient([payload]), tmp_path / "state.json"
    )
    configure_for_signals(runtime)

    state = run(runtime.tick(evaluated_at_ms=BASE_TIME))

    assert not state["entry_signals"]
    assert not state["paper_fills"]
    assert not state["paper_trades"]
    assert state["latest_entry_evaluation"]["entry_signal"] is False
    assert state["latest_entry_evaluation"]["feed_ready"] is False
    assert reason in state["latest_entry_evaluation"]["unavailable_reason"]
    assert all(
        detail["status"] in {"UNAVAILABLE", "OFF"}
        for detail in state["entry_conditions"].values()
    )
    assert state["recorder"]["total_snapshots"] == 0
    assert state["recorder"]["invalid_snapshots"] == 1
    assert state["recorder"]["snapshots_in_memory"] == 0
    assert state["paper_safeguards"]["execution_allowed"] is False


def test_structurally_invalid_or_unready_client_payload_clears_current_verdict(tmp_path):
    valid = market_snapshot(BASE_TIME)
    invalid = market_snapshot(BASE_TIME + 100)
    invalid.pop("timestamp_ms")
    invalid.pop("received_at_ms")
    runtime = LighterMicroRuntime(
        SnapshotClient([valid, invalid]), tmp_path / "state.json"
    )
    configure_for_signals(runtime)
    first = run(runtime.tick(evaluated_at_ms=BASE_TIME))
    second = run(runtime.tick(evaluated_at_ms=BASE_TIME + 100))

    assert len(first["entry_signals"]) == 1
    assert second["entry_signals"] == first["entry_signals"]
    assert len(second["paper_fills"]) == 1
    assert second["latest_entry_evaluation"]["entry_signal"] is False
    assert second["latest_entry_evaluation"]["source_timestamp_ms"] is None
    assert second["recorder"]["invalid_snapshots"] == 1


def test_replay_revalidates_epoch_metadata_and_cannot_echo_old_marker(tmp_path):
    runtime = LighterMicroRuntime(
        SnapshotClient([market_snapshot(BASE_TIME)]),
        tmp_path / "state.json",
    )
    configure_for_signals(runtime)
    state = run(runtime.tick(evaluated_at_ms=BASE_TIME))
    assert len(state["entry_signals"]) == 1
    assert len(state["paper_fills"]) == 1

    runtime._snapshot_metadata[0]["stream"]["connection_id"] = 999
    replay = runtime.replay(limit=1)

    assert not replay["entry_signals"]
    assert not replay["paper_fills"]
    assert not replay["paper_trades"]
    assert replay["evaluations"][0]["feed_ready"] is False
    assert (
        replay["evaluations"][0]["entry"]["conditions"]["entry_direction"][
            "status"
        ]
        == "UNAVAILABLE"
    )
    assert "connection epoch" in replay["evaluations"][0]["unavailable_reason"]


def test_snapshot_and_trade_history_are_hard_bounded_for_service_memory(tmp_path):
    snapshots = []
    for offset in range(5):
        payload = market_snapshot(BASE_TIME + offset * 100, trades=False)
        payload["trades"] = [
            {
                "timestamp_ms": payload["timestamp_ms"] - index,
                "price": 100.0,
                "size": 1.0,
                "aggressor_side": "buy" if index % 2 == 0 else "sell",
            }
            for index in range(5)
        ]
        payload["stream"]["markets"]["1"]["trade_count_buffered"] = 5
        snapshots.append(payload)
    runtime = LighterMicroRuntime(
        SnapshotClient(snapshots), tmp_path / "state.json"
    )
    configure_for_signals(
        runtime,
        raw_snapshot_history_limit=3,
        max_trade_prints_per_snapshot=2,
    )
    for offset in range(5):
        run(runtime.tick(evaluated_at_ms=BASE_TIME + offset * 100))

    state = runtime.public_state()
    assert state["recorder"]["snapshots_in_memory"] == 3
    assert state["recorder"]["snapshot_capacity"] == 3
    assert state["recorder"]["max_trade_prints_per_snapshot"] == 2
    assert state["recorder"]["total_trade_prints"] == 10
    assert state["recorder"]["truncated_trade_prints"] == 15
    assert all(len(snapshot.trades) <= 2 for snapshot in runtime._snapshots)
    assert runtime.replay(limit=500)["source"]["snapshot_count"] == 3

    with pytest.raises(ValueError, match="between 2 and 1000"):
        runtime.update_config(
            {"runtime": {"raw_snapshot_history_limit": 1_001}}
        )
    with pytest.raises(ValueError, match="between 1 and 1000"):
        runtime.update_config(
            {"runtime": {"max_trade_prints_per_snapshot": 1_001}}
        )


@pytest.mark.parametrize(
    "update,match",
    [
        ({"entry": {"unknown_alpha": True}}, "unsupported"),
        ({"entry": {"min_depth_imbalance": 1.1}}, "between 0 and 1"),
        ({"exit": {"stop_loss_bps": -1}}, "non-negative"),
        ({"runtime": {"paper_max_slippage_bps": -1}}, "non-negative"),
        ({"runtime": {"symbol": "ETH", "market_id": 0}}, "unsupported symbol"),
        ({"entry": {"use_trade_flow": "false"}}, "must be a boolean"),
        ({"exit": {"take_profit_bps": "7.5"}}, "must be a number"),
    ],
)
def test_all_config_sections_validate_unknown_or_unsafe_values(tmp_path, update, match):
    runtime = LighterMicroRuntime(SnapshotClient([]), tmp_path / "state.json")
    with pytest.raises(ValueError, match=match):
        runtime.update_config(update)
