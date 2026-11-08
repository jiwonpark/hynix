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
