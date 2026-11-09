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
