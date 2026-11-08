# Trading terminal condition status

Every user-facing entry or exit condition in every trading tab and strategy must show its **own evaluated state** next to that condition. An overall strategy badge or `ON/OFF` switch cannot substitute for a per-condition verdict. Use the same visual language throughout the terminal: `PASS` when the evaluated predicate is true, `WAITING` when it is false, `OFF` when an optional rule is disabled, and `UNAVAILABLE` or `N/A` when the required completed candle or position does not exist. Never render a default `PASS` for missing data.

The status must come from the same predicate and parameters that the live engine or replay uses. Show the measured value and threshold in the badge tooltip or alongside the row, and identify the source (`LIVE` or `PAPER`) and evaluated candle time. Recompute or clear the verdict when the symbol, interval, strategy, parameter, switch, or replay result changes. Do not leave a prior result visible while a new replay is running or has failed. A live-only execution check that replay cannot model must say so and remain separate from strategy conditions.

The OU mean-reversion panel in Tab 3 and the strategy panels in Tab 4 and Tab 5 follow this rule. OU entry Z, half-life, minimum deviation, macro EMA alignment, and stop-zone checks each need a verdict; neutral-Z exit and the always-active emergency stop need separate verdicts. Grid, Trend MA Stack, Multi-Factor Gate, Macro Trend Reversion, and Custom Rule Composer likewise need a verdict for every actual entry and exit predicate evaluated by their causal engine. Exit predicates that require an open position display `N/A` when none exists.

All testable strategies presented across the terminal are deployable to autonomous live execution, never restricted to Grid. Strategy parameters (entry/exit thresholds, lookback windows, quorum counts, and pullback distances) are fully wired and persisted on the live executor. When a strategy is deployed, the live daemon evaluates that strategy's real rules on incoming completed candles and verifies the current executable order book quote prior to order entry. Per-condition verdicts reflect the active mode, labeled `LIVE` when evaluating completed candles and inventory on the running executor, and `PAPER` during replay simulation.

Each visible optional condition (such as Base Entry Spacing, Dwell Anti-Churn, Peak-Out Rollover, Trend MA Stacking, and Convergence Target) must remain independently switchable and persistable to the live bot when deployed, with its applicable threshold adjustable and wired to the actual engine. Never present a decorative switch or ignore condition toggles during live strategy deployment. Show execution safeguards such as order validity, reconciliation, and account limits in a separate group, without decorative switches. Verify at least one mixed case where one condition passes and another waits, a disabled condition, missing/stale data, and a parameter change that flips the replay verdict.

For single-leg Tab 5, distinguish **exposure** from **margin**. Exchange leverage or the 10× assumption used to estimate initial margin does not make a 10× account position an acceptable risk target. A single-leg position has no hedge: its approximate loss from an adverse price move is `account-wide gross notional × move percentage`, regardless of how little initial margin the exchange requires. Limit projected account-wide gross exposure to `account collateral × (10% equity-loss budget ÷ 10% adverse-move scenario)`, currently a 1× gross cap. Recompute the dollar cap and remaining entry capacity from fresh collateral and all account positions; other Lighter positions consume the same budget. For example, $170 collateral with $20 existing gross exposure leaves about $150 for the next entry before rounding.

Tab 5's live entry-rate control is an execution slicer, not a strategy-signal frequency control. One qualifying completed-candle entry signal starts a persistent campaign: `notional_usd` is the size of every child order, `max_tranches` is the total bot-owned piece cap, and `min_seconds_between_orders` sets the target pacing between pieces. The campaign must stop on an exit or opposite signal, bot pause, reconciliation, emergency flatten, configured tranche limit, or a fresh account-safety/capacity rejection. Each child fill is execution history associated with the original signal; it must not create additional `entry_signals`. Label this behavior as live-only because replay continues to model the strategy signal and target fill independently of real order timing.

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

For multi-part terminal refreshes, account and position telemetry must render as
soon as its own request completes. Slower strategy-history reconciliation,
replay, or trend requests must not hold valid account data behind a combined
barrier. Read-only venue telemetry must use a shorter bounded deadline than
execution reconciliation and may reuse a recent authenticated account snapshot;
it must never force an additional fresh account read merely to obtain positions.


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

