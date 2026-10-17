from pathlib import Path
import tempfile
from unittest.mock import MagicMock
import pytest
from backend.lighter_strategy import (
    evaluate_ma_acceleration_signals,
    evaluate_strategy_signal,
    LIVE_STRATEGIES,
)
from backend.crypto_bot import CryptoBot
from backend.lighter_crypto_bot import LighterCryptoBot


def test_ma_acceleration_live_strategies_registration():
    assert "ma_acceleration" in LIVE_STRATEGIES


def test_ma_acceleration_long_entry_and_exit():
    # Long Setup:
    # 5m MA rising (slope > 0), accelerating (accel > 0), and price below MA (pullback).
    # prices: [70.0, 50.0, 100.0, 100.0, 100.0, 95.0]
    # For w = 4:
    # ma_prev2 = (70 + 50 + 100 + 100) / 4 = 80.0
    # ma_prev = (50 + 100 + 100 + 100) / 4 = 87.5 => slope_prev = +7.5
    # ma_curr = (100 + 100 + 100 + 95) / 4 = 98.75 => slope_curr = +11.25 > 0 (rising)
    # accel = slope_curr - slope_prev = 11.25 - 7.5 = +3.75 > 0 (accelerating)
    # price = 95.0 < 98.75 (pullback below MA)
    test_prices = [70.0, 50.0, 100.0, 100.0, 100.0, 95.0]
    entry, side, exit_sig, details = evaluate_ma_acceleration_signals(
        test_prices,
        ma_accel_period=4,
        ma_accel_min_slope=0.0,
        ma_accel_min_accel=0.0,
        use_ma_slope=True,
        use_ma_accel=True,
        use_ma_pullback=True,
        use_ma_cross_exit=True,
        use_ma_stack_1h=False,
    )
    assert entry is True
    assert side == 1
    assert details["slope"] == 11.25
    assert details["acceleration"] == 3.75
    assert details["price_vs_ma"] == -3.75
    assert details["condition_pass"]["entry_ma_slope"] is True
    assert details["condition_pass"]["entry_ma_accel"] is True
    assert details["condition_pass"]["entry_ma_pullback"] is True

    # Test long exit when price recovers and crosses above or touches MA:
    # Price recovers to 102.0 (>= ma_curr):
    exit_test_prices = [70.0, 50.0, 100.0, 100.0, 100.0, 102.0]
    _, _, exit_sig_hit, details_exit = evaluate_ma_acceleration_signals(
        exit_test_prices,
        ma_accel_period=4,
        position_side=1,
        entry_price=95.0,
        use_ma_cross_exit=True,
        use_ma_stack_1h=False,
    )
    assert exit_sig_hit is True
    assert details_exit["condition_pass"]["exit_ma_cross"] is True


def test_ma_acceleration_short_entry_and_exit():
    # Short Setup:
    # 5m MA falling (slope < 0), decelerating (accel < 0), and price above MA (bounce into MA).
    # prices: [130.0, 150.0, 100.0, 100.0, 100.0, 105.0]
    # For w = 4:
    # ma_prev2 = (130 + 150 + 100 + 100) / 4 = 120.0
    # ma_prev = (150 + 100 + 100 + 100) / 4 = 112.5 => slope_prev = -7.5
    # ma_curr = (100 + 100 + 100 + 105) / 4 = 101.25 => slope_curr = -11.25 < 0 (falling)
    # accel = slope_curr - slope_prev = -11.25 - (-7.5) = -3.75 < 0 (decelerating)
    # price = 105.0 > 101.25 (bounce above MA)
    test_prices = [130.0, 150.0, 100.0, 100.0, 100.0, 105.0]
    entry, side, exit_sig, details = evaluate_ma_acceleration_signals(
        test_prices,
        ma_accel_period=4,
        ma_accel_min_slope=0.0,
        ma_accel_min_accel=0.0,
        use_ma_slope=True,
        use_ma_accel=True,
        use_ma_pullback=True,
        use_ma_cross_exit=True,
        use_ma_stack_1h=False,
    )
    assert entry is True
    assert side == -1
    assert details["slope"] == -11.25
    assert details["acceleration"] == -3.75
    assert details["price_vs_ma"] == 3.75
    assert details["condition_pass"]["entry_ma_slope"] is True
    assert details["condition_pass"]["entry_ma_accel"] is True
    assert details["condition_pass"]["entry_ma_pullback"] is True

    # Test short exit when price crosses or drops below MA:
    # Price drops to 98.0 (<= ma_curr):
    exit_test_prices = [130.0, 150.0, 100.0, 100.0, 100.0, 98.0]
    _, _, exit_sig_hit, details_exit = evaluate_ma_acceleration_signals(
        exit_test_prices,
        ma_accel_period=4,
        position_side=-1,
        entry_price=105.0,
        use_ma_cross_exit=True,
        use_ma_stack_1h=False,
    )
    assert exit_sig_hit is True
    assert details_exit["condition_pass"]["exit_ma_cross"] is True


