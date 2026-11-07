# Native Lighter protection verification — 2026-11-07 KST

Runtime implementation: commits `0638ec6`, `65b61e7`, `785d1d1`.
Frontend build: `v1.7.1+785d1d1.20261107211131`.

- 136 backend tests passed: native protection, Lighter crypto execution,
  single-leg TP/SL, telemetry, and paired Lighter execution.
- Condition-switch and grouping tests, cross-tab invariants, both crypto tab
  mount tests, both venue UI checks, terminal unlock checks, and JS syntax passed.
- Native tests cover per-slice ownership, old-slice stops, restart idempotency,
  partial fills, partial fills during pause, cancellation/fill races, uncertain
  submissions without duplicate placement, single-leg conditional exits,
  integer order precision, reduce-only flags, and fee-adjusted targets.
- Inspected production checkout, service, installed SDK signatures and baseline
  hashes before installation. Only affected code files were installed; runtime
  state and unrelated production changes were preserved. Backend restarted and
  read-only status endpoint returned HTTP 200. Frontend returned HTTP 200 HTML
  with the stamped build marker.
- Initial browser verification overlapped restart and encountered an empty Tab 3
  chart. Repeated verification after startup succeeded in Tabs 2–5. Captured and
  inspected actual price and MA lines, not only canvas containers or API counts.
- Final browser measurements from tab activation: Tab 2 chart 0.958 s; Tab 3
  chart 4.884 s; Tab 4 chart 7.348 s, account 6.135 s. Tab 5 was prefetched and
  ready in 0.034 s; that value is not a cold network-fetch measurement.
- Tab 3 navigation back succeeded, followed by actual 15m/5m chart changes
  (verified timestamp spacing), taking 5.030/4.030 s for chart readiness.
- Final Tab 5 navigation back, 15m/5m changes and cache-bypassing reload passed.
  Chart readiness after interval changes: 5.569/2.027 s. Account remained usable.
  Reload account and chart/MA were first observed at 5.102 s; first polling was
  after a five-second startup wait, so this is an upper bound, not a precise
  first-paint measurement.
- At 21:12:28 KST, the chart's latest 5m candle opened at 21:10 (forming), with
  the prior completed candle opening at 21:05. Account source time was
  21:12:22.779 KST, approximately 5.6 s old, and was not flagged stale.
  Displayed USD account values matched their API snapshot at display precision;
  selected BTC position units, entry price and P&L were populated and checked
  against authenticated read-only telemetry. Account figures are not copied
  into this document.
- The native setting remained OFF, with six owned slices and no native groups.
  Existing live strategy settings were preserved. No test orders or live
  configuration changes were sent. Real exchange trigger/fill behavior has not
  been exercised by this verification; native execution is covered by SDK
  inspection and mocked regression tests until the user enables it while flat.

Local browser evidence: `/tmp/hynix-native-oco-final-deploy.log`,
`/tmp/hynix-native-oco-final-lifecycle.log`, `/tmp/native_oco_tab5_reload.png`,
`/tmp/native_oco_controls.png`, and `/tmp/live_{trading,lighter,crypto,lighterCrypto}.png`.
