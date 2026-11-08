# Automatic realized P&L verification

Tab 4/5 status endpoints intentionally stopped launching exchange reconciliation
to prevent synchronous signer initialization from blocking charts and accounts.
The remaining refresh functions had no caller; after restart their caches stayed
empty indefinitely. Native reductions therefore appeared only as local estimates.

Independent lifespan workers now refresh history outside the API/trading event
loop. Each refresh uses an isolated client, asyncio locks/session and a copy of
bot state, with state saving prohibited. Data-only reconciliation caches survive
refreshes. Slow/failing venue reads cannot block the status route or certify an
empty history. Successful verified rows are merged onto current local history
by symbol/order/side/quantity; newer fills and current positions are preserved.
Workers are cancelled at service shutdown. Existing exchange network deadlines
bound HTTP reads; source staleness remains explicit until a successful refresh.

Lighter reconciliation now reads the account-side bid/ask client ID and aggregates
counterparty fills by that ID before matching a complete local order. A local
tracked exit with one owning entry is verified from both entry and exit fills,
using the tracked entry basis and proportional entry plus exit fees. Account
average-cost realized P&L remains separate in exchange_account_pnl_usd. Missing
entry coverage must leave the tracked lot unverified rather than substituting
account average cost. Funding is excluded. The current API history window is
100 fills; older/incomplete coverage can legitimately remain unverified.

A production read-only dry run, with state writes and all order methods blocked,
confirmed five recent native TP exits:

| Client order | Tracked net USD | Exchange trade count |
| --- | ---: | ---: |
| 99096781091124 | 0.234168 | 1 |
| 24757868790735 | 0.314384 | 3 |
| 159329064762710 | 0.287628 | 1 |
| 148302452718640 | 0.304392 | 1 |
| 250563263100559 | 0.196548 | 1 |

Total: +$1.337120, funding excluded. All five received
LIGHTER_VERIFIED_TRANCHE_FILLS, retaining their actual owning entry prices.

Validation covers synchronous-reader isolation, no state mutation, preservation
of newer fills/positions, side/quantity matching, partial-fill aggregation,
tranche versus account basis, missing entry coverage, strict history errors and
worker lifecycle wiring. Cross-tab invariants, Tab 4/5 mount and Lighter UI checks
also pass. Deployment verification must remain read-only and inspect live
prices/MA lines and account data; no test orders.

Deployment and live evidence (2026-11-08, approximately 22:51–22:55 KST):

- Runtime commit 450650a pushed and deployed: server.py, lighter_crypto_bot.py,
  and new realized_history.py. Old production hashes matched the committed
  baseline. Backups included all four trading state files; no configuration or
  runtime ownership was edited. Service restarted successfully. An initial local
  health probe used an unrelated port and returned 404; corrected port 8000 and
  the public route both returned HTTP 200, with all staged file bytes verified.
  Frontend remained unchanged; public document returned HTTP 200 text/html.
- 171 backend tests passed. Relevant UI/mount tests and cross-tab interaction
  invariants passed. First Chrome launch failed to expose DevTools; retry passed.
- Screenshots inspected actual price and MA rendering in Tabs 2–5. Navigation
  away/back and 5m→15m→5m succeeded in each. Initial chart observation times were
  3.634s / 4.333s / 4.331s / 0.045s, respectively; Tab 5 was prefetched. Initial
  Tab 3/4 chart snapshots preceded account readiness; subsequent account reads
  populated and were not accepted as zero balances.
- Tab 5 fresh reload: account by 6.225s, chart by 5.019s. The helper initially
  waits five seconds, so these are first-observed bounds. API and UI agreed on
  collateral $75.400847, BTC 0.00132 at $75,935.4 and available margin about
  $70.37. Account source age at capture was about 6.1s, reported non-stale.
  5m forming candle opened 22:50 KST; prior completed candle opened 22:45.
- Tab 4 fresh reload: account by 10.878s, chart by 15.941s. Actual price and three
  MAs were visible. UI $843.54 / $427.41 agreed with authenticated collateral
  $843.53883155 and available margin $427.41247051; positions were empty.
  Latest forming 5m candle opened 22:55 KST. History was non-stale.
- Tab 3 collateral matched the shared Lighter account ($75.40). Its free amount
  remains an engine estimate rather than exchange available margin; the paired
  endpoint still lacks an exchange account source timestamp. This pre-existing
  limitation is not certified as fresh exchange margin by these checks.
- Live history_stale=false, 41 verified exits, verified total $1.453833 for the
  current retained history. This broader total differs from the five recent
  native exits (+$1.337120). Opened Execution History and inspected the visible
  rows: all five show their expected net amounts and Verified. Screenshots:
  /tmp/realized_history_verified_rows.png and /tmp/realized_tab4_reload.png.
- The user's bot remained enabled. Its current native position was 1/1 protected;
  ongoing strategy activity was not changed or used to submit verification orders.
