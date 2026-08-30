import asyncio
from backend.config import config
from backend.binance_client import BinanceFuturesClient

async def main():
    print(f"[Config] Base URL: {config.BASE_URL}")
    print(f"[Config] API Key present: {bool(config.BINANCE_API_KEY)}")
    print(f"[Config] API Secret present: {bool(config.BINANCE_API_SECRET)}")
    
    client = BinanceFuturesClient()
    ping_ok = await client.ping()
    print(f"[Binance] Ping Status: {'OK' if ping_ok else 'FAILED'}")
    
    overview = await client.get_detailed_account_overview()
    print(f"[Account] Authenticated: {overview.get('authenticated')}")
    if overview.get('authenticated'):
        s = overview.get('summary', {})
        print(f"[Account] Total Equity: ${s.get('total_equity_usd', 0.0):,.2f}")
        print(f"[Account] Available Margin: ${s.get('available_margin_usd', 0.0):,.2f}")
        print(f"[Account] Unrealized PnL: ${s.get('total_unrealized_pnl_usd', 0.0):,.2f}")
        print(f"[Account] Margin Ratio: {s.get('margin_ratio_percent', 0.0):.2f}%")
        print(f"[Account] Non-Zero Assets Count: {len(overview.get('assets', []))}")
        for a in overview.get('assets', []):
            print(f"  - {a['asset']}: Wallet={a['wallet_balance']} | Margin={a['margin_balance']} | Avail={a['available_balance']}")
        print(f"[Account] Open Positions Count: {len(overview.get('positions', []))}")
        for p in overview.get('positions', []):
            print(f"  - {p['symbol']} ({p['side']} {p['leverage']}x): Notional=${p['notional']} | PnL=${p['unrealized_pnl']:.2f} ({p['roe_percent']:.2f}%)")
    else:
        print(f"[Account] Notice: {overview.get('error')}")
    await client.close()

if __name__ == '__main__':
    asyncio.run(main())
