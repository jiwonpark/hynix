# Tab 11 ETH preset validation — 2026-11-27 KST

This report records the evidence used for the optional **ETH Research Preset**.
It is a historical robustness check, not a profit guarantee or authorization to
arm the live bot.

## Fixed strategy selected without using the final-year result

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
