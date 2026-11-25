"""API-contract tests for the read-only Lighter order-flow lab."""

import asyncio

import pytest

pytest.importorskip("fastapi")

from backend import server
from backend.lighter_micro_runtime import LighterMicroRuntime


class NoOrderClient:
    async def create_market_order(self, *args, **kwargs):
        raise AssertionError("The microstructure lab must not submit exchange orders")


def test_config_schema_maps_every_control_to_real_runtime_fields(tmp_path, monkeypatch):
    runtime = LighterMicroRuntime(NoOrderClient(), tmp_path / "micro-state.json")
    monkeypatch.setattr(server, "lighter_micro_runtime", runtime)

    schema = server._lighter_micro_config_schema()
    assert schema["strategy_enabled"] is False
    assert schema["strategy_enabled_editable"] is False
    assert schema["live_execution_available"] is False
    assert len(schema["conditions"]) == len(server.LIGHTER_MICRO_CONDITION_SPECS)
    condition_rows = {row["key"]: row for row in schema["conditions"]}
    assert condition_rows["entry_depth_imbalance"]["label"] == "Top 5 depth imbalance"
    assumptions = schema["fixed_assumptions"]
    assert assumptions["editable"] is False
    items = {
        item["key"]: item
        for group in assumptions["groups"]
        for item in group["items"]
    }
    assert items["depth_levels"]["value"] == runtime.entry_config.depth_levels
    assert items["trade_flow_lookback_ms"]["value"] == runtime.entry_config.trade_flow_lookback_ms
    assert items["momentum_lookback_ms"]["value"] == runtime.entry_config.momentum_lookback_ms
    assert items["depth_imbalance_edge_scale_bps"]["value"] == runtime.entry_config.depth_imbalance_edge_scale_bps
    assert items["trade_flow_edge_scale_bps"]["value"] == runtime.entry_config.trade_flow_edge_scale_bps
    assert items["price_momentum_weight"]["value"] == runtime.entry_config.price_momentum_weight
    assert items["taker_fee_bps_per_side"]["value"] == runtime.entry_config.taker_fee_bps_per_side
    assert items["paper_order_notional_usd"]["value"] == runtime.runtime_config.paper_order_notional_usd
    assert items["book_depth"]["value"] == server.LIGHTER_MICRO_SNAPSHOT_DEPTH

    updated = server._lighter_micro_apply_config_payload(
        {
            "strategy_enabled": False,
            "conditions": [
                {"key": "entry_trade_flow", "enabled": False, "threshold": 0.31},
                {"key": "exit_max_holding_time", "enabled": True, "threshold": 7_500},
            ],
        }
    )
    assert runtime.entry_config.use_trade_flow is False
    assert runtime.entry_config.min_trade_flow_imbalance == pytest.approx(0.31)
    assert runtime.exit_config.use_max_holding_time is True
    assert runtime.exit_config.max_holding_ms == 7_500
    by_key = {row["key"]: row for row in updated["conditions"]}
    assert by_key["entry_trade_flow"]["enabled"] is False
    assert by_key["entry_trade_flow"]["threshold"]["value"] == pytest.approx(0.31)
    assert by_key["exit_max_holding_time"]["threshold"]["value"] == 7_500


def test_config_rejects_live_enable_unknown_and_invalid_threshold(tmp_path, monkeypatch):
    runtime = LighterMicroRuntime(NoOrderClient(), tmp_path / "micro-state.json")
    monkeypatch.setattr(server, "lighter_micro_runtime", runtime)

    with pytest.raises(ValueError, match="Live execution is locked"):
        server._lighter_micro_apply_config_payload({"strategy_enabled": True})
    with pytest.raises(ValueError, match="Unsupported condition"):
        server._lighter_micro_apply_config_payload(
            {"conditions": [{"key": "decorative_switch", "enabled": True}]}
        )
    with pytest.raises(ValueError, match="between 0.0 and 1.0"):
        server._lighter_micro_apply_config_payload(
            {"conditions": [{"key": "entry_trade_flow", "threshold": 1.1}]}
        )


