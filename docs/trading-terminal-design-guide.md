# Trading terminal condition status

Every user-facing entry or exit condition in every trading tab and strategy must show its **own evaluated state** next to that condition. An overall strategy badge or `ON/OFF` switch cannot substitute for a per-condition verdict. Use the same visual language throughout the terminal: `PASS` when the evaluated predicate is true, `WAITING` when it is false, `OFF` when an optional rule is disabled, and `UNAVAILABLE` or `N/A` when the required completed candle or position does not exist. Never render a default `PASS` for missing data.

The status must come from the same predicate and parameters that the live engine or replay uses. Show the measured value and threshold in the badge tooltip or alongside the row, and identify the source (`LIVE` or `PAPER`) and evaluated candle time. Recompute or clear the verdict when the symbol, interval, strategy, parameter, switch, or replay result changes. Do not leave a prior result visible while a new replay is running or has failed. A live-only execution check that replay cannot model must say so and remain separate from strategy conditions.

The OU mean-reversion panel in Tab 3 and the strategy panels in Tab 4 and Tab 5 follow this rule. OU entry Z, half-life, minimum deviation, macro EMA alignment, and stop-zone checks each need a verdict; neutral-Z exit and the always-active emergency stop need separate verdicts. Grid, Trend MA Stack, Multi-Factor Gate, Macro Trend Reversion, and Custom Rule Composer likewise need a verdict for every actual entry and exit predicate evaluated by their causal engine. Exit predicates that require an open position display `N/A` when none exists.

All testable strategies presented across the terminal are deployable to autonomous live execution, never restricted to Grid. Strategy parameters (entry/exit thresholds, lookback windows, quorum counts, and pullback distances) are fully wired and persisted on the live executor. When a strategy is deployed, the live daemon evaluates that strategy's real rules on incoming completed candles and verifies the current executable order book quote prior to order entry. Per-condition verdicts reflect the active mode, labeled `LIVE` when evaluating completed candles and inventory on the running executor, and `PAPER` during replay simulation.

Each visible optional condition (such as Base Entry Spacing, Dwell Anti-Churn, Peak-Out Rollover, Trend MA Stacking, and Convergence Target) must remain independently switchable and persistable to the live bot when deployed, with its applicable threshold adjustable and wired to the actual engine. Never present a decorative switch or ignore condition toggles during live strategy deployment. Show execution safeguards such as order validity, reconciliation, and account limits in a separate group, without decorative switches. Verify at least one mixed case where one condition passes and another waits, a disabled condition, missing/stale data, and a parameter change that flips the replay verdict.

For single-leg Tab 5, distinguish **exposure** from **margin**. Exchange leverage or the 10× assumption used to estimate initial margin does not make a 10× account position an acceptable risk target. A single-leg position has no hedge: its approximate loss from an adverse price move is `account-wide gross notional × move percentage`, regardless of how little initial margin the exchange requires. Limit projected account-wide gross exposure to `account collateral × (10% equity-loss budget ÷ 10% adverse-move scenario)`, currently a 1× gross cap. Recompute the dollar cap and remaining entry capacity from fresh collateral and all account positions; other Lighter positions consume the same budget. For example, $170 collateral with $20 existing gross exposure leaves about $150 for the next entry before rounding.

Check available margin separately. As in Tab 2, apply the 25% buffer to estimated **initial margin**, not to full order notional: `required margin = max($2.50, next order notional ÷ 10 × 1.25)`. A $150 order therefore needs an estimated $18.75 of available margin, while the exposure check still requires projected account-wide gross notional to stay within the 1× cap. The 10× value is a conservative margin-estimation assumption, not a target leverage or permission to exceed the exposure cap. These are execution/account safeguards, shown separately from optional strategy conditions and without fake switches.

Show projected next-entry account-wide gross leverage, the buffered margin requirement, and estimated account-equity loss under the 10% adverse-move scenario. Label the scenario as an estimate, not a worst-case loss or liquidation threshold; gaps, fees, and liquidation can produce different outcomes. The UI preview may use the requested order notional, but the final server-side checks must use the rounded executable quantity, current quote, fresh collateral, and fresh account positions before ordering.
# Paper/backtest entry signals

