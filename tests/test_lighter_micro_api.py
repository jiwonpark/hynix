"""API-contract tests for the read-only Lighter order-flow lab."""

import asyncio

import pytest

pytest.importorskip("fastapi")

from backend import server
from backend.lighter_client import LighterClient
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


def test_account_capacity_never_values_open_exposure_at_entry_price(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    monkeypatch.setattr(
        server.lighter_client,
        "account_telemetry_snapshot",
        lambda: {
            "source": "TEST_ACCOUNT_STREAM",
            "updated_at_ms": now_ms,
            "account": {
                "collateral": "100",
                "positions": [{"position": "0.01", "avg_entry_price": "50000"}],
            },
        },
    )

    facts = server._lighter_micro_account_facts()

    assert facts["gross_notional"] is None
    assert facts["gross_leverage"] is None
    assert facts["account_capacity_ok"] is False


@pytest.mark.parametrize(
    "position",
    [
        {"position": "0", "position_value": "10"},
        {"position": "1", "position_value": "nan"},
        {"position": "1", "mark_price": "-5"},
        {"position": "inf", "position_value": "10"},
    ],
)
def test_account_capacity_rejects_inconsistent_or_nonfinite_exposure(
    position, monkeypatch
):
    now_ms = server.time.time_ns() // 1_000_000
    monkeypatch.setattr(
        server.lighter_client,
        "account_telemetry_snapshot",
        lambda: {
            "source": "TEST_ACCOUNT_STREAM",
            "updated_at_ms": now_ms,
            "account": {"collateral": "100", "positions": [position]},
        },
    )

    facts = server._lighter_micro_account_facts()

    assert facts["gross_notional"] is None
    assert facts["gross_leverage"] is None
    assert facts["account_capacity_ok"] is False


def test_account_capacity_rejects_future_account_timestamp(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    monkeypatch.setattr(
        server.lighter_client,
        "account_telemetry_snapshot",
        lambda: {
            "source": "TEST_ACCOUNT_STREAM",
            "updated_at_ms": now_ms + server.LIGHTER_MAX_FUTURE_SKEW_MS + 60_000,
            "account": {"collateral": "100", "positions": []},
        },
    )

    facts = server._lighter_micro_account_facts()

    assert facts["account_stale"] is True
    assert facts["account_capacity_ok"] is False


def test_legacy_pause_safeguard_never_claims_exchange_inventory(monkeypatch):
    state = {
        "source": {"timestamp_ms": 1_800_000_000_000},
        "live": {"gates": {"gates": {}}},
        "recorder": {},
        "config": {"runtime": {"live_min_recorded_snapshots": 1_000}},
    }
    account = {
        "authenticated": False,
        "gross_leverage": None,
        "account_capacity_ok": False,
    }
    monkeypatch.setattr(
        server.lighter_crypto_bot,
        "state",
        {"enabled": False, "recovery_required": True, "execution_blocked": True},
    )

    safeguards = server._lighter_micro_safeguards(state, account)
    paused = next(row for row in safeguards if row["key"] == "legacy_one_leg_paused")
    assert paused["state"] == "PASS"
    assert "sent no flatten or cancel action" in paused["detail"]
    assert "must be reconciled separately" in paused["detail"]
    assert "remain intact" not in paused["detail"]

    server.lighter_crypto_bot.state["enabled"] = True
    enabled = next(
        row for row in server._lighter_micro_safeguards(state, account)
        if row["key"] == "legacy_one_leg_paused"
    )
    assert enabled["state"] == "BLOCKED"
    assert "still enabled" in enabled["detail"]


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
    public_state_calls = []
    original_public_state = runtime.public_state

    def tracked_public_state(*, include_history=True):
        public_state_calls.append(include_history)
        return original_public_state(include_history=include_history)

    monkeypatch.setattr(runtime, "public_state", tracked_public_state)
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
    assert public_state_calls == [False]


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

    public_state_calls = []

    class StubRuntime:
        def public_state(self, *, include_history=True):
            public_state_calls.append(include_history)
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
    assert public_state_calls == [False]


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


def test_micro_chart_uses_coalesced_latest_read_without_stale_fallback(
    monkeypatch,
):
    calls = []

    async def candles(market_id, resolution, count, end_timestamp=None, **kwargs):
        calls.append({
            "market_id": market_id,
            "resolution": resolution,
            "count": count,
            "end_timestamp": end_timestamp,
            **kwargs,
        })
        return [{
            "t": 1_800_000_000_000,
            "o": "100",
            "h": "101",
            "l": "99",
            "c": "100.5",
            "v": "2",
        }]

    class StubBot:
        def public_state(self):
            return {"execution_history": []}

    monkeypatch.setattr(server.lighter_client, "candles", candles)
    monkeypatch.setattr(server, "lighter_crypto_bot", StubBot())
    monkeypatch.setattr(server, "_lighter_micro_chart_cache", server.ChartResponseCache())
    monkeypatch.setattr(server, "_lighter_crypto_chart_cache", server.ChartResponseCache())

    micro = asyncio.run(
        server.get_lighter_crypto_candles("BTC", "1m", server.LIGHTER_MICRO_CHART_LIMIT)
    )
    regular = asyncio.run(server.get_lighter_crypto_candles("BTC", "1m", 181))

    assert micro["success"] is True
    assert micro["stale"] is False
    assert regular["success"] is True
    assert regular["stale"] is False
    assert calls[0]["count"] == 180
    assert calls[0]["fresh"] is False
    assert calls[0]["allow_stale"] is False
    assert calls[1]["count"] == 181
    assert calls[1]["fresh"] is False
    assert calls[1]["allow_stale"] is False


def test_micro_and_regular_latest_charts_share_one_upstream_candle_read(monkeypatch):
    client = LighterClient()
    upstream_calls = []
    upstream_started = asyncio.Event()
    release_upstream = asyncio.Event()
    rows = [{
        "t": 1_800_000_000_000 + index * 60_000,
        "o": str(100 + index),
        "h": str(101 + index),
        "l": str(99 + index),
        "c": str(100.5 + index),
        "v": "2",
    } for index in range(500)]

    async def request(endpoint, params=None, headers=None):
        upstream_calls.append((endpoint, dict(params or {})))
        upstream_started.set()
        await release_upstream.wait()
        return {"c": rows}

    class StubBot:
        def public_state(self):
            return {"execution_history": []}

    client.request = request
    monkeypatch.setattr(server, "lighter_client", client)
    monkeypatch.setattr(server, "lighter_crypto_bot", StubBot())
    monkeypatch.setattr(server, "_lighter_micro_chart_cache", server.ChartResponseCache())
    monkeypatch.setattr(server, "_lighter_crypto_chart_cache", server.ChartResponseCache())

    async def run():
        micro_task = asyncio.create_task(
            server.get_lighter_crypto_candles(
                "BTC", "1m", server.LIGHTER_MICRO_CHART_LIMIT
            )
        )
        await upstream_started.wait()
        regular_task = asyncio.create_task(
            server.get_lighter_crypto_candles("BTC", "1m", 500)
        )
        await asyncio.sleep(0)
        release_upstream.set()
        return await asyncio.gather(micro_task, regular_task)

    micro, regular = asyncio.run(run())

    assert len(upstream_calls) == 1
    assert upstream_calls[0][0] == "/api/v1/candles"
    assert upstream_calls[0][1]["count_back"] == 500
    assert len(micro["bars"]) == server.LIGHTER_MICRO_CHART_LIMIT
    assert len(regular["bars"]) == 500
    assert micro["bars"] == regular["bars"][-server.LIGHTER_MICRO_CHART_LIMIT:]
    assert micro["stale"] is False
    assert regular["stale"] is False


def test_micro_chart_cold_timeout_returns_explicit_error_not_stale_data(monkeypatch):
    async def slow_candles(*args, **kwargs):
        await asyncio.sleep(0.05)
        return []

    monkeypatch.setattr(server.lighter_client, "candles", slow_candles)
    monkeypatch.setattr(
        server,
        "_lighter_micro_chart_cache",
        server.ChartResponseCache(timeout=0.001),
    )

    payload = asyncio.run(
        server.get_lighter_crypto_candles("BTC", "1m", server.LIGHTER_MICRO_CHART_LIMIT)
    )

    assert payload["success"] is False
    assert payload["bars"] == []
    assert payload["markers"] == []
    assert payload.get("stale") is not False
    assert payload["error"]


@pytest.mark.parametrize(
    ("age_ms", "expected_stale", "expected_refreshes"),
    ((5_000, False, 0), (11_000, False, 1), (16_000, True, 1)),
)
def test_account_refreshes_before_stale_boundary_and_preserves_truthful_age(
    age_ms, expected_stale, expected_refreshes, monkeypatch
):
    now_ms = server.time.time_ns() // 1_000_000
    snapshot = {
        "source": "TEST_ACCOUNT_STREAM",
        "updated_at_ms": now_ms - age_ms,
        "positions_updated_ms": now_ms - age_ms,
        "collateral_updated_ms": now_ms - age_ms,
        "account": {
            "collateral": "100",
            "available_balance": "80",
            "positions": [],
        },
    }
    refreshes = []

    async def refresh():
        refreshes.append(True)

    class StubBot:
        GROSS_LEVERAGE_CAP = 8.0
        state = {
            "last_evaluation": {},
            "last_error": None,
            "recovery_required": False,
        }

        def public_state(self):
            return {"execution_history": []}

    monkeypatch.setattr(
        server.lighter_client, "account_telemetry_snapshot", lambda: snapshot
    )
    monkeypatch.setattr(
        server.lighter_client,
        "market_detail_snapshot",
        lambda market_id: {"status": "active", "mark_price": "100"},
    )
    monkeypatch.setattr(server, "lighter_crypto_bot", StubBot())
    monkeypatch.setattr(server, "_refresh_lighter_account_cache", refresh)
    monkeypatch.setattr(server, "_lighter_account_refresh_task", None)

    async def read_status():
        payload = await server.get_lighter_crypto_status("BTC")
        task = server._lighter_account_refresh_task
        if task is not None:
            await task
        return payload

    payload = asyncio.run(read_status())

    assert payload["success"] is True
    assert payload["authenticated"] is True
    assert payload["account_stale"] is expected_stale
    assert payload["account_age_ms"] >= age_ms
    assert len(refreshes) == expected_refreshes


def test_account_mark_uses_fresh_book_not_paused_bot_evaluation(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    snapshot = {
        "source": "TEST_ACCOUNT_STREAM",
        "updated_at_ms": now_ms,
        "positions_updated_ms": now_ms,
        "collateral_updated_ms": now_ms,
        "account": {
            "collateral": "104.25",
            "available_balance": "104.25",
            "positions": [{"market_id": 1, "position": "0", "position_value": "0"}],
        },
    }

    class StubBot:
        GROSS_LEVERAGE_CAP = 8.0
        state = {
            "last_evaluation": {"ratio": 68_681.7},
            "last_error": None,
            "recovery_required": True,
        }

        def public_state(self):
            return {"enabled": False, "recovery_required": True}

    monkeypatch.setattr(
        server.lighter_client, "account_telemetry_snapshot", lambda: snapshot
    )
    monkeypatch.setattr(
        server.lighter_client,
        "market_detail_snapshot",
        lambda market_id: {"status": "active", "mark_price": "68681.7"},
    )
    monkeypatch.setattr(
        server,
        "_lighter_crypto_live_mark",
        lambda market_id: {
            "mark_price": 58_808.2,
            "source": "TEST_VALIDATED_L2",
            "timestamp_ms": now_ms,
            "stale": False,
        },
    )
    monkeypatch.setattr(server, "lighter_crypto_bot", StubBot())

    payload = asyncio.run(server.get_lighter_crypto_status("BTC"))

    assert payload["mark_price"] == pytest.approx(58_808.2)
    assert payload["price_ratio"] == pytest.approx(58_808.2)
    assert payload["mark_source"] == "TEST_VALIDATED_L2"
    assert payload["mark_updated_ms"] == now_ms
    assert payload["mark_stale"] is False
    assert payload["positions"] == []
    assert payload["execution_enabled"] is False


def test_account_mark_fails_closed_when_validated_book_is_stale(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    monkeypatch.setattr(
        server.lighter_client,
        "account_telemetry_snapshot",
        lambda: {
            "source": "TEST_ACCOUNT_STREAM",
            "updated_at_ms": now_ms,
            "account": {"collateral": "100", "positions": []},
        },
    )
    monkeypatch.setattr(
        server.lighter_client,
        "market_detail_snapshot",
        lambda market_id: {"status": "active", "mark_price": "68681.7"},
    )
    monkeypatch.setattr(
        server,
        "_lighter_crypto_live_mark",
        lambda market_id: {
            "mark_price": None,
            "source": None,
            "timestamp_ms": None,
            "stale": True,
        },
    )

    class StubBot:
        state = {"last_error": None, "recovery_required": False}

        def public_state(self):
            return {"enabled": False}

    monkeypatch.setattr(server, "lighter_crypto_bot", StubBot())

    payload = asyncio.run(server.get_lighter_crypto_status("BTC"))

    assert payload["mark_price"] is None
    assert payload["price_ratio"] is None
    assert payload["mark_source"] is None
    assert payload["mark_updated_ms"] is None
    assert payload["mark_stale"] is True
    assert payload["execution_enabled"] is False


def _validated_mark_state(now_ms, *, connection_id=7, nonce=22):
    return {
        "config": {"runtime": {"market_id": 1, "max_quote_age_ms": 500}},
        "source": {"timestamp_ms": now_ms},
        "latest_entry_evaluation": {
            "feed_ready": True,
            "source": {"timestamp_ms": now_ms},
        },
        "orderbook": {
            "source": "TEST_VALIDATED_L2",
            "timestamp_ms": now_ms,
            "sequence": nonce,
            "bids": [{"price": 58_807.2, "size": 1}],
            "asks": [{"price": 58_809.2, "size": 1}],
            "metadata": {
                "market_id": 1,
                "feed_ready": True,
                "connection_id": connection_id,
            },
        },
    }


def _validated_mark_stream(*, connection_id=7, nonce=22):
    return {
        "connected": True,
        "connection_id": connection_id,
        "last_error": None,
        "markets": {
            "1": {"book_valid": True, "quote_age_ms": 0, "nonce": nonce},
        },
    }


def test_live_mark_requires_matching_market_connection_epoch_and_nonce(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    state = _validated_mark_state(now_ms)
    stream = _validated_mark_stream()
    monkeypatch.setattr(
        server.lighter_micro_runtime, "public_state", lambda **kwargs: state
    )
    monkeypatch.setattr(
        server.lighter_client, "micro_stream_status", lambda market_id: stream
    )

    fresh = server._lighter_crypto_live_mark(1)
    assert fresh == {
        "mark_price": pytest.approx(58_808.2),
        "source": "TEST_VALIDATED_L2",
        "timestamp_ms": now_ms,
        "stale": False,
    }

    state["orderbook"]["sequence"] = 21
    assert server._lighter_crypto_live_mark(1)["mark_price"] is None
    state["orderbook"]["sequence"] = 22
    state["orderbook"]["metadata"]["connection_id"] = 6
    assert server._lighter_crypto_live_mark(1)["mark_price"] is None


def test_live_mark_rejects_future_source_timestamp(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    future_ms = now_ms + server.LIGHTER_MAX_FUTURE_SKEW_MS + 60_000
    monkeypatch.setattr(
        server.lighter_micro_runtime,
        "public_state",
        lambda **kwargs: _validated_mark_state(future_ms),
    )
    monkeypatch.setattr(
        server.lighter_client,
        "micro_stream_status",
        lambda market_id: _validated_mark_stream(),
    )

    mark = server._lighter_crypto_live_mark(1)

    assert mark["mark_price"] is None
    assert mark["stale"] is True


def test_live_mark_never_reuses_btc_book_for_another_symbol(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    calls = []
    monkeypatch.setattr(
        server.lighter_micro_runtime,
        "public_state",
        lambda **kwargs: _validated_mark_state(now_ms),
    )
    monkeypatch.setattr(
        server.lighter_client,
        "micro_stream_status",
        lambda market_id: calls.append(market_id),
    )

    unavailable = server._lighter_crypto_live_mark(0)
    assert unavailable["mark_price"] is None
    assert unavailable["stale"] is True
    assert calls == []


def test_non_btc_and_missing_position_valuation_fail_closed(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    monkeypatch.setattr(
        server.lighter_client,
        "account_telemetry_snapshot",
        lambda: {
            "source": "TEST_ACCOUNT_STREAM",
            "updated_at_ms": now_ms,
            "account": {
                "collateral": "100",
                "available_balance": "90",
                "positions": [{
                    "market_id": 0,
                    "position": "0.5",
                    "avg_entry_price": "2500",
                }],
            },
        },
    )
    monkeypatch.setattr(
        server.lighter_client,
        "market_detail_snapshot",
        lambda market_id: {"status": "active", "mark_price": "2600"},
    )
    monkeypatch.setattr(
        server,
        "_lighter_crypto_live_mark",
        lambda market_id: {
            "mark_price": None, "source": None, "timestamp_ms": None, "stale": True,
        },
    )

    class StubBot:
        GROSS_LEVERAGE_CAP = 8.0
        state = {"last_error": None, "recovery_required": False}

        def public_state(self):
            return {"enabled": False}

    monkeypatch.setattr(server, "lighter_crypto_bot", StubBot())
    payload = asyncio.run(server.get_lighter_crypto_status("ETH"))

    assert payload["mark_price"] is None
    assert payload["mark_stale"] is True
    assert payload["execution_enabled"] is False
    assert payload["account_gross_notional"] is None
    assert payload["selected_gross_notional"] is None
    assert payload["positions"] == [{
        "symbol": "ETH",
        "market_id": 0,
        "position_amt": 0.5,
        "size": 0.5,
        "notional": None,
        "entry_price": 2500.0,
        "mark_price": None,
        "unrealized_pnl": None,
        "initial_margin": None,
        "roe_percent": None,
    }]


def test_zero_size_nonzero_value_is_inconsistent_not_a_position(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    monkeypatch.setattr(
        server.lighter_client,
        "account_telemetry_snapshot",
        lambda: {
            "source": "TEST_ACCOUNT_STREAM",
            "updated_at_ms": now_ms,
            "account": {
                "collateral": "100",
                "positions": [{
                    "market_id": 1, "position": "0", "position_value": "123",
                }],
            },
        },
    )
    monkeypatch.setattr(
        server.lighter_client,
        "market_detail_snapshot",
        lambda market_id: {"status": "active"},
    )
    monkeypatch.setattr(
        server,
        "_lighter_crypto_live_mark",
        lambda market_id: {
            "mark_price": 58_808.2,
            "source": "TEST_VALIDATED_L2",
            "timestamp_ms": now_ms,
            "stale": False,
        },
    )

    class StubBot:
        GROSS_LEVERAGE_CAP = 8.0
        state = {"last_error": None, "recovery_required": False}

        def public_state(self):
            return {"enabled": False}

    monkeypatch.setattr(server, "lighter_crypto_bot", StubBot())
    payload = asyncio.run(server.get_lighter_crypto_status("BTC"))

    assert payload["positions"] == []
    assert payload["account_gross_notional"] is None
    assert payload["selected_gross_notional"] is None


@pytest.mark.parametrize(
    "position",
    [
        {"market_id": 1, "position": "nan", "position_value": "100"},
        {"market_id": 1, "position": "1", "position_value": "nan"},
        {"market_id": 1, "position": "1", "position_value": "-100"},
        {"market_id": 1, "position": "1", "mark_price": "-1"},
    ],
)
def test_malformed_position_numbers_never_become_fresh_zero(position, monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    monkeypatch.setattr(
        server.lighter_client,
        "account_telemetry_snapshot",
        lambda: {
            "source": "TEST_ACCOUNT_STREAM",
            "updated_at_ms": now_ms,
            "account": {"collateral": "100", "positions": [position]},
        },
    )
    monkeypatch.setattr(
        server.lighter_client,
        "market_detail_snapshot",
        lambda market_id: {"status": "active"},
    )
    monkeypatch.setattr(
        server,
        "_lighter_crypto_live_mark",
        lambda market_id: {
            "mark_price": None, "source": None, "timestamp_ms": None, "stale": True,
        },
    )

    class StubBot:
        GROSS_LEVERAGE_CAP = 8.0
        state = {"last_error": None, "recovery_required": False}

        def public_state(self):
            return {"enabled": False}

    monkeypatch.setattr(server, "lighter_crypto_bot", StubBot())
    payload = asyncio.run(server.get_lighter_crypto_status("BTC"))

    assert payload["execution_enabled"] is False
    assert payload["account_gross_notional"] is None
    assert payload["selected_gross_notional"] is None
    if payload["positions"]:
        assert payload["positions"][0]["notional"] is None
        assert payload["positions"][0]["initial_margin"] is None
        assert payload["positions"][0]["roe_percent"] is None


def test_future_account_timestamp_is_stale_and_cannot_enable_execution(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    future_ms = now_ms + server.LIGHTER_MAX_FUTURE_SKEW_MS + 60_000
    monkeypatch.setattr(
        server.lighter_client,
        "account_telemetry_snapshot",
        lambda: {
            "source": "TEST_ACCOUNT_STREAM",
            "updated_at_ms": future_ms,
            "account": {"collateral": "100", "positions": []},
        },
    )
    monkeypatch.setattr(
        server.lighter_client,
        "market_detail_snapshot",
        lambda market_id: {"status": "active"},
    )
    monkeypatch.setattr(
        server,
        "_lighter_crypto_live_mark",
        lambda market_id: {
            "mark_price": 58_808.2,
            "source": "TEST_VALIDATED_L2",
            "timestamp_ms": now_ms,
            "stale": False,
        },
    )

    class StubBot:
        state = {"last_error": None, "recovery_required": False}

        def public_state(self):
            return {"enabled": False}

    monkeypatch.setattr(server, "lighter_crypto_bot", StubBot())
    async def refresh():
        return None

    monkeypatch.setattr(server, "_refresh_lighter_account_cache", refresh)
    monkeypatch.setattr(server, "_lighter_account_refresh_task", None)
    payload = asyncio.run(server.get_lighter_crypto_status("BTC"))

    assert payload["account_stale"] is True
    assert payload["execution_enabled"] is False


def test_invalid_sign_fails_position_and_gross_aggregates_closed(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    monkeypatch.setattr(
        server.lighter_client,
        "account_telemetry_snapshot",
        lambda: {
            "source": "TEST_ACCOUNT_STREAM",
            "updated_at_ms": now_ms,
            "account": {
                "collateral": "100",
                "available_balance": "90",
                "positions": [{
                    "market_id": 1,
                    "position": "1",
                    "sign": "0.5",
                    "position_value": "100",
                    "allocated_margin": "10",
                }],
            },
        },
    )
    monkeypatch.setattr(
        server.lighter_client, "market_detail_snapshot", lambda market_id: {"status": "active"}
    )
    monkeypatch.setattr(
        server,
        "_lighter_crypto_live_mark",
        lambda market_id: {
            "mark_price": 100.0,
            "source": "TEST_VALIDATED_L2",
            "timestamp_ms": now_ms,
            "stale": False,
        },
    )

    class StubBot:
        state = {"last_error": None, "recovery_required": False}

        def public_state(self):
            return {"enabled": False}

    monkeypatch.setattr(server, "lighter_crypto_bot", StubBot())
    payload = asyncio.run(server.get_lighter_crypto_status("BTC"))

    assert payload["positions"] == []
    assert payload["account_gross_notional"] is None
    assert payload["selected_gross_notional"] is None


def test_missing_exchange_margin_never_fabricates_available_or_roe(monkeypatch):
    now_ms = server.time.time_ns() // 1_000_000
    monkeypatch.setattr(
        server.lighter_client,
        "account_telemetry_snapshot",
        lambda: {
            "source": "TEST_ACCOUNT_STREAM",
            "updated_at_ms": now_ms,
            "account": {
                "collateral": "100",
                "positions": [{
                    "market_id": 1,
                    "position": "1",
                    "position_value": "100",
                    "unrealized_pnl": "1",
                }],
            },
        },
    )
    monkeypatch.setattr(
        server.lighter_client, "market_detail_snapshot", lambda market_id: {"status": "active"}
    )
    monkeypatch.setattr(
        server,
        "_lighter_crypto_live_mark",
        lambda market_id: {
            "mark_price": 100.0,
            "source": "TEST_VALIDATED_L2",
            "timestamp_ms": now_ms,
            "stale": False,
        },
    )

    class StubBot:
        state = {"last_error": None, "recovery_required": False}

        def public_state(self):
            return {"enabled": False}

    monkeypatch.setattr(server, "lighter_crypto_bot", StubBot())
    payload = asyncio.run(server.get_lighter_crypto_status("BTC"))

    assert payload["available_margin"] is None
    assert payload["account_gross_notional"] == pytest.approx(100)
    assert payload["selected_gross_notional"] == pytest.approx(100)
    assert payload["positions"][0]["initial_margin"] is None
    assert payload["positions"][0]["roe_percent"] is None