Tab 2 uses compact native vertical arrows: buy and cover point up in green, while
sell and short point down in red. Labels remain hidden at rest and appear only on
marker hover. Tabs 3–5 intentionally retain their established 8px horizontal
triangle contract: entries point right, exits point left, paper/replay triangles
are outlined, and actual-execution triangles are filled. Their hover or selection
also renders the paired P&L triangle and diagonal connector.

P&L triangles have translucent green fills for profitable trades and translucent
red fills for losing trades, for both paper and actual trades. Preserve the
existing selection/hover behavior. When actual net P&L is unverified, use neutral
gray rather than implying profit or loss. This marker-shape distinction is an
intentional venue-chart presentation exception; marker visibility, selection,
hover details, and P&L semantics remain shared interaction behavior.

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
`Regime MA` replay field adjusts the period (2–120) and the existing macro-condition
switch enables/disables it. Deploy saves that period through authenticated bot
configuration; status and replay/live matching include it. OU retains its own
independently adjustable EMA-slope condition and labels.

Every non-MACD crypto strategy that evaluates the hourly wider-trend entry condition must
show its shared switch as **Wider trend filter · completed 1h MA slope**, alongside
its own PAPER PASS/WAITING/OFF verdict. Dedicated strategy panels must not hide
this real rule. The period is adjusted in the chart's Regime MA field and is saved
with the switch through authenticated strategy deployment. OU uses its own
visible EMA-alignment switch; never override it from a hidden inherited switch.
Tab 5 MA Stack intentionally bypasses the hourly filter: label it N/A, disable
the unused hourly period input and retain the 5m full-stack/diff rules.

Tabs 4 and 5 MACD strategies may explicitly select **Chart MA slope**, **Chart MACD-H
zone + slope**, or **Hybrid** for that same wider-trend condition. Both indicators use the
same completed candle array and interval as the strategy chart (5m in the live bot; the
selected interval in replay), never a separately sampled hourly series. The MA, MACD fast,
slow, and signal periods are independently adjustable and saved. BULL / long ok requires the
MACD histogram to be below zero and rising; BEAR / short ok requires it to be above zero
and falling; otherwise it is neutral. The configured confirmation count applies causally
to consecutive completed chart candles. Hybrid requires both the completed-chart MA slope
and completed-chart MACD-H regime to agree. All values persist in authenticated live
configuration and must be reported in status and used identically by replay. The replay
background, PAPER condition badge,
LIVE evaluation, and source timestamp must all use the selected predicate; neutral direction
permits neither side rather than fabricating a trend.

The **MACD Zero Cross** strategy is an intentional exception to the wider-trend
filter above. It has exactly two independently switchable completed-candle
conditions: histogram zero cross (`−→+` for long, `+→−` for short) and signal
line on the origin side (`< 0` for long, `> 0` for short). Histogram crossing is
enabled by default; the signal-line origin filter is optional and defaults OFF.
Saved live configurations retain their existing choice until changed through
authenticated configuration. It exposes adjustable
MACD fast, slow, and signal periods, but no macro/MA regime control. The opposite
histogram cross exits one owned tranche; reverse entry must independently satisfy the entry pattern. Replay entry markers come from the
position-independent `entry_signals` stream, while fills and exit verdicts may
still depend on simulated or live position state.

MACD period controls in Tabs 4 and 5 must drive the plotted MACD, its period legend,
replay signals, and the authenticated live deployment payload together. Editing
Fast / Slow / Signal updates the paper chart; saving live settings still requires
unlocking, pausing the bot, and deploying the selected strategy.

MACD Fast / Slow / Signal replay drafts persist through the authenticated bot
state, isolated by terminal and strategy. Refresh and strategy remount must
restore the saved draft ahead of generic defaults. Until that state arrives,
the controls and MACD pane must show a loading/unavailable state and must not run
a replay with hard-coded fallback periods. Explicit Align to saved bot thresholds
replaces the draft. Draft persistence must never change live bot configuration
or enable trading.

## Single-leg net take-profit and stop-loss exits (Tabs 4 and 5)

