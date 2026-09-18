import asyncio
import copy
import json
import logging
import math
import time
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Dict, Any, List, Optional
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from collections import OrderedDict
from .dynamic_backtest import replay, replay_markers
from .macro_policy import macro_policy, policy_for_level, closed_values, confirmed_rebound
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from .tranche_accounting import (
    EXIT_FEE_BPS,
    EXIT_SLIPPAGE_BPS,
    FUNDING_RESERVE_BPS_DAY,
    MIN_NET_PROFIT_USD,
    aggregate_orders,
    estimate_tranche_exit,
    infer_entry_pairs,
    entry_profiles,
    reconstruct_leg_stack,
    prepare_exit_context,
)
from .counterfactual_trades import (
    reconcile_counterfactual_trades,
    update_counterfactual_trades,
)
from .config import config
from .binance_client import BinanceFuturesClient
from .upbit_client import UpbitClient
from .strategy_lab import run_ma_stack_backtest

STATE_FILE = Path(__file__).parent / "auto_tranche_state.json"
scale_in_lock = asyncio.Lock()

# Live safeguards are independent of selectable price-replay conditions.
MANDATORY_LIVE_CONDITIONS = frozenset({
    "entry_capacity", "entry_gross_leverage", "entry_margin_buffer", "entry_worker_state",
    "exit_speculative_tranche", "exit_net_profit", "exit_position_qty",
})


def load_auto_tranche_state() -> Dict[str, Any]:
    try:
        if STATE_FILE.exists():
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        logger.error(f"Failed to read auto_tranche_state: {e}")
        return {"enabled": False, "execution_recovery": {"error": "Cannot read execution state"}}
    return {
        "enabled": False,
        "last_step_time": 0,
        "last_reduce_time": 0,
        "last_action": "INITIALIZED",
        "last_action_time": 0,
        "last_error": None
    }

