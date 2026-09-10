import asyncio
import json
import logging
import time
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Dict, Any, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from .config import config
from .binance_client import BinanceFuturesClient
from .upbit_client import UpbitClient

STATE_FILE = Path(__file__).parent / "auto_tranche_state.json"

def load_auto_tranche_state() -> Dict[str, Any]:
    try:
        if STATE_FILE.exists():
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        logger.error(f"Failed to read auto_tranche_state: {e}")
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
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        logger.error(f"Failed to save auto_tranche_state: {e}")

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
    auto_tranche_task = asyncio.create_task(auto_tranche_worker())
    yield
    broadcaster_task.cancel()
    auto_tranche_task.cancel()
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

_parity_cache: Dict[str, Any] = {
    "key": "",
    "timestamp": 0.0,
    "data": []
}

async def get_cached_parity_bars(interval: str = "5m", limit: int = 60) -> List[Dict[str, Any]]:
    global _parity_cache
    now = time.time()
    cache_key = f"{interval}_{limit}"
    if _parity_cache["key"] == cache_key and (now - _parity_cache["timestamp"]) < 4.0:
        return _parity_cache["data"]

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
                _parity_cache = {"key": cache_key, "timestamp": now, "data": bars}
                return bars
    except Exception as e:
        logger.warning(f"Error fetching parity bars: {e}")

    return _parity_cache.get("data", [])

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

        # Fetch recent user fills for SKHYUSDT to display exact entry and exit markers on chart
        executions = []
        try:
            start_ms = int((time.time() - 24 * 3600) * 1000)
            skhy_trades = await binance_client.request("GET", "/fapi/v1/userTrades", {"symbol": "SKHYUSDT", "startTime": start_ms, "limit": 100}, signed=True)
            if not isinstance(skhy_trades, list) or len(skhy_trades) == 0:
                skhy_trades = await binance_client.request("GET", "/fapi/v1/userTrades", {"symbol": "SKHYUSDT", "limit": 100}, signed=True)
            if isinstance(skhy_trades, list):
                for t in skhy_trades:
                    executions.append({
                        "id": str(t.get("id", "")),
                        "symbol": "SKHYUSDT",
                        "side": t.get("side", ""),
                        "price": float(t.get("price", 0.0)),
                        "qty": float(t.get("qty", 0.0)),
                        "realized_pnl": float(t.get("realizedPnl", 0.0)),
                        "commission": float(t.get("commission", 0.0)),
                        "commission_asset": str(t.get("commissionAsset", "USDT")),
                        "time": int(t.get("time", 0)),
                        "action_type": "ENTRY_SHORT" if t.get("side") == "SELL" else "EXIT_SHORT"
                    })
            executions.sort(key=lambda x: x["time"])
        except Exception:
            pass

        # Real-time criteria for speculative trend-reversal auto-tranching & anti-churn LIFO ratchet
        base_entry = entry_spread if entry_spread else 139.30
        curr_spread = current_spread if current_spread else 139.30
        tranches_remaining = max(0, 10 - tranches_active)
        can_scale_in = bool(tranches_remaining > 0 and free_buffer >= 2.0)

        # 1. Moving Average & Speculative Peak-Out Metrics
        parity_bars = await get_cached_parity_bars("5m", 30)
        if parity_bars and len(parity_bars) >= 6:
            ma_subset = parity_bars[-24:] if len(parity_bars) >= 24 else parity_bars
            ma24 = sum(b["value"] for b in ma_subset) / len(ma_subset)
            last_val = parity_bars[-1]["value"]
            prev_val = parity_bars[-2]["value"] if len(parity_bars) > 1 else last_val
            prev2_val = parity_bars[-3]["value"] if len(parity_bars) > 2 else prev_val
            local_high_3 = max(prev_val, prev2_val)
            is_peaking_out = bool(last_val <= prev_val or last_val < local_high_3)
            spread_velocity = round(last_val - prev_val, 3)
        else:
            ma24 = base_entry
            is_peaking_out = True
            spread_velocity = 0.0

        ma_stretch_pts = round(curr_spread - ma24, 2)
        is_stretched_above_ma = bool(ma_stretch_pts >= 0.10)
        is_above_entry = bool(curr_spread >= base_entry + 0.10) if tranches_active > 0 else True
        scale_in_armed = bool(can_scale_in and is_stretched_above_ma and is_above_entry and is_peaking_out)
        scale_in_trigger = round(max(ma24 + 0.10, base_entry + 0.10), 2)

        # 2. Multi-Tranche Entry Tracking (Anti-Churn LIFO Stack Queue)
        # Reconstruct the active open tranche stack from chronological trade history
        now_sec = time.time()
        active_tranches_queue = []

        if executions:
            for tr in executions:
                action = tr.get("action_type")
                t_sec = tr.get("time", 0) / 1000
                matched_bar = min(parity_bars, key=lambda b: abs(b["time"] - t_sec)) if parity_bars else None
                bar_spread = matched_bar["value"] if matched_bar else base_entry

                if action == "ENTRY_SHORT":
                    active_tranches_queue.append({
                        "trade_id": str(tr.get("id", "")),
                        "time": t_sec,
                        "qty": float(tr.get("qty", 0.08)),
                        "entry_spread": round(bar_spread, 2),
                        "entry_price": float(tr.get("price", 0.0)),
                        "target_out_spread": round(bar_spread - 0.08, 2)
                    })
                elif action == "EXIT_SHORT":
                    if active_tranches_queue:
                        active_tranches_queue.pop()  # LIFO: exit pops the most recent entry tranche

        # 1-to-1 Entry-to-Exit Matching Invariant:
        # Each scale-out requires a corresponding un-exited scale-in entry.
        # Once all entries are exited, remaining position is accumulated core inventory and CANNOT be trimmed.
        if adr_qty == 0 or stock_qty == 0:
            active_tranches_queue = []
        elif len(active_tranches_queue) > tranches_active:
            active_tranches_queue = active_tranches_queue[-tranches_active:]
        # DO NOT prepend missing tranches! If len(active_tranches_queue) < tranches_active,
        # the difference represents accumulated core inventory that must remain protected.

        speculative_tranches_active = len(active_tranches_queue)
        core_accumulated_skhy = round(max(0.0, adr_qty - (speculative_tranches_active * 0.08)), 4)
        core_accumulated_csop = round(max(0.0, stock_qty - (speculative_tranches_active * 1.40)), 4)

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

        is_out_profitable_relative_to_latest = bool(current_target_tranche and curr_spread <= out_target_spread)
        is_dwell_satisfied = bool(current_target_tranche and dwell_time_sec >= 120)
        can_take_profit = bool(
            speculative_tranches_active > 0 
            and eligible_for_take_profit 
            and is_out_profitable_relative_to_latest 
            and is_dwell_satisfied
            and adr_qty >= 0.07
            and stock_qty >= 1.20
        )

        status_scale_in = (
            "PEAK_REVERSAL_ARMED" if scale_in_armed
            else ("MAX_CAPACITY" if not can_scale_in
            else ("AWAITING_MA_STRETCH" if not is_stretched_above_ma
            else ("WAITING_PEAK_EXHAUSTION" if not is_peaking_out
            else "WAITING_DIVERGENCE")))
        )

        status_take_profit = (
            "TRIM_READY" if can_take_profit
            else ("NO_ACTIVE_TRANCHES" if adr_qty == 0
            else ("CORE_INVENTORY_RETAINED" if speculative_tranches_active == 0
            else ("LOCKED_AWAITING_PROFIT" if not eligible_for_take_profit
            else (f"ANTI_CHURN_DWELL ({120 - dwell_time_sec}s)" if not is_dwell_satisfied
            else f"ANTI_CHURN_WAITING_CONVERGENCE (Target <={out_target_spread}%)"))))
        )

        auto_state = load_auto_tranche_state()

        auto_criteria = {
            "backend_auto_tranche_enabled": bool(auto_state.get("enabled", False)),
            "backend_auto_tranche_state": auto_state,
            "entry_baseline_spread": round(base_entry, 2),
            "current_spread": round(curr_spread, 2),
            "rolling_ma_24": round(ma24, 2),
            "ma_stretch_pts": ma_stretch_pts,
            "is_stretched_above_ma": is_stretched_above_ma,
            "is_peaking_out": is_peaking_out,
            "spread_velocity_1bar": spread_velocity,
            "scale_in_trigger_spread": scale_in_trigger,
            "gap_to_scale_in_pts": round(scale_in_trigger - curr_spread, 2),
            "scale_in_threshold_pts": 0.10,
            "scale_in_armed": scale_in_armed,
            "tranches_active": tranches_active,
            "speculative_tranches_active": speculative_tranches_active,
            "core_accumulated_skhy": core_accumulated_skhy,
            "core_accumulated_csop": core_accumulated_csop,
            "tranches_max": 10,
            "tranches_remaining": tranches_remaining,
            "can_scale_in": can_scale_in,
            "status_scale_in": status_scale_in,

            # Anti-Churn & Queued Multi-Tranche Out Tracking:
            "active_tranches_queue": active_tranches_queue,
            "current_target_tranche": current_target_tranche,
            "latest_entry_spread": round(latest_in_spread, 2),
            "out_target_spread": out_target_spread,
            "take_profit_trigger_spread": out_target_spread,
            "gap_to_out_pts": round(curr_spread - out_target_spread, 2),
            "gap_to_take_profit_pts": round(curr_spread - out_target_spread, 2),
            "dwell_time_sec": dwell_time_sec,
            "dwell_min_sec": 120,
            "is_dwell_satisfied": is_dwell_satisfied,
            "is_out_profitable_relative_to_latest": is_out_profitable_relative_to_latest,
            "can_take_profit": can_take_profit,
            "status_take_profit": status_take_profit,

            "asymmetric_sizing": {
                "scale_in_skhy": 0.08,
                "scale_in_csop": 1.40,
                "scale_in_notional_usd": 23.40,
                "scale_out_skhy": 0.07,
                "scale_out_csop": 1.20,
                "scale_out_notional_usd": 20.41,
                "residual_retained_skhy": 0.01,
                "residual_retained_csop": 0.20
            },
            "next_tranche_size": {
                "skhy_qty": 0.08,
                "csop_qty": 1.40,
                "notional_usd": 23.40,
                "leverage_add": 0.67
            }
        }

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
            "recent_executions": executions,
            "auto_tranche_criteria": auto_criteria,
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