def test_ma_acceleration_toggles():
    # If price is at 100.0 (not dipped below ma_curr 100.0), pullback requirement is not met:
    test_prices = [70.0, 50.0, 100.0, 100.0, 100.0, 100.0]
    entry_disabled, _, _, _ = evaluate_ma_acceleration_signals(
        test_prices,
        ma_accel_period=4,
        use_ma_pullback=True,
        use_ma_stack_1h=False,
    )
    assert entry_disabled is False

    # Disabling pullback requirement allows the entry:
    entry_enabled, side, _, _ = evaluate_ma_acceleration_signals(
        test_prices,
        ma_accel_period=4,
        use_ma_pullback=False,
        use_ma_stack_1h=False,
    )
    assert entry_enabled is True
    assert side == 1


def test_evaluate_strategy_signal_dispatch():
    config = {
        "ma_accel_period": 4,
        "ma_accel_min_slope": 0.0,
        "ma_accel_min_accel": 0.0,
        "use_ma_slope": True,
        "use_ma_accel": True,
        "use_ma_pullback": True,
        "use_ma_cross_exit": True,
        "use_ma_stack_1h": False,
    }
    test_prices = [70.0, 50.0, 100.0, 100.0, 100.0, 95.0]
    entry, side, exit_sig, details = evaluate_strategy_signal("ma_acceleration", test_prices, config)
    assert entry is True
    assert side == 1
    assert details["strategy"] == "ma_acceleration"


@pytest.mark.asyncio
async def test_crypto_bots_ma_acceleration_state_and_config():
    with tempfile.NamedTemporaryFile() as tmp4, tempfile.NamedTemporaryFile() as tmp5:
        client4 = MagicMock()
        bot4 = CryptoBot(client4, Path(tmp4.name))
        state4 = bot4.public_state()
        assert state4["ma_accel_period"] == 24
        assert state4["use_ma_slope"] is True
        assert state4["use_ma_accel"] is True
        assert state4["use_ma_pullback"] is True
        assert state4["use_ma_cross_exit"] is True

        cfg4 = await bot4.configure({
            "strategy_mode": "ma_acceleration",
            "ma_accel_period": 30,
            "ma_accel_min_slope": 0.005,
            "ma_accel_min_accel": 0.001,
            "use_ma_pullback": False,
        })
        assert cfg4["strategy_mode"] == "ma_acceleration"
        assert cfg4["ma_accel_period"] == 30
        assert cfg4["ma_accel_min_slope"] == 0.005
        assert cfg4["ma_accel_min_accel"] == 0.001
        assert cfg4["use_ma_pullback"] is False

        client5 = MagicMock()
        bot5 = LighterCryptoBot(client5, Path(tmp5.name))
        state5 = bot5.public_state()
        assert state5["ma_accel_period"] == 24
        assert state5["use_ma_slope"] is True

        cfg5 = await bot5.configure({
            "strategy_mode": "ma_acceleration",
            "ma_accel_period": 18,
            "ma_accel_min_slope": 0.002,
            "use_ma_accel": False,
        })
        assert cfg5["strategy_mode"] == "ma_acceleration"
        assert cfg5["ma_accel_period"] == 18
        assert cfg5["ma_accel_min_slope"] == 0.002
        assert cfg5["use_ma_accel"] is False
