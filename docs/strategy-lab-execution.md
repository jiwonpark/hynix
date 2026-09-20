# Strategy Lab execution safety

Strategy Lab mutations require a server-issued, one-hour bearer session. Unlock
using the header switch. Backtests and status remain readable while locked.
Restarting the daemon invalidates existing sessions. The former public frontend
password is no longer used.

The backend reads `backend/terminal_auth.json` (or `TERMINAL_AUTH_FILE`). This
untracked file contains a random hex `salt` and a hex `hash` produced by
`hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1)`.
Keep it readable only by the service user (mode 0600). Missing configuration
fails closed. Never commit a password or this configuration. Unlock attempts
are limited to five per minute across the service.

Live orders have a durable intent/identifier before submission. Exchange reads
reconcile cumulative quantities, trade-weighted prices and paid fees. Partial
sells retain unsold inventory and cost basis. A pending order blocks all further
orders and mode changes. Reconciliation continues while the bot is paused.
A restart reuses the persisted intent; it never resubmits the order.

If submission has an unknown outcome, the bot pauses and looks up that identifier.
An unresolved "order not found" is deliberately not treated as permission to buy
again. Inspect the displayed pending identifier through Upbit order history and
resolve the exchange outcome before any manual recovery. Do not delete the state
file or clear pending state just to resume trading. Failed emergency exits retain
inventory; canceled or partially filled emergency sells may require another
explicit flatten for the remainder once reconciliation finishes.

The live minimum net exit percentage compares the latest tracked LIFO entry's
cost (including entry fee) with estimated sell proceeds after the exit fee.
Emergency flatten bypasses this gate. Actual fills can differ from the estimate.
Backtest condition controls remain research settings; live sizing and minimum
profit are configured separately in the bot controls.

Candle times are opening timestamps. Only finalized candles are cached. A 5m
signal uses hourly information whose close time is no later than its decision
time; historical fills use the next 5m open. Live signals use the latest completed
5m bar and a current ticker; stale 5m signals are skipped.

Run verification with the project's backend dependencies installed:

```
python -m unittest discover -s tests
for test_file in tests/test_*.js; do node "$test_file" || exit; done
```

All exchange calls in execution regression tests are mocked. Deployment checks
must use read-only API calls and must never place test orders.