@app.get("/api/trade/short_term_parity")
async def get_short_term_parity(interval: str = "5m", limit: int = 60) -> Dict[str, Any]:
    """
    Returns high-resolution short-term parity spread series, aligned executions,
    and markers for the live entry/exit chart.
    """
    try:
        limit = min(120, max(20, limit))
        interval = interval if interval in ["1m", "5m", "15m"] else "5m"
        interval_ms = (1 if interval == "1m" else (5 if interval == "5m" else 15)) * 60 * 1000

        k1, k2 = await asyncio.gather(
            binance_client.request("GET", "/fapi/v1/klines", {"symbol": "SKHYUSDT", "interval": interval, "limit": limit}),
            binance_client.request("GET", "/fapi/v1/klines", {"symbol": "SKHYNIXUSDT", "interval": interval, "limit": limit}),
            return_exceptions=True
        )

        if not isinstance(k1, list) or not isinstance(k2, list):
            return {"error": "Failed to fetch klines from Binance", "bars": [], "markers": []}

        m2 = {x[0]: float(x[4]) for x in k2}
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
                    "domestic": round(p2, 2)
                })

        markers = []
        executions = []
        try:
            start_ms = int((bars[0]["time"] - 1800) * 1000) if bars else int((time.time() - 6 * 3600) * 1000)
            trades = await binance_client.request("GET", "/fapi/v1/userTrades", {"symbol": "SKHYUSDT", "startTime": start_ms, "limit": 100}, signed=True)
            if not isinstance(trades, list) or len(trades) == 0:
                trades = await binance_client.request("GET", "/fapi/v1/userTrades", {"symbol": "SKHYUSDT", "limit": 100}, signed=True)

            if isinstance(trades, list) and bars:
                min_time_sec = bars[0]["time"]
                candle_markers = {}
                for tr in sorted(trades, key=lambda x: x.get("time", 0)):
                    t_ms = int(tr.get("time", 0))
                    t_sec = int(t_ms / 1000)
                    if t_sec >= min_time_sec - 600:
                        bar_bucket_sec = int((t_ms // interval_ms) * (interval_ms // 1000))
                        matched_bar = min(bars, key=lambda b: abs(b["time"] - bar_bucket_sec))
                        marker_time = matched_bar["time"]

                        side = tr.get("side", "")
                        is_entry = (side == "SELL")
                        price = float(tr.get("price", 0.0))
                        qty = float(tr.get("qty", 0.0))

                        key = (marker_time, is_entry)
                        if key not in candle_markers:
                            candle_markers[key] = {
                                "time": marker_time,
                                "is_entry": is_entry,
                                "total_qty": qty,
                                "weighted_price": price * qty,
                                "count": 1
                            }
                        else:
                            candle_markers[key]["total_qty"] += qty
                            candle_markers[key]["weighted_price"] += price * qty
                            candle_markers[key]["count"] += 1

                        executions.append({
                            "time": t_sec,
                            "side": side,
                            "price": price,
                            "qty": qty,
                            "type": "ENTRY" if is_entry else "EXIT"
                        })

                # Sort chronologically by marker_time to satisfy Lightweight Charts strict monotonic ordering
                for (m_time, is_entry), m_data in sorted(candle_markers.items(), key=lambda x: x[0][0]):
                    avg_px = m_data["weighted_price"] / max(1e-6, m_data["total_qty"])
                    qty_str = f"{m_data['total_qty']:.2f}"
                    cnt_str = f" ({m_data['count']}x)" if m_data['count'] > 1 else ""
                    lbl = f"{'Entry' if is_entry else 'Exit'}{cnt_str} ${avg_px:.2f} ({qty_str})"
                    markers.append({
                        "time": m_time,
                        "position": "belowBar" if is_entry else "aboveBar",
                        "color": "#16a34a" if is_entry else "#dc2626",
                        "shape": "arrowUp" if is_entry else "arrowDown",
                        "text": lbl
                    })
        except Exception:
            logger.exception("Error loading trade markers")

        return {
            "success": True,
            "interval": interval,
            "bars": bars,
            "markers": markers,
            "executions": executions,
            "latest_parity": bars[-1]["value"] if bars else None
        }
    except Exception as e:
        logger.exception("Error in get_short_term_parity")
        return {"error": str(e), "bars": [], "markers": []}

@app.post("/api/trade/step_tranche")
async def step_tranche() -> Dict[str, Any]:
    """
    Executes Asymmetric Scale-In Tranche:
    - Sets 10x leverage and CROSSED margin on SKHYUSDT and CSOPSKHYNIX2LUSDT
    - SELL MARKET 0.08 SKHYUSDT (Short ADR)
    - BUY MARKET 1.40 CSOPSKHYNIX2LUSDT (Long CSOP 2x ETF Perp)
    - Leaves +0.01 SKHY / +0.20 CSOP residual core inventory upon GCD trim!
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

        order_adr = await binance_client.create_order("SKHYUSDT", "SELL", 0.08, "MARKET")
        order_stock = await binance_client.create_order("CSOPSKHYNIX2LUSDT", "BUY", 1.40, "MARKET")

        return {
            "success": True,
            "message": "Asymmetric Scale-in filled: Short 0.08 SKHYUSDT + Long 1.40 CSOPSKHYNIX2LUSDT",
            "scale_in_adr_qty": 0.08,
            "scale_in_stock_qty": 1.40,
            "order_adr": order_adr,
            "order_stock": order_stock
        }
    except Exception as e:
        logger.exception("Error executing tranche step")
        return {"success": False, "error": str(e)}

@app.post("/api/trade/reduce_tranche")
async def reduce_tranche(force: bool = False) -> Dict[str, Any]:
    """
    Closes 1 Tranche (Take-Profit):
    - STRICTLY ENFORCES ZERO-LOSS INVARIANT: Rejects order if combined unrealized PnL <= $0.02!
    - ENFORCES ANTI-CHURN GUARD: Blocks immediate flip unless minimum hold elapsed or force=True.
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
        if combined_pnl <= 0.02 and not force:
            return {
                "success": False,
                "error": f"ZERO-LOSS INVARIANT ENFORCED: Combined PnL is ${combined_pnl:.2f} <= $0.02 threshold. You cannot exit at a loss. Wait for convergence or add tranches."
            }

        # Anti-Churn Guard: block immediate flip if latest entry was executed < 60s ago
        if not force:
            try:
                trades = await binance_client.request("GET", "/fapi/v1/userTrades", {"symbol": "SKHYUSDT", "limit": 10}, signed=True)
                if isinstance(trades, list):
                    entry_trades = [t for t in trades if t.get("side") == "SELL"]
                    if entry_trades:
                        latest_entry = entry_trades[-1]
                        elapsed_sec = int(time.time() - (int(latest_entry.get("time", 0)) / 1000))
                        if elapsed_sec < 60:
                            return {
                                "success": False,
                                "error": f"ANTI-CHURN GUARD: Latest tranche entered only {elapsed_sec}s ago (< 60s min hold). Wait for convergence to prevent churning."
                            }
            except Exception:
                pass

        stock_sym = stock_pos.get("symbol", "CSOPSKHYNIX2LUSDT")
        adr_pos_amt = abs(float(adr_pos.get("position_amt", 0.0)))
        stock_pos_amt = abs(float(stock_pos.get("position_amt", 0.0)))

        # 1-to-1 Entry-to-Exit Matching Guard:
        # Require position to have at least 1 full tranche size (0.07 SKHY / 1.20 CSOP)
        # to prevent liquidating fractional core accumulation!
        if not force:
            if adr_pos_amt < 0.07 or stock_pos_amt < 1.20:
                return {
                    "success": False,
                    "error": f"CORE INVENTORY PROTECTED: Position size ({adr_pos_amt} SKHY / {stock_pos_amt} CSOP) is below 1 full tranche (0.07 / 1.20). Remaining inventory is retained core accumulation."
                }

        adr_reduce_qty = 0.07 if (adr_pos_amt >= 0.07 or force) else adr_pos_amt
        stock_target = 1.20 if stock_sym == "CSOPSKHYNIX2LUSDT" else 0.01
        stock_reduce_qty = stock_target if (stock_pos_amt >= stock_target or force) else stock_pos_amt

        if adr_reduce_qty <= 0 or stock_reduce_qty <= 0:
            return {"success": False, "error": f"Position sizes too small to reduce: ADR {adr_pos_amt}, Stock {stock_pos_amt}"}

        order_adr, order_stock = await asyncio.gather(
            binance_client.create_order("SKHYUSDT", "BUY", adr_reduce_qty, "MARKET", reduce_only=True),
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

@app.get("/api/trade/auto_tranche_status")
async def get_auto_tranche_status() -> Dict[str, Any]:
    """Returns persistent 24/7 EC2 auto-tranche state."""
    state = load_auto_tranche_state()
    return {"success": True, "state": state}

@app.post("/api/trade/toggle_auto_tranche")
async def toggle_auto_tranche(enabled: Optional[bool] = None) -> Dict[str, Any]:
    """Toggles or sets the 24/7 EC2 server-side auto-tranche execution daemon."""
    state = load_auto_tranche_state()
    if enabled is None:
        state["enabled"] = not state.get("enabled", False)
    else:
        state["enabled"] = bool(enabled)
    state["last_action"] = f"TOGGLED_{'ENABLED' if state['enabled'] else 'DISABLED'}"
    state["last_action_time"] = time.time()
    save_auto_tranche_state(state)
    logger.info(f"[Auto-Tranche] Daemon mode toggled to: {state['enabled']}")
    return {"success": True, "state": state}

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
            if state.get("enabled", False):
                status = await get_hedged_status()
                if status.get("authenticated"):
                    criteria = status.get("auto_tranche_criteria", {})
                    can_take_profit = bool(criteria.get("can_take_profit", False))
                    scale_in_armed = bool(criteria.get("scale_in_armed", False))
                    tranches_active = int(status.get("tranches_active", 0))

                    now = time.time()
                    last_reduce = float(state.get("last_reduce_time", 0))
                    last_step = float(state.get("last_step_time", 0))

                    # 1. Take-Profit (Conservative Anti-Churn Scale-Out)
                    if tranches_active > 0 and can_take_profit:
                        if now - last_reduce >= 30:
                            logger.info("[Auto-Tranche Worker] Executing autonomous take-profit trim...")
                            res = await reduce_tranche()
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
                    elif scale_in_armed and tranches_active < 10:
                        if now - last_step >= 60:
                            logger.info("[Auto-Tranche Worker] Executing autonomous speculative scale-in step...")
                            res = await step_tranche()
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

