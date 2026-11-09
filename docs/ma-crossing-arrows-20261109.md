# Directional MA guide crossings

Intersection circles are replaced by thin MA-colored arrows. Read the guide
from pivot toward hovered candle: an up arrow means the guide crosses from
below the MA to above it; a down arrow means above to below. The arrow tip is
anchored at the intersection, with a light halo for visibility. These glyphs
have stems and use MA colors, distinguishing them from trade triangles.

A tangent touch without a side change has no crossing direction and gets no
arrow. Coincident spans and shared endpoints remain excluded. The original
filled pivot dot is unchanged. Geometry remains in the existing visual-only
primitive; no series data, hit targets, scale ranges or trading rules change.

Tests cover both crossing directions, reversed guide orientation, exact-vertex
crossings, tangent exclusion, multiple/between-candle crossings, missing gaps,
arrow tip placement/orientation, price/time reprojection, visibility and leave.
Cross-tab invariants, sync, zoom/pagination, chart visibility, marker hover,
Tab 4/5 mount and Lighter UI checks passed. A read-only local browser test passed
actual hover/wheel/pan/price scaling/pane sync/clearing in Tabs 2–5; screenshots
showed both up/down arrows, including several in the same MA24 segment.

Live deployment and verification:

- Runtime commit c5250f7 pushed and deployed via deploy_frontend.sh with
  terminal-common.js; index.html was stamped automatically. The service was
  active and the previous shared-renderer hash matched before deployment.
  Dirty backend files, credentials and runtime state were preserved; no restart.
- HTTP 200 text/html and build v1.7.1+c5250f7.20261109210114 verified. The exact
  versioned renderer matched SHA256 ead21053b5adabec91165d9d0a9025728fd9680c64b8f7a3bf590d942b579253.
- Live four-tab interaction checks passed, with direction metadata on every
  crossing. Both up/down arrows were observed, including nearby opposing
  crossings within one MA24 segment. Hover left the viewport/data unchanged;
  wheel, multi-step pan, price-axis scaling, linked ranges and leave clearing
  passed. Inspected arrow and fresh-reload screenshots showed actual MA curves
  and prices. No uncaught JavaScript exceptions or verification orders.
- Navigation away/back and 5m→15m→5m were checked in each tab against actual
  300/900-second candle spacing and a bounded candle-age check.

Fresh-reload first-observed bounds (seconds):

| Tab | Account | Prices and MAs |
| --- | ---: | ---: |
| 2 | 5.074 | 13.750 |
| 3 | 18.142 | 5.542 |
| 4 | 11.383 | 5.565 |
| 5 | 8.237 | 5.046 |

The helper waits five seconds after reload before polling, so these are observed
bounds rather than exact paint times. Account loading remains slower than chart
loading in several tabs; this visual change does not fix that latency.

Checks ran approximately 21:01–21:07 KST on 2026-11-09. Fresh 5m captures showed
21:00 forming and 20:55 completed candles. Tab 5's interval change initially
showed the prior completed 20:45 candle; a subsequent read had the 21:00 candle.
A bounded freshness probe first returned stale-while-refreshing data, then
stale=false with fetch time 21:06:56 by the 21:06:59 response. Old cached source
times were not relabeled as fresh. Fetch times and candle completion times were
kept separate.

Account snapshots were authenticated and displayed USD units, with positions
and P&L populated as applicable. Tab 2 showed approximately $819.98 equity and
$450.11 available; Tab 4 $817.57 / $446.97, changing with intervening market marks.
Lighter collateral was $75.207243; Tab 5 available margin about $35.01. Its
reload source timestamp was 21:04:40 at the 21:04:48 observation (non-stale),
and the subsequent API source was 21:04:49. Tab 3 still reports an engine free
estimate and no exchange account source timestamp; these pre-existing limits
were not certified as fresh exchange available margin.

Logs: /tmp/hynix-crossing-arrows-deploy.log and
/tmp/hynix-crossing-arrows-lifecycle.log. No trading settings were changed.