Paper and backtest charts have two separate event streams:

- `entry_signals`: every completed candle where all enabled entry conditions pass.
  This stream is evaluated as flat and is independent of positions, tranches,
  account capacity, balances, margin, recovery, and order state.
- simulated fills/trades: the position-aware accounting stream used for exits,
  P&L, fees, and open-position summaries.

Render entry arrows from `entry_signals`, never by inferring them from trades or
open positions. Label counts separately (for example, “12 entry signals · 3
simulated fills”). A strategy may use prior signal history for an enabled spacing
or cooldown rule; it may not use open-position history to suppress a marker.
Use the evaluated candle's timestamp and price for the signal, including the
latest completed candle even when its next-open simulated fill is unavailable.
Link a signal to an exit only through its corresponding simulated fill; unfilled
signals must never consume or replace a trade's entry in chart pairing. Profit
references and trade connectors use fill prices, while signal arrows keep the
condition candle's price.
Regression coverage for every new replay strategy must demonstrate that a second
qualifying candle is still returned while the simulated position remains open.


# Account, chart, and time verification

These are mandatory basic checks for every affected trading tab after deployment,
including tabs that share a changed component or backend. Other agents must use
this checklist before reporting that the work is complete.

- **Account data:** Open the real account panel and compare equity, available
  margin, position quantities, entry prices, and applicable P&L with the
  authenticated read-only API for the same venue/account. Check dollar values,
  currency, units, and signs. Confirm that legitimate zero balances and no open
  positions are distinguishable from missing, failed, or stale account data.
  Cached or unavailable data must carry an explicit source/status and timestamp.
- **Actual chart rendering:** Inspect a screenshot of the price series, MA lines,
  populated price/legend values, and any affected secondary pane or markers.
  A mounted container, canvas, HTTP 200, or API bar count is insufficient. Check
  a fresh load, reload, navigation away/back, and interval switching. Include a
  returning user with saved collapsed chart/ancestor sections: entering the tab
  must reveal its main chart, and expand/collapse controls must work while locked.
  Ensure the
  displayed symbol and interval match the loaded data and the plot is visible
  within its price/time scales. Check for JavaScript errors.
- **Loading time:** Measure elapsed wall-clock seconds from the user action to
  usable account values and separately to visible chart data. Record the action,
  tab, symbol/interval, timings, and outcome in verification evidence. Measure a
  fresh load as well as a cached reload; cached content alone cannot establish
  that live data refreshed. Enforce any configured loading budget. Otherwise
  report the measured delays rather than silently accepting a slow response.
- **Clock and freshness:** Compare the current time with account update times,
  market/candle times, and displayed source timestamps. Check timezone conversion
  and seconds/milliseconds handling; use KST where the UI promises KST. Verify
  that candle spacing matches the selected interval and strategy signals use the
  latest completed candle, not a forming candle. Fetch time, market-data time,
  strategy evaluation time, and deployment time describe different events and
  must not substitute for one another. Expose cache age/staleness explicitly;
  unexplained future timestamps or old data shown as current fail verification.
- **Completion and failure:** Loading must resolve to usable data or an explicit
  bounded timeout/error with retry. Observe recovery after a transient failure.
  Empty charts, indefinite spinners, stale account values shown as current, and
  silent fallback to placeholder values are failures. Document unresolved issues
  instead of reporting a successful deployment. Never submit test orders or
  change live trading settings as part of these checks.


# Optional entry-count cap

The Binance and Lighter single-leg crypto terminals allow every integer entry
count from 1 through 100, plus Unlimited. This is a cap on simultaneously open
bot-owned entry tranches, not a limit on exchange position rows. Unlimited is
persisted and returned as `max_tranches: null`; it removes only the count cap.
Leverage/exposure, available margin, exchange validity, executable-quote checks,
order reconciliation, and recovery safeguards still apply to every entry.
Display Unlimited explicitly in the selector, status, and capacity summaries;
never substitute five, eight, zero, or the active count for a null limit. Save
through authenticated live configuration, preserve the existing configured value
on deployment, and never change live settings or place orders to verify this UI.

