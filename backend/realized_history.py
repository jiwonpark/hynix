"""Read-only history snapshots isolated from the trading/API event loop."""
import asyncio
import copy


async def read_history_snapshot(bot):
    state = copy.deepcopy(bot.state)
    caches = copy.deepcopy(getattr(bot, "_history_reader_caches", {}))

    def read():
        async def run():
            client = type(bot.client)()
            reader = copy.copy(bot)
            reader.state, reader.client = state, client
            reader.lock = asyncio.Lock()
            reader._trade_lock = asyncio.Lock()
            reader._pnl_lock = asyncio.Lock()
            reader._trade_cache = caches.get("trades")
            reader._pnl_cache = caches.get("pnl")

            def no_save():
                raise RuntimeError("History reader cannot write trading state")

            reader._save = no_save
            try:
                result = await reader.reconciled_public_state()
                if result.get("pnl_reconciliation", {}).get("error"):
                    raise RuntimeError(result["pnl_reconciliation"]["error"])
                return result, {"trades": reader._trade_cache, "pnl": reader._pnl_cache}
            finally:
                await client.close()
        return asyncio.run(run())

    # Signer initialization can perform synchronous HTTP. Neither it nor its
    # asyncio locks/sessions may run on or be shared with the API loop.
    result, caches = await asyncio.to_thread(read)
    bot._history_reader_caches = caches
    return result


def apply_history_snapshot(current, cached):
    """Apply verified rows without replacing current positions or newer fills."""
    if not cached:
        return current
    verified = {(e.get("symbol"), str(e.get("order_id"))): e
                for e in cached.get("execution_history", [])
                if e.get("event") == "EXIT" and e.get("pnl_authoritative")}
    for row in current.get("execution_history", []):
        match = verified.get((row.get("symbol"), str(row.get("order_id"))))
        qty = float(row.get("qty", 0) or 0)
        if (row.get("event") == "EXIT" and match
                and int(row.get("side", 0)) == int(match.get("side", 0))
                and abs(qty - float(match.get("qty", 0))) <= max(1e-12, qty * 1e-6)):
            row.update(copy.deepcopy(match))
    exits = [e for e in current.get("execution_history", [])
             if e.get("event") == "EXIT" and e.get("pnl_authoritative")]
    current["verified_exit_count"] = len(exits)
    current["verified_realized_pnl_usd"] = sum(float(e["net_pnl_usd"]) for e in exits)
    if "pnl_reconciliation" in cached:
        current["pnl_reconciliation"] = copy.deepcopy(cached["pnl_reconciliation"])
    return current
