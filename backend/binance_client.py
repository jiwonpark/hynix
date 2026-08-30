import time
import hmac
import hashlib
import urllib.parse
from typing import Dict, Any, List, Optional
import aiohttp
from .config import config

class BinanceFuturesClient:
    def __init__(self, api_key: Optional[str] = None, api_secret: Optional[str] = None, base_url: Optional[str] = None):
        self.api_key = api_key or config.BINANCE_API_KEY
        self.api_secret = api_secret or config.BINANCE_API_SECRET
        self.base_url = base_url or config.BASE_URL
        self._session: Optional[aiohttp.ClientSession] = None

    async def get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=10)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    def _sign_params(self, params: Dict[str, Any]) -> str:
        """Create signed query string with HMAC-SHA256 signature."""
        params["timestamp"] = int(time.time() * 1000)
        params["recvWindow"] = 60000  # 60 seconds tolerance for clock drift
        query_string = urllib.parse.urlencode(sorted(params.items()))
        signature = hmac.new(
            self.api_secret.encode("utf-8"),
            query_string.encode("utf-8"),
            hashlib.sha256
        ).hexdigest()
        return f"{query_string}&signature={signature}"

    async def request(self, method: str, endpoint: str, params: Optional[Dict[str, Any]] = None, signed: bool = False) -> Any:
        session = await self.get_session()
        params = params or {}
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "SKHynix-QuantEngine/1.0"
        }

        if signed:
            if not self.api_key or not self.api_secret:
                raise ValueError("Binance API Key and Secret are required for signed endpoints.")
            headers["X-MBX-APIKEY"] = self.api_key
            query_str = self._sign_params(params)
            url = f"{self.base_url}{endpoint}?{query_str}"
        else:
            if params:
                url = f"{self.base_url}{endpoint}?{urllib.parse.urlencode(params)}"
            else:
                url = f"{self.base_url}{endpoint}"

        async with session.request(method, url, headers=headers) as resp:
            data = await resp.json()
            if resp.status != 200:
                msg = data.get("msg", str(data)) if isinstance(data, dict) else str(data)
                code = data.get("code", resp.status) if isinstance(data, dict) else resp.status
                raise Exception(f"Binance API Error [{code}]: {msg}")
            return data

    async def ping(self) -> bool:
        """Test connectivity to Binance Futures API."""
        try:
            res = await self.request("GET", "/fapi/v1/ping")
            return res == {}
        except Exception:
            return False

    async def get_raw_account(self) -> Dict[str, Any]:
        """Fetch raw account endpoint /fapi/v2/account."""
        return await self.request("GET", "/fapi/v2/account", signed=True)

    async def get_raw_positions(self) -> List[Dict[str, Any]]:
        """Fetch raw position risk endpoint /fapi/v2/positionRisk."""
        return await self.request("GET", "/fapi/v2/positionRisk", signed=True)

    async def get_detailed_account_overview(self) -> Dict[str, Any]:
        """
        Fetch and synthesize all account balances, margin stats, and open positions
        into a clean, structured payload for UI & execution monitoring.
        """
        if not self.api_key or not self.api_secret:
            return {
                "authenticated": False,
                "error": "No Binance API Key / Secret configured. Please set BINANCE_API_KEY and BINANCE_API_SECRET in .env or environment.",
                "summary": {
                    "total_equity_usd": 0.0,
                    "total_wallet_balance_usd": 0.0,
                    "total_unrealized_pnl_usd": 0.0,
                    "available_margin_usd": 0.0,
                    "maintenance_margin_usd": 0.0,
                    "margin_ratio_percent": 0.0,
                    "max_withdraw_amount_usd": 0.0,
                },
                "assets": [],
                "positions": [],
                "timestamp": int(time.time() * 1000)
            }

        # Fetch in parallel
        acc_data, pos_data = await asyncio_gather(
            self.get_raw_account(),
            self.get_raw_positions()
        )

        total_wallet = float(acc_data.get("totalWalletBalance", 0.0))
        total_unrealized = float(acc_data.get("totalUnrealizedProfit", 0.0))
        total_margin_balance = float(acc_data.get("totalMarginBalance", 0.0))
        total_maint_margin = float(acc_data.get("totalMaintMargin", 0.0))
        total_initial_margin = float(acc_data.get("totalInitialMargin", 0.0))
        max_withdraw = float(acc_data.get("maxWithdrawAmount", 0.0))
        
        # Calculate Margin Ratio %
        # Margin Ratio = (Maintenance Margin / Margin Balance) * 100
        margin_ratio = (total_maint_margin / total_margin_balance * 100.0) if total_margin_balance > 0 else 0.0
        free_margin = max(0.0, total_margin_balance - total_initial_margin)

        # 1. Parse Non-Zero Assets
        assets_list = []
        raw_assets = acc_data.get("assets", [])
        for a in raw_assets:
            wallet_bal = float(a.get("walletBalance", 0.0))
            unrealized = float(a.get("unrealizedProfit", 0.0))
            margin_bal = float(a.get("marginBalance", 0.0))
            avail_bal = float(a.get("availableBalance", 0.0))
            max_withdraw_asset = float(a.get("maxWithdrawAmount", 0.0))

            # Include if there is any balance or open unrealized profit
            if abs(wallet_bal) > 0.000001 or abs(unrealized) > 0.000001 or abs(margin_bal) > 0.000001:
                assets_list.append({
                    "asset": a.get("asset"),
                    "wallet_balance": wallet_bal,
                    "unrealized_profit": unrealized,
                    "margin_balance": margin_bal,
                    "available_balance": avail_bal,
                    "max_withdraw_amount": max_withdraw_asset,
                    "cross_wallet_balance": float(a.get("crossWalletBalance", 0.0)),
                    "cross_unrealized_pnl": float(a.get("crossUnPnl", 0.0))
                })

        # Sort assets: USDT first, USDC second, then by margin_balance descending
        def asset_sort_key(item):
            sym = item["asset"].upper()
            if sym == "USDT":
                return (0, -item["margin_balance"])
            elif sym == "USDC":
                return (1, -item["margin_balance"])
            elif sym == "BNB":
                return (2, -item["margin_balance"])
            return (3, -item["margin_balance"])

        assets_list.sort(key=asset_sort_key)

        # 2. Parse Active Open Positions
        positions_list = []
        for p in pos_data:
            amt = float(p.get("positionAmt", 0.0))
            if abs(amt) < 1e-8:
                continue  # Skip closed / zero positions

            entry_price = float(p.get("entryPrice", 0.0))
            mark_price = float(p.get("markPrice", 0.0))
            liq_price = float(p.get("liquidationPrice", 0.0))
            unrealized_pnl = float(p.get("unRealizedProfit", 0.0))
            leverage = int(p.get("leverage", 1))
            notional = abs(float(p.get("notional", 0.0)))
            isolated = p.get("isolated", False) or (p.get("marginType", "").lower() == "isolated")
            side = "LONG" if amt > 0 else "SHORT"

            # Compute Margin & ROE
            initial_margin = (notional / leverage) if leverage > 0 else notional
            roe_percent = (unrealized_pnl / initial_margin * 100.0) if initial_margin > 0 else 0.0

            # Distance to Liquidation %
            distance_to_liq_percent = None
            if liq_price > 0 and mark_price > 0:
                if side == "LONG":
                    distance_to_liq_percent = ((mark_price - liq_price) / mark_price) * 100.0
                else:
                    distance_to_liq_percent = ((liq_price - mark_price) / mark_price) * 100.0

            positions_list.append({
                "symbol": p.get("symbol"),
                "side": side,
                "size": abs(amt),
                "position_amt": amt,
                "entry_price": entry_price,
                "mark_price": mark_price,
                "liquidation_price": liq_price if liq_price > 0 else None,
                "distance_to_liq_percent": distance_to_liq_percent,
                "unrealized_pnl": unrealized_pnl,
                "roe_percent": roe_percent,
                "leverage": leverage,
                "notional": notional,
                "initial_margin": initial_margin,
                "margin_type": "ISOLATED" if isolated else "CROSS",
                "update_time": int(p.get("updateTime", 0))
            })

        # Sort positions: SKHYUSDT and SKHYNIXUSDT first, then by notional descending
        def pos_sort_key(item):
            sym = item["symbol"].upper()
            if sym == "SKHYUSDT":
                return (0, -item["notional"])
            elif sym == "SKHYNIXUSDT":
                return (1, -item["notional"])
            return (2, -item["notional"])

        positions_list.sort(key=pos_sort_key)

        return {
            "authenticated": True,
            "can_trade": acc_data.get("canTrade", True),
            "can_deposit": acc_data.get("canDeposit", True),
            "can_withdraw": acc_data.get("canWithdraw", True),
            "fee_tier": acc_data.get("feeTier", 0),
            "summary": {
                "total_equity_usd": total_margin_balance,
                "total_wallet_balance_usd": total_wallet,
                "total_unrealized_pnl_usd": total_unrealized,
                "available_margin_usd": free_margin,
                "maintenance_margin_usd": total_maint_margin,
                "initial_margin_usd": total_initial_margin,
                "margin_ratio_percent": margin_ratio,
                "max_withdraw_amount_usd": max_withdraw
            },
            "assets": assets_list,
            "positions": positions_list,
            "open_position_count": len(positions_list),
            "timestamp": int(time.time() * 1000)
        }

async def asyncio_gather(*coros):
    import asyncio
    return await asyncio.gather(*coros)
