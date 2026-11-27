# Tab 11 ETH preset rejection — expanded 2026-11-27 KST

This report preserves the original three-year evidence and the later expanded
test that **rejected the ETH Research Preset**. It is not a profit guarantee or
authorization to arm the live bot.

## Expanded five-year result (supersedes the promotion below)

The sample was extended to 11,115 completed ETHUSDT 4h candles and 1,852
completed daily candles, beginning in November 2021. Candidate ranking used the
first nine chronological half-year folds. The newest 1,093 4h candles (about six
months) were reserved and printed only after development ranking. All fills were
next-open, all daily values were completed and causally aligned, and results were
stress-tested at a modeled 20 bp round trip.

The former preset failed the expanded gate:

- Development Rank IC was **+0.0263**, below the project minimum of +0.03.
- At 20 bp, development returned +26.37% with PF 1.48 and 16.91% drawdown, but
  only four of nine half-year folds were positive; three lost money and two had
  no completed trade.
- The reserved six months returned +5.06% at 20 bp, but PF was only 1.46 across
  19 trades. A positive aggregate holdout did not repair the weak development
  consistency or cost margin.

Removing MA-derived inputs from Ridge was the only model variant to clear the
statistical layer over the broader development sample (Rank IC +0.0329; reserved
Rank IC +0.0524). It still did not clear execution validation: the old rule had
development PF 1.08 at 20 bp, and the model's development directional edge was
only about 1.23 bp per bar—far below the required margin over modeled costs.

The reproducible searches in `scripts/research_eth_model_variants.py` and
`scripts/research_eth_improvement.py` then tested long-only and symmetric
long/short daily regimes, confidence and expected-edge gates, MA periods,
minimum holds, continuation modes, causal pullback/RSI/slope filters, and 20–100
bp high-conviction forecast tails. No candidate met the combined chronological
fold, cost, drawdown, holdout PF, and sample-size requirements. Development
winners that looked attractive lost money in the reserved period; the apparent
best stronger-Ridge rule had only two reserved trades.

Consequently, the preset button and preset defaults were removed. The live bot
was left paused and its persisted configuration was not migrated. Tab 11 remains
an exploratory paper/replay tool until a future candidate passes the complete
gate.

## Original three-year result (historical, now superseded)

- Market: Binance Futures ETHUSDT
- Signal interval: completed 4h candles
- Ridge forecast horizon: 1 bar
- Entry: Ridge long probability confidence at least 52%, completed daily close
  above daily SMA100, long-only
- Exit: minimum 3 completed bars; continue holding while a fresh qualifying long
  signal agrees
- Paper fills: next 4h bar open after the completed signal/exit decision
- Sizing: fixed 1x notional, no compounding
- Modeled round-trip cost: 10 bp; stress case 20 bp
- Stop loss: off

The configuration ranked strongly on the first two chronological years from a
three-year, 6,569-bar sample, and its final-third result is reported separately.
Because the broader research iteration had already inspected the final third for
other candidates, this is exploratory out-of-sample evidence rather than a fully
pristine confirmatory holdout. A prospective paper-forward sample is still needed.
Daily inputs used only candles whose close time was no later than the 4h signal
close. Model fitting was causal and used only matured target labels.

## Results

| Period | Cost | Trades | Fixed-notional return | Profit factor |
|---|---:|---:|---:|---:|
| First two years (selection) | 10 bp | 54 | +31.7% | 1.79 |
| Final year (untouched) | 10 bp | 25 | +9.3% | 1.82 |
| Full three years | 10 bp | 79 | +41.0% | 1.79 |
| First two years (stress) | 20 bp | 54 | +26.3% | 1.61 |
| Final year (stress) | 20 bp | 25 | +6.8% | 1.54 |
| Full three years (stress) | 20 bp | 79 | +33.1% | 1.60 |

With the implemented adverse intratrade high/low mark, full-sample maximum
drawdown was 16.5% at 10 bp and 16.8% at 20 bp. Worst completed trade was −6.2%
at 10 bp and −6.3% at 20 bp.

## Limitations and rejection criteria

- The same configuration was not validated for BTC: its final-year result was
  negative with only four trades. The UI must not imply cross-symbol validation.
- Historical candles do not reproduce live order-book slippage, funding, outages,
  rejected orders, liquidation behavior, or future regime changes.
- The preset should return to research-only status if rolling forward results turn
  negative after modeled costs, profit factor falls below 1.5 with an adequate
  sample, or execution differs materially from next-open assumptions.
- Live activation remains a separate authenticated operator decision. Deployment
  and verification must never submit a test order or arm the bot.
