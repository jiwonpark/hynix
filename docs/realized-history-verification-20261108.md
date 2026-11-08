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