Every strategy in Tabs 4/5 exposes a separate optional **Net take profit** exit,
default ON at 0.20%, adjustable 0.01–100% of the matched entry notional (not margin
ROE). Existing signal exits remain active. The same controls drive replay and
authenticated live deployment; browser drafts persist and explicit Align replaces
them. The separate **Net stop loss** control defaults OFF with a 0.20% threshold.
Enter a positive loss percentage in the same 0.01–100% range. The stop triggers
when net return is at or below the negative threshold. Both controls show PAPER
and LIVE PASS/WAITING/OFF/N/A/UNAVAILABLE, source and KST timestamp.

Live checks executable bid for longs / ask for shorts on each daemon tick, before
completed-candle deduplication. Match the latest owned tranche first; if Lighter
minimum order size requires merging dust, test the exact merged reduction's
weighted basis and allocated entry fees. Recheck with the final executable quote
and quantity immediately before submitting a reduce-only exit. Never close foreign
inventory. Default ON also applies to existing bot state lacking these new fields.

Net return = (directional fill-to-quote P&L − allocated confirmed entry commissions
− expected exit commission) / matched entry notional. Binance reads signed
commissionRate and reconciles entry commissions from complete USDT userTrades.
Lighter Standard account type 0 has zero execution fees; other account tiers
currently show fee UNAVAILABLE and skip this exit rather than assume zero.
Funding is excluded. Missing fees make these net exits unavailable. Other signal exits remain active.

Paper checks completed candle closes, with the current account taker rate applied
to both entry and exit as an explicit estimate. It does not reconstruct historical
fee tiers or intrabar book prices. Missing fee lookup shows UNAVAILABLE. Paper
entry_signals remain position-independent; summary/triangle P&L retains the existing
pre-fee basis, while net take-profit and stop-loss trades additionally return net_pnl_pct. Do not
present that paper gross summary as realized account net P&L.

## Hourly MACD histogram direction regime (Tabs 4 and 5)

All single-leg strategies expose an additional optional entry filter, default ON:
compute H = MACD − signal from the latest **completed 1h candle**. Positive H
permits LONG entries only; negative H permits SHORT entries only; exactly zero
or unavailable permits neither. A completed H zero-cross therefore changes the
permitted entry direction. Fast/Slow/Signal are independently adjustable (default 20/60/9)
from the selected strategy/chart MACD. The switch and periods persist through the
authenticated bot config and are reported in strategy_params. Replay drafts may
persist in the browser; deploying saves live, explicit Align restores live values.

Show separate direction-correct LONG/H-positive and SHORT/H-negative PAPER and LIVE
PASS/WAITING/OFF/UNAVAILABLE states, exact periods, previous/current histogram,
zero-cross state and completed-hour source timestamp in KST. Replay background uses this hourly entry filter
when enabled; the other strategy conditions remain independently evaluated.
Replay maps each chart bar's close to the newest hourly close available then.
Never use the forming hourly candle or let future hourly data change old signals.
Retain legacy `use_hourly_hist` and period/condition API keys for saved controls;
return source `COMPLETED_1H_MACD_HISTOGRAM_REGIME` plus previous/current histogram
and `histogram_cross`. Do not label a cached old-rule evaluation as the new rule.
Hourly direction is evaluated independently of inventory for entry_signals.

This filter is entry-only: keep every existing signal, emergency and net-profit
exit active. Recheck current completed-hour direction immediately before **every**
entry order, including each persisted Tab5 campaign piece. Cancel a campaign when
its direction is no longer allowed by this filter or saved Long-only/Short-only
mode. Missing hourly data blocks new entries without suppressing exits.

The earlier MACD Zero Cross and Tab5 MA Stack exceptions bypass only the older
MA/zone-based wider-trend gate; this separately labeled hourly histogram-slope
filter applies to them as well.

### MACD Zero Cross exits: histogram only

For Tabs4/5, LONG exits on a completed histogram +→− cross; SHORT exits on −→+.
Signal-line sign and hourly direction are entry-only and never gate this exit.
The exit has an independent persisted `use_macd_hist_exit` switch (default ON),
separate from entry's `use_macd_zero_cross` and `use_macd_signal_zone` switches.
Show both directional exit labels and PASS/WAITING/OFF/N/A. Remove the old
exit-signal-zone row. Replay and live use the same evaluator. Existing reduction
sizing is unchanged (one owned LIFO tranche per signal), and reverse entries still
require the full entry pattern and hourly gate. Existing take-profit stays active.


