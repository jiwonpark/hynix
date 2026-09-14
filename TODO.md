# TODO

## Deferred

- [ ] Replace the latest-1,000-fill tranche reconstruction limit with paginated
  Binance `userTrades` recovery (using `fromId`) and a persistent local execution
  ledger/checkpoint. The current limit is acceptable for the present trade volume,
  but older active speculative entries can eventually fall outside the recovery
  window and be conservatively misclassified as protected core inventory.