# Trade marker and P&L triangle styles

Paper, virtual, and backtest entry/exit markers have colored outlines with no
fill. Actual execution markers keep solid fills. Entries point right (▷/▶),
exits point left (◁/◀); marker color follows buy/cover green and sell/short red.
P&L triangles have translucent green fills for profitable trades and translucent
red fills for losing trades, for both paper and actual trades. Preserve the
existing selection/hover behavior. When actual net P&L is unverified, use neutral
gray rather than implying profit or loss.

# Entry-filter trend background

In Tabs 4 and 5, chart background colors must come from the same causal wider-trend
predicates that the selected strategy replay uses for entry, returned by the
backend as `entry_trend`. Green allows longs only, red allows shorts only, and
neutral allows both (or indicates OFF/UNAVAILABLE, explicitly labeled). Use OU's
configured EMA slope for OU and the completed-hourly gate for other strategies.
Show PAPER, venue, rule/timeframe, enabled state, and source candle time. Clear
colors immediately when replay settings change, while loading, or on failure;
never carry a prior strategy's trend shading into a new replay. Forming candles
and candles outside the replay coverage have no evaluated background. Separate
reference trend dropdowns must say reference; they do not configure live filters.
# Paper/replay refresh invariant

Across all trading tabs, live price, account, position, and P&L polling must not reset or recompute paper/replay results. Replay is recalculated only when its symbol, candle interval, strategy, enabled conditions, or thresholds change, or when the user explicitly reruns it. Keep the last completed replay visible (dimmed and labelled as updating when appropriate) until its replacement succeeds. Loading UI must identify the pending components rather than presenting an unlabelled blank surface.

## Cross-tab interaction contract

Tabs 2–5 use the same navigation, loading, chart viewport, history, marker, and replay interaction model. Venue and strategy differences must not change those mechanics. Linked chart panes must receive identical ordered timestamps; represent unavailable observations as whitespace instead of removing the timestamp. Entering a different terminal starts at the top of that terminal, while horizontal navigation centering must never alter the document's vertical scroll. Every shared-interaction change requires verification across all four tabs.

Tabs 4 and 5 default the hourly wider-trend regime to **simple MA60 slope**.
Compare the latest completed hourly MA with its value one completed hour earlier;
rising permits longs, falling permits shorts, exactly flat permits both. Require
at least period + 1 completed hourly closes; missing history is UNAVAILABLE. The
`1h MA` replay field adjusts the period (2–120) and the existing macro-condition
switch enables/disables it. Deploy saves that period through authenticated bot
configuration; status and replay/live matching include it. OU retains its own
independently adjustable EMA-slope condition and labels.

Every crypto strategy that evaluates the hourly wider-trend entry condition must
show its shared switch as **Wider trend filter · completed 1h MA slope**, alongside
its own PAPER PASS/WAITING/OFF verdict. Dedicated strategy panels must not hide
this real rule. The period is adjusted in the chart's 1h MA field and is saved
with the switch through authenticated strategy deployment. OU uses its own
visible EMA-alignment switch; never override it from a hidden inherited switch.
Tab 5 MA Stack intentionally bypasses the hourly filter: label it N/A, disable
the unused hourly period input and retain the 5m full-stack/diff rules.

Tab 5 MACD strategies may explicitly select **MA slope**, **MACD-H
direction**, or **Hybrid** for that same wider-trend condition. MACD-H direction
considers both the completed-hour histogram level and its one-bar change. Long
alignment requires a negative histogram that is rising; short alignment requires
a positive histogram that is falling. A zero cross invalidates the old alignment
immediately. Its hourly MACD Fast, Slow, and Signal periods are independently
adjustable from the entry MACD, and its consecutive confirmation count is also
user-adjustable. All four values persist in authenticated live configuration and
must be reported in status and used identically by replay. No normalized Z threshold is used.
Hybrid requires both the completed-hour MA direction and the MACD-H direction
regime to agree. The replay background, PAPER condition
badge, LIVE evaluation, and source timestamp must all use the selected predicate;
neutral histogram direction permits neither side rather than fabricating a trend.
