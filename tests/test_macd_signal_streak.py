import math

from backend.lighter_strategy import (
    evaluate_strategy_signal,
    macd_signal_streak_exhaustion,
    required_strategy_bars,
)


def oscillating_prices(count=180):
    return [100.0 + 3.0 * math.sin(index / 5.0) + 0.01 * index for index in range(count)]


def test_signal_streak_metric_uses_completed_same_sign_history():
    metric = macd_signal_streak_exhaustion(
        oscillating_prices(100), candidate_side=1,
        macd_fast_period=3, macd_slow_period=8, macd_signal_period=3,
        lookback=20, min_samples=3, min_percentile=0,
        min_reversal_probability_pct=0, require_turn=False,
    )
    assert metric["ready"] is True
    assert metric["current_sign"] == 1
    assert metric["direction_ok"] is True
    assert metric["current_streak_length"] == 8
    assert metric["sample_lengths"] == [5, 16, 16]
    assert metric["last_same_sign_streak_length"] == 16
    assert metric["percentile"] == 33.3333
    assert metric["reversal_probability_pct"] == 25.0
    assert metric["pass"] is True

    wrong_direction = macd_signal_streak_exhaustion(
        oscillating_prices(100), candidate_side=-1,
        macd_fast_period=3, macd_slow_period=8, macd_signal_period=3,
        lookback=20, min_samples=3, min_percentile=0,
        min_reversal_probability_pct=0, require_turn=False,
    )
    assert wrong_direction["current_sign"] == 1
    assert wrong_direction["direction_ok"] is False
    assert wrong_direction["pass"] is False

    negative = macd_signal_streak_exhaustion(
        oscillating_prices(120), candidate_side=-1,
        macd_fast_period=3, macd_slow_period=8, macd_signal_period=3,
        lookback=20, min_samples=3, min_percentile=0,
        min_reversal_probability_pct=0, require_turn=False,
    )
    assert negative["current_sign"] == -1
    assert negative["direction_ok"] is True
    assert negative["pass"] is True


def test_optional_streak_condition_is_position_independent_and_can_block_entry():
    prices = oscillating_prices()
    base = {
        "macd_fast_period": 3, "macd_slow_period": 8, "macd_signal_period": 3,
        "use_macd_signal_streak": True, "macd_streak_lookback": 20,
        "macd_streak_min_samples": 3, "macd_streak_min_percentile": 0,
        "macd_streak_min_reversal_prob_pct": 100,
        "macd_streak_require_turn": False,
        "macd_streak_use_timing": True,
    }
    flat = evaluate_strategy_signal("macd_zero_cross", prices, base, position_side=0)
    holding = evaluate_strategy_signal("macd_zero_cross", prices, base, position_side=1)
    assert flat[0] is False
    assert holding[0] is False
    assert flat[1] == holding[1]
    assert flat[3]["macd_signal_streak"] == holding[3]["macd_signal_streak"]
    assert flat[3]["condition_enabled"]["entry_signal_streak_exhaustion"] is True
    assert flat[3]["condition_pass"]["entry_signal_streak_exhaustion"] is False


def test_disabled_streak_is_observable_without_gating_and_increases_history_when_enabled():
    prices = oscillating_prices()
    config = {"macd_fast_period": 3, "macd_slow_period": 8, "macd_signal_period": 3}
    disabled = evaluate_strategy_signal("macd_hist_turn", prices, config)
    assert disabled[3]["condition_enabled"]["entry_signal_streak_exhaustion"] is False
    assert "macd_signal_streak" in disabled[3]
    assert required_strategy_bars("macd_hist_turn", config) == 12
    assert required_strategy_bars("macd_hist_turn", {
        **config, "use_macd_signal_streak": True, "macd_streak_lookback": 20,
    }) == 12
    assert required_strategy_bars("macd_hist_turn", {
        **config, "use_macd_signal_streak": True, "macd_streak_use_timing": True,
        "macd_streak_lookback": 20,
    }) == 251


