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
