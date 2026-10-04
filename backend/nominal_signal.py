"""Nominal ADR/CSOP signal; order quantities are deliberately absent."""
import math


SIGNAL_VERSION = "adr_csop_sqrt_v1"
# Fixed quote-unit normalization keeps the signal near the old percentage scale.
# It is not an estimate of intrinsic value or a dollar-weighted portfolio return.
CSOP_SQRT_SCALE = 60.0


def nominal_premium(adr_price, csop_price):
    try:
        adr, csop = float(adr_price), float(csop_price)
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(value) and value > 0 for value in (adr, csop)):
        return None
    return 100.0 * adr / (CSOP_SQRT_SCALE * math.sqrt(csop))
