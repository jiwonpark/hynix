import asyncio
import json

from backend.binance_client import BinanceFuturesClient
from backend.tranche_accounting import aggregate_orders


async def main():
    with open("backend/auto_tranche_state.json") as f:
        pairs = json.load(f)["entry_order_pairs"]
    start = next(i for i, p in enumerate(pairs) if str(p["adr_order_id"]) == "1539800050")
    campaign = pairs[start:]
    adr_ids = {str(p["adr_order_id"]) for p in campaign}
    stock_ids = {str(p["stock_order_id"]) for p in campaign}

    client = BinanceFuturesClient()
    try:
        window = {"startTime": 1790049600000, "limit": 1000}
        raw_adr, raw_stock, overview = await asyncio.gather(
            client.request("GET", "/fapi/v1/userTrades", {"symbol": "SKHYUSDT", **window}, signed=True),
            client.request("GET", "/fapi/v1/userTrades", {"symbol": "CSOPSKHYNIX2LUSDT", **window}, signed=True),
            client.get_detailed_account_overview(),
        )
    finally:
        await client.close()

    executions = []
    for symbol, trades in (("SKHYUSDT", raw_adr), ("CSOPSKHYNIX2LUSDT", raw_stock)):
        for t in trades:
            executions.append({
                "id": str(t["id"]), "order_id": str(t["orderId"]), "symbol": symbol,
                "side": t["side"], "price": float(t["price"]), "qty": float(t["qty"]),
                "commission": float(t.get("commission", 0)),
                "commission_asset": t.get("commissionAsset", "USDT"), "time": int(t["time"]),
            })
    orders = aggregate_orders(executions)
    selected = [o for o in orders if o["order_id"] in adr_ids or o["order_id"] in stock_ids]
    positions = {p["symbol"]: p for p in overview["positions"]}
    adr_mark = float(positions["SKHYUSDT"]["mark_price"])
    stock_mark = float(positions["CSOPSKHYNIX2LUSDT"]["mark_price"])
    gross = fees = adr_pnl = stock_pnl = 0.0
    for o in selected:
        px = o["cost"] / o["qty"]
        pnl = o["qty"] * ((px - adr_mark) if o["symbol"] == "SKHYUSDT" else (stock_mark - px))
        gross += pnl
        fees += o["fee"]
        if o["symbol"] == "SKHYUSDT": adr_pnl += pnl
        else: stock_pnl += pnl
    exit_fee_estimate = sum(o["qty"] * (adr_mark if o["symbol"] == "SKHYUSDT" else stock_mark) for o in selected) * 0.0005
    print(json.dumps({
        "campaign_pairs": len(campaign), "matched_orders": len(selected),
        "adr_mark": adr_mark, "stock_mark": stock_mark,
        "adr_gross_pnl": adr_pnl, "stock_gross_pnl": stock_pnl,
        "combined_gross_pnl": gross, "entry_fees": fees,
        "net_after_entry_fees": gross - fees,
        "estimated_exit_fees": exit_fee_estimate,
        "net_if_closed_now_before_slippage_funding": gross - fees - exit_fee_estimate,
    }, indent=2))


asyncio.run(main())
