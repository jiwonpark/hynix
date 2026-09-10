import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Dict, Any, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from .config import config
from .binance_client import BinanceFuturesClient
from .upbit_client import UpbitClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("skhynix-daemon")

binance_client = BinanceFuturesClient()
upbit_client = UpbitClient()

# Active WebSocket connections for live push
active_connections: List[WebSocket] = []

async def account_broadcaster():
    """Background task to broadcast multi-exchange account updates to all connected WebSockets."""
    while True:
        try:
            if active_connections:
                b_overview, u_overview = await asyncio.gather(
                    binance_client.get_detailed_account_overview(),
                    upbit_client.get_detailed_account_overview(),
                    return_exceptions=True
                )
                if isinstance(b_overview, Exception):
                    b_overview = {"authenticated": False, "error": str(b_overview), "summary": {}, "assets": [], "positions": []}
                if isinstance(u_overview, Exception):
                    u_overview = {"authenticated": False, "error": str(u_overview), "summary": {}, "assets": []}

                payload = {
                    "type": "multi_exchange_feed",
                    "binance": b_overview,
                    "upbit": u_overview,
                    "server_time_ms": int(asyncio.get_event_loop().time() * 1000)
                }

                dead_connections = []
                for ws in active_connections:
                    try:
                        await ws.send_json(payload)
                    except Exception:
                        dead_connections.append(ws)
                for ws in dead_connections:
                    if ws in active_connections:
                        active_connections.remove(ws)
        except Exception as e:
            logger.error(f"Error in account broadcaster: {e}")
        await asyncio.sleep(3)  # Broadcast every 3 seconds

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting SK Hynix Trading & Multi-Exchange Telemetry Daemon...")
    logger.info(f"Connecting to Binance ({'TESTNET' if config.USE_TESTNET else 'PRODUCTION'})...")
    if config.BINANCE_API_KEY:
        masked_binance = config.BINANCE_API_KEY[:6] + "..." + config.BINANCE_API_KEY[-4:]
        logger.info(f"Loaded Binance API Key from {config.AUTH_SOURCE}: {masked_binance}")
    else:
        logger.warning("No Binance API Key detected.")

    if config.UPBIT_ACCESS_KEY:
        masked_upbit = config.UPBIT_ACCESS_KEY[:6] + "..." + config.UPBIT_ACCESS_KEY[-4:]
        logger.info(f"Loaded Upbit Access Key from {config.UPBIT_AUTH_SOURCE}: {masked_upbit}")
    else:
        logger.warning("No Upbit Access Key detected (checked .env, arbiter/keys.json, midas/keys.json).")

    broadcaster_task = asyncio.create_task(account_broadcaster())
    yield
    broadcaster_task.cancel()
    await asyncio.gather(binance_client.close(), upbit_client.close(), return_exceptions=True)
    logger.info("SK Hynix Trading Daemon shutdown complete.")

