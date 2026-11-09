# MA Pullback pivot-guide entry filter

Tabs 4–5 only, under MA Pullback → Entry conditions. Runtime commits c1f058a
and 72f4183 are pushed. The filter defaults OFF; deployment did not enable it
or change saved trading settings. Replay edits remain local until authenticated
Save & Deploy, and survive reload. Match Live replaces the replay draft.

- Long: pivot-to-completed-candle guide rises OR at least the configured number
  of up crossings occurs within that segment.
- Short: guide falls OR enough down crossings occurs.
- Choose MA7, MA24 or MA60. Lookback: 3–440 completed MA points, default 120.
  Minimum same-direction arrows: 1–440, default 1.
- Uses the most recent confirmed pivot in that exact window. Warmup requires
  MA period + lookback − 1 completed closes. No confirmed pivot / insufficient
  history blocks an enabled rule and shows UNAVAILABLE, never a fabricated pass.
- Count strict interior side changes, excluding endpoints, tangent touches and
  coincident spans. Geometry uses linear prices and ordered candle indices;
  native chart coordinates project the same crossing fractions for drawing.
- Selected-MA hover uses the same bounded calculation; forming candles use the
  latest completed guide. Other guides preserve the common visual behavior.
- Each direction has separate PAPER/LIVE states and KST source times, parameters,
  slope and arrow counts. Unmatched evaluated parameters are unavailable.
- Existing entry conditions remain independently switchable. Exits are unchanged.
  If this is the sole MA entry rule, guide direction chooses the candidate side.
  Replay entry_signals remain independent of position/account/capacity state.
- Live quote checks keep the pivot on completed closes while other quote checks
  use executable prices. Every Lighter campaign child slice requires a fresh
  passing pivot verdict with parameters matching saved settings.

Validation includes shared Python/JavaScript geometry fixtures, both crossing
orientations, plateaus, endpoints, exact-vertex crossings, no pivot, history
warmup, threshold changes, causal history, forming-candle exclusion, native arrow
projection, toggle/scope behavior, both bots' save/reload/public status and pause
validation, campaign child filtering, both replay routes and entry-stream parity
against the flat live evaluator. Changing simulated exits leaves entry signals
unchanged. Related backend regressions and cross-tab, mount, condition-group,
switch, loading/error, synchronization, zoom/pagination, visibility and marker
UI tests passed. The existing async MA configuration test was run directly with
asyncio because the local pytest environment lacks pytest-asyncio.

Deployment used the frontend stamping script and separately installed only the
changed backend code. Both production inspections matched the prior code hashes;
credentials, unrelated remote changes and runtime state were preserved. Code and
all four state files were backed up under private /tmp deployment directories.
The backend service was restarted and read-only bot status returned HTTP 200;
both pivot switches remained false. All five deployed backend file hashes and
all three exact versioned frontend assets match the pushed checkout.

Live frontend: v1.7.1+72f4183.20261109213724, deployed 2026-11-09 21:37:24 KST.
HTTP 200 text/html and build metadata verified. Renderer SHA256:
4d73e7fe6fd7df442dbbdd99935af8c25d94d6f8ad0f2b9083db17b3e0371927.

The deployment browser checks passed hover, wheel, multi-step drag, price-axis
scaling, linked panes and leave clearing across Tabs 2–5, with unchanged chart
ranges/data during hover and no uncaught exceptions. Subsequent read-only browser
checks exercised MA7/120/1, MA24/120/1, MA24/120/3 and MA60/40/1 in both affected
tabs. Chart analysis matched replay readiness, both direction verdicts and both
arrow counts for every selection; PASS/WAITING and KST source values rendered.
The current rising guides correctly passed long with zero up arrows via the OR
branch. The MA60/40 draft survived reload; live saved switches remained false.
Screenshots were inspected, including the final compact checkbox layout.

No verification orders were placed. Live bot configuration was not saved by QA.

Final lifecycle verification ran approximately 21:41–21:46 KST. Every tab passed
navigation away/back, 5m→15m→5m (checked against actual 300/900-second spacing),
and a fresh reload. The screenshots were inspected: actual prices, all three
MAs and linked price/MACD panes were visible with populated values. Enabled
MA24 hover on the historical 21:25 candle painted four canonical crossings in
each affected tab, matching the analysis counts; the screenshots showed both
up/down arrows with their tips on the MA crossings.

Fresh-reload first-observed wall-clock delays (seconds):

| Tab | Account | Prices / MAs |
| --- | ---: | ---: |
| 2 | 5.691 | 15.808 |
| 3 | 18.269 | 1.337 |
| 4 | 24.892 | 1.574 |
| 5 | 12.600 | 0.876 |

These measure UI readiness from reload, polling approximately every 0.5 seconds
after the app is available, rather than HTTP response latency. Fast chart
results can use the cache/prefetch; candle timestamps and age were checked
separately, and screenshots were taken after account readiness. Loading remains
slow in places: Tab 5's 15m switch took 34.944 seconds, then the 5m switch 6.132
seconds. No indefinite chart/account loading or uncaught exceptions was observed.
This feature does not certify a loading-performance improvement.

Fresh 5m reload captures at 21:41–21:44 had 21:40 forming / 21:35 completed bars;
Tab 5 at 21:45:50 had 21:45 forming / 21:40 completed bars. A separate Lighter
candle response reported stale=false and source fetch time 21:44:17, with 21:40
forming data. Binance candle responses have no explicit fetch-age metadata;
source candle times, rather than a newly rendered fetch label, were used.

Account checks used authenticated read-only responses and USD units. The UI
rounded the stored response values correctly. Tab 2 showed $816.27 equity /
$426.45 available; Tab 4 $816.68 / $426.48. Subsequent account calls moved with
market marks (they are not simultaneous snapshots). Tab 4's selected BTC
position list was empty in the authenticated response. Lighter collateral was
$75.207243; Tab 5 showed $34.84 available and the same BTC quantity/mark/P&L as
the source snapshot. At its reload observation, source time was 21:45:41.902,
server render 21:45:47.183, observed at 21:45:50.510, account_stale=false. The
following read-only response remained non-stale with source time 21:45:57.752.
Binance lacks an underlying account-source timestamp, and Tab 3 still reports
an engine free-margin estimate with no exchange account-source time; these
existing limitations are not certified as fresh exchange available margin.

One additional existing display issue was found: Tab 5's header showed
$74,534.20 while the latest candle/position marks were around $74,795–74,801.
`get_lighter_crypto_status` prefers `last_evaluation.ratio` for its header mark,
which remains old while the bot is paused; the chart uses newer candles. This
header mismatch is recorded, not counted as a fresh quote. The new pivot rule
uses completed candle history and the execution quote safeguard uses the book;
it does not derive its condition from that header. This separate header issue
was not changed in this entry-filter implementation.

Evidence logs:
- /tmp/hynix-ma-pivot-backend-deploy.log and backend-followup.log
- /tmp/hynix-ma-pivot-frontend-followup.log
- /tmp/hynix-ma-pivot-condition-final-live.log
- /tmp/hynix-ma-pivot-lifecycle-live.log

Screenshots include /tmp/ma_pivot_condition_{crypto,lighterCrypto}.png,
/tmp/pivot_reload_{trading,lighter,crypto,lighterCrypto}.png and
/tmp/ma_pivot_enabled_hover_{crypto,lighterCrypto}.png.