### Grouping conditions in Tabs 4 and 5

Use the common terminal condition layout in both single-leg tabs: **Entry
conditions** contains the selected strategy's entry switches and the hourly
signal second-difference direction filter; **Exit conditions** contains the strategy's exit
rules and net take-profit. Keep optional strategy rules separate from
**Execution safeguards & live deployment**, which contains account capacity,
leverage, margin, recovery/reconciliation and authenticated deployment controls.
Shared MACD reversal pattern switches also govern opposite-position exits;
explain this relationship in the exit section without adding duplicate switches.

Move existing controls rather than cloning them. Preserve input identity, drafts,
listeners, authentication locks and saved live settings when rebuilding a
strategy panel. Put PAPER and LIVE verdicts next to the condition where a dedicated
row exists; otherwise list verdicts within the matching entry or exit section.
Always show the source candle time. When selected replay and saved live strategy
differ, label the difference and clear inline live verdicts instead of showing a
prior strategy's PASS. The layout change must not change trading predicates,
entry signals, execution safeguards or sizing.

Do not hide an entire inherited condition card until extracting any real shared
rules used by the selected strategy. In particular, wider-trend switches for
non-Zero-Cross strategies must remain in Entry conditions. Hide only unrelated
legacy rules; preserve the original shared inputs and handlers across switches.


### Replay condition loading readiness

Tabs4/5 loading completion must use the current parameter-matched condition
result, never a retained chart background. Keep Conditions + signals pending
through a replacement request when settings change in flight. If a response is
discarded, fetch the current settings instead of leaving conditions empty.
A prior completed request key cannot suppress retry when its result is missing.
Abort replay requests after 30 seconds and show UNAVAILABLE with a Rerun Paper
retry instruction; keep live condition verdicts separate. A successful response
without completed-candle condition data is unavailable, not complete. After a
replay settles, clear residual condition-value loading dots: show Not reported
for a separate measurement absent from the response, never a fabricated value.

### Complete strategy-switch inventory

Use `TerminalCommon.inheritedStrategyConditions(mode, prefix)` as the single
source for inherited switch visibility, labels, replay verdict keys and live
verdict placement in Tabs4/5. Dedicated OU/MACD and Tab5 MA Stack controls remain
in their corresponding entry/exit groups. Preserve the full set of existing
switches consumed by each evaluator: Grid/Custom/Adaptive8; MA Acceleration5;
Golden/Death Cross6; Tab4 MA Stack6 inherited plus its dedicated diff controls;
Tab5 MA Stack uses its four dedicated controls. MACD Zero Cross has its three
specific switches, plus shared hourly and take-profit controls. Do not attach
Grid/Z/spacing predicates to MACD merely to restore the old visual checklist.

Test the real `setParadigm` lifecycle across every strategy and verify every
supported inherited switch in both ON and OFF states against both replay settings
and the live deployment payload. A test of a visibility helper alone is
insufficient. Unsupported inherited rules remain unselected even after polling;
account safeguards belong in their separate real execution controls, without
fake optional switches. Direction-specific entry alternatives must be labeled as
such instead of implying every long and short trigger must pass simultaneously.


### Histogram-only entry default (Tabs4/5)

MACD Zero Cross defaults to H crossing −→+ for long, +→− for short, without a
signal-line sign requirement. Keep `use_macd_signal_zone` as a real optional
switch, default OFF consistently in fresh bot configuration, evaluator dispatch,
replay API and UI. Preserve an existing saved ON value when loading state; a
new default must not silently migrate live settings. Saved changes persist via
the authenticated bot configuration. The hourly histogram-direction entry filter
continues independently, and histogram-only exits, net take-profit, position
sizing and execution safeguards are unchanged. The MACD signal period/line still
forms part of calculating H; only its separate entry-zone predicate is optional.


### MACD histogram momentum-turn entries (Tabs4/5)

Offer **MACD ΔH Turn** (`macd_hist_turn`) alongside the existing Zero Cross
strategy. Let H be the selected MACD histogram on completed chart candles and
ΔH_t = H_t − H_(t−1). Long requires previous ΔH ≤ 0, current ΔH > 0 and current
H < 0. Short requires previous ΔH ≥ 0, current ΔH < 0 and current H > 0. A flat
previous delta may turn positive/negative; a flat current delta is not a turn.
The strict H-zone requirement excludes H = 0. Use three completed histogram bars,
no forming bar, future bar, inventory, balance, capacity or recovery state.

