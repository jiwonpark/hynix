# Missing native protection recovery — 2026-11-08 KST

Runtime fix: `e1579c7`; frontend build
`v1.7.1+e1579c7.20261108133047`.

## Incident and evidence

The paused Tab 5 bot retained one BTC entry and a `placing` OCO intent with
client IDs `132737632219333` and `57665124510422`. Both exact-ID lookups were
empty; BTC active orders were empty; inactive orders did not contain the pair.
The exchange still held exactly the tracked position. The original submission
receipt/deadline was not journaled, so the original delivery failure cannot be
identified conclusively. Transaction-history retrieval returned CloudFront 403;
that response was never treated as proof of rejection or an empty account.

Independently inspected the installed signer with broadcasting blocked: its
signed transaction lifetime was 599 seconds. The original intent was far older.
The legacy intent received a conservative 900-second expiry bound with an
explicit evidence annotation, rather than an automatically invented deadline.
The new reconciliation path additionally verified authenticated fill-history
coverage with no matching fills, fresh absence of both child orders, and exact
live position ownership before retiring the expired intent. The attempt was
archived; the position was preserved; the bot remained paused and protection
became pending explicit resume. No order or cancellation was submitted during
recovery, deployment verification, or the SDK check.

Eight native exit event timestamps were corrected against their terminal
exchange order rows. Future order timestamps normalize seconds/milliseconds.
A backup of code and runtime state was taken before repair. Unrelated production
changes, credentials and other bot runtime state were preserved.

## Prevention and validation

- Journal signed hash, nonce and deadline before network submission; retain
  the submission error and avoid unjournaled retries.
- Retire expired missing intents only with the independent evidence above.
  History failures, truncated coverage, matching fills, ownership mismatches,
  unknown deadlines, and live/cancelling groups remain blocked.
- Pause and require explicit resume after retirement. Signing/preflight failures
  before broadcasting no longer leave a phantom order ID.
- Clear only the resolved native error; retain unrelated execution recovery.
- Enable authenticated Reconcile for native errors even when market-order
  `recovery_required` is false.
- 148 backend tests passed, including submission journaling before a lost send
  response, strict history failure handling, expiry/coverage/ownership guards,
  timestamp units, restart idempotency and cancellation races.
- Condition controls, strategy-switch lifecycle, tab mount, venue UI,
  cross-tab invariants and JS syntax checks passed. A separate real-controller
  UI regression verifies Reconcile availability and authentication for native
  errors without ordinary market-order recovery.

## Live browser evidence

The first Chrome launch failed before page inspection; a fresh launch succeeded.
Actual chart price and MA lines were captured and visually inspected in Tabs
2–5. Navigation away/back and 15m/5m interval switching passed in all four tabs.
Cold-profile activation-to-chart measurements: Tab 2 0.977 s, Tab 3 7.482 s,
Tab 4 7.430 s. Tab 4 account readiness: 4.360 s. Tab 5 was prefetched and ready
in 0.028 s; this is not a cold-fetch measurement.

Tab 5 15m/5m chart changes took 4.044/1.549 s. A reload first showed chart and
an authenticated cached account at 5.217 s, with the account correctly flagged
stale. The subsequent read-only account response was fresh and matched displayed
USD values at display precision and BTC position units. At 13:32:46 KST its
account source time was 13:32:41 KST. The 5m chart's latest candle opened at
13:30 (forming); the previous completed candle opened at 13:25. Native status
showed pending resume, one tracked slice, no native groups and no error.

Local evidence: `/tmp/hynix-native-recovery-lifecycle.log`,
`/tmp/hynix-native-recovery-status.json`, `/tmp/native_oco_controls.png`,
`/tmp/native_oco_tab5_reload.png`, and `/tmp/live_*.png`.

## Tab 5 below-minimum remainder follow-up, 2026-11-10 KST

At 03:05 the live SMA7 and MA24 pivot arrow filters disagreed. At 03:10 both
passed long, but an emergency exit tried to reduce 0.00001 BTC against a
0.00014 BTC minimum and preempted entry. Commit `f06489e` lets a valid same-side
signal proceed after that specific preflight error. It retains the tracked
remainder and requires a successful close before reversal. The 94 backend
tests passed, including simulated same-side entry and blocked reversal.

The production service restarted with its saved settings and inventory. The
frontend returned HTTP 200 text/html and read-only bot status returned HTTP
200 with no recovery or pending order. Tab 5 showed rendered prices and all
three MAs at 1.620 s and authenticated account data at 9.518 s after reload.
Navigation and 5m → 15m → 5m switching passed. The 03:15 forming and 03:10
completed candles appeared with the cached-data label, so the chart timing
measures rendering. At 03:17:18 the account source was 03:17:10 KST and marked
non-stale. Equity, free margin, BTC quantity and unrealized P&L matched the
read-only response. Verification submitted no orders and observed no
post-deploy fill. Logs: `/tmp/hynix-dust-entry-deploy.log` and
`/tmp/hynix-dust-entry-ui-retry.log`.

At 03:28 KST on 2026-11-10, commit `8a64106` superseded the separate-close
restriction for a verified below-minimum remainder. A qualifying opposite
signal can net the old lot and sized entry in one order. Full and partial
fills, history deduplication and unowned inventory rejection were tested.
The 78 focused bot and native protection tests passed.

Production returned HTTP 200 text/html and bot status with no pending order
or recovery lock. Tab 5 rendered price and all three MAs in 3.63 seconds and
loaded authenticated account figures in 9.28 seconds on reload. The capture
showed cached 03:25 forming data while refreshing at 03:29, with 03:20 the
latest completed candle. Switching away and back and 5m → 15m → 5m worked.
The account snapshot at 03:28:54 KST agreed with the read-only response for
rounded collateral ($75.48), available margin ($75.44), BTC position size
and P&L. No test order was submitted and no live reversal fill was observed
during verification. Browser evidence: `/tmp/lighter-net-dust-ui.log` and
`/tmp/lighter-net-dust-chart.png`.