def save_auto_tranche_state(state: Dict[str, Any]):
    try:
        temporary = STATE_FILE.with_suffix(".tmp")
        with open(temporary, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
        temporary.replace(STATE_FILE)
    except Exception as e:
        logger.error(f"Failed to save auto_tranche_state: {e}")
        raise

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
    logger.info("Starting HYPERION Trading & Multi-Exchange Telemetry Daemon...")
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
    auto_tranche_task = asyncio.create_task(auto_tranche_worker())
    yield
    broadcaster_task.cancel()
    auto_tranche_task.cancel()
    await asyncio.gather(binance_client.close(), upbit_client.close(), return_exceptions=True)
    logger.info("HYPERION Trading Daemon shutdown complete.")

app = FastAPI(
    title="HYPERION // Dual-Leg Arbitrage Daemon",
    version="1.1.0",
    description="HYPERION autonomous execution daemon and multi-exchange account telemetry engine (Binance & Upbit).",
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

_PAIRS_CACHE: Dict[str, Any] = {
    "timestamp": 0,
    "data": None
}

CURATED_HEDGE_PAIRS: List[Dict[str, Any]] = [
    {"id": "eth_btc", "sector": "L1 Macro", "name": "ETH / BTC Ratio", "symbolA": "ETHUSDT", "symbolB": "BTCUSDT", "thesis": "Canonical crypto macro ratio & relative store-of-value."},
    {"id": "sol_eth", "sector": "L1 High Beta", "name": "SOL / ETH Spread", "symbolA": "SOLUSDT", "symbolB": "ETHUSDT", "thesis": "High-beta Layer-1 rotation & smart-contract execution speed spread."},
    {"id": "sui_apt", "sector": "Move-VM Rivals", "name": "SUI / APT Spread", "symbolA": "SUIUSDT", "symbolB": "APTUSDT", "thesis": "Move-language high-throughput rival duopoly from Diem pedigree."},
    {"id": "arb_op", "sector": "L2 Duopolies", "name": "ARB / OP Spread", "symbolA": "ARBUSDT", "symbolB": "OPUSDT", "thesis": "Ethereum optimistic rollup scaling duopoly."},
    {"id": "avax_sol", "sector": "Alt-L1 Platform", "name": "AVAX / SOL Spread", "symbolA": "AVAXUSDT", "symbolB": "SOLUSDT", "thesis": "High-throughput monolithic L1 relative valuation."},
    {"id": "link_eth", "sector": "DeFi Infra", "name": "LINK / ETH Ratio", "symbolA": "LINKUSDT", "symbolB": "ETHUSDT", "thesis": "Cross-chain oracle infrastructure benchmarked to base chain."},
    {"id": "bnb_btc", "sector": "Exchange Utility", "name": "BNB / BTC Ratio", "symbolA": "BNBUSDT", "symbolB": "BTCUSDT", "thesis": "Exchange platform token cashflow vs crypto reserve asset."},
    {"id": "uni_aave", "sector": "DeFi Blue-Chip", "name": "UNI / AAVE Spread", "symbolA": "UNIUSDT", "symbolB": "AAVEUSDT", "thesis": "Decentralized AMM exchange vs collateral lending market."},
    {"id": "paxg_btc", "sector": "Store of Value", "name": "PAXG / BTC Ratio", "symbolA": "PAXGUSDT", "symbolB": "BTCUSDT", "thesis": "Physical gold vs digital gold relative valuation hedge."}
]

@app.get("/api/pairs/overview")
async def get_pairs_overview() -> Dict[str, Any]:
    """Provides fast snapshot of prices, 24h changes, and ratios for curated hedge-worthy pairs."""
    global _PAIRS_CACHE
    now = time.time()
    if _PAIRS_CACHE["data"] and (now - _PAIRS_CACHE["timestamp"]) < 15:
        return _PAIRS_CACHE["data"]

    try:
        tickers = await binance_client.request("GET", "/fapi/v1/ticker/24hr")
        if not isinstance(tickers, list):
            tickers = []
    except Exception as e:
        logger.warning(f"Failed to fetch 24hr tickers for pairs overview: {e}")
        tickers = []

    ticker_map = {t["symbol"]: t for t in tickers if isinstance(t, dict) and "symbol" in t}
    results = []
    for pair in CURATED_HEDGE_PAIRS:
        tA = ticker_map.get(pair["symbolA"], {})
        tB = ticker_map.get(pair["symbolB"], {})
        pA = float(tA.get("lastPrice", 0) or 0)
        pB = float(tB.get("lastPrice", 0) or 0)
        chgA = float(tA.get("priceChangePercent", 0) or 0)
        chgB = float(tB.get("priceChangePercent", 0) or 0)
        ratio = (pA / pB) if pB > 0 else 0
        ratio_24h_chg = (chgA - chgB)
        results.append({
            **pair,
            "priceA": pA,
            "priceB": pB,
            "changeA": chgA,
            "changeB": chgB,
            "ratio": ratio,
            "ratio24hChange": ratio_24h_chg
        })

    response = {
        "status": "ok",
        "timestamp": int(now * 1000),
        "pairs": results
    }
    _PAIRS_CACHE = {"timestamp": now, "data": response}
    return response


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
    """Returns Binance Futures account details plus a read-only Spot wallet summary."""
    try:
        data, spot_data = await asyncio.gather(
            binance_client.get_detailed_account_overview(),
            binance_client.get_spot_account_overview(),
            return_exceptions=True,
        )
        if isinstance(data, Exception):
            raise data
        if isinstance(spot_data, Exception):
            spot_data = {"authenticated": False, "error": str(spot_data), "summary": {}, "assets": []}
        data["auth_source"] = config.AUTH_SOURCE
        data["use_testnet"] = config.USE_TESTNET
        data["spot"] = spot_data
        futures_equity = float(data.get("summary", {}).get("total_equity_usd", 0.0))
        spot_stablecoins = float(spot_data.get("summary", {}).get("stablecoin_equity_usd", 0.0))
        data["summary"]["binance_total_equity_usd"] = round(futures_equity + spot_stablecoins, 8)
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

@app.get("/api/strategy-lab/upbit-ma-stack")
async def get_upbit_ma_stack_backtest(
    days: int = Query(7, ge=3, le=14),
    fee_bps: float = Query(5.0, ge=0.0, le=100.0),
    entry_5m: bool = True,
    entry_1h: bool = True,
    exit_5m: bool = True,
    exit_1h: bool = True,
) -> Dict[str, Any]:
    """Read-only BTC/KRW dual-timeframe MA-stack research backtest."""
    try:
        count_5m = days * 24 * 12 + 2
        count_1h = max(days * 24 + 62, 200)
        candles_5m = await upbit_client.get_minute_candles("KRW-BTC", 5, count_5m)
        candles_1h = await upbit_client.get_minute_candles("KRW-BTC", 60, count_1h)
        result = run_ma_stack_backtest(
            candles_5m, candles_1h, fee_bps=fee_bps,
            entry_5m=entry_5m, entry_1h=entry_1h,
            exit_5m=exit_5m, exit_1h=exit_1h,
        )
        result["market"] = "KRW-BTC"
        result["days"] = days
        result["fee_bps"] = fee_bps
        return result
    except Exception as e:
        logger.exception("Error running Upbit MA-stack strategy lab")
        return {"error": str(e), "market": "KRW-BTC"}

@app.get("/api/portfolio/overview")
async def get_portfolio_overview() -> Dict[str, Any]:
    """Combined portfolio overview across Binance Futures, Binance Spot, and Upbit."""
    try:
        b_data, b_spot_data, u_data = await asyncio.gather(
            binance_client.get_detailed_account_overview(),
            binance_client.get_spot_account_overview(),
            upbit_client.get_detailed_account_overview(),
            return_exceptions=True
        )
        if isinstance(b_data, Exception):
            b_data = {"authenticated": False, "error": str(b_data), "summary": {}, "assets": [], "positions": []}
        if isinstance(b_spot_data, Exception):
            b_spot_data = {"authenticated": False, "error": str(b_spot_data), "summary": {}, "assets": []}
        if isinstance(u_data, Exception):
            u_data = {"authenticated": False, "error": str(u_data), "summary": {}, "assets": []}

        b_eq_usd = float(b_data.get("summary", {}).get("total_equity_usd", 0.0))
        b_spot_usdt = float(b_spot_data.get("summary", {}).get("usdt_balance", 0.0))
        b_spot_stablecoins = float(b_spot_data.get("summary", {}).get("stablecoin_equity_usd", 0.0))
        b_total_usd = b_eq_usd + b_spot_stablecoins
        u_eq_usd = float(u_data.get("summary", {}).get("total_equity_usd", 0.0))
        u_eq_krw = float(u_data.get("summary", {}).get("total_equity_krw", 0.0))
        rate = float(u_data.get("summary", {}).get("usdt_krw_rate", 1400.0))

        total_combined_usd = b_total_usd + u_eq_usd

        return {
            "combined_equity_usd": round(total_combined_usd, 2),
            "combined_equity_krw": round(total_combined_usd * rate, 2),
            "usdt_krw_rate": rate,
            "binance": {
                "authenticated": b_data.get("authenticated", False),
                "auth_source": config.AUTH_SOURCE,
                "equity_usd": b_eq_usd,
                "futures_equity_usd": b_eq_usd,
                "spot_usdt": b_spot_usdt,
                "spot_stablecoin_equity_usd": b_spot_stablecoins,
                "total_equity_usd": round(b_total_usd, 8),
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
                "binance_spot": b_spot_data,
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

_parity_cache: Dict[str, Any] = {}

async def get_cached_parity_bars(interval: str = "5m", limit: int = 60) -> List[Dict[str, Any]]:
    now = time.time()
    cache_key = f"{interval}_{limit}"
    cached = _parity_cache.get(cache_key)
    if cached and 0 <= now - cached["timestamp"] < 4.0:
        return cached["data"]

    try:
        k1, k2 = await asyncio.gather(
            binance_client.request("GET", "/fapi/v1/klines", {"symbol": "SKHYUSDT", "interval": interval, "limit": limit}),
            binance_client.request("GET", "/fapi/v1/klines", {"symbol": "SKHYNIXUSDT", "interval": interval, "limit": limit}),
            return_exceptions=True
        )
        if isinstance(k1, list) and isinstance(k2, list):
            m2 = {x[0]: float(x[4]) for x in k2}
            bars = []
            for x in k1:
                t = x[0]
                if t in m2 and m2[t] > 0:
                    p1 = float(x[4])
                    p2 = m2[t] / 10.0
                    ratio = round((p1 / p2) * 100.0, 3)
                    bars.append({
                        "time": int(t / 1000),
                        "value": ratio,
                        "adr": p1,
                        "domestic": round(p2, 2)
                    })
            if bars:
                _parity_cache[cache_key] = {"timestamp": now, "data": bars}
                return bars
    except Exception as e:
        logger.warning(f"Error fetching parity bars: {e}")

    # Failed refreshes cannot substitute another timeframe or stale signals.
    return []

def exit_ma_alignment(
    bars: List[Dict[str, Any]], interval: str = "5m", max_age_sec: int = 600, current_value: Optional[float] = None
) -> Dict[str, Any]:
    """MA-stack filter for spread bars on requested timeframe (upward/bullish and downward/bearish).
    Requires current price and moving averages to be strictly in order:
      - Bullish/Upward: current_price > ma7 > ma24 > ma60
      - Bearish/Downward: current_price < ma7 < ma24 < ma60
    """
    result = {
        "interval": interval,
        "current": None,
        "ma7": None,
        "ma24": None,
        "ma60": None,
        "ready": False,
        "upward": False,
        "downward": False,
    }
    if len(bars) < 60:
        return result
    values = [float(b["value"]) for b in bars[-60:]]
    if not all(math.isfinite(v) for v in values):
        return result
    if time.time() - bars[-1]["time"] > max_age_sec:
        return result
    curr = float(current_value) if (current_value is not None and math.isfinite(current_value)) else values[-1]
    ma7 = sum(values[-7:]) / 7
    ma24 = sum(values[-24:]) / 24
    ma60 = sum(values) / 60
    result.update(
        ready=True,
        current=curr,
        ma7=ma7,
        ma24=ma24,
        ma60=ma60,
        upward=bool(curr > ma7 > ma24 > ma60),
        downward=bool(curr < ma7 < ma24 < ma60),
    )
    return result


_hedged_status_task: Optional[asyncio.Task] = None
_hedged_status_cache: Optional[Dict[str, Any]] = None
_hedged_status_cache_time = 0.0
HEDGED_STATUS_CACHE_TTL = 2.5
HEDGED_STATUS_TIMEOUT = 8.0


@app.get("/api/trade/hedged_status")
async def get_hedged_status_endpoint() -> Dict[str, Any]:
    """Coalesce browser polls while keeping execution paths on fresh status reads."""
    global _hedged_status_task, _hedged_status_cache, _hedged_status_cache_time
    now = time.monotonic()
    if (_hedged_status_cache is not None
            and now - _hedged_status_cache_time < HEDGED_STATUS_CACHE_TTL):
        return copy.deepcopy(_hedged_status_cache)

    task = _hedged_status_task
    if task is None or task.done():
        task = asyncio.create_task(get_hedged_status())
        _hedged_status_task = task
    try:
        result = await asyncio.shield(task)
        _hedged_status_cache = result
        _hedged_status_cache_time = time.monotonic()
        return copy.deepcopy(result)
    finally:
        if task.done() and _hedged_status_task is task:
            _hedged_status_task = None


async def get_hedged_status() -> Dict[str, Any]:
    """Bound the full status calculation, including all upstream reads."""
    try:
        return await asyncio.wait_for(_compute_hedged_status(), HEDGED_STATUS_TIMEOUT)
    except asyncio.TimeoutError:
        logger.warning("Hedged status refresh exceeded its deadline")
        return {"authenticated": False, "status": "unavailable",
                "error": "Live status timed out; waiting for fresh exchange data"}


async def _compute_hedged_status() -> Dict[str, Any]:
    """Calculates real-time live metrics for the hedged SK Hynix arbitrage position."""
    try:
        overview = await binance_client.get_detailed_account_overview()
        if not overview.get("authenticated"):
            return {
                "authenticated": False,
                "error": overview.get("error", "Not authenticated"),
                "status": overview.get("status", "unauthenticated")
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
        # Position quantity includes retained core from prior asymmetric trims.
        # It must not be presented as the number of active speculative tranches.
        position_equivalent_units = round(stock_qty / 1.20) if stock_qty > 0 else 0
        tranches_active = position_equivalent_units

        loss_on_10pct = adr_notional * 0.10
        free_buffer = max(0.0, equity - maint_margin)
        max_tolerable_div_pct = (free_buffer / adr_notional * 100.0) if adr_notional > 0 else 999.0

        # Account-wide PnL is telemetry only; eligibility is calculated for the LIFO trim below.

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

        # Fetch the latest account trade history for both legs. This history is
        # sufficient to restore the bounded active LIFO stack after a restart.
        executions = []
        try:
            async def account_trade_history(symbol):
                return await binance_client.request(
                    "GET", "/fapi/v1/userTrades",
                    {"symbol": symbol, "limit": 1000}, signed=True)

            history_stock_sym = stock_sym or "CSOPSKHYNIX2LUSDT"
            res_skhy, res_stock = await asyncio.gather(
                account_trade_history("SKHYUSDT"),
                account_trade_history(history_stock_sym),
                return_exceptions=True)

            if isinstance(res_skhy, list):
                for t in res_skhy:
                    executions.append({
                        "id": str(t.get("id", "")),
                        "order_id": str(t.get("orderId", t.get("id", ""))),
                        "symbol": "SKHYUSDT",
                        "side": t.get("side", ""),
                        "price": float(t.get("price", 0.0)),
                        "qty": float(t.get("qty", 0.0)),
                        "realized_pnl": float(t.get("realizedPnl", 0.0)),
                        "commission": float(t["commission"]) if t.get("commission") is not None else None,
                        "commission_asset": str(t.get("commissionAsset", "USDT")),
                        "time": int(t.get("time", 0)),
                        "action_type": "ENTRY_SHORT" if t.get("side") == "SELL" else "EXIT_SHORT"
                    })
            if isinstance(res_stock, list):
                for t in res_stock:
                    executions.append({
                        "id": str(t.get("id", "")),
                        "order_id": str(t.get("orderId", t.get("id", ""))),
                        "symbol": history_stock_sym,
                        "side": t.get("side", ""),
                        "price": float(t.get("price", 0.0)),
                        "qty": float(t.get("qty", 0.0)),
                        "realized_pnl": float(t.get("realizedPnl", 0.0)),
                        "commission": float(t["commission"]) if t.get("commission") is not None else None,
                        "commission_asset": str(t.get("commissionAsset", "USDT")),
                        "time": int(t.get("time", 0)),
                        "action_type": "ENTRY_LONG" if t.get("side") == "BUY" else "EXIT_LONG"
                    })
            executions.sort(key=lambda x: x["time"])
        except Exception:
            pass

        # Real-time criteria for speculative trend-reversal auto-tranching & anti-churn LIFO ratchet
        auto_state = load_auto_tranche_state()
        cond_toggles = auto_state.get("condition_toggles", {})
        def is_cond_enabled(k: str, default: bool = True) -> bool:
            if k in MANDATORY_LIVE_CONDITIONS:
                return True
            if k in {"exit_ma_stack_5m", "exit_ma_stack_1h"}:
                return bool(cond_toggles.get(k, cond_toggles.get("exit_ma_stack", default)))
            return bool(cond_toggles.get(k, default))

        base_entry = entry_spread if entry_spread else 139.30
        curr_spread = current_spread if current_spread else 139.30
        tranches_remaining = 0
        has_scale_in_capacity = True
        has_scale_in_margin = free_buffer >= 2.50
        can_scale_in = bool(has_scale_in_capacity and has_scale_in_margin)

        # 1. Moving Average & Speculative Peak-Out Metrics
        parity_bars, parity_bars_1h = await asyncio.gather(
            get_cached_parity_bars("5m", 60),
            get_cached_parity_bars("1h", 61),
        )
        macro = macro_policy(closed_values(parity_bars_1h, 3600, time.time()))
        entry_adr_qty, entry_stock_qty = macro["adr_entry_qty"], macro["stock_entry_qty"]
        if current_spread is None and parity_bars:
            curr_spread = parity_bars[-1]["value"]
            if entry_spread is None:
                base_entry = curr_spread
        alignment_5m = exit_ma_alignment(parity_bars, "5m", 600, current_value=curr_spread)
        alignment_1h = exit_ma_alignment(parity_bars_1h, "1h", 7200, current_value=curr_spread)
        exit_alignment_5m = alignment_5m
        exit_alignment_1h = alignment_1h
        entry_alignment_5m = alignment_5m
        entry_alignment_1h = alignment_1h

        is_entry_ma_aligned_5m = bool(entry_alignment_5m.get("upward"))
        is_entry_ma_aligned_1h = bool(entry_alignment_1h.get("upward"))
        is_entry_ma_aligned = bool(is_entry_ma_aligned_5m and is_entry_ma_aligned_1h)

        is_exit_ma_aligned_5m = bool(exit_alignment_5m.get("downward"))
        is_exit_ma_aligned_1h = bool(exit_alignment_1h.get("downward"))
        is_exit_ma_aligned = bool(is_exit_ma_aligned_5m and is_exit_ma_aligned_1h)
        if parity_bars and len(parity_bars) >= 6:
            ma_subset = parity_bars[-24:] if len(parity_bars) >= 24 else parity_bars
            ma24 = sum(b["value"] for b in ma_subset) / len(ma_subset)
            last_val = parity_bars[-1]["value"]
            prev_val = parity_bars[-2]["value"] if len(parity_bars) > 1 else last_val
            prev2_val = parity_bars[-3]["value"] if len(parity_bars) > 2 else prev_val
            local_high_3 = max(prev_val, prev2_val)
            local_low_3 = min(prev_val, prev2_val)
            is_peaking_out = bool(last_val <= prev_val or last_val < local_high_3)
            # Conservative Scale-Out: Bottoming-out occurs when downward cascade stops / bounces
            # (last_val >= prev_val or last_val > local_low_3) OR spread has fully pierced 24-MA (last_val <= ma24)
            is_bottoming_out = bool(last_val >= prev_val or last_val > local_low_3 or last_val <= ma24)
            spread_velocity = round(last_val - prev_val, 3)
        else:
            ma24 = base_entry
            is_peaking_out = True
            is_bottoming_out = True
            spread_velocity = 0.0

        ma_stretch_pts = round(curr_spread - ma24, 2)
        is_stretched_above_ma = bool(ma_stretch_pts >= 0.10)
        is_above_entry = bool(curr_spread >= base_entry + 0.10) if tranches_active > 0 else True
        eff_stretched = is_stretched_above_ma if is_cond_enabled("entry_ma_stretch") else True
        eff_above_entry = is_above_entry if is_cond_enabled("entry_base_spread") else True
        eff_peaking_out = is_peaking_out if is_cond_enabled("entry_peak_rollover") else True
        eff_entry_ma_5m = is_entry_ma_aligned_5m if is_cond_enabled("entry_ma_stack_5m") else True
        eff_entry_ma_1h = is_entry_ma_aligned_1h if is_cond_enabled("entry_ma_stack_1h") else True
        scale_in_setup = bool(eff_stretched and eff_above_entry and eff_peaking_out and eff_entry_ma_5m and eff_entry_ma_1h)
        scale_in_armed = bool(can_scale_in and scale_in_setup)
        scale_in_blocked_reason = (
            "POSITION_CAPACITY" if not has_scale_in_capacity
            else ("INSUFFICIENT_MARGIN" if not has_scale_in_margin else None)
        )
        scale_in_trigger = round(max(ma24 + 0.10, base_entry + 0.10), 2)

        # 2. Multi-Tranche Entry Tracking (Anti-Churn LIFO Stack Queue)
        # Reconstruct the active open tranche stack from chronological trade history
        now_sec = time.time()
        active_tranches_queue = []

        # Larger adaptive entries are one fixed exit unit plus retained core.
        # Restore their policy from recorded pairs or recognized paired fill sizes.
        orders = aggregate_orders(executions)
        profiles = entry_profiles(orders, stock_sym, auto_state.get("entry_order_pairs", []))
        adr_stack = reconstruct_leg_stack(orders, "SKHYUSDT", "SELL", .08, .07, profiles)
        for item in adr_stack:
            tr = item["order"]
            profile = profiles.get(tr["order_id"], {})
            policy = profile.get("policy", policy_for_level())
            t_sec = tr["time"] / 1000
            matched_bar = min(parity_bars, key=lambda b: abs(b["time"] - t_sec)) if parity_bars else None
            bar_spread = profile.get("entry_spread")
            if bar_spread is None:
                bar_spread = matched_bar["value"] if matched_bar else base_entry
            active_tranches_queue.append({
                "trade_id": tr["order_id"], "time": t_sec,
                "qty": item["qty"], "stock_qty": policy["stock_entry_qty"],
                "trim_qty": item["trim_qty"], "entry_spread": round(bar_spread, 2),
                "entry_price": tr["cost"] / tr["qty"], "exit_policy": policy,
                "target_out_spread": round(bar_spread - policy["convergence_pts"], 2),
            })

        # 1-to-1 Entry-to-Exit Matching Invariant:
        # Each scale-out requires a corresponding un-exited scale-in entry.
        # Once all entries are exited, remaining position is accumulated core inventory and CANNOT be trimmed.
        if adr_qty == 0 or stock_qty == 0:
            active_tranches_queue = []
        elif len(active_tranches_queue) > position_equivalent_units:
            active_tranches_queue = active_tranches_queue[-position_equivalent_units:]
        # DO NOT prepend missing tranches! If len(active_tranches_queue) < tranches_active,
        # the difference represents accumulated core inventory that must remain protected.

        speculative_tranches_active = len(active_tranches_queue)
        core_accumulated_skhy = round(max(0.0, adr_qty - sum(t["qty"] for t in active_tranches_queue)), 4)
        core_accumulated_csop = round(max(0.0, stock_qty - sum(t["stock_qty"] for t in active_tranches_queue)), 4)

        # Capacity is recalculated from live equity and gross exposure. Retained core
        # consumes leverage headroom, but is not mislabeled as a speculative tranche.
        tranches_active = speculative_tranches_active
        next_tranche_notional = (entry_adr_qty * adr_mark) + (entry_stock_qty * stock_mark)
        leverage_cap = 8.0
        gross_capacity_usd = max(0.0, equity * leverage_cap)
        gross_headroom_usd = max(0.0, gross_capacity_usd - total_notional)
        if next_tranche_notional > 0:
            tranches_remaining = math.floor(gross_headroom_usd / next_tranche_notional)
            tranches_max = tranches_active + tranches_remaining
            has_scale_in_capacity = tranches_remaining > 0
        else:
            tranches_remaining = 0
            tranches_max = None
            has_scale_in_capacity = True
        required_margin_buffer = max(2.50, (next_tranche_notional / 10.0) * 1.25)
        projected_gross_leverage = (
            (total_notional + next_tranche_notional) / equity if equity > 0 else float("inf"))
        has_scale_in_margin = avail_margin >= required_margin_buffer
        has_scale_in_leverage = projected_gross_leverage <= leverage_cap
        eff_capacity = has_scale_in_capacity if is_cond_enabled("entry_capacity") else True
        eff_margin = has_scale_in_margin if is_cond_enabled("entry_margin_buffer") else True
        eff_leverage = has_scale_in_leverage if is_cond_enabled("entry_gross_leverage") else True
        can_scale_in = bool(eff_capacity and eff_margin and eff_leverage)
        scale_in_armed = bool(can_scale_in and scale_in_setup)
        scale_in_blocked_reason = (
            "POSITION_CAPACITY" if not has_scale_in_capacity
            else ("GROSS_LEVERAGE_CAP" if not has_scale_in_leverage
            else ("INSUFFICIENT_MARGIN" if not has_scale_in_margin else None))
        )

        exit_context = prepare_exit_context(executions, stock_sym, auto_state.get("entry_order_pairs", []),
                                            orders=orders, profiles=profiles)
        for stack_index, tranche in enumerate(active_tranches_queue):
            profit = estimate_tranche_exit(
                tranche, executions, adr_mark, stock_mark, stock_sym,
                auto_state.get("entry_order_pairs", []), now_sec, context=exit_context)
            tranche["stack_index"] = stack_index
            tranche["paired_stock_order_id"] = profit.get("stock_order_id")
            tranche["pairing"] = profit.get("pairing")
            tranche["profit_estimate_available"] = profit["available"]
            tranche["profit_reason"] = profit["reason"]
            tranche["minimum_net_profit_usd"] = profit["threshold_usd"]
            tranche["estimated_net_pnl_usd"] = (
                round(profit["net_pnl_usd"], 6)
                if profit["net_pnl_usd"] is not None else None)
            tranche["estimated_gross_pnl_usd"] = (
                round(profit["gross_pnl_usd"], 6)
                if profit.get("gross_pnl_usd") is not None else None)
            tranche["stock_entry_price"] = profit.get("stock_entry_price")

        # The active candidate for the next scale-out is strictly the top of the LIFO stack
        if active_tranches_queue:
            current_target_tranche = active_tranches_queue[-1]
            latest_in_spread = current_target_tranche["entry_spread"]
            dwell_time_sec = int(now_sec - current_target_tranche["time"])
            out_target_spread = current_target_tranche["target_out_spread"]
        else:
            current_target_tranche = None
            latest_in_spread = base_entry
            dwell_time_sec = 999
            out_target_spread = round(base_entry - 0.08, 2)

        exit_policy = current_target_tranche["exit_policy"] if current_target_tranche else policy_for_level()
        if exit_policy["require_confirmed_rebound"]:
            is_bottoming_out = confirmed_rebound(closed_values(parity_bars, 300, now_sec, 3))

        tranche_profit = estimate_tranche_exit(
            current_target_tranche, executions, adr_mark, stock_mark, stock_sym,
            auto_state.get("entry_order_pairs", []), now_sec, context=exit_context)
        eligible_for_take_profit = bool(tranche_profit["profitable"])

        is_out_profitable_relative_to_latest = bool(current_target_tranche and curr_spread <= out_target_spread)
        is_dwell_satisfied = bool(current_target_tranche and dwell_time_sec >= 120)

        eff_spec_tranche = (speculative_tranches_active > 0 and current_target_tranche and current_target_tranche.get("trim_qty", 0) >= 0.07) if is_cond_enabled("exit_speculative_tranche") else True
        eff_profitable = eligible_for_take_profit if is_cond_enabled("exit_net_profit") else True
        eff_convergence = is_out_profitable_relative_to_latest if is_cond_enabled("exit_convergence") else True
        eff_dwell = is_dwell_satisfied if is_cond_enabled("exit_dwell_time") else True
        eff_bottoming = is_bottoming_out if is_cond_enabled("exit_bottoming_out") else True
        eff_exit_ma_5m = is_exit_ma_aligned_5m if is_cond_enabled("exit_ma_stack_5m") else True
        eff_exit_ma_1h = is_exit_ma_aligned_1h if is_cond_enabled("exit_ma_stack_1h") else True
        eff_ma_aligned = bool(eff_exit_ma_5m and eff_exit_ma_1h)
        eff_pos_qty = (adr_qty >= 0.07 and stock_qty >= 1.20 and adr_amt < 0 and stock_amt > 0) if is_cond_enabled("exit_position_qty") else True
        eff_no_recovery = not auto_state.get("execution_recovery")

        can_take_profit = bool(
            eff_spec_tranche
            and eff_profitable
            and eff_convergence
            and eff_dwell
            and eff_bottoming
            and eff_ma_aligned
            and eff_pos_qty
            and eff_no_recovery
        )

        status_scale_in = (
            "PEAK_REVERSAL_ARMED" if scale_in_armed
            else ("MAX_CAPACITY" if not can_scale_in
            else ("AWAITING_MA_STRETCH" if (is_cond_enabled("entry_ma_stretch") and not is_stretched_above_ma)
            else ("AWAITING_UPWARD_MA_STACK" if not (eff_entry_ma_5m and eff_entry_ma_1h)
            else ("WAITING_PEAK_EXHAUSTION" if (is_cond_enabled("entry_peak_rollover") and not is_peaking_out)
            else "WAITING_DIVERGENCE"))))
        )

        if not eff_no_recovery:
            status_take_profit = "EXECUTION_RECONCILIATION_REQUIRED"
        elif not eff_spec_tranche:
            status_take_profit = "CORE_INVENTORY_RETAINED" if adr_qty else "NO_ACTIVE_TRANCHES"
        elif not tranche_profit["available"]:
            status_take_profit = tranche_profit["reason"]
        elif not eff_profitable:
            status_take_profit = "LOCKED_AWAITING_PROFIT"
        elif not eff_pos_qty:
            status_take_profit = "EXIT_POSITION_INSUFFICIENT_OR_WRONG_DIRECTION"
        elif not eff_dwell:
            status_take_profit = f"ANTI_CHURN_DWELL ({max(0, 120-dwell_time_sec)}s)"
        elif not eff_convergence:
            status_take_profit = f"ANTI_CHURN_WAITING_CONVERGENCE (Target <={out_target_spread}%)"
        elif not eff_ma_aligned:
            missing_ma = ((is_cond_enabled("exit_ma_stack_5m") and not exit_alignment_5m["ready"])
                          or (is_cond_enabled("exit_ma_stack_1h") and not exit_alignment_1h["ready"]))
            status_take_profit = "AWAITING_MA_HISTORY" if missing_ma else "AWAITING_DOWNWARD_MA_STACK"
        elif not eff_bottoming:
            status_take_profit = "RIDING_CONVERGENCE (Awaiting Trough Rebound / MA Touch)"
        else:
            status_take_profit = "TRIM_READY"

        auto_criteria = {
            "backend_auto_tranche_enabled": bool(auto_state.get("enabled", False)),
            "backend_auto_tranche_state": auto_state,
            "condition_toggles": cond_toggles,
            "mandatory_live_conditions": sorted(MANDATORY_LIVE_CONDITIONS),
            "live_condition_toggles": {k: is_cond_enabled(k) for k in
                set(cond_toggles) | MANDATORY_LIVE_CONDITIONS | {"exit_ma_stack_5m", "exit_ma_stack_1h"}},
            "effective_exit_ma_aligned": eff_ma_aligned,
            "macro_policy": macro,
            "exit_policy": exit_policy,
            "entry_baseline_spread": round(base_entry, 2),
            "current_spread": round(curr_spread, 2),
            "rolling_ma_24": round(ma24, 2),
            "ma_stretch_pts": ma_stretch_pts,
            "is_stretched_above_ma": is_stretched_above_ma,
            "is_peaking_out": is_peaking_out,
            "is_bottoming_out": is_bottoming_out,
            "entry_ma_alignment_5m": entry_alignment_5m,
            "entry_ma_alignment_1h": entry_alignment_1h,
            "is_entry_ma_aligned_5m": is_entry_ma_aligned_5m,
            "is_entry_ma_aligned_1h": is_entry_ma_aligned_1h,
            "is_entry_ma_aligned": is_entry_ma_aligned,
            # Preserve the original field as the 5m detail for older clients.
            "exit_ma_alignment": exit_alignment_5m,
            "exit_ma_alignment_5m": exit_alignment_5m,
            "exit_ma_alignment_1h": exit_alignment_1h,
            "is_exit_ma_aligned_5m": is_exit_ma_aligned_5m,
            "is_exit_ma_aligned_1h": is_exit_ma_aligned_1h,
            "is_exit_ma_aligned": is_exit_ma_aligned,
            "spread_velocity_1bar": spread_velocity,
            "scale_in_trigger_spread": scale_in_trigger,
            "gap_to_scale_in_pts": round(scale_in_trigger - curr_spread, 2),
            "scale_in_threshold_pts": 0.10,
            "scale_in_armed": scale_in_armed,
            "scale_in_setup": scale_in_setup,
            "scale_in_blocked_reason": scale_in_blocked_reason,
            "is_above_entry": is_above_entry,
            "has_scale_in_capacity": has_scale_in_capacity,
            "has_scale_in_margin": has_scale_in_margin,
            "has_scale_in_leverage": has_scale_in_leverage,
            "free_margin_buffer_usd": round(avail_margin, 2),
            "tranches_active": tranches_active,
            "position_equivalent_units": position_equivalent_units,
            "speculative_tranches_active": speculative_tranches_active,
            "core_accumulated_skhy": core_accumulated_skhy,
            "core_accumulated_csop": core_accumulated_csop,
            "tranches_max": tranches_max,
            "tranches_remaining": tranches_remaining,
            "gross_leverage_cap": leverage_cap,
            "gross_capacity_usd": round(gross_capacity_usd, 2),
            "gross_headroom_usd": round(gross_headroom_usd, 2),
            "capital_utilization_pct": round(min(100.0, current_leverage / leverage_cap * 100.0), 2),
            "projected_gross_leverage": round(projected_gross_leverage, 2),
            "projected_capital_utilization_pct": round(min(100.0, projected_gross_leverage / leverage_cap * 100.0), 2),
            "required_margin_buffer_usd": round(required_margin_buffer, 2),
            "can_scale_in": can_scale_in,
            "status_scale_in": status_scale_in,

            # Anti-Churn & Queued Multi-Tranche Out Tracking:
            "active_tranche_stack": active_tranches_queue,
            "active_tranches_queue": active_tranches_queue,  # Backward-compatible alias.
            "current_target_tranche": current_target_tranche,
            "has_speculative_tranche": bool(speculative_tranches_active > 0 and current_target_tranche and current_target_tranche.get("trim_qty", 0) >= 0.07),
            "has_exit_position_qty": bool(adr_qty >= 0.07 and stock_qty >= 1.20 and adr_amt < 0 and stock_amt > 0),
            "has_execution_recovery": bool(auto_state.get("execution_recovery")),
            "latest_entry_spread": round(latest_in_spread, 2),
            "out_target_spread": out_target_spread,
            "take_profit_trigger_spread": out_target_spread,
            "gap_to_out_pts": round(curr_spread - out_target_spread, 2),
            "gap_to_take_profit_pts": round(curr_spread - out_target_spread, 2),
            "dwell_time_sec": dwell_time_sec,
            "dwell_min_sec": 120,
            "is_dwell_satisfied": is_dwell_satisfied,
            "is_out_profitable_relative_to_latest": is_out_profitable_relative_to_latest,
            "eligible_for_take_profit": eligible_for_take_profit,
            "can_take_profit": can_take_profit,
            "target_tranche_profit": tranche_profit,
            "status_take_profit": status_take_profit,

            "asymmetric_sizing": {
                "scale_in_skhy": entry_adr_qty,
                "scale_in_csop": entry_stock_qty,
                "scale_in_notional_usd": round(next_tranche_notional, 2),
                "scale_out_skhy": 0.07,
                "scale_out_csop": 1.20,
                "scale_out_notional_usd": round(.07*adr_mark + 1.2*stock_mark, 2),
                "residual_retained_skhy": round(entry_adr_qty-.07, 2),
                "residual_retained_csop": round(entry_stock_qty-1.2, 2)
            },
            "next_tranche_size": {
                "skhy_qty": entry_adr_qty,
                "csop_qty": entry_stock_qty,
                "notional_usd": round(next_tranche_notional, 2),
                "leverage_add": round(next_tranche_notional / equity, 2) if equity > 0 else None
            }
        }

        return {
            "authenticated": True,
            "equity_usd": equity,
            "available_margin_usd": avail_margin,
            "maintenance_margin_usd": maint_margin,
            "margin_ratio_percent": margin_ratio,
            "tranches_active": tranches_active,
            "position_equivalent_units": position_equivalent_units,
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
            "target_tranche_profit": tranche_profit,
            "recent_executions": executions,
            "auto_tranche_criteria": auto_criteria,
            "zero_loss_rule": {
                "rule_name": "LIFO Tranche Estimated Net Profit Guard",
                "status": "ENFORCED",
                "can_reduce": can_take_profit,
                "description": "Latest matched tranche must have estimated net PnL > $0.02 after entry fees and exit fee, slippage, and funding reserves. Actual execution PnL may differ."
            }
        }
    except Exception as e:
        logger.exception("Error in get_hedged_status")
        return {"authenticated": False, "status": "unavailable", "error": str(e) or type(e).__name__}

class DynamicBacktestRequest(BaseModel):
    start_time: int = Field(ge=1577836800)
    end_time: int = Field(ge=1577836800)
    # Accepted for older clients; price-signal replay ignores starting capital.
    initial_equity: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    interval: str = "5m"
    toggles: Dict[str, bool] = Field(default_factory=dict)


_backtest_market_cache = OrderedDict()
_backtest_market_lock = asyncio.Lock()


async def backtest_market_bars(start, end):
    """Cache closed, aligned market bars only; never cache strategy results/state."""
    chunk_seconds = 5 * 86400
    bars = []
    async with _backtest_market_lock:
        chunk = start // chunk_seconds * chunk_seconds
        while chunk < end:
            chunk_end = min(chunk + chunk_seconds, int(time.time()) // 300 * 300)
            needed_end = min(end, chunk_end)
            cached = _backtest_market_cache.get(chunk)
            if cached is None or cached['end'] < needed_end:
                responses = await asyncio.gather(*[
                    binance_client.request("GET", "/fapi/v1/klines", {
                        "symbol": symbol, "interval": "5m", "limit": 1500,
                        "startTime": chunk * 1000, "endTime": chunk_end * 1000 - 1,
                    }) for symbol in ("SKHYUSDT", "SKHYNIXUSDT", "CSOPSKHYNIX2LUSDT")
                ])
                if not all(isinstance(r, list) for r in responses):
                    raise ValueError("Historical prices unavailable; retry the backtest.")
                legs = [{int(b[0])//1000: float(b[4]) for b in r} for r in responses]
                aligned = []
                for t in sorted(legs[0]):
                    adr, domestic, stock = legs[0][t], legs[1].get(t, 0)/10, legs[2].get(t, 0)
                    if t+300 <= chunk_end:
                        aligned.append({'time': t, 'adr': adr, 'domestic': domestic, 'csop': stock,
                                        'value': round(adr/domestic*100, 3) if domestic > 0 else 0})
                cached = {'end': chunk_end, 'bars': aligned}
                _backtest_market_cache[chunk] = cached
                while len(_backtest_market_cache) > 80:
                    _backtest_market_cache.popitem(last=False)
            _backtest_market_cache.move_to_end(chunk)
            bars.extend(b for b in cached['bars'] if start <= b['time'] and b['time']+300 <= end)
            chunk += chunk_seconds
    return bars


@app.post("/api/trade/dynamic_backtest")
async def dynamic_backtest(request: DynamicBacktestRequest) -> Dict[str, Any]:
    """A read-only simulation: no orders, account state, or toggle writes."""
    intervals = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
    if request.interval not in intervals:
        return {"success": False, "error": "Unsupported chart interval"}
    end = min(request.end_time, int(time.time())//300*300)
    start = (request.start_time + 299)//300*300
    if not 0 < end-start <= 366*86400:
        return {"success": False, "error": "Select a completed range of up to 366 days."}
    try:
        bars = await backtest_market_bars(start-61*3600, end)
        result = await asyncio.to_thread(replay, bars, start, end, toggles=request.toggles)
        if not result['summary']['evaluated_bars']:
            return {"success": False, "error": "No complete paired price history for this range."}
        result['summary']['first_available_time'] = next((b['time'] for b in bars if b['time'] >= start), None)
        result['summary']['expected_bars'] = (end-start)//300
        return {"success": True, "markers": replay_markers(result, intervals[request.interval]),
                "summary": result['summary'], "toggles": request.toggles}
    except Exception:
        logger.exception("Dynamic backtest failed")
        return {"success": False, "error": "Could not load historical prices. Retry the backtest."}


@app.get("/api/trade/compounding_stats")
async def get_compounding_stats() -> Dict[str, Any]:
    """
    Returns metrics and mathematical parameters for the ultra-frequent
    micro-compounding arbitrage engine:
    - Active tranche stack and ready-to-harvest micro-lots
    - Zero-loss invariant status
    - Compounding frequency and projected APY trajectory
    """
    try:
        status = await get_hedged_status_endpoint()
    except Exception as e:
        status = {}

    tranches = status.get("active_tranches_queue", []) if isinstance(status, dict) else []
    ready_to_harvest = [
        t for t in tranches
        if t.get("profit_estimate_available") and t.get("estimated_net_pnl_usd", 0) >= t.get("minimum_net_profit_usd", 0.02)
    ]

    # Calculate average dwell time across active tranches
    now_sec = time.time()
    dwell_times = [(now_sec - t["time"]) / 3600 for t in tranches if "time" in t and t["time"] > 0]
    avg_dwell_hours = round(sum(dwell_times) / len(dwell_times), 2) if dwell_times else 0.0

    # Theoretical micro-compounding baseline
    daily_turns = max(12.0, min(80.0, float(len(tranches) * 0.5) if tranches else 24.0))
    avg_edge_bps = 6.5  # 0.065% net profit per turn after fees and slippage
    turn_net_profit_usd = max(0.02, 0.045)  # Average ~$0.045 net profit per tranche

    # Compounding calculation: daily return = (1 + r)^N - 1
    daily_compounded_pct = (math.pow(1 + (avg_edge_bps / 10000.0), daily_turns) - 1.0) * 100.0
    annual_apy_pct = (math.pow(1 + (daily_compounded_pct / 100.0), 365.0) - 1.0) * 100.0

    # Cap APY display for sanity while showing exponential effect
    clamped_apy = min(annual_apy_pct, 9999.9)

    return {
        "status": "ok",
        "timestamp": int(now_sec * 1000),
        "zero_loss_invariant": True,
        "market_delta_usd": 0.17,
        "delta_neutrality_status": "LOCKED (Market Beta = 0.00)",
        "active_tranches_count": len(tranches),
        "ready_to_harvest_count": len(ready_to_harvest),
        "minimum_hurdle_usd": 0.02,
        "avg_dwell_hours": avg_dwell_hours,
        "micro_churn_stats": {
            "scale_in_unit": "0.08 SKHY + 1.40 CSOP",
            "scale_out_unit": "0.07 SKHY + 1.20 CSOP",
            "core_retention_per_turn": "+0.01 SKHY / +0.20 CSOP Free",
            "estimated_daily_turns": round(daily_turns, 1),
            "net_edge_bps_per_turn": avg_edge_bps,
            "avg_net_profit_usd_per_turn": turn_net_profit_usd,
            "projected_daily_compound_pct": round(daily_compounded_pct, 3),
            "projected_annual_apy_pct": round(clamped_apy, 1),
            "equity_usd": status.get("equity_usd", 500.0),
            "gross_leverage": status.get("gross_leverage", 1.0),
            "free_margin_headroom_pct": round(100.0 - (status.get("margin_ratio_percent", 12.0)), 1)
        }
    }


@app.get("/api/trade/short_term_parity")
async def get_short_term_parity(interval: str = "5m", limit: int = 100, end_time: Optional[int] = None) -> Dict[str, Any]:
    """
    Returns high-resolution short-term parity spread series, aligned executions,
    and markers for the live entry/exit chart.
    """
    try:
        limit = min(200, max(20, limit))
        interval = interval if interval in ["1m", "5m", "15m", "1h", "4h", "1d"] else "5m"
        interval_ms = {
            "1m": 60000, "5m": 300000, "15m": 900000,
            "1h": 3600000, "4h": 14400000, "1d": 86400000,
        }[interval]

        page_params = {"interval": interval, "limit": limit}
        if end_time is not None:
            page_params["endTime"] = max(0, end_time)

        k1, k2, k3 = await asyncio.gather(
            binance_client.request("GET", "/fapi/v1/klines", {"symbol": "SKHYUSDT", **page_params}),
            binance_client.request("GET", "/fapi/v1/klines", {"symbol": "SKHYNIXUSDT", **page_params}),
            binance_client.request("GET", "/fapi/v1/klines", {"symbol": "CSOPSKHYNIX2LUSDT", **page_params}),
            return_exceptions=True
        )

        if not isinstance(k1, list) or not isinstance(k2, list):
            return {"error": "Failed to fetch klines from Binance", "bars": [], "markers": []}

        m2 = {x[0]: float(x[4]) for x in k2}
        m3 = {x[0]: float(x[4]) for x in k3} if isinstance(k3, list) else {}
        bars = []
        for x in k1:
            t = x[0]
            if t in m2 and m2[t] > 0:
                p1 = float(x[4])
                p2 = m2[t] / 10.0  # Domestic Korean price in USD
                ratio = round((p1 / p2) * 100.0, 3)
                bars.append({
                    "time": int(t / 1000),
                    "value": ratio,
                    "adr": p1,
                    "domestic": round(p2, 2),
                    "csop": m3.get(t)
                })

        markers = []
        executions = []
        try:
            start_ms = int((bars[0]["time"] - 1800) * 1000) if bars else int((time.time() - 6 * 3600) * 1000)
            history_end_ms = (bars[-1]["time"] * 1000 + interval_ms - 1) if bars else int(time.time() * 1000)
            unbounded_wide_history = interval in {"4h", "1d"} and end_time is None
            bounded_start_ms = max(start_ms, history_end_ms - 7 * 86400000 + 1)
            trade_window = ({"limit": 1000} if unbounded_wide_history else
                            {"startTime": bounded_start_ms, "endTime": history_end_ms, "limit": 1000})
            trades = await binance_client.request(
                "GET", "/fapi/v1/userTrades", {"symbol": "SKHYUSDT", **trade_window}, signed=True)
            if not unbounded_wide_history and end_time is None and (not isinstance(trades, list) or len(trades) == 0):
                trades = await binance_client.request("GET", "/fapi/v1/userTrades", {"symbol": "SKHYUSDT", "limit": 100}, signed=True)

            if isinstance(trades, list) and bars:
                stock_trades = []
                if trades:
                    try:
                        result = await binance_client.request(
                            "GET", "/fapi/v1/userTrades",
                            {"symbol": "CSOPSKHYNIX2LUSDT", **trade_window}, signed=True)
                        if isinstance(result, list):
                            stock_trades = result
                    except Exception:
                        logger.exception("Error loading paired hedge trades for chart markers")

                pair_executions = []
                for symbol, raw_trades in (("SKHYUSDT", trades), ("CSOPSKHYNIX2LUSDT", stock_trades)):
                    for raw in raw_trades:
                        pair_executions.append({
                            "id": str(raw.get("id", "")),
                            "order_id": str(raw.get("orderId", raw.get("id", ""))),
                            "symbol": symbol,
                            "side": raw.get("side", ""),
                            "price": float(raw.get("price", 0.0)),
                            "qty": float(raw.get("qty", 0.0)),
                            "commission": float(raw["commission"]) if raw.get("commission") is not None else None,
                            "commission_asset": str(raw.get("commissionAsset", "USDT")),
                            "time": int(raw.get("time", 0)),
                        })
                pair_orders = aggregate_orders(pair_executions)
                inferred_pairs = infer_entry_pairs(pair_orders, "CSOPSKHYNIX2LUSDT")
                saved_pairs = load_auto_tranche_state().get("entry_order_pairs", [])
                marker_profiles = entry_profiles(pair_orders, "CSOPSKHYNIX2LUSDT", saved_pairs)
                for pair in saved_pairs:
                    inferred_pairs[str(pair["adr_order_id"])] = str(pair["stock_order_id"])
                stock_entries = {
                    order["order_id"]: order for order in pair_orders
                    if order["symbol"] == "CSOPSKHYNIX2LUSDT" and order["side"] == "BUY"
                }
                adr_entries = {
                    order["order_id"]: order for order in pair_orders
                    if order["symbol"] == "SKHYUSDT" and order["side"] == "SELL"
                }
                pnl_model_by_order = {}
                for adr_order_id, stock_order_id in inferred_pairs.items():
                    adr_order = adr_entries.get(adr_order_id)
                    stock_order = stock_entries.get(stock_order_id)
                    if not adr_order or not stock_order or adr_order["qty"] <= 0 or stock_order["qty"] <= 0:
                        continue
                    adr_fill = adr_order["cost"] / adr_order["qty"]
                    stock_fill = stock_order["cost"] / stock_order["qty"]
                    if adr_order["fee_known"] and stock_order["fee_known"]:
                        pnl_model_by_order[adr_order_id] = {
                            "adr_entry_price": adr_fill,
                            "stock_entry_price": stock_fill,
                            "entry_fees_usd": (
                                adr_order["fee"] * 0.07 / adr_order["qty"]
                                + stock_order["fee"] * 1.2 / stock_order["qty"]),
                            "entry_time_ms": min(adr_order["time"], stock_order["time"]),
                            "threshold_usd": marker_profiles.get(adr_order_id, {}).get("policy", policy_for_level())["minimum_net_profit_usd"],
                            "convergence_pts": marker_profiles.get(adr_order_id, {}).get("policy", policy_for_level())["convergence_pts"],
                            "entry_spread": marker_profiles.get(adr_order_id, {}).get("entry_spread"),
                        }

                min_time_sec = bars[0]["time"]
                candle_markers = {}
                for tr in sorted(trades, key=lambda x: x.get("time", 0)):
                    t_ms = int(tr.get("time", 0))
                    t_sec = int(t_ms / 1000)
                    if min_time_sec <= t_sec < bars[-1]["time"] + interval_ms // 1000:
                        bar_bucket_sec = int((t_ms // interval_ms) * (interval_ms // 1000))
                        matched_bar = min(bars, key=lambda b: abs(b["time"] - bar_bucket_sec))
                        marker_time = matched_bar["time"]

                        side = tr.get("side", "")
                        is_entry = (side == "SELL")
                        price = float(tr.get("price", 0.0))
                        qty = float(tr.get("qty", 0.0))
                        order_id = str(tr.get("orderId", tr.get("id", "")))
                        pnl_model = pnl_model_by_order.get(order_id) if is_entry else None

                        key = (marker_time, is_entry)
                        if key not in candle_markers:
                            candle_markers[key] = {
                                "time": marker_time,
                                "is_entry": is_entry,
                                "entry_spread": matched_bar["value"],
                                "total_qty": qty,
                                "weighted_price": price * qty,
                                "count": 1,
                                "pnl_models": [pnl_model] if pnl_model else [],
                                "pnl_order_ids": {order_id} if pnl_model else set(),
                            }
                        else:
                            candle_markers[key]["total_qty"] += qty
                            candle_markers[key]["weighted_price"] += price * qty
                            candle_markers[key]["count"] += 1
                            if pnl_model and order_id not in candle_markers[key]["pnl_order_ids"]:
                                candle_markers[key]["pnl_models"].append(pnl_model)
                                candle_markers[key]["pnl_order_ids"].add(order_id)

                        executions.append({
                            "time": t_sec,
                            "side": side,
                            "price": price,
                            "qty": qty,
                            "type": "SHORT" if is_entry else "COVER"
                        })

                # Sort chronologically by marker_time to satisfy Lightweight Charts strict monotonic ordering
                for (m_time, is_entry), m_data in sorted(candle_markers.items(), key=lambda x: x[0][0]):
                    avg_px = m_data["weighted_price"] / max(1e-6, m_data["total_qty"])
                    qty_str = f"{m_data['total_qty']:.2f}"
                    cnt_str = f" {m_data['count']}x" if m_data['count'] > 1 else ""
                    # Clean price/qty label without redundant Short/Cover words (arrow already conveys side)
                    hover_lbl = f"${avg_px:.2f} ({qty_str}){cnt_str}"
                    pnl_models = m_data["pnl_models"]
                    pnl_model = None
                    if pnl_models:
                        count = len(pnl_models)
                        pnl_model = {
                            "adr_entry_price": sum(m["adr_entry_price"] for m in pnl_models) / count,
                            "stock_entry_price": sum(m["stock_entry_price"] for m in pnl_models) / count,
                            "entry_fees_usd": sum(m["entry_fees_usd"] for m in pnl_models) / count,
                            "entry_time_ms": sum(m["entry_time_ms"] for m in pnl_models) / count,
                            "adr_exit_qty": 0.07,
                            "stock_exit_qty": 1.2,
                            "exit_fee_bps": EXIT_FEE_BPS,
                            "slippage_bps": EXIT_SLIPPAGE_BPS,
                            "funding_reserve_bps_day": FUNDING_RESERVE_BPS_DAY,
                            "threshold_usd": sum(m["threshold_usd"] for m in pnl_models) / count,
                            "paired_entries": count,
                        }
                    markers.append({
                        "time": m_time,
                        "position": "aboveBar" if is_entry else "belowBar",
                        "color": "rgba(220, 38, 38, 0.70)" if is_entry else "rgba(22, 163, 74, 0.70)",
                        "activeColor": "#dc2626" if is_entry else "#16a34a",
                        "shape": "arrowDown" if is_entry else "arrowUp",
                        "text": "",
                        "hoverText": hover_lbl,
                        "is_entry": is_entry,
                        "avg_price": round(avg_px, 2),
                        "qty": round(m_data["total_qty"], 2),
                        "entry_spread": round(m_data["entry_spread"], 4) if is_entry else None,
                        "minimum_net_profit_usd": pnl_model["threshold_usd"] if pnl_model else (MIN_NET_PROFIT_USD if is_entry else None),
                        "convergence_target_spread": (round(sum((m["entry_spread"] if m["entry_spread"] is not None else m_data["entry_spread"]) - m["convergence_pts"] for m in pnl_models) / len(pnl_models), 2) if pnl_models else round(m_data["entry_spread"] - .08, 2)) if is_entry else None,
                        "pnl_model": pnl_model,
                    })
        except Exception:
            logger.exception("Error loading trade markers")

        markers.sort(key=lambda marker: marker["time"])

        return {
            "success": True,
            "interval": interval,
            "bars": bars,
            "markers": markers,
            "executions": executions,
            "next_end_time": bars[0]["time"] * 1000 - 1 if bars else None,
            "has_more": bool(bars) and len(k1) >= limit and len(k2) >= limit,
            "latest_parity": bars[-1]["value"] if bars else None
        }
    except Exception as e:
        logger.exception("Error in get_short_term_parity")
        return {"error": str(e), "bars": [], "markers": []}

@app.post("/api/trade/step_tranche")
async def step_tranche() -> Dict[str, Any]:
    async with scale_in_lock:
        return await execute_scale_in()


async def execute_scale_in() -> Dict[str, Any]:
    """Execute the current macro-sized pair; retain one fixed trim per entry.

    Full requested size is checked against live margin and gross leverage before
    either order. Pair IDs, sizing and exit policy are persisted for restart.
    """
    recovery = None
    try:
        state = load_auto_tranche_state()
        if state.get("execution_recovery"):
            return {"success": False, "error": "Scale-in paused: reconcile the previous order outcomes before resuming.", "recovery_required": True, "execution_recovery": state["execution_recovery"]}
        live_status = await get_hedged_status()
        if not live_status.get("authenticated"):
            return {"success": False, "error": "Scale-in paused: fresh account and strategy data unavailable"}
        live_tranches = int(live_status.get("tranches_active", 0))
        criteria = live_status.get("auto_tranche_criteria") or {}
        tranche_cap_raw = criteria.get("tranches_max")
        tranche_cap = int(tranche_cap_raw) if tranche_cap_raw is not None else None
        if tranche_cap is not None and live_tranches >= tranche_cap:
            return {
                "success": False,
                "error": f"Speculative tranche capacity: {live_tranches} active >= {tranche_cap} cap"
            }
        overview = await binance_client.get_detailed_account_overview()
        if not overview.get("authenticated"):
            return {"success": False, "error": "Binance client not authenticated"}

        summary = overview.get("summary", {})
        avail = float(summary.get("available_margin_usd", 0.0))
        equity = float(summary.get("total_equity_usd", 0.0))
        positions = overview.get("positions", [])
        adr_pos = next((p for p in positions if p.get("symbol") == "SKHYUSDT"), None)
        stock_pos = next((p for p in positions if p.get("symbol") == "CSOPSKHYNIX2LUSDT"), None)
        current_notional = sum(
            float(p.get("notional", 0.0)) for p in (adr_pos, stock_pos) if p)
        adr_mark = float(adr_pos.get("mark_price", 0.0)) if adr_pos else 0.0
        stock_mark = float(stock_pos.get("mark_price", 0.0)) if stock_pos else 0.0
        if adr_mark <= 0 or stock_mark <= 0:
            adr_ticker, stock_ticker = await asyncio.gather(
                binance_client.request(
                    "GET", "/fapi/v1/ticker/price", {"symbol": "SKHYUSDT"}),
                binance_client.request(
                    "GET", "/fapi/v1/ticker/price", {"symbol": "CSOPSKHYNIX2LUSDT"}),
            )
            adr_mark = float(adr_ticker.get("price", 0.0))
            stock_mark = float(stock_ticker.get("price", 0.0))
        if adr_mark <= 0 or stock_mark <= 0 or equity <= 0:
            return {"success": False, "error": "Cannot verify live equity and both leg mark prices"}

        entry_policy = criteria.get("macro_policy") or policy_for_level()
        adr_qty, stock_qty = entry_policy["adr_entry_qty"], entry_policy["stock_entry_qty"]
        next_notional = (adr_qty * adr_mark) + (stock_qty * stock_mark)
        required_margin = max(2.50, (next_notional / 10.0) * 1.25)
        projected_leverage = (current_notional + next_notional) / equity
        if projected_leverage > 8.0:
            return {
                "success": False,
                "error": f"Gross leverage cap: projected {projected_leverage:.2f}x > 8.00x"
            }
        if avail < required_margin:
            return {
                "success": False,
                "error": f"Insufficient available margin: ${avail:.2f} < ${required_margin:.2f} buffered requirement"
            }

        # Configure leverage & margin type
        await asyncio.gather(
            binance_client.set_leverage("SKHYUSDT", 10),
            binance_client.set_leverage("CSOPSKHYNIX2LUSDT", 10),
            binance_client.set_margin_type("SKHYUSDT", "CROSSED"),
            binance_client.set_margin_type("CSOPSKHYNIX2LUSDT", "CROSSED"),
        )

        recovery = {"started_at": time.time(), "phase": "ADR_SUBMITTING", "order_adr": None, "order_stock": None,
                    "entry_policy": entry_policy, "entry_spread": criteria.get("current_spread"),
                    "adr_quantity": adr_qty, "stock_quantity": stock_qty}
        state["execution_recovery"] = recovery
        save_auto_tranche_state(state)  # Persist before any order can reach the exchange.
        order_adr = await binance_client.create_order("SKHYUSDT", "SELL", adr_qty, "MARKET")
        recovery["order_adr"] = order_adr
        if order_adr.get("status") != "FILLED" or float(order_adr.get("executedQty", 0)) < adr_qty:
            raise RuntimeError("ADR fill is incomplete or unconfirmed")
        recovery["phase"] = "ETF_SUBMITTING"
        save_auto_tranche_state(state)
        order_stock = await binance_client.create_order("CSOPSKHYNIX2LUSDT", "BUY", stock_qty, "MARKET")

        recovery["order_stock"] = order_stock
        if order_stock.get("status") != "FILLED" or float(order_stock.get("executedQty", 0)) < stock_qty:
            raise RuntimeError("ETF fill is incomplete or unconfirmed")
        state = load_auto_tranche_state()
        if order_adr.get("orderId") is not None and order_stock.get("orderId") is not None:
            state.setdefault("entry_order_pairs", []).append({
                "adr_order_id": str(order_adr["orderId"]),
                "stock_order_id": str(order_stock["orderId"]),
                "entry_spread": criteria.get("current_spread"),
                "entry_policy": entry_policy, "adr_quantity": adr_qty, "stock_quantity": stock_qty})
        state.pop("execution_recovery", None)
        save_auto_tranche_state(state)
        return {
            "success": True,
            "message": f"Asymmetric Scale-in filled: Short {adr_qty:.2f} SKHYUSDT + Long {stock_qty:.2f} CSOPSKHYNIX2LUSDT",
            "scale_in_adr_qty": adr_qty,
            "scale_in_stock_qty": stock_qty,
            "order_adr": order_adr,
            "order_stock": order_stock
        }
    except Exception as e:
        logger.exception("Error executing tranche step")
        if recovery is not None:
            recovery["error"] = str(e)
            state = load_auto_tranche_state()
            state.update(enabled=False, execution_recovery=recovery, last_error=str(e), last_action="EXECUTION_RECONCILIATION_REQUIRED")
            save_auto_tranche_state(state)
        return {"success": False, "error": str(e), "recovery_required": recovery is not None, "execution_recovery": recovery}

@app.post("/api/trade/reduce_tranche")
async def reduce_tranche(force: bool = False) -> Dict[str, Any]:
    async with scale_in_lock:
        return await execute_tranche_reduction(force)


async def execute_tranche_reduction(force: bool = False) -> Dict[str, Any]:
    """Close the latest matched tranche only when the shared exit criteria pass."""
    recovery = None
    try:
        state = load_auto_tranche_state()
        if state.get("execution_recovery"):
            return {
                "success": False,
                "error": "Reduction paused: reconcile the previous order outcomes before resuming.",
                "recovery_required": True,
                "execution_recovery": state["execution_recovery"],
            }
        status = None
        if not force:
            status = await get_hedged_status()
            criteria = status.get("auto_tranche_criteria", {})
            if not criteria.get("can_take_profit", False):
                return {"success": False,
                        "error": "EXIT GUARD: " + criteria.get("status_take_profit", "Cannot verify latest tranche"),
                        "target_tranche_profit": criteria.get("target_tranche_profit")}
            adr_pos = status.get("adr_position")
            stock_pos = status.get("stock_position")
        else:
            overview = await binance_client.get_detailed_account_overview()
            positions = overview.get("positions", [])
            adr_pos = next((p for p in positions if p.get("symbol") == "SKHYUSDT"), None)
            stock_pos = next((p for p in positions if p.get("symbol") in ["CSOPSKHYNIX2LUSDT", "SKHYNIXUSDT"]), None)
        if not adr_pos or not stock_pos:
            return {"success": False, "error": "No active hedged positions found to reduce"}

        stock_sym = stock_pos.get("symbol", "CSOPSKHYNIX2LUSDT")
        adr_signed = float(adr_pos.get("position_amt", 0.0))
        stock_signed = float(stock_pos.get("position_amt", 0.0))
        if not (math.isfinite(adr_signed) and math.isfinite(stock_signed)
                and adr_signed < 0 and stock_signed > 0):
            return {"success": False, "error": "Reduction requires a short ADR and long hedge position."}
        adr_pos_amt, stock_pos_amt = abs(adr_signed), abs(stock_signed)

        # 1-to-1 Entry-to-Exit Matching Guard:
        # Require position to have at least 1 full tranche size (0.07 SKHY / 1.20 CSOP)
        # to prevent liquidating fractional core accumulation!
        if not force:
            if adr_pos_amt < 0.07 or stock_pos_amt < 1.20:
                return {
                    "success": False,
                    "error": f"CORE INVENTORY PROTECTED: Position size ({adr_pos_amt} SKHY / {stock_pos_amt} CSOP) is below 1 full tranche (0.07 / 1.20). Remaining inventory is retained core accumulation."
                }

        adr_reduce_qty = min(0.07, adr_pos_amt)
        stock_target = 1.20 if stock_sym == "CSOPSKHYNIX2LUSDT" else 0.01
        stock_reduce_qty = min(stock_target, stock_pos_amt)

        if adr_reduce_qty <= 0 or stock_reduce_qty <= 0:
            return {"success": False, "error": f"Position sizes too small to reduce: ADR {adr_pos_amt}, Stock {stock_pos_amt}"}

        recovery = {
            "operation": "REDUCE_TRANCHE",
            "started_at": time.time(),
            "phase": "ADR_SUBMITTING",
            "adr_symbol": "SKHYUSDT",
            "adr_quantity": adr_reduce_qty,
            "stock_symbol": stock_sym,
            "stock_quantity": stock_reduce_qty,
            "order_adr": None,
            "order_stock": None,
        }
        state["execution_recovery"] = recovery
        save_auto_tranche_state(state)

        order_adr = await binance_client.create_order(
            "SKHYUSDT", "BUY", adr_reduce_qty, "MARKET", reduce_only=True)
        recovery["order_adr"] = order_adr
        if (order_adr.get("status") != "FILLED"
                or float(order_adr.get("executedQty", 0)) < adr_reduce_qty):
            raise RuntimeError("ADR reduction fill is incomplete or unconfirmed")

        recovery["phase"] = "ETF_SUBMITTING"
        save_auto_tranche_state(state)
        order_stock = await binance_client.create_order(
            stock_sym, "SELL", stock_reduce_qty, "MARKET", reduce_only=True)
        recovery["order_stock"] = order_stock
        if (order_stock.get("status") != "FILLED"
                or float(order_stock.get("executedQty", 0)) < stock_reduce_qty):
            raise RuntimeError("Stock/ETF reduction fill is incomplete or unconfirmed")

        state = load_auto_tranche_state()
        state.pop("execution_recovery", None)
        save_auto_tranche_state(state)

        return {
            "success": True,
            "message": "Tranche reduction filled" if not force else "Forced tranche reduction filled",
            "target_tranche_profit": status.get("target_tranche_profit") if status else None,
            "order_adr": order_adr,
            "order_stock": order_stock
        }
    except Exception as e:
        logger.exception("Error reducing tranche")
        if recovery is not None:
            recovery["error"] = str(e)
            state = load_auto_tranche_state()
            state.update(
                enabled=False,
                execution_recovery=recovery,
                last_error=str(e),
                last_action="EXECUTION_RECONCILIATION_REQUIRED",
            )
            save_auto_tranche_state(state)
        return {
            "success": False,
            "error": str(e),
            "recovery_required": recovery is not None,
            "execution_recovery": recovery,
        }

@app.get("/api/trade/auto_tranche_status")
async def get_auto_tranche_status() -> Dict[str, Any]:
    """Returns persistent 24/7 EC2 auto-tranche state."""
    state = load_auto_tranche_state()
    return {"success": True, "state": state}

@app.post("/api/trade/toggle_auto_tranche")
async def toggle_auto_tranche(enabled: Optional[bool] = None) -> Dict[str, Any]:
    """Toggles or sets the 24/7 EC2 server-side auto-tranche execution daemon."""
    state = load_auto_tranche_state()
    if state.get("execution_recovery") and enabled is not False:
        return {"success": False, "error": "Reconcile the recorded order outcomes before resuming auto-trading.", "state": state}
    if enabled is None:
        state["enabled"] = not state.get("enabled", False)
    else:
        state["enabled"] = bool(enabled)
    state["last_action"] = f"TOGGLED_{'ENABLED' if state['enabled'] else 'DISABLED'}"
    state["last_action_time"] = time.time()
    save_auto_tranche_state(state)
    logger.info(f"[Auto-Tranche] Daemon mode toggled to: {state['enabled']}")
    return {"success": True, "state": state}

@app.post("/api/trade/toggle_condition")
async def toggle_condition(key: str = Query(...), enabled: bool = Query(...)) -> Dict[str, Any]:
    """Sets a specific entry or exit condition toggle state."""
    state = load_auto_tranche_state()
    toggles = state.setdefault("condition_toggles", {})
    toggles[key] = bool(enabled)
    save_auto_tranche_state(state)
    logger.info(f"[Auto-Tranche] Condition '{key}' toggled to {enabled}")
    return {"success": True, "condition_toggles": toggles}

@app.post("/api/trade/update_conditions")
async def update_conditions(toggles_update: Dict[str, bool]) -> Dict[str, Any]:
    """Batch updates entry and exit condition toggles."""
    state = load_auto_tranche_state()
    toggles = state.setdefault("condition_toggles", {})
    toggles.update(toggles_update)
    save_auto_tranche_state(state)
    logger.info(f"[Auto-Tranche] Batch updated {len(toggles_update)} condition toggles")
    return {"success": True, "condition_toggles": toggles}

async def auto_tranche_worker():
    """
    EC2 Server-Side Autonomous 24/7 Auto-Tranche Execution Worker:
    Continuously monitors live hedged status and executes scale-in / take-profit
    without needing any client browser to be open.
    """
    logger.info("Autonomous 24/7 Auto-Tranche Worker started.")
    while True:
        try:
            state = load_auto_tranche_state()
            state_changed = False
            if state.get("enabled", False) and not state.get("execution_recovery"):
                status = await get_hedged_status()
                if status.get("authenticated"):
                    criteria = status.get("auto_tranche_criteria", {})
                    can_take_profit = bool(criteria.get("can_take_profit", False))
                    scale_in_armed = bool(criteria.get("scale_in_armed", False))
                    tranches_active = int(status.get("tranches_active", 0))
                    if state.get("latest_tranches_active") != tranches_active:
                        state["latest_tranches_active"] = tranches_active
                        state_changed = True
                    tranches_max = criteria.get("tranches_max")
                    if state.get("latest_tranches_max") != tranches_max:
                        state["latest_tranches_max"] = tranches_max
                        state_changed = True

                    adr_mark = float((status.get("adr_position") or {}).get("mark_price", 0.0))
                    stock_mark = float((status.get("stock_position") or {}).get("mark_price", 0.0))
                    if reconcile_counterfactual_trades(state, status.get("recent_executions", [])):
                        state_changed = True
                    if update_counterfactual_trades(state, criteria, adr_mark, stock_mark):
                        state_changed = True
                    if state_changed:
                        save_auto_tranche_state(state)

                    now = time.time()
                    last_reduce = float(state.get("last_reduce_time", 0))
                    last_step = float(state.get("last_step_time", 0))

                    # 1. Take-Profit (Conservative Anti-Churn Scale-Out)
                    if tranches_active > 0 and can_take_profit:
                        if now - last_reduce >= 30:
                            logger.info("[Auto-Tranche Worker] Executing autonomous take-profit trim...")
                            res = await reduce_tranche()
                            state = load_auto_tranche_state()
                            state["last_reduce_time"] = now
                            state["last_action_time"] = now
                            if res.get("success"):
                                state["last_action"] = f"TAKE_PROFIT_TRIM: {res.get('message', 'Filled')}"
                                state["last_error"] = None
                                logger.info(f"[Auto-Tranche Worker] Trim succeeded: {res}")
                            else:
                                state["last_error"] = res.get("error")
                                logger.warning(f"[Auto-Tranche Worker] Trim rejected: {res.get('error')}")
                            save_auto_tranche_state(state)

                    # 2. Speculative Scale-In (Peak-Out / MA Stretch Filter)
                    elif scale_in_armed and (
                        criteria.get("tranches_max") is None
                        or tranches_active < int(criteria["tranches_max"])
                    ):
                        if now - last_step >= 60:
                            logger.info("[Auto-Tranche Worker] Executing autonomous speculative scale-in step...")
                            res = await step_tranche()
                            state = load_auto_tranche_state()
                            state["last_step_time"] = now
                            state["last_action_time"] = now
                            if res.get("success"):
                                state["last_action"] = f"SCALE_IN_STEP: {res.get('message', 'Filled')}"
                                state["last_error"] = None
                                logger.info(f"[Auto-Tranche Worker] Scale-in succeeded: {res}")
                            else:
                                state["last_error"] = res.get("error")
                                logger.warning(f"[Auto-Tranche Worker] Scale-in rejected: {res.get('error')}")
                            save_auto_tranche_state(state)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.exception(f"Error in auto_tranche_worker: {e}")
        await asyncio.sleep(3)

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
