# MA guide intersection markers

Guides remain straight chords from the most recent confirmed MA pivot to the
hovered candle. Hollow circles in the owning MA's color now mark isolated
intersections inside that chord. Crossings between candles are interpolated;
isolated tangent/vertex contacts are included once. Shared endpoints retain
the existing pivot/crosshair dots. Coincident spans have no arbitrary rings.

The same primitive renders guide and markers in Tabs 2–5. Intersections are
computed from the rendered MA polyline and guide coordinates, rather than
assuming uniform timestamps or a linear price transform. Pan/zoom/price-axis
changes reproject them on the native chart paint. Visibility and pointer leave
clear all markers. Chart data, time ranges, price autoscaling and pointer hit
areas are not modified by this feature.

Tests cover multiple/interpolated crossings, exact vertices, tangencies,
endpoints, coincident lines, missing-data gaps, actual ring draw calls, price/time
scaling, changed interior curve with unchanged endpoints, hidden MAs and leave.
Cross-tab invariants, chart sync, zoom/pagination, chart visibility, marker hover,
Tab 4/5 mount, Lighter UI and condition grouping/switch tests pass.

A read-only local browser run found visible intersections in every tab and
inspected each screenshot. Wheel zoom, physical multi-step pan, price-axis
scaling, pane sync and clearing all passed without runtime exceptions. No orders
were submitted; the local server rejected POST requests.

The browser verifier can select real visible intersections automatically:
`HYPERION_VERIFY_INTERSECTIONS=1 HYPERION_VERIFY_INTERACTION=1 node scripts/verify_live_charts.mjs`.

Production evidence (2026-11-09, approximately 20:42–20:48 KST):

- Runtime commit 23394fb pushed and deployed using deploy_frontend.sh with
  terminal-common.js; index.html was stamped automatically. Existing production
  shared-renderer hash matched the previous deployment. The script inspected the
  dirty backend checkout/service and preserved runtime files; no backend restart.
- HTTP 200 text/html and build v1.7.1+23394fb.20261109204232 verified. The exact
  versioned terminal-common.js URL matched local SHA256 c64bf345ef09ad374866f6ff54efa084b5af6e2a1dced091da8a2f9713126f48.
  An unversioned URL still returned an older CDN entry; deployed HTML uses the
  new versioned URL, which was verified rather than treating that old cache as
  current code.
- Live interaction suite found/rendered intersections in all four tabs (Tab 2:
  MA24 and MA60; Tabs 3–5: MA60 in the sampled spans). Inspected screenshots show
  hollow circles at the curve/guide intersections. Hover preserved the data and
  viewport; wheel zoom, multi-step pan, price scaling, pane sync and leave
  clearing passed without uncaught JavaScript exceptions.
- Fresh-reload screenshots in all four tabs showed actual prices and MA lines.
  Navigation away/back and 5m→15m→5m were exercised, checking actual 300/900-second
  spacing. 15m data initially included an older cached interval; it was not
  certified fresh. A read-only probe showed Tab 5's cached 19:15 candle fetched
  at 19:24. It subsequently refreshed: the actual 15m interval check returned a
  20:45 forming candle and 20:30 preceding candle. Final 5m snapshots used the
  20:45 forming and 20:40 completed candle.

Fresh reload first-observed bounds in seconds:

| Tab | Account | Prices and MAs |
| --- | ---: | ---: |
| 2 | 7.636 | 20.311 |
| 3 | 41.337 | 5.567 |
| 4 | 14.314 | 5.538 |
| 5 | 7.060 | 5.012 |

The helper waits five seconds after reload before polling; these are observation
bounds, not exact paint times. Account loading remains slow, especially Tab 3.
Older-history requests also emitted bounded 20-second timeout/retry warnings;
this change does not fix those pre-existing data-loading delays.

UI account values agreed with read-only data within intervening marks: Tab 2
$818.60 equity / $448.90 available; Tab 4 approximately $820.47 / $451.54; Lighter
collateral $75.278362 and Tab 5 available margin approximately $35.28–35.51.
Positions/P&L were populated, not treated as missing zero balances. Tab 5's
reload account source was 20:47:56 (reported non-stale) at the 20:48:03 observation;
a subsequent read had source 20:48:04. Source timestamps are distinct from fetch
or render times. The paired Lighter endpoint still lacks an exchange source time
and displays an engine free-margin estimate, so it is not certified as fresh
exchange available margin. Trading settings and runtime state were not edited;
no verification orders were submitted.

Logs: /tmp/hynix-intersections-deploy.log and
/tmp/hynix-intersections-lifecycle.log. Inspected images:
/tmp/pivot_hover_{trading,lighter,crypto,lighterCrypto}.png and the corresponding
pivot_scaled/pivot_reload images.