def test_ma_proximity_exposes_and_applies_the_same_optional_streak_filter():
    prices = [110, 80, 120, 120, 120, 100]
    config = {
        "ma_accel_period": 4, "use_ma_accel": False,
        "use_macd_signal_streak": False,
        "macd_fast_period": 3, "macd_slow_period": 5, "macd_signal_period": 2,
    }
    baseline = evaluate_strategy_signal("ma_proximity", prices, config)
    assert baseline[:2] == (True, 1)
    assert baseline[3]["condition_enabled"]["entry_signal_streak_exhaustion"] is False
    assert "macd_signal_streak" in baseline[3]

    blocked = evaluate_strategy_signal("ma_proximity", prices, {
        **config, "use_macd_signal_streak": True,
        "macd_streak_use_timing": True,
        "macd_streak_min_samples": 3, "macd_streak_min_percentile": 0,
        "macd_streak_min_reversal_prob_pct": 0, "macd_streak_require_turn": False,
    })
    assert blocked[0] is False
    assert blocked[1] == 1
    assert blocked[3]["condition_enabled"]["entry_signal_streak_exhaustion"] is True
    assert required_strategy_bars("ma_proximity", {
        **config, "use_macd_signal_streak": True, "macd_streak_lookback": 20,
    }) == 7
    assert required_strategy_bars("ma_proximity", {
        **config, "use_macd_signal_streak": True, "macd_streak_use_timing": True,
        "macd_streak_lookback": 20,
    }) == 247


def test_ma_proximity_replay_returns_streak_status_from_completed_bars():
    from backend.server import _run_crypto_backtest_sync

    bars = [{"time": (index + 1) * 300, "value": value}
            for index, value in enumerate(oscillating_prices(300))]
    replay = _run_crypto_backtest_sync(
        bars, True, strategy_mode="ma_proximity", use_hourly_hist=False,
        ma_accel_period=4, use_ma_accel=False,
        use_macd_signal_streak=True,
        macd_fast_period=3, macd_slow_period=8, macd_signal_period=3,
        macd_streak_lookback=20, macd_streak_min_samples=3,
        macd_streak_min_percentile=0,
        macd_streak_min_reversal_prob_pct=0,
        macd_streak_require_turn=False,
    )
    evaluation = replay["latest_evaluation"]
    assert evaluation["condition_enabled"]["entry_signal_streak_exhaustion"] is True
    assert evaluation["condition_pass"]["entry_signal_streak_exhaustion"] == evaluation["macd_signal_streak"]["pass"]
    assert evaluation["macd_signal_streak"]["rule"] == "macd_signal_regime_streak_v2"


def test_streak_condition_can_be_the_only_ma_proximity_entry_trigger():
    prices = oscillating_prices()
    entry, side, _, evaluation = evaluate_strategy_signal("ma_proximity", prices, {
        "ma_accel_period": 4,
        "use_ma_slope": False, "use_ma_pullback": False,
        "use_ma_pivot_7": False, "use_ma_pivot_24": False, "use_ma_pivot_60": False,
        "use_ma_price_7": False, "use_ma_price_24": False, "use_ma_price_60": False,
        "use_macd_signal_streak": True,
        "macd_fast_period": 3, "macd_slow_period": 8, "macd_signal_period": 3,
        "macd_streak_lookback": 20, "macd_streak_min_samples": 3,
        "macd_streak_min_percentile": 0,
        "macd_streak_min_reversal_prob_pct": 0,
        "macd_streak_require_turn": False,
    })

    streak = evaluation["macd_signal_streak"]
    assert entry is True
    assert streak["standalone_trigger"] is True
    assert streak["pass"] is True
    assert side == (1 if streak["current_sign"] > 0 else -1)


