"""Optional entry-count cap, independent of leverage and margin safeguards."""
import math


def parse_entry_count_limit(value):
    if value is None or value == "unlimited":
        return None
    if isinstance(value, bool):
        raise ValueError("max_tranches must be an integer from 1 to 100, or null for Unlimited")
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = math.nan
    if not math.isfinite(number) or not number.is_integer() or not 1 <= number <= 100:
        raise ValueError("max_tranches must be an integer from 1 to 100, or null for Unlimited")
    return int(number)


def has_entry_slot(state):
    limit = state.get("max_tranches", 5)
    return limit is None or len(state.get("tranches", [])) < limit
