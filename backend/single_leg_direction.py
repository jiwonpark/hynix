"""Shared auto-entry direction policy for the single-leg trading bots."""

ENTRY_DIRECTION_MODES = {"two_way", "long_only", "short_only"}


def parse_entry_direction_mode(value: object) -> str:
    mode = str(value).strip().lower()
    if mode not in ENTRY_DIRECTION_MODES:
        allowed = ", ".join(sorted(ENTRY_DIRECTION_MODES))
        raise ValueError(f"entry_direction_mode must be one of: {allowed} (got {mode})")
    return mode


def entry_direction_allowed(mode: object, side: int) -> bool:
    parsed = parse_entry_direction_mode(mode)
    return parsed == "two_way" or (parsed == "long_only" and side > 0) or (parsed == "short_only" and side < 0)