Give ΔH turning (`use_macd_hist_turn`) and histogram zone (`use_macd_hist_zone`)
independent real switches, both default ON. Retain the optional signal-line sign
filter default OFF. Add a fixed-timeframe completed-5m MACD signal-slope entry
condition (`use_macd_signal_slope_5m`), default ON: S_t > S_(t−1) for long and
S_t < S_(t−1) for short, using the strategy's adjustable Fast/Slow/Signal
periods. It is independent of the selected chart interval; flat or unavailable
5m signal data waits instead of passing. Show separate PAPER/LIVE
PASS/WAITING/OFF/UNAVAILABLE verdicts for `entry_histogram_delta_turn`,
`entry_histogram_zone` and `entry_signal_slope_5m`, plus current H,
previous/current ΔH, previous/current 5m S and both source candle times in KST.
Each checkbox change schedules one replay. New mode drafts inherit current MACD
periods when first selected, then keep their own adjustable/saved Fast/Slow/Signal
values.

Pausing execution does not pause MACD condition telemetry. While a MACD bot is
paused, continue evaluating completed venue candles in read-only mode, label the
snapshot `READ-ONLY (BOT PAUSED)`, and never submit orders or advance the bot's
last-executed candle. This keeps LIVE PASS/WAITING and source timestamps honest
without turning a paused bot back on.

Bot status must return saved strategy configuration and the latest condition
snapshot without waiting for exchange trade-history reconciliation. Refresh
realized-P&L history only through its separate authenticated reconciliation flow
and label cached history stale until that completes. Do not launch reconciliation
from the lightweight status route: synchronous signer work can starve its API
event loop even when wrapped in a background coroutine. Slow P&L history must
not blank current LIVE conditions.

Tab 5 account and position cards must render from the latest authoritative
Lighter account stream or last successful REST snapshot without waiting for a
new exchange request. Show the account source timestamp and label snapshots
older than 15 seconds `STALE`; never stamp the HTTP response time onto old
balances. A stale/missing snapshot schedules one coalesced REST refresh, while
the current UI response remains bounded. Stale account data disables live-order
availability but remains visible instead of becoming a fresh zero or an HTTP
proxy timeout.

On Tab 5 activation, chart loading may remain parallel, but automatic paper
replay must wait until an account snapshot has rendered. If the first account
read fails, leave replay idle so the bounded account retry has a quiet API
window; start replay automatically after that retry succeeds. Manual replay
remains available once the terminal is usable. The account snapshot alone uses
a 35-second client deadline so severe production CPU contention does not turn a
valid but slow snapshot into a false unavailable state; other reads retain the
standard 20-second bound. Once an authenticated account snapshot has rendered,
a later refresh failure keeps those values visible as an explicitly stale
snapshot with the failed-refresh reason and retry state; it must not replace
known balances or positions with dashes or zeros.

The completed-hour histogram regime remains an independent entry-direction filter.
Exits use the opposite ΔH turn and H zone: close long when previous ΔH ≥ 0,
current ΔH < 0 and H > 0; close short when previous ΔH ≤ 0, current ΔH > 0
and H < 0. Give the exit turn (`use_macd_hist_exit`) and exit H zone
(`use_macd_hist_exit_zone`) separate switches, both default ON, and separate
`exit_histogram_delta_turn` / `exit_histogram_zone` verdicts. Each signal exits
one owned LIFO tranche. Net take-profit remains an independent exit; optional
entry switches, signal-line sign and hourly entry gating do not gate exits. Live and replay dispatch to the same evaluator and expose position-free
entry_signals for every completed match. Existing Zero Cross and other strategy
predicates are retained. Saving the new mode to a running bot uses authenticated
configuration while paused; a code deployment alone must not migrate a saved
live strategy mode or submit orders.

On Tab 5, a paused bot may switch between `macd_zero_cross` and
`macd_hist_turn` while retaining tracked inventory: both use the same single-leg
LIFO lots. Preserve quantities, entry prices, fees and execution history exactly;
the newly selected rules manage those lots after resume. This configuration
change submits no orders. Pending orders or inventory recovery must be resolved
first. Retain the flat-inventory requirement for symbol changes and switches to
other strategy families.