app = FastAPI(
    title="SK Hynix Arbitrage Trading Daemon",
    version="1.1.0",
    description="Automated execution daemon and multi-exchange account telemetry engine (Binance & Upbit).",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/klines")
async def get_klines(symbol: str, interval: str = "15m", limit: int = 1000, endTime: Optional[int] = None):
    """Proxy Binance Futures klines endpoint to bypass browser CORS / ISP blocks with server-side speed."""
    params = {"symbol": symbol, "interval": interval, "limit": min(1500, max(1, limit))}
    if endTime:
        params["endTime"] = endTime
    try:
        data = await binance_client.request("GET", "/fapi/v1/klines", params=params)
        return data
    except Exception as e:
        logger.error(f"Error fetching klines for {symbol}: {e}")
        return []

@app.get("/api/health")
async def health_check() -> Dict[str, Any]:
    ping_ok = await binance_client.ping()
    return {
        "status": "online",
        "binance_connected": ping_ok,
        "binance_authenticated": bool(config.BINANCE_API_KEY and config.BINANCE_API_SECRET),
        "binance_auth_source": config.AUTH_SOURCE,
        "upbit_authenticated": bool(config.UPBIT_ACCESS_KEY and config.UPBIT_SECRET_KEY),
        "upbit_auth_source": config.UPBIT_AUTH_SOURCE,
        "use_testnet": config.USE_TESTNET,
        "server_time_ms": int(asyncio.get_event_loop().time() * 1000)
    }

@app.get("/api/account")
async def get_account() -> Dict[str, Any]:
    """Returns Binance total equity, balances, margin metrics, and active positions."""
    try:
        data = await binance_client.get_detailed_account_overview()
        data["auth_source"] = config.AUTH_SOURCE
        data["use_testnet"] = config.USE_TESTNET
        return data
    except Exception as e:
        logger.exception("Error fetching Binance account overview")
        return {
            "authenticated": False,
            "auth_source": config.AUTH_SOURCE,
            "error": str(e),
            "summary": {},
            "assets": [],
            "positions": []
        }

@app.get("/api/upbit/account")
async def get_upbit_account() -> Dict[str, Any]:
    """Returns Upbit KRW equity, crypto asset breakdown, valuations, and return rates."""
    try:
        return await upbit_client.get_detailed_account_overview()
    except Exception as e:
        logger.exception("Error fetching Upbit account overview")
        return {
            "authenticated": False,
            "auth_source": config.UPBIT_AUTH_SOURCE,
            "error": str(e),
            "summary": {},
            "assets": []
        }

@app.get("/api/portfolio/overview")
async def get_portfolio_overview() -> Dict[str, Any]:
    """Combined multi-exchange portfolio overview across Binance Futures and Upbit Spot."""
    try:
        b_data, u_data = await asyncio.gather(
            binance_client.get_detailed_account_overview(),
            upbit_client.get_detailed_account_overview(),
            return_exceptions=True
        )
        if isinstance(b_data, Exception):
            b_data = {"authenticated": False, "error": str(b_data), "summary": {}, "assets": [], "positions": []}
        if isinstance(u_data, Exception):
            u_data = {"authenticated": False, "error": str(u_data), "summary": {}, "assets": []}

        b_eq_usd = float(b_data.get("summary", {}).get("total_equity_usd", 0.0))
        u_eq_usd = float(u_data.get("summary", {}).get("total_equity_usd", 0.0))
        u_eq_krw = float(u_data.get("summary", {}).get("total_equity_krw", 0.0))
        rate = float(u_data.get("summary", {}).get("usdt_krw_rate", 1400.0))

        total_combined_usd = b_eq_usd + u_eq_usd

        return {
            "combined_equity_usd": round(total_combined_usd, 2),
            "combined_equity_krw": round(total_combined_usd * rate, 2),
            "usdt_krw_rate": rate,
            "binance": {
                "authenticated": b_data.get("authenticated", False),
                "auth_source": config.AUTH_SOURCE,
                "equity_usd": b_eq_usd,
                "open_positions": len(b_data.get("positions", [])),
                "assets_count": len(b_data.get("assets", []))
            },
            "upbit": {
                "authenticated": u_data.get("authenticated", False),
                "auth_source": config.UPBIT_AUTH_SOURCE,
                "equity_krw": u_eq_krw,
                "equity_usd": u_eq_usd,
                "assets_count": len(u_data.get("assets", []))
            },
            "details": {
                "binance": b_data,
                "upbit": u_data
            }
        }
    except Exception as e:
        logger.exception("Error synthesizing combined portfolio")
        return {"error": str(e)}

@app.get("/api/positions")
async def get_positions() -> Dict[str, Any]:
    """Returns only the list of active open positions."""
    try:
        overview = await binance_client.get_detailed_account_overview()
        return {
            "positions": overview.get("positions", []),
            "open_position_count": len(overview.get("positions", []))
        }
    except Exception as e:
        return {"error": str(e), "positions": []}

@app.get("/api/trade/hedged_status")
async def get_hedged_status() -> Dict[str, Any]:
    """Calculates real-time live metrics for the hedged SK Hynix arbitrage position."""
    try:
        overview = await binance_client.get_detailed_account_overview()
        if not overview.get("authenticated"):
            return {
                "authenticated": False,
                "error": overview.get("error", "Not authenticated"),
                "status": "unauthenticated"
            }

        positions = overview.get("positions", [])
        summary = overview.get("summary", {})
        equity = float(summary.get("total_equity_usd", 0.0))
        avail_margin = float(summary.get("available_margin_usd", 0.0))
        maint_margin = float(summary.get("maintenance_margin_usd", 0.0))
        margin_ratio = float(summary.get("margin_ratio_percent", 0.0))

        adr_pos = next((p for p in positions if p.get("symbol") == "SKHYUSDT"), None)
        stock_pos = next((p for p in positions if p.get("symbol") == "CSOPSKHYNIX2LUSDT"), None)
        if not stock_pos:
            stock_pos = next((p for p in positions if p.get("symbol") == "SKHYNIXUSDT"), None)

        adr_notional = float(adr_pos.get("notional", 0.0)) if adr_pos else 0.0
        stock_notional = float(stock_pos.get("notional", 0.0)) if stock_pos else 0.0
        adr_pnl = float(adr_pos.get("unrealized_pnl", 0.0)) if adr_pos else 0.0
        stock_pnl = float(stock_pos.get("unrealized_pnl", 0.0)) if stock_pos else 0.0

        total_notional = adr_notional + stock_notional
        current_leverage = (total_notional / equity) if equity > 0 else 0.0
        combined_pnl = adr_pnl + stock_pnl
        combined_pnl_pct = (combined_pnl / equity * 100.0) if equity > 0 else 0.0
        # CSOP is a 2x leveraged ETF perp, so its effective delta is 2.0x notional
        effective_stock_delta = stock_notional * 2.0
        net_delta = effective_stock_delta - adr_notional

        adr_mark = float(adr_pos.get("mark_price", 0.0)) if adr_pos else 0.0
        stock_mark = float(stock_pos.get("mark_price", 0.0)) if stock_pos else 0.0
        adr_entry = float(adr_pos.get("entry_price", 0.0)) if adr_pos else 0.0
        stock_entry = float(stock_pos.get("entry_price", 0.0)) if stock_pos else 0.0

        stock_sym = stock_pos.get("symbol") if stock_pos else ""

        # Retrieve live domestic Korean share price (SKHYNIXUSDT contract = 10 domestic shares)
        # to calculate the true ADR vs. Domestic Parity ratio (~135% - 139%)
        domestic_price = None
        if stock_sym == "SKHYNIXUSDT" and stock_mark > 0:
            domestic_price = stock_mark / 10.0
        else:
            try:
                ticker = await binance_client.request("GET", "/fapi/v1/ticker/price", {"symbol": "SKHYNIXUSDT"})
                if ticker and "price" in ticker:
                    domestic_price = float(ticker["price"]) / 10.0
            except Exception:
                pass

        if not domestic_price and stock_mark > 0:
            # CSOP fallback estimation (CSOP is roughly 1/24.5th of domestic share price)
            domestic_price = stock_mark * 24.5

        if domestic_price and adr_mark > 0:
            current_spread = (adr_mark / domestic_price) * 100.0
            if stock_sym == "CSOPSKHYNIX2LUSDT" and stock_entry > 0 and stock_mark > 0:
                csop_pct = (stock_mark - stock_entry) / stock_entry
                domestic_entry = domestic_price / (1.0 + (csop_pct / 2.0))
                entry_spread = (adr_entry / domestic_entry) * 100.0 if domestic_entry > 0 else current_spread
            elif stock_sym == "SKHYNIXUSDT" and stock_entry > 0:
                entry_spread = (adr_entry / (stock_entry / 10.0)) * 100.0
            else:
                entry_spread = current_spread
        else:
            current_spread = (adr_mark / (stock_mark * 34.0) * 100.0) if stock_mark > 0 else None
            entry_spread = (adr_entry / (stock_entry * 34.0) * 100.0) if stock_entry > 0 else None

        stock_qty = abs(float(stock_pos.get("position_amt", 0.0))) if stock_pos else 0.0
        adr_qty = abs(float(adr_pos.get("position_amt", 0.0))) if adr_pos else 0.0
        tranches_active = round(stock_qty / 1.20) if stock_qty > 0 else 0

        loss_on_10pct = adr_notional * 0.10
        free_buffer = max(0.0, equity - maint_margin)
        max_tolerable_div_pct = (free_buffer / adr_notional * 100.0) if adr_notional > 0 else 999.0

        eligible_for_take_profit = bool(total_notional > 0 and combined_pnl > 0.02)

        # Exposure converted to SKHY and Korean domestic shares
        adr_amt = float(adr_pos.get("position_amt", 0.0)) if adr_pos else 0.0
        stock_amt = float(stock_pos.get("position_amt", 0.0)) if stock_pos else 0.0

        adr_skhy_shares = adr_amt
        adr_krx_shares = adr_amt * 0.1
        if stock_sym == "CSOPSKHYNIX2LUSDT":
            stock_delta_usd = stock_amt * stock_mark * 2.0
            stock_skhy_shares = (stock_delta_usd / adr_mark) if adr_mark > 0 else 0.0
            stock_krx_shares = stock_skhy_shares * 0.1
        elif stock_sym == "SKHYNIXUSDT":
            stock_krx_shares = stock_amt
            stock_skhy_shares = stock_amt * 10.0
        else:
            stock_skhy_shares = 0.0
            stock_krx_shares = 0.0

        net_skhy_shares = adr_skhy_shares + stock_skhy_shares
        net_krx_shares = adr_krx_shares + stock_krx_shares

        return {
            "authenticated": True,
            "equity_usd": equity,
            "available_margin_usd": avail_margin,
            "maintenance_margin_usd": maint_margin,
            "margin_ratio_percent": margin_ratio,
            "tranches_active": tranches_active,
            "adr_position": adr_pos,
            "stock_position": stock_pos,
            "adr_qty": adr_qty,
            "stock_qty": stock_qty,
            "adr_notional_usd": adr_notional,
            "stock_notional_usd": stock_notional,
            "total_notional_usd": total_notional,
            "gross_leverage": round(current_leverage, 2),
            "net_delta_imbalance_usd": round(net_delta, 2),
            "combined_unrealized_pnl_usd": round(combined_pnl, 2),
            "combined_unrealized_pnl_pct": round(combined_pnl_pct, 2),
            "current_spread_pct": round(current_spread, 2) if current_spread else None,
            "entry_spread_pct": round(entry_spread, 2) if entry_spread else None,
            "loss_on_10pct_divergence_usd": round(loss_on_10pct, 2),
            "max_tolerable_divergence_pct": round(max_tolerable_div_pct, 1),
            "adr_skhy_shares": round(adr_skhy_shares, 4),
            "stock_skhy_shares": round(stock_skhy_shares, 4),
            "net_skhy_shares": round(net_skhy_shares, 4),
            "adr_krx_shares": round(adr_krx_shares, 5),
            "stock_krx_shares": round(stock_krx_shares, 5),
            "net_krx_shares": round(net_krx_shares, 5),
            "eligible_for_take_profit": eligible_for_take_profit,
            "zero_loss_rule": {
                "rule_name": "Zero-Loss Structural Convergence Invariant",
                "status": "ENFORCED",
                "can_reduce": eligible_for_take_profit,
                "description": "Never exit at a loss. Only take profit when Net Realized PnL > 0. If divergence widens: Scale in or Hold."
            }
        }
    except Exception as e:
        logger.exception("Error in get_hedged_status")
        return {"error": str(e)}

@app.post("/api/trade/step_tranche")
async def step_tranche() -> Dict[str, Any]:
    """
    Executes +1 Tranche:
    - Sets 10x leverage and CROSSED margin on SKHYUSDT and CSOPSKHYNIX2LUSDT
    - SELL MARKET 0.07 SKHYUSDT (Short ADR)
    - BUY MARKET 1.20 CSOPSKHYNIX2LUSDT (Long CSOP 2x ETF Perp)
    """
    try:
        overview = await binance_client.get_detailed_account_overview()
        if not overview.get("authenticated"):
            return {"success": False, "error": "Binance client not authenticated"}

        avail = float(overview.get("summary", {}).get("available_margin_usd", 0.0))
        if avail < 2.50:
            return {"success": False, "error": f"Insufficient available margin: ${avail:.2f} < $2.50 required"}

        # Configure leverage & margin type
        await asyncio.gather(
            binance_client.set_leverage("SKHYUSDT", 10),
            binance_client.set_leverage("CSOPSKHYNIX2LUSDT", 10),
            binance_client.set_margin_type("SKHYUSDT", "CROSSED"),
            binance_client.set_margin_type("CSOPSKHYNIX2LUSDT", "CROSSED"),
            return_exceptions=True
        )

        order_adr = await binance_client.create_order("SKHYUSDT", "SELL", 0.07, "MARKET")
        order_stock = await binance_client.create_order("CSOPSKHYNIX2LUSDT", "BUY", 1.20, "MARKET")

        return {
            "success": True,
            "message": "Tranche executed successfully: Short 0.07 SKHYUSDT + Long 1.20 CSOPSKHYNIX2LUSDT",
            "order_adr": order_adr,
            "order_stock": order_stock
        }
    except Exception as e:
        logger.exception("Error executing tranche step")
        return {"success": False, "error": str(e)}

@app.post("/api/trade/reduce_tranche")
async def reduce_tranche() -> Dict[str, Any]:
    """
    Closes 1 Tranche (Take-Profit):
    - STRICTLY ENFORCES ZERO-LOSS INVARIANT: Rejects order if combined unrealized PnL <= 0!
    - BUY MARKET 0.07 SKHYUSDT
    - SELL MARKET 1.20 CSOPSKHYNIX2LUSDT
    """
    try:
        overview = await binance_client.get_detailed_account_overview()
        positions = overview.get("positions", [])
        adr_pos = next((p for p in positions if p.get("symbol") == "SKHYUSDT"), None)
        stock_pos = next((p for p in positions if p.get("symbol") in ["CSOPSKHYNIX2LUSDT", "SKHYNIXUSDT"]), None)

        if not adr_pos or not stock_pos:
            return {"success": False, "error": "No active hedged positions found to reduce"}

        combined_pnl = float(adr_pos.get("unrealized_pnl", 0.0)) + float(stock_pos.get("unrealized_pnl", 0.0))
        if combined_pnl <= 0.01:
            return {
                "success": False,
                "error": f"ZERO-LOSS INVARIANT ENFORCED: Combined PnL is ${combined_pnl:.2f}. You cannot exit at a loss. Wait for convergence or add tranches."
            }

        stock_sym = stock_pos.get("symbol", "CSOPSKHYNIX2LUSDT")
        stock_reduce_qty = 1.20 if stock_sym == "CSOPSKHYNIX2LUSDT" else 0.01

        order_adr, order_stock = await asyncio.gather(
            binance_client.create_order("SKHYUSDT", "BUY", 0.07, "MARKET", reduce_only=True),
            binance_client.create_order(stock_sym, "SELL", stock_reduce_qty, "MARKET", reduce_only=True),
            return_exceptions=True
        )

        if isinstance(order_adr, Exception):
            return {"success": False, "error": f"Failed to close ADR: {order_adr}"}
        if isinstance(order_stock, Exception):
            return {"success": False, "error": f"Failed to close Stock/ETF: {order_stock}"}

        return {
            "success": True,
            "message": f"Take-profit tranche closed successfully with positive PnL (+${combined_pnl:.2f})",
            "order_adr": order_adr,
            "order_stock": order_stock
        }
    except Exception as e:
        logger.exception("Error reducing tranche")
        return {"success": False, "error": str(e)}

@app.post("/api/trade/flatten")
async def flatten_positions(emergency: bool = False) -> Dict[str, Any]:
    """
    Emergency market close of both legs.
    """
    try:
        overview = await binance_client.get_detailed_account_overview()
        positions = overview.get("positions", [])
        symbols_to_close = ["SKHYUSDT", "CSOPSKHYNIX2LUSDT", "SKHYNIXUSDT"]

        results = []
        for sym in symbols_to_close:
            pos = next((p for p in positions if p.get("symbol") == sym), None)
            if pos:
                amt = float(pos.get("position_amt", 0.0))
                if abs(amt) > 0.001:
                    side = "BUY" if amt < 0 else "SELL"
                    res = await binance_client.create_order(sym, side, abs(amt), "MARKET", reduce_only=True)
                    results.append(res)

        return {"success": True, "message": "All hedged positions flattened", "orders": results}
    except Exception as e:
        logger.exception("Error flattening positions")
        return {"success": False, "error": str(e)}

@app.websocket("/ws/account")
async def websocket_account_feed(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    try:
        # Send initial snapshot immediately
        b_data, u_data = await asyncio.gather(
            binance_client.get_detailed_account_overview(),
            upbit_client.get_detailed_account_overview(),
            return_exceptions=True
        )
        if isinstance(b_data, Exception):
            b_data = {"authenticated": False, "error": str(b_data)}
        if isinstance(u_data, Exception):
            u_data = {"authenticated": False, "error": str(u_data)}

        await websocket.send_json({
            "type": "initial_snapshot",
            "binance": b_data,
            "upbit": u_data
        })
        while True:
            # Keep alive and listen for client messages
            await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in active_connections:
            active_connections.remove(websocket)
    except Exception:
        if websocket in active_connections:
            active_connections.remove(websocket)

if __name__ == "__main__":
    uvicorn.run("backend.server:app", host=config.HOST, port=config.PORT, reload=False)

