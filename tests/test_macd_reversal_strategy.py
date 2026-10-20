import asyncio
import math
import tempfile
from pathlib import Path

from backend.crypto_bot import CryptoBot
from backend.lighter_crypto_bot import LighterCryptoBot
from backend.lighter_strategy import (
    LIVE_STRATEGIES,
    evaluate_macd_reversal_signals,
    evaluate_strategy_signal,
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
        "entry_signal_negative": True,
        "entry_histogram_negative": True,
        "entry_histogram_reversal": True,
        "exit_signal_positive": None,
        "exit_histogram_positive": None,
        "exit_histogram_reversal": None,
    }

    _, _, exit_signal, exit_details = evaluate_macd_reversal_signals(prices(2.7), position_side=1)
    assert exit_signal is True
    assert exit_details["condition_pass"]["exit_signal_positive"] is True
    assert exit_details["condition_pass"]["exit_histogram_positive"] is True
    assert exit_details["condition_pass"]["exit_histogram_reversal"] is True


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
    entry, side, _, details = evaluate_strategy_signal("macd_reversal", prices(5.9), {})
    assert entry is True
    assert side == 1
    assert details["strategy"] == "macd_reversal"


def test_macd_entry_evaluation_is_independent_of_inventory():
    flat_entry, _, _, _ = evaluate_macd_reversal_signals(prices(5.9), position_side=0)
    held_entry, _, _, _ = evaluate_macd_reversal_signals(prices(5.9), position_side=1)
    assert flat_entry is True
    assert held_entry is True


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
