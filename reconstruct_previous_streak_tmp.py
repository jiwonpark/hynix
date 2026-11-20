import asyncio
import json
from datetime import datetime, timezone, timedelta

from backend.binance_client import BinanceFuturesClient
from backend.tranche_accounting import aggregate_orders

KST = timezone(timedelta(hours=9))


async def main():
    client = BinanceFuturesClient()
    try:
        raw = {}
        for symbol in ("SKHYUSDT", "CSOPSKHYNIX2LUSDT"):
            raw[symbol] = await client.request(
                "GET", "/fapi/v1/userTrades", {"symbol": symbol, "limit": 1000}, signed=True
            )
    finally:
        await client.close()

    executions = []
    for symbol, trades in raw.items():
        for trade in trades:
            executions.append({
                "id": str(trade.get("id", "")),
                "order_id": str(trade.get("orderId", trade.get("id", ""))),
                "symbol": symbol,
                "side": trade.get("side", ""),
                "price": float(trade.get("price", 0)),
                "qty": float(trade.get("qty", 0)),
                "commission": float(trade.get("commission", 0)),
                "commission_asset": str(trade.get("commissionAsset", "USDT")),
                "time": int(trade.get("time", 0)),
            })

    orders = aggregate_orders(executions)
    with open("backend/auto_tranche_state.json") as state_file:
        pairs = json.load(state_file).get("entry_order_pairs", [])
    saved = {str(p["adr_order_id"]): p for p in pairs}

    # The immediately previous completed exit campaign, as seen in the order tape.
    exit_start = datetime(2026, 9, 21, 14, 29, tzinfo=timezone.utc).timestamp() * 1000
    exit_end = datetime(2026, 9, 21, 15, 14, tzinfo=timezone.utc).timestamp() * 1000
    current_start = datetime(2026, 9, 22, 4, 5, tzinfo=timezone.utc).timestamp() * 1000

    adr_entries = [o for o in orders if o["symbol"] == "SKHYUSDT" and o["side"] == "SELL" and o["time"] < current_start]
    stock_entries = {o["order_id"]: o for o in orders if o["symbol"] == "CSOPSKHYNIX2LUSDT" and o["side"] == "BUY"}
    adr_exits = [o for o in orders if o["symbol"] == "SKHYUSDT" and o["side"] == "BUY" and exit_start <= o["time"] <= exit_end]
    stock_exits = [o for o in orders if o["symbol"] == "CSOPSKHYNIX2LUSDT" and o["side"] == "SELL" and exit_start <= o["time"] <= exit_end]

    # Fetch minute bars for the domestic leg so exit premium uses the production parity definition.
    domestic_by_minute = {}
    cursor = int(exit_start - 60000)
    while cursor <= exit_end + 60000:
        bars = await BinanceFuturesClient().request(
            "GET", "/fapi/v1/klines",
            {"symbol": "SKHYNIXUSDT", "interval": "1m", "startTime": cursor,
             "endTime": int(exit_end + 60000), "limit": 1000},
        )
        if not bars:
            break
        for bar in bars:
            domestic_by_minute[int(bar[0])] = float(bar[4]) / 10.0
        cursor = int(bars[-1][0]) + 60000

    # Production exits one speculative lot from the top of each LIFO stack.
    stack = []
    for entry in adr_entries:
        pair = saved.get(entry["order_id"])
        stock = stock_entries.get(str(pair["stock_order_id"])) if pair else None
        if pair and stock:
            stack.append((entry, stock, pair))

    rows = []
    for adr_exit, stock_exit in zip(adr_exits, stock_exits):
        if not stack:
            break
        adr_entry, stock_entry, pair = stack.pop()
        entry_spread = float(pair.get("entry_spread") or 0)
        minute = (adr_exit["time"] // 60000) * 60000
        domestic = domestic_by_minute.get(minute)
        exit_adr = adr_exit["cost"] / adr_exit["qty"]
        exit_spread = exit_adr / domestic * 100 if domestic else None
        captured_pp = entry_spread - exit_spread if exit_spread is not None else None
        rows.append({
            "n": len(rows) + 1,
            "entry_kst": datetime.fromtimestamp(adr_entry["time"] / 1000, KST).strftime("%m-%d %H:%M:%S"),
            "exit_kst": datetime.fromtimestamp(adr_exit["time"] / 1000, KST).strftime("%m-%d %H:%M:%S"),
            "entry_premium_pct": round(entry_spread, 4),
            "exit_premium_pct": round(exit_spread, 4) if exit_spread is not None else None,
            "captured_percentage_points": round(captured_pp, 4) if captured_pp is not None else None,
            "captured_relative_pct": round(captured_pp / entry_spread * 100, 4) if captured_pp is not None and entry_spread else None,
            "entry_order_id": adr_entry["order_id"],
            "exit_order_id": adr_exit["order_id"],
        })
    print(json.dumps({"count": len(rows), "rows": rows}, indent=2))


asyncio.run(main())
