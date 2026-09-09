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

