# Tab 3 completed-reduction recovery — 2026-11-08 KST

Backend fixes: `8090b87` and `a7d6e22`. Frontend files were unchanged.

## Cause and repair

Both legs of a saved paired reduction had filled on the exchange, while the
ledger retained both original tranches. The reduction belonged to the older
tranche, but recovery required a match with the newest tranche. Exact client-ID
trade matches confirmed both full fills, and fresh exchange positions matched
only the newer remaining tranche.

Recovery now persists the owning tranche ID before reducing. Legacy reductions
must uniquely match direction and both confirmed quantities. Unknown owners,
ambiguous identical lots, overfills and residual-position mismatches remain
blocked. Both full fills and fresh residual positions are required before
recording the exit. A second reconciliation does nothing after the pending
intent is cleared. The stale pre-exit risk-capacity snapshot is invalidated.

Production code and state were backed up. The already-filled reduction was
recorded once, recovery flags cleared, and the remaining tranche preserved
exactly. The bot remained paused. Recovery explicitly replaced order submission
with a function that raises, preventing an accidental retry; no orders were
submitted. Credentials and unrelated runtime state were preserved. The service
restarted and the affected read-only endpoint returned HTTP 200 with recovery
and execution blocking false and one tracked pair.

## Verification

154 backend tests passed across paired recovery, paired execution, crypto
execution, native protection, TP/SL and telemetry. The focused paired suites
(69 tests) passed again after adding risk-snapshot invalidation. New regressions
cover an older-tranche exit, explicit ownership, ambiguous legacy ownership,
position mismatch, overfill, idempotency and ownership persistence before a lost
submission response. Cross-tab invariants and venue UI checks passed.

After the final backend restart, captured and visually inspected actual prices
and MA lines in Tabs 2–5. Tab 3 cold-profile activation showed chart and account
at 1.235 s. Navigation away/back passed; 15m and 5m chart changes completed in
0.526/0.511 s, with actual timestamp spacing checked. Cache-bypassing reload
first showed chart/MA at 5.537 s and authenticated account at 6.040 s. Polling
started after a five-second startup wait, so these are first-observation bounds.

At 14:36:35 KST, Tab 3 used 5m candles: latest candle opened 14:35 (forming),
previous completed candle opened 14:30. Account server time was current; displayed
USD collateral and paired leg quantities agreed with authenticated read-only
telemetry. P&L for the recovered exit came from confirmed exchange fills, fees
excluded from gross and allocated in net. The paired status API does not provide
exchange available margin; its UI free-margin figure is an engine estimate,
which was not certified as exchange-reported available margin. The obsolete
pre-exit capacity snapshot was removed rather than reused as fresh data.

Local evidence: `/tmp/hynix-tab3-inspect.py`,
`/tmp/hynix-tab3-final-status.json`, `/tmp/hynix-tab3-recovery-final-ui.log`,
`/tmp/tab3_recovery_reload.png`, and `/tmp/live_*.png`.

## Follow-up: automatic reconciliation

Runtime commit `5c62548` adds periodic read-only reconciliation of completed
reduction intents with both saved order IDs. The worker now checks those intents
even while paused. Both full fills, a unique or explicit owner, and matching
residual positions are still required. The automatic path sets
`allow_leg_retry=False`, never evaluates a new trade in the reconciliation tick,
and preserves the existing enabled/paused state. Missing legs, uncertain
submissions and mismatches remain blocked. Reads are throttled using monotonic
time; actual polling cadence also depends on the existing worker scheduler.

159 backend tests passed, including five additional worker tests for paused
recovery, restart, delayed confirmation with backoff, no missing-leg retry,
no same-tick trade and exactly-once history. The saved incident was also replayed
against real exchange fill/position reads using a temporary state file and an
order-submission function that raises. It recovered correctly once, stayed
paused in the replay, and did not alter live state or submit orders.

Production source was checked and backed up before installation; runtime state,
credentials and unrelated changes were preserved. The backend restarted,
read-only status returned HTTP 200 with no recovery/execution block, and the
frontend remained HTTP 200 text/html. No frontend files changed. The deployed
bot's existing enabled setting remained enabled; the deployment did not issue a
toggle or change strategy settings.

Actual price/MA lines were captured and inspected in Tabs 2–5. Tab 3 activation
showed chart/account in 0.628 s in a fresh browser profile (prefetch can contribute).
Navigation away/back and actual 15m/5m changes passed (1.107/1.005 s chart readiness).
Reload chart/account were first observed at 5.518 s, including the five-second
startup wait. At the 15:22:53 KST sample, latest 5m candle opened 15:20 (forming),
prior completed candle opened 15:15, and account server time was 15:22:55 (about
two seconds ahead of the browser clock). The paired endpoint does not expose
an independent account-update timestamp, so underlying account age is not
certified from that server-render timestamp alone. Displayed collateral and
paired quantities were checked against authenticated read-only telemetry.
Local evidence: `/tmp/hynix-tab3-auto-ui.log`,
`/tmp/hynix-tab3-auto-live-status.json`, and `/tmp/tab3_recovery_reload.png`.
