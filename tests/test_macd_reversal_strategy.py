import asyncio
import math
import tempfile
from pathlib import Path

from backend.crypto_bot import CryptoBot
from backend.lighter_crypto_bot import LighterCryptoBot
from backend.lighter_strategy import (
    LIVE_STRATEGIES,
    evaluate_macd_reversal_signals,
    evaluate_macd_strength_scaleout_signals,
    evaluate_strategy_signal,
    macd_histogram_acceleration_regime_series,
    required_strategy_bars,
)


def prices(phase: float) -> list[float]:
    return [100 + 0.03 * index + 4 * math.sin(index / 7 + phase) for index in range(120)]


def test_macd_reversal_entry_and_exact_opposite_exit():
    entry, side, exit_signal, entry_details = evaluate_macd_reversal_signals(prices(5.9))
    assert entry is True
    assert side == 1
    assert exit_signal is False
    assert entry_details["condition_pass"] == {
        "entry_signal_zone": True,
        "entry_histogram_zone": True,
        "entry_histogram_reversal": True,
        "entry_ma_stack_1h": False,
        "exit_signal_zone": None,
        "exit_histogram_zone": None,
        "exit_histogram_reversal": None,
    }

    _, _, exit_signal, exit_details = evaluate_macd_reversal_signals(prices(2.7), position_side=1)
    assert exit_signal is True
    assert exit_details["condition_pass"]["exit_signal_zone"] is True
    assert exit_details["condition_pass"]["exit_histogram_zone"] is True
    assert exit_details["condition_pass"]["exit_histogram_reversal"] is True


def test_macd_reversal_has_symmetric_short_entry_and_directional_macro_gate():
    short_entry, side, _, details = evaluate_macd_reversal_signals(
        prices(2.7), use_ma_stack_1h=True, macro_alignment=(True, True))
    assert short_entry is True
    assert side == -1
    assert details["condition_pass"]["entry_signal_zone"] is True
    assert details["condition_pass"]["entry_histogram_zone"] is True
    assert details["condition_pass"]["entry_histogram_reversal"] is True

    blocked_long, long_side, _, blocked_details = evaluate_macd_reversal_signals(
        prices(5.9), use_ma_stack_1h=True, macro_alignment=(False, True))
    assert long_side == 1
    assert blocked_long is False
    assert blocked_details["condition_pass"]["entry_ma_stack_1h"] is False

    allowed_short, short_side, _, _ = evaluate_macd_reversal_signals(
        prices(2.7), use_ma_stack_1h=True, macro_alignment=(False, True))
    assert short_side == -1
    assert allowed_short is True


def test_macd_reversal_switches_are_real_and_empty_sets_do_not_fire():
    entry, _, _, _ = evaluate_macd_reversal_signals(
        prices(5.9), use_macd_signal_negative=False,
        use_macd_hist_negative=False, use_macd_hist_reversal=False,
    )
    assert entry is False
    _, _, exit_signal, _ = evaluate_macd_reversal_signals(
        prices(2.7), position_side=1, use_macd_signal_positive=False,
        use_macd_hist_positive=False, use_macd_hist_reversal_exit=False,
    )
    assert exit_signal is False


def test_macd_reversal_registered_and_dispatched():
    assert "macd_reversal" in LIVE_STRATEGIES
    assert required_strategy_bars("macd_reversal", {}) == 36
    entry, side, _, details = evaluate_strategy_signal(
        "macd_reversal", prices(5.9), {"use_ma_stack_1h": False})
    assert entry is True
    assert side == 1
    assert details["strategy"] == "macd_reversal"


def test_macd_entry_evaluation_is_independent_of_inventory():
    flat_entry, _, _, _ = evaluate_macd_reversal_signals(prices(5.9), position_side=0)
    held_entry, _, _, _ = evaluate_macd_reversal_signals(prices(5.9), position_side=1)
    assert flat_entry is True
    assert held_entry is True


def test_strength_scaleout_entry_filter_is_real_and_inventory_independent():
    weak, _, _, weak_details = evaluate_macd_strength_scaleout_signals(
        prices(5.9), macd_strength_min_pct=1000, position_side=0)
    bypassed, _, _, _ = evaluate_macd_strength_scaleout_signals(
        prices(5.9), macd_strength_min_pct=1000, use_macd_strength=False, position_side=1)
    assert weak is False
    assert weak_details["condition_pass"]["entry_strength"] is False
    assert bypassed is True
    assert "macd_strength_scaleout" in LIVE_STRATEGIES
    assert required_strategy_bars("macd_strength_scaleout", {}) == 36


def test_strength_scaleout_configuration_persists():
    async def run():
        with tempfile.TemporaryDirectory() as directory:
            bot = LighterCryptoBot(object(), Path(directory) / "state.json")
            state = await bot.configure({
                "strategy_mode": "macd_strength_scaleout",
                "macd_strength_min_pct": 35,
                "macd_first_exit_pct": 40,
                "use_macd_two_stage_exit": True,
            })
            assert state["strategy_params"]["macd_strength_min_pct"] == 35
            assert state["strategy_params"]["macd_first_exit_pct"] == 40
    asyncio.run(run())


def test_bots_accept_and_persist_macd_configuration():
    async def run():
        values = {
            "strategy_mode": "macd_reversal", "macd_fast_period": 10,
            "macd_slow_period": 30, "macd_signal_period": 8,
            "use_macd_hist_reversal": False,
        }
        with tempfile.TemporaryDirectory() as directory:
            for bot_type in (CryptoBot, LighterCryptoBot):
                bot = bot_type(object(), Path(directory) / f"{bot_type.__name__}.json")
                state = await bot.configure(values)
                assert state["strategy_mode"] == "macd_reversal"
                assert state["strategy_params"]["macd_fast_period"] == 10
                assert state["strategy_params"]["use_macd_hist_reversal"] is False
    asyncio.run(run())


def test_macd_histogram_acceleration_regime_is_causal_and_hysteretic():
    values = [100 + 0.04 * i + 3 * math.sin(i / 6) for i in range(180)]
    series = macd_histogram_acceleration_regime_series(
        values, z_window=24, enter_z=0.5, exit_z=0.25, confirm_bars=2)
    assert len(series) == len(values)
    assert any(point["regime"] == "BULL" for point in series)
    assert any(point["regime"] == "BEAR" for point in series)
    cutoff = 130
    changed_future = values[:cutoff] + [value + 1000 for value in values[cutoff:]]
    changed = macd_histogram_acceleration_regime_series(
        changed_future, z_window=24, enter_z=0.5, exit_z=0.25, confirm_bars=2)
    assert series[:cutoff] == changed[:cutoff]
    assert all(not (point["long_ok"] and point["short_ok"]) for point in series)


def test_bots_persist_adjustable_macro_acceleration_regime():
    async def run():
        values = {
            "macro_regime_mode": "macd_hist_accel",
            "macro_macd_z_window": 36,
            "macro_macd_enter_z": 0.7,
            "macro_macd_exit_z": 0.2,
            "macro_macd_confirm_bars": 3,
        }
        with tempfile.TemporaryDirectory() as directory:
            for bot_type in (CryptoBot, LighterCryptoBot):
                bot = bot_type(object(), Path(directory) / f"macro_{bot_type.__name__}.json")
                state = await bot.configure(values)
                for key, expected in values.items():
                    assert state["strategy_params"][key] == expected
    asyncio.run(run())