def test_streak_only_replay_emits_position_independent_chart_signals():
    from backend.server import _run_crypto_backtest_sync

    bars = [{"time": (index + 1) * 300, "value": value}
            for index, value in enumerate(oscillating_prices(300))]
    replay = _run_crypto_backtest_sync(
        bars, True, strategy_mode="ma_proximity", use_hourly_hist=False,
        ma_accel_period=4, use_ma_slope=False, use_ma_pullback=False,
        use_ma_pivot_7=False, use_ma_pivot_24=False, use_ma_pivot_60=False,
        use_ma_price_7=False, use_ma_price_24=False, use_ma_price_60=False,
        use_macd_signal_streak=True,
        macd_fast_period=3, macd_slow_period=8, macd_signal_period=3,
        macd_streak_lookback=20, macd_streak_min_samples=3,
        macd_streak_min_percentile=0,
        macd_streak_min_reversal_prob_pct=0,
        macd_streak_require_turn=False,
    )

    assert replay["entry_signals"]
    assert all(signal["conditions"]["entry_signal_streak_exhaustion"] is True
               for signal in replay["entry_signals"])


def test_streak_only_macd_replay_uses_regime_direction_without_another_trigger():
    from backend.server import _run_crypto_backtest_sync

    bars = [{"time": (index + 1) * 300, "value": value}
            for index, value in enumerate(oscillating_prices(300))]
    replay = _run_crypto_backtest_sync(
        bars, True, strategy_mode="macd_zero_cross", use_hourly_hist=False,
        use_macd_zero_cross=False, use_macd_signal_zone=False,
        use_macd_signal_streak=True,
        macd_fast_period=3, macd_slow_period=8, macd_signal_period=3,
        macd_streak_lookback=20, macd_streak_min_samples=3,
        macd_streak_min_percentile=0,
        macd_streak_min_reversal_prob_pct=0,
        macd_streak_require_turn=False,
    )

    assert replay["entry_signals"]
    assert all(signal["conditions"]["entry_signal_streak_exhaustion"] is True
               for signal in replay["entry_signals"])
    assert replay["latest_evaluation"]["macd_signal_streak"]["standalone_trigger"] is True


def test_ma7_price_side_and_simple_macd_regime_emit_many_entry_signals():
    from backend.server import _run_crypto_backtest_sync

    bars = [{"time": (index + 1) * 300, "value": value}
            for index, value in enumerate(oscillating_prices(300))]
    replay = _run_crypto_backtest_sync(
        bars, True, strategy_mode="ma_proximity", use_hourly_hist=False,
        ma_accel_period=4, use_ma_slope=False, use_ma_pullback=False,
        use_ma_pivot_7=False, use_ma_pivot_24=False, use_ma_pivot_60=False,
        use_ma_price_7=True, use_ma_price_24=False, use_ma_price_60=False,
        use_macd_signal_streak=True, macd_streak_use_timing=False,
        macd_fast_period=3, macd_slow_period=8, macd_signal_period=3,
    )

    assert len(replay["entry_signals"]) > 20
    assert all(signal["conditions"]["entry_ma_price_7"] is True
               and signal["conditions"]["entry_signal_streak_exhaustion"] is True
               for signal in replay["entry_signals"])
    latest = replay["latest_evaluation"]
    assert latest["ma_price_sides"]["7"]["ready"] is True
    assert latest["macd_signal_streak"]["timing_enabled"] is False


def test_streak_timing_remains_a_real_optional_gate():
    prices = oscillating_prices(180)
    common = {
        "ma_accel_period": 4,
        "use_ma_slope": False, "use_ma_pullback": False,
        "use_ma_pivot_7": False, "use_ma_pivot_24": False, "use_ma_pivot_60": False,
        "use_ma_price_7": False, "use_ma_price_24": False, "use_ma_price_60": False,
        "use_macd_signal_streak": True,
        "macd_fast_period": 3, "macd_slow_period": 8, "macd_signal_period": 3,
        "macd_streak_min_samples": 3, "macd_streak_min_percentile": 101,
        "macd_streak_min_reversal_prob_pct": 101, "macd_streak_require_turn": False,
    }
    direction_only = evaluate_strategy_signal(
        "ma_proximity", prices, {**common, "macd_streak_use_timing": False})
    timed = evaluate_strategy_signal(
        "ma_proximity", prices, {**common, "macd_streak_use_timing": True})

    assert direction_only[0] is True
    assert direction_only[3]["macd_signal_streak"]["timing_pass"] is False
    assert timed[0] is False
