import asyncio
from backend.config import config
from backend.binance_client import BinanceFuturesClient
from backend.upbit_client import UpbitClient

async def main():
    print("=" * 60)
    print("  SK Hynix Arbitrage Multi-Exchange Status Diagnostic")
    print("=" * 60)

    # 1. Binance Check
    print("\n--- [1. Binance Futures] ---")
    print(f"Base URL: {config.BASE_URL}")
    print(f"Auth Source: {config.AUTH_SOURCE}")
    print(f"API Key present: {bool(config.BINANCE_API_KEY)}")
    print(f"API Secret present: {bool(config.BINANCE_API_SECRET)}")

    binance_client = BinanceFuturesClient()
    try:
        b_overview = await binance_client.get_detailed_account_overview()
        print(f"Authenticated: {b_overview.get('authenticated')}")
        if b_overview.get('authenticated'):
            s = b_overview.get('summary', {})
            print(f"Total Equity: ${s.get('total_equity_usd', 0.0):,.2f}")
            print(f"Available Margin: ${s.get('available_margin_usd', 0.0):,.2f}")
            print(f"Unrealized PnL: ${s.get('total_unrealized_pnl_usd', 0.0):,.2f}")
            print(f"Margin Ratio: {s.get('margin_ratio_percent', 0.0):.2f}%")
            print(f"Assets: {len(b_overview.get('assets', []))} non-zero")
            for a in b_overview.get('assets', [])[:5]:
                print(f"  - {a['asset']}: Wallet={a['wallet_balance']} | Margin=${a['margin_balance']:,.2f}")
            print(f"Open Positions: {len(b_overview.get('positions', []))}")
            for p in b_overview.get('positions', []):
                print(f"  - {p['symbol']} ({p['side']} {p['leverage']}x): Notional=${p['notional']:,.2f} | PnL=${p['unrealized_pnl']:.2f}")
        else:
            print(f"Notice: {b_overview.get('error')}")
    except Exception as e:
        print(f"Binance Check Error: {e}")
    finally:
        await binance_client.close()

    # 2. Upbit Check
    print("\n--- [2. Upbit Spot] ---")
    print(f"Base URL: {config.UPBIT_BASE_URL}")
    print(f"Auth Source: {config.UPBIT_AUTH_SOURCE}")
    print(f"Access Key present: {bool(config.UPBIT_ACCESS_KEY)}")
    print(f"Secret Key present: {bool(config.UPBIT_SECRET_KEY)}")

    upbit_client = UpbitClient()
    try:
        u_overview = await upbit_client.get_detailed_account_overview()
        print(f"Authenticated: {u_overview.get('authenticated')}")
        if u_overview.get('authenticated'):
            s = u_overview.get('summary', {})
            print(f"Total Equity: ₩{s.get('total_equity_krw', 0.0):,.0f} (~${s.get('total_equity_usd', 0.0):,.2f})")
            print(f"Cash Balance: ₩{s.get('cash_krw', 0.0):,.0f} (Locked: ₩{s.get('locked_krw', 0.0):,.0f})")
            print(f"Crypto Valuation: ₩{s.get('crypto_eval_krw', 0.0):,.0f}")
            print(f"Total Unrealized PnL: ₩{s.get('total_unrealized_pnl_krw', 0.0):,.0f} ({s.get('total_return_pct', 0.0):+.2f}%)")
            print(f"USDT/KRW Rate: ₩{s.get('usdt_krw_rate', 1400.0):,.1f}")
            print(f"Assets: {len(u_overview.get('assets', []))} non-zero")
            for a in u_overview.get('assets', []):
                print(f"  - {a['currency']}: Qty={a['total_quantity']:,.4f} | KRW Value=₩{a['eval_amount_krw']:,.0f} | Return={a['return_rate_percent']:+.2f}%")
        else:
            print(f"Notice: {u_overview.get('error')}")
    except Exception as e:
        print(f"Upbit Check Error: {e}")
    finally:
        await upbit_client.close()

    print("\n" + "=" * 60)

if __name__ == '__main__':
    asyncio.run(main())

