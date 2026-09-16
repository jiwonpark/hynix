# Macro accumulation and price replay

The macro signal changes entry amounts and exit patience. It does not relax
entry filters. The inputs are the last 60 contiguous, completed hourly parity
closes. Forming, stale or incomplete history cannot enable a size increase.

| Regime | ADR entry (short) | ETF entry (long) | Convergence required | Minimum estimated net profit |
| --- | ---: | ---: | ---: | ---: |
| Normal | 0.08 | 1.40 | 0.08 percentage points | > $0.02 |
| Top watch | 0.10 | 1.75 | 0.12 percentage points | > $0.03 |
| Topping | 0.12 | 2.10 | 0.16 percentage points | > $0.04 |

Every entry has **one** fixed exit allocation: 0.07 ADR / 1.20 ETF.
The rest remains core after the exit. Both boosted regimes require two rising
completed 5m closes when the bottoming condition is enabled; being below MA24
alone does not qualify. Strategy switches still control the corresponding
conditions. Live net profit, position, core, margin and leverage guards remain
mandatory.

The spread must be elevated: its last close is at least 0.5 standard deviations
above its 60-hour mean, and its last seven closes contain a high at least one
standard deviation above that mean. Top watch requires the latest three-hour
slope to be at most half the preceding positive three-hour slope. Topping
requires two consecutive lower hourly closes. Topping takes precedence over
top watch. The displayed score is 0 / 50 / 100, a discrete rule level, not a
probability. These are initial strategy settings, not empirically optimized
parameters.

Entry policy and spread are saved with both order IDs. An entry retains its exit
policy even when the current macro regime changes. Account history can also
restore the recognized paired entry sizes; boosted entries must never be split
into multiple speculative exit units. Older bulk orders retain legacy unit
attribution.

The chart replay starts flat at the beginning of loaded history and uses only
closed 5m prices and completed hourly indicators. It has no capital, margin or
leverage constraints and never stops because of losses. A legacy starting
capital argument is accepted but ignored. It reports net marked PnL, dollar
drawdown, peak gross exposure, open inventory and retained core, including fees,
slippage and estimated funding. Peak exposure is not a margin requirement.
Account state and order submission are never used by the replay.
