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
