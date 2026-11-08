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
