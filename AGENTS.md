# Project workflow

## Condition controls (product requirement)

Across every trading tab and strategy, each condition presented as a user-facing
entry or exit rule must correspond to a real rule in the live engine or replay.
Users must be able to turn each strategy condition on or off and adjust every
applicable threshold. Changes to replay controls must affect the replay; live
changes must be saved through the authenticated bot configuration and reflected
in status. Show clearly when replay cannot model a live-only execution check.
Never present a decorative switch, a hard-coded threshold, or a stale rule label
as though it controls trading. Exchange validity, order reconciliation, and
account safety limits are execution safeguards; label them separately from
optional strategy conditions instead of presenting disabled fake switches.
Follow [the trading terminal design guide](docs/trading-terminal-design-guide.md)
for per-condition PASS/WAITING states and source/timestamp display.

## Paper/backtest entry-signal invariant

Across every current and future strategy, evaluate and return entry-condition
signals on every completed candle without consulting simulated or live position
state, tranche count, capacity, balances, margin, or recovery state. Expose these
matches as a distinct `entry_signals` stream and use that stream for chart entry
markers. Positions may still drive simulated exits, fills, P&L, and execution
safeguards, but they must never suppress or fabricate an entry-condition marker.
Stateful strategy conditions based on prior signals (for example configured entry
spacing) may use signal history, but never open-position history. UI summaries
must distinguish entry signals from simulated fills/trades.

The user wants implementation changes committed, pushed, and deployed by default.
After completing the appropriate checks, commit the changes, push to origin, deploy
both affected frontend and backend files, and verify the live site. Do not stop at
local changes or request the same authorization again.

Production: https://control.jiwonova.com/skhynix/
SSH host: thejiwon2025
Frontend: /var/www/skhynix/index.html
Backend checkout: /home/ubuntu/skhynix
Backend service: skhynix-daemon

Inspect the remote checkout and service before deploying. Preserve credentials,
runtime state (especially backend/auto_tranche_state.json), and unrelated changes.
Restart the backend service when backend code changes. Verify HTTP 200 text/html
for the frontend and check affected read-only API endpoints after deployment.
Never place test orders as part of deployment verification.

Deploy frontend changes with `scripts/deploy_frontend.sh`, passing any changed
root-level frontend assets as arguments (for example, `strategy-lab.js`). The
script always stages `index.html`, stamps a unique Git SHA + KST build version
and deployment time, inspects production, uploads the files, and verifies the
live metadata. Do not copy `index.html` directly because that bypasses stamping.


## Basic UI verification (required for every deployment)

Open every affected tab on the live site after deployment. Verify that actual
price data and MA lines are visible, with populated values and usable controls,
then check a fresh reload, navigation away/back, and interval switching. A chart
container, canvas, HTTP 200, or nonzero API bar count alone is not proof that a
chart rendered. Capture and inspect the chart itself. Treat empty charts,
JavaScript exceptions, and indefinite loading as failed verification. Never
place orders while checking the UI.