def test_account_capacity_uses_all_positions_and_never_fabricates_zero(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    snapshot = {
        "source": "TEST_ACCOUNT_STREAM",
        "updated_at_ms": now_ms,
        "account": {
            "collateral": "100",
            "positions": [
                {"position": "0.01", "mark_price": "100000"},
                {"position": "-2", "position_value": "4000"},
            ],
        },
    }
    monkeypatch.setattr(
        server.lighter_client, "account_telemetry_snapshot", lambda: snapshot
    )
    facts = server._lighter_micro_account_facts()
    assert facts["authenticated"] is True
    assert facts["gross_notional"] == pytest.approx(5_000)
    assert facts["gross_leverage"] == pytest.approx(50)
    assert facts["account_capacity_ok"] is False

    snapshot["account"].pop("collateral")
    missing = server._lighter_micro_account_facts()
    assert missing["authenticated"] is False
    assert missing["collateral"] is None
    assert missing["gross_notional"] is None
    assert missing["gross_leverage"] is None


def test_empty_replay_is_explicitly_prospective_and_keeps_streams_distinct(
    tmp_path, monkeypatch
):
    runtime = LighterMicroRuntime(NoOrderClient(), tmp_path / "micro-state.json")
    monkeypatch.setattr(server, "lighter_micro_runtime", runtime)
    payload = asyncio.run(server.get_lighter_micro_replay(limit=10))

    assert payload["success"] is True
    assert payload["stale"] is True
    assert payload["source"] == "PROSPECTIVE_IN_MEMORY_L2_TRADES"
    assert payload["raw_history_persisted"] is False
    assert payload["entry_signals"] == []
    assert payload["fills"] == []
    assert payload["trades"] == []


def test_direction_is_mandatory_prerequisite_not_optional_condition():
    source = {"name": "TEST", "instrument": "BTC", "timestamp_ms": 1_800_000_000_000}
    raw = {
        "entry_direction": {
            "enabled": True,
            "available": True,
            "pass": True,
            "status": "PASS",
            "source_timestamp_ms": source["timestamp_ms"],
        },
        "entry_max_spread": {
            "enabled": True,
            "available": True,
            "pass": True,
            "status": "PASS",
            "source_timestamp_ms": source["timestamp_ms"],
        },
    }
    optional = server._lighter_micro_decorated_conditions(raw, source)
    mandatory = server._lighter_micro_decorated_prerequisites(raw, source)
    assert "entry_direction" not in optional
    assert "entry_max_spread" in optional
    assert mandatory["entry_direction"]["mandatory"] is True
    assert mandatory["entry_direction"]["editable"] is False
    assert "cannot be disabled" in mandatory["entry_direction"]["requirement"]


def test_status_health_fails_closed_for_disconnected_invalid_or_stale_feed():
    now_ms = 1_800_000_000_000
    state = {
        "config": {"runtime": {"market_id": 1, "max_quote_age_ms": 500}},
        "source": {"timestamp_ms": now_ms - 100},
        "orderbook": {
            "sequence": 22,
            "metadata": {"feed_ready": True, "connection_id": 7},
        },
    }
    fresh = server._lighter_micro_status_health(
        state,
        {"connected": True, "connection_id": 7,
         "markets": {"1": {"book_valid": True, "quote_age_ms": 100, "nonce": 22}}},
        now_ms,
    )
    assert fresh["stale"] is False
    assert fresh["data_valid"] is True

    disconnected = server._lighter_micro_status_health(
        state,
        {"connected": False, "connection_id": 7,
         "markets": {"1": {"book_valid": True, "quote_age_ms": 100, "nonce": 22}}},
        now_ms,
    )
    assert disconnected["stale"] is True
    assert "stream_disconnected" in disconnected["stale_reasons"]

    invalid = server._lighter_micro_status_health(
        state,
        {"connected": True, "connection_id": 7,
         "markets": {"1": {"book_valid": False, "quote_age_ms": 100, "nonce": 22}}},
        now_ms,
    )
    assert invalid["stale"] is True
    assert "book_invalid" in invalid["stale_reasons"]

    evaluation_invalid = server._lighter_micro_status_health(
        {**state, "latest_entry_evaluation": {
            "feed_ready": False,
            "source": {"timestamp_ms": now_ms - 100},
        }},
        {"connected": True, "connection_id": 7, "last_error": "nonce mismatch",
         "markets": {"1": {"book_valid": True, "quote_age_ms": 100, "nonce": 22}}},
        now_ms,
    )
    assert evaluation_invalid["stale"] is True
    assert evaluation_invalid["data_valid"] is False
    assert "stream_error" in evaluation_invalid["stale_reasons"]
    assert "evaluation_invalid" in evaluation_invalid["stale_reasons"]

    stale = server._lighter_micro_status_health(
        state,
        {"connected": True, "connection_id": 7,
         "markets": {"1": {"book_valid": True, "quote_age_ms": 501, "nonce": 22}}},
        now_ms + 501,
    )
    assert stale["stale"] is True
    assert "quote_stale" in stale["stale_reasons"]
    assert "evaluation_stale" in stale["stale_reasons"]


def test_status_route_propagates_disconnected_state_to_live_payload(
    tmp_path, monkeypatch
):
    runtime = LighterMicroRuntime(NoOrderClient(), tmp_path / "micro-state.json")
    monkeypatch.setattr(server, "lighter_micro_runtime", runtime)
    monkeypatch.setattr(
        server.lighter_client,
        "account_telemetry_snapshot",
        lambda: None,
    )
    monkeypatch.setattr(
        server.lighter_client,
        "micro_stream_status",
        lambda market_id: {
            "connected": False,
            "last_error": "socket closed",
            "markets": {str(market_id): {"book_valid": False, "quote_age_ms": None}},
        },
    )
    payload = asyncio.run(server.get_lighter_micro_status())
    assert payload["stale"] is True
    assert payload["data_valid"] is False
    assert payload["live"]["stale"] is True
    assert payload["live"]["connected"] is False
    assert payload["live"]["book_valid"] is False
    assert payload["safeguards_stale"] is True
    assert "stream_disconnected" in payload["stale_reasons"]
    assert "stream_error" in payload["stale_reasons"]


def test_snapshot_depth_is_capped_to_collected_twenty_levels(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    levels = [{"price": 100 + index, "size": 1} for index in range(30)]
    state = {
        "config": {
            "entry": {"depth_levels": 5, "trade_flow_lookback_ms": 1_000,
                      "momentum_lookback_ms": 1_000},
            "runtime": {"max_quote_age_ms": 500},
        },
        "orderbook": {
            "timestamp_ms": now_ms,
            "source": "TEST_STREAM",
            "bids": levels,
            "asks": levels,
            "metadata": {"book_valid": True, "feed_ready": True},
        },
        "latest_entry_evaluation": {"metrics": {}, "source": {"timestamp_ms": now_ms}},
        "entry_conditions": {},
        "exit_conditions": {},
        "source": {"timestamp_ms": now_ms},
        "last_error": None,
    }

    class StubRuntime:
        def public_state(self):
            return state

    monkeypatch.setattr(server, "lighter_micro_runtime", StubRuntime())
    monkeypatch.setattr(
        server.lighter_client,
        "micro_stream_status",
        lambda market_id: {
            "connected": True,
            "markets": {str(market_id): {"book_valid": True, "quote_age_ms": 0}},
        },
    )
    payload = server._lighter_micro_snapshot_payload(100)
    assert payload["depth_limit"] == 20
    assert payload["order_book"]["depth"] == 20
    assert len(payload["order_book"]["bids"]) == 20
    assert len(payload["order_book"]["asks"]) == 20
    assert payload["metric_context"]["depth_levels"] == 5


def test_micro_routes_expose_no_order_or_arm_endpoint():
    paths = {
        route.path
        for route in server.app.routes
        if getattr(route, "path", "").startswith("/api/lighter-micro/")
    }
    assert paths == {
        "/api/lighter-micro/snapshot",
        "/api/lighter-micro/status",
        "/api/lighter-micro/replay",
        "/api/lighter-micro/config",
    }
    assert not any("order" in path or "arm" in path for path in paths)
