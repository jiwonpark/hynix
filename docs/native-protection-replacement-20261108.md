# Active native protection replacement

The authenticated Tab 5 Save & Deploy action now replaces working native TP/SL
without requiring flat inventory. The bot must be paused. It reconciles fills
and verifies ownership before changing protection, journals remaining owners,
then cancels and confirms each owner's old children before placing replacement
reduce-only exits for its residual quantity. Disabling cancels tracked exits.
Initial activation still waits for explicit resume. Replacement exits can trigger
immediately when current prices have already reached the new targets.

Interrupted updates retain a durable owner queue and block Resume. Retry Save &
Deploy after resolving the reported exchange error. Restart reconciliation may
finish cancellation or account for fills, but cannot automatically submit
replacement protection while that update is pending. Unknown submissions require
authoritative reconciliation before another submission. Other owners' working
protection is retained when one replacement fails; exchange limits remain real
constraints. No account-wide cancellation or automatic inventory flattening.

Both OCO children now use one explicit expiry in milliseconds. Upstream
lighter-go sharedlib/main.go expands the -1 default independently per child,
while types/txtypes/create_grouped_orders.go requires identical expiries. The
installed production SDK signed the new request successfully in a dry run whose
send function was replaced with a throwing guard; no transaction was broadcast.

Validation: 165 backend tests passed, including cancellation races, residual
quantity, disable, lost submission responses, partial update preservation,
restart and retry, preflight failure, and the shared-expiry invariant. Native
controls, condition switches/grouping, cross-tab invariants, mounting, Lighter UI,
and terminal unlock checks passed. No verification orders were submitted.

Runtime implementation commit: 42686c4. Backend deployment checked the previous
hashes of all three affected files, backed up code and runtime state, installed
only those files and restarted skhynix-daemon. Dirty remote files were preserved.
Frontend used scripts/deploy_frontend.sh with lighter-crypto-tab.js; HTTP 200
text/html and stamped metadata verified.

Live checks on 2026-11-08 around 22:20–22:21 KST inspected screenshots of actual
prices and MA lines in Tabs 2–5, navigation away/back, and 5m→15m→5m changes.
Observed chart readiness after activation: Tab 2 0.713s, Tab 3 6.386s, Tab 4
3.141s, Tab 5 0.029s (the latter was already prefetched). Account data for Tabs
3/4 was not ready in that initial chart snapshot; it subsequently populated.
Tab 5 reload: chart first observed by 5.016s, account by 5.551s; the helper waits
five seconds after reload, so these are first-observed bounds rather than exact
paint times. Tab 5 account source age was approximately 4.8s at that capture,
reported non-stale. BTC 5m latest forming candle opened 22:20 KST; preceding
completed candle opened 22:15 KST. The 15m forming candle opened 22:15 KST.

Authenticated Tab 5 API and UI agreed on collateral $74.063727, BTC 0.0066,
entry $75,832.6 and displayed unrealized P&L about $2.11. Available margin moved
$51.17–$51.22 between fresh responses. Tab 3 collateral also matched $74.06;
its displayed free amount remains an engine estimate, not exchange available
margin, and its endpoint provides no exchange source timestamp. Tabs 2/4 showed
approximately $840 equity and $423 available margin; values moved with marks.
Do not treat render/fetch timestamps as underlying account freshness evidence.

Existing Tab 5 state was preserved: paused, native protection pending resume,
4 of 5 slices protected and eight working conditional children. Deploying code
did not apply strategy settings or replace those live orders. Actual replacement
requires the user's authenticated Save & Deploy action.
