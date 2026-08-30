import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Dict, Any, List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from .config import config
from .binance_client import BinanceFuturesClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("skhynix-daemon")

binance_client = BinanceFuturesClient()

# Active WebSocket connections for live push
active_connections: List[WebSocket] = []

async def account_broadcaster():
    """Background task to broadcast account updates to all connected WebSockets."""
    while True:
        try:
            if active_connections:
                overview = await binance_client.get_detailed_account_overview()
                dead_connections = []
                for ws in active_connections:
                    try:
                        await ws.send_json(overview)
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
    logger.info("Starting SK Hynix Trading & Telemetry Daemon...")
    logger.info(f"Connecting to Binance ({'TESTNET' if config.USE_TESTNET else 'PRODUCTION'})...")
    if config.BINANCE_API_KEY:
        masked_key = config.BINANCE_API_KEY[:6] + "..." + config.BINANCE_API_KEY[-4:]
        logger.info(f"Loaded Binance API Key: {masked_key}")
    else:
        logger.warning("No Binance API Key detected. Account data will return mock/unauthenticated status.")
    
    broadcaster_task = asyncio.create_task(account_broadcaster())
    yield
    broadcaster_task.cancel()
    await binance_client.close()
    logger.info("SK Hynix Trading Daemon shutdown complete.")

app = FastAPI(
    title="SK Hynix Arbitrage Trading Daemon",
    version="1.0.0",
    description="Automated execution daemon and account telemetry engine for SK Hynix Perp Arbitrage.",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/health")
async def health_check() -> Dict[str, Any]:
    ping_ok = await binance_client.ping()
    return {
        "status": "online",
        "binance_connected": ping_ok,
        "authenticated": bool(config.BINANCE_API_KEY and config.BINANCE_API_SECRET),
        "auth_source": config.AUTH_SOURCE,
        "use_testnet": config.USE_TESTNET,
        "server_time_ms": int(asyncio.get_event_loop().time() * 1000)
    }

@app.get("/api/account")
async def get_account() -> Dict[str, Any]:
    """Returns total equity, balances, margin metrics, and active positions."""
    try:
        data = await binance_client.get_detailed_account_overview()
        data["auth_source"] = config.AUTH_SOURCE
        data["use_testnet"] = config.USE_TESTNET
        return data
    except Exception as e:
        logger.exception("Error fetching account overview")
        return {
            "authenticated": False,
            "auth_source": config.AUTH_SOURCE,
            "error": str(e),
            "summary": {},
            "assets": [],
            "positions": []
        }

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
        initial_data = await binance_client.get_detailed_account_overview()
        await websocket.send_json(initial_data)
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
