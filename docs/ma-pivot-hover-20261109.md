# MA pivot hover regression

Reported after 6f942c6: pivot guides did not appear and chart pointer interaction
failed. A real browser using the local frontend and a read-only production-data
proxy reproduced `RangeError: Maximum call stack size exceeded` on a single
mouse move. The stack repeatedly entered `handleCrosshair` and
`renderMaLegendValues`. Guide rendering called real line-series `applyOptions`
and `setData` inside that crosshair callback; these synchronously emitted another
crosshair event before any guide data could settle.

The common guide helper now attaches one visual pane primitive to the existing
price series. Its wrappers update only guide geometry/visibility and request a
paint when that geometry changes. No extra chart series, timestamps, autoscale
contributions or pointer hit targets are created. Coordinate transforms are
read during native drawing, so zoom/pan/price-axis scaling reprojects guides.
MA visibility and pointer-leave clearing still apply. Flat runs require a real
reversal; null/missing data cannot become a zero-price pivot.

Local validation:

- MA guide tests cover native rendering coordinates, no chart-data mutation,
  no autoscale/hit-test hooks, duplicate hover suppression, leave/visibility,
  plateau confirmation and missing data.
- Cross-tab invariants, chart sync (2/3 panes), saved chart visibility, zoom and
  pagination, marker x-hover, execution controller, condition grouping/switches,
  Tab 4/5 mount and Lighter UI checks passed. The visibility test fixture now
  loads TerminalCommon into the same browser-like context as each engine.
- Real-browser interaction suite passed in Tabs 2–5. Hover left the logical
  range and data unchanged; guides appeared. Wheel zoom, realistic multi-step
  drag and price-axis scaling worked; linked ranges matched; leave cleared all
  guides. No runtime exceptions. Initial one/two-step synthetic drags did not
  cross the library's full drag-start sequence; the final test sends eight
  successive movements, matching a physical drag.
- Screenshots of all four hover states were inspected. A monotonic MA with no
  confirmed earlier pivot correctly has no guide (Tab 2 MA60 in this sample).
  The local proxy blocked all POSTs; one Tab 2 replay failed in that restricted
  harness and is not evidence of a production replay failure.

Run the reproducible browser suite with:
`HYPERION_VERIFY_INTERACTION=1 node scripts/verify_live_charts.mjs`.
An optional HYPERION_VERIFY_URL permits a local read-only test server. Uncaught
browser exceptions now fail the verifier rather than merely being logged.

Production verification:

- Runtime commit 0019c2f pushed and deployed through deploy_frontend.sh, staging
  index.html plus terminal-common.js and all three cloned terminal assets.
  Production baselines matched origin/main; dirty backend/runtime files were
  preserved and no backend restart was needed. No trading configuration changed.
- HTTP 200 text/html and build v1.7.1+0019c2f.20261109191900 verified. Served
  terminal-common.js SHA256 matched the local committed implementation. Stamped
  script URLs include the new build version, invalidating older cached assets.
- Live interaction checks passed in all four tabs: same viewport and candle
  count before/after hover, guides visible, wheel range changed, multi-step drag
  panned, linked ranges matched, price-axis drag changed the price transform,
  and pointer leave cleared the guides. No uncaught JavaScript exceptions.
- Inspected hover and scaled screenshots in every tab. The guide lines/dots
  stayed attached to the visible MA coordinates. Actual prices and MA lines were
  visible after fresh reload in every tab; those screenshots were also inspected.
- Navigation away/back and 5m→15m→5m were checked in all four tabs. The final
  lifecycle check waited for actual 900/300-second candle spacing, not merely the
  interval button label. An earlier preliminary check only waited for the label
  and was superseded by this stronger final run.

Fresh-reload first-observed times (seconds):

| Tab | Account | Prices and MAs |
| --- | ---: | ---: |
| 2 | 5.109 | 5.612 |
| 3 | 15.813 | 5.585 |
| 4 | 12.156 | 5.545 |
| 5 | 5.012 | 5.012 |

The helper waits five seconds after reload before polling, so these are observed
bounds rather than exact first-paint times. Prefetched navigation timings are
recorded separately in /tmp/hynix-pivot-live-lifecycle-final.log. Account loading
remains materially slower than chart loading for Tabs 3/4; do not report instant
account readiness from the chart result alone.

Checks ran around 19:19–19:24 KST on 2026-11-09. Selected 5m charts had latest
forming candle 19:20 and latest completed candle 19:15; the 15m check had forming
19:15 and preceding completed 19:00. Source/fetch timestamps were kept separate.
Tab 5 account source was 19:24:08 at the reload observation, reported non-stale;
a subsequent authenticated API snapshot had source 19:24:15. Displayed account
values loaded with USD units and agreed with their respective read-only data
within intervening market marks: Binance equity approximately $819–820 and free
margin $482–483, Lighter collateral $75.321491, Tab 5 available margin about
$55.21–55.33. Positions/P&L were populated, not accepted as missing zero balances.
The paired Lighter endpoint still lacks an exchange account source timestamp and
its displayed free amount is an engine estimate; this pre-existing limitation
is not certified as fresh exchange available margin. Binance status render times
also do not establish underlying exchange source time.

No test orders were placed. Local reproduction used a server that rejected all
POST requests, and production validation used viewing/navigation controls and
read-only account APIs only. Runtime data, credentials and bot state were not
modified by this frontend deployment. Frontend deployment now enables browser
interaction checks by default, and the verifier logs its actual target URL.