### Tab 5 native conditional protection

`use_native_protection` is an authenticated live execution option, default OFF
for existing configurations. It does not change entry signals or paper fills.
When enabled, each confirmed entry slice receives reduce-only native Lighter
TP/SL orders using the existing adjustable net TP/SL targets. Both enabled exits
form an OCO group; one enabled exit is a standalone conditional order. Entry and
estimated exit trading fees enter trigger calculation; funding is excluded.
Triggers are not guaranteed execution prices: IOC slippage protection may leave
unfilled inventory. Reconcile partial fills to the owning slice, cancel remaining
children, and protect the residual on the next bot tick, including while paused. Native fills are
attributed to their entry slice rather than an unrelated newer LIFO slice.

Persist child client IDs before submission. Missing/ambiguous orders must block
new risk rather than be blindly resubmitted. Resolve and confirm cancellations
and racing fills before strategy/manual reductions; re-protect remaining lots
after a confirmed reduction. Protection remains on exchange during pause and
reconciliation continues while paused. Restart must reconcile protection before
checking inventory. Users may save native protection while paused with existing
inventory; persist pending activation and enroll those slices only on explicit
resume. First activation places no orders until resume. Changing active native TP/SL
while paused uses Save & Deploy to cancel, confirm and replace protection one
slice at a time without flattening inventory. Account for racing fills and
protect only residual owned quantity. Journal remaining replacements before
cancelling; an incomplete update blocks resume and requires retrying Save &
Deploy. Preserve other slices’ working orders on failure. Disabling cancels
tracked native exits; never cancel unrelated exchange orders. Show these effects
in the confirmation and native status, including that replacement exits may
trigger immediately if their targets are already reached. Use an identical explicit expiry for both
OCO children. Exchange capacity/unknown outcomes still block unsafe submission.
Keep the native execution option inside Exit conditions alongside TP/SL across
strategy switches. Preserve unsaved browser drafts across reload, distinguish
them from the saved live state, and save native protection through the same
authenticated Save & Deploy action as the other exit settings. Do not add a
separate per-condition save button. Show save errors inline and retain drafts
until the server confirms the saved configuration. The UI labels it live-only, displays
protected/owned slice counts, exchange check time in KST, and errors. Paper
completed-close results cannot certify native trigger or intrabar performance.
Deployment verification never submits test orders or enables native protection.


Native submission recovery must journal the signed transaction hash, nonce and
submission deadline before broadcasting, preserving the first submission error.
Missing order rows alone never authorize a retry. A missing, never-confirmed
group may be retired only after its verified signed deadline plus a safety
margin, fresh absence of every child, complete authenticated trade-history
coverage with no matching fills, and an exact fresh position/ownership match.
Unknown legacy deadlines require separately verified evidence; never invent a
deadline automatically. Archive the retired attempt, keep the bot paused, and
mark protection pending explicit resume. History/authentication failures must
remain unavailable, never become empty-history evidence. Confirmed working
orders must clear only their own stale error, preserving unrelated recovery.
Native exchange order timestamps may be seconds; normalize to milliseconds
before creating fill events. The Reconcile control must recognize native
protection errors even when ordinary market-order recovery is false.

Paired-venue recovery must reconcile the actual reduced tranche, including
non-newest slices selected by emergency exits. Persist the owning `tranche_id`
before submitting reduction legs. Legacy intents without that ID may match only
one tranche by direction and both confirmed quantities; ambiguous matches remain
blocked. Require both full fills and fresh residual exchange positions matching
the remaining ledger before recording the exit and clearing recovery. Reconcile
exactly once, retain the other tranches, and preserve the paused/enabled state.


Completed paired reductions must also reconcile automatically in the worker,
including after restart and while paused. Automatic recovery is read-only:
confirm both full fills, identify the owning tranche, verify residual exchange
inventory, then record the exit once. Never retry a missing leg or enter a trade
in that recovery tick, and never enable a paused bot. Incomplete/ambiguous
executions remain blocked. Throttle recovery reads to avoid hammering venue
rate limits; a disabled worker without pending execution must not touch the
exchange. Explicit operator recovery retains its separately guarded repair path.
