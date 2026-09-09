import time
import uuid
import hmac
import hashlib
import urllib.parse
from typing import Dict, Any, List, Optional
import aiohttp
import jwt
from .config import config

class UpbitClient:
    """
    Upbit Open API Client with JWT authorization.
    Provides account balance retrieval, market ticker valuation, and portfolio synthesis.
    """
    def __init__(self, access_key: Optional[str] = None, secret_key: Optional[str] = None, base_url: Optional[str] = None):
        self.access_key = access_key or config.UPBIT_ACCESS_KEY
        self.secret_key = secret_key or config.UPBIT_SECRET_KEY
        self.base_url = (base_url or config.UPBIT_BASE_URL).rstrip("/")
        self._session: Optional[aiohttp.ClientSession] = None

    async def get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=10)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    def _generate_jwt_token(self, params: Optional[Dict[str, Any]] = None) -> str:
        """Create Upbit JWT authorization token with optional SHA-512 query hash."""
        payload: Dict[str, Any] = {
            "access_key": self.access_key,
            "nonce": str(uuid.uuid4())
        }
        if params:
            query_string = urllib.parse.unquote(urllib.parse.urlencode(params, doseq=True)).encode("utf-8")
            m = hashlib.sha512()
            m.update(query_string)
            query_hash = m.hexdigest()
            payload["query_hash"] = query_hash
            payload["query_hash_alg"] = "SHA512"

        token = jwt.encode(payload, self.secret_key, algorithm="HS256")
        if isinstance(token, bytes):
            return token.decode("utf-8")
        return str(token)

    async def request(self, method: str, endpoint: str, params: Optional[Dict[str, Any]] = None, signed: bool = False) -> Any:
        session = await self.get_session()
        headers = {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }

        if signed:
            if not self.access_key or not self.secret_key:
                raise ValueError("Upbit Access Key and Secret Key are required for signed endpoints.")
            jwt_token = self._generate_jwt_token(params)
            headers["Authorization"] = f"Bearer {jwt_token}"

        url = f"{self.base_url}{endpoint}"
        if params and method.upper() == "GET":
            url = f"{url}?{urllib.parse.urlencode(params, doseq=True)}"

        async with session.request(method, url, headers=headers) as resp:
            data = await resp.json()
            if resp.status not in (200, 201):
                msg = ""
                if isinstance(data, dict):
                    err = data.get("error", {})
                    msg = err.get("message", str(data)) if isinstance(err, dict) else str(data)
                else:
                    msg = str(data)
                raise Exception(f"Upbit API Error [{resp.status}]: {msg}")
            return data

    async def ping(self) -> bool:
        """Test connectivity to Upbit API."""
        try:
            res = await self.request("GET", "/v1/market/all", params={"isDetails": "false"})
            return isinstance(res, list) and len(res) > 0
        except Exception:
            return False

    async def get_raw_accounts(self) -> List[Dict[str, Any]]:
        """Fetch raw account balances from /v1/accounts."""
        return await self.request("GET", "/v1/accounts", signed=True)

    async def get_tickers(self, markets: List[str]) -> List[Dict[str, Any]]:
        """Fetch current prices for given markets (e.g. ['KRW-BTC', 'KRW-USDT'])."""
        if not markets:
            return []
        # Chunk into max 100 markets per request
        chunk_size = 100
        all_tickers = []
        for i in range(0, len(markets), chunk_size):
            chunk = markets[i:i + chunk_size]
            try:
                data = await self.request("GET", "/v1/ticker", params={"markets": ",".join(chunk)})
                if isinstance(data, list):
                    all_tickers.extend(data)
            except Exception:
                pass
        return all_tickers

    async def get_detailed_account_overview(self) -> Dict[str, Any]:
        """
        Fetch and synthesize all Upbit balances, KRW/USD valuations, and asset breakdown
        into a structured payload for multi-exchange monitoring and arbitrage analysis.
        """
        if not self.access_key or not self.secret_key:
            return {
                "authenticated": False,
                "auth_source": config.UPBIT_AUTH_SOURCE,
                "exchange": "UPBIT",
                "error": "No Upbit API Key / Secret detected. Please configure UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY in .env or keys.json (arbiter/midas).",
                "summary": {
                    "total_equity_krw": 0.0,
                    "total_equity_usd": 0.0,
                    "cash_krw": 0.0,
                    "locked_krw": 0.0,
                    "crypto_eval_krw": 0.0,
                    "total_unrealized_pnl_krw": 0.0,
                    "total_return_pct": 0.0,
                    "usdt_krw_rate": 1400.0
                },
                "assets": []
            }

        try:
            raw_accounts = await self.get_raw_accounts()
            if not isinstance(raw_accounts, list):
                raw_accounts = []

            # Filter non-zero items
            active_accounts = []
            currencies_to_price = set()

            for item in raw_accounts:
                curr = item.get("currency", "")
                bal = float(item.get("balance", 0.0))
                lck = float(item.get("locked", 0.0))
                if (bal + lck) > 1e-8:
                    active_accounts.append(item)
                    if curr != "KRW":
                        currencies_to_price.add(curr)

            # Always price KRW-USDT to establish an accurate USD/KRW conversion rate
            all_market_queries = [f"KRW-{c}" for c in currencies_to_price]
            if "KRW-USDT" not in all_market_queries:
                all_market_queries.append("KRW-USDT")

            ticker_list = await self.get_tickers(all_market_queries)
            ticker_map = {t["market"]: float(t.get("trade_price", 0.0)) for t in ticker_list if "market" in t}

            # Resolve USDT/KRW rate
            usdt_krw_rate = ticker_map.get("KRW-USDT", 1400.0)
            if usdt_krw_rate <= 0:
                usdt_krw_rate = 1400.0

            cash_krw = 0.0
            locked_krw = 0.0
            crypto_eval_krw = 0.0
            total_buy_cost_krw = 0.0
            total_pnl_krw = 0.0

            processed_assets = []

            for item in active_accounts:
                curr = item.get("currency", "")
                bal = float(item.get("balance", 0.0))
                lck = float(item.get("locked", 0.0))
                total_qty = bal + lck
                avg_buy_price = float(item.get("avg_buy_price", 0.0))

                if curr == "KRW":
                    cash_krw += bal
                    locked_krw += lck
                    total_buy_cost_krw += total_qty
                    processed_assets.append({
                        "currency": "KRW",
                        "name": "Korean Won (Cash)",
                        "balance": bal,
                        "locked": lck,
                        "total_quantity": total_qty,
                        "avg_buy_price": 1.0,
                        "current_price_krw": 1.0,
                        "eval_amount_krw": total_qty,
                        "eval_amount_usd": round(total_qty / usdt_krw_rate, 2),
                        "unrealized_pnl_krw": 0.0,
                        "return_rate_percent": 0.0
                    })
                else:
                    m_key = f"KRW-{curr}"
                    cur_price = ticker_map.get(m_key, avg_buy_price)
                    eval_val = total_qty * cur_price
                    buy_val = total_qty * avg_buy_price if avg_buy_price > 0 else eval_val
                    pnl_val = eval_val - buy_val if avg_buy_price > 0 else 0.0
                    roe = ((cur_price - avg_buy_price) / avg_buy_price * 100.0) if avg_buy_price > 0 else 0.0

                    crypto_eval_krw += eval_val
                    total_buy_cost_krw += buy_val
                    total_pnl_krw += pnl_val

                    processed_assets.append({
                        "currency": curr,
                        "name": curr,
                        "balance": bal,
                        "locked": lck,
                        "total_quantity": total_qty,
                        "avg_buy_price": avg_buy_price,
                        "current_price_krw": cur_price,
                        "eval_amount_krw": round(eval_val, 2),
                        "eval_amount_usd": round(eval_val / usdt_krw_rate, 2),
                        "unrealized_pnl_krw": round(pnl_val, 2),
                        "return_rate_percent": round(roe, 2)
                    })

            # Sort assets: KRW first, then by KRW valuation descending
            processed_assets.sort(key=lambda a: (0 if a["currency"] == "KRW" else 1, -a["eval_amount_krw"]))

            total_equity_krw = cash_krw + locked_krw + crypto_eval_krw
            total_equity_usd = total_equity_krw / usdt_krw_rate
            total_return_pct = (total_pnl_krw / total_buy_cost_krw * 100.0) if total_buy_cost_krw > 0 else 0.0

            return {
                "authenticated": True,
                "auth_source": config.UPBIT_AUTH_SOURCE,
                "exchange": "UPBIT",
                "summary": {
                    "total_equity_krw": round(total_equity_krw, 2),
                    "total_equity_usd": round(total_equity_usd, 2),
                    "cash_krw": round(cash_krw, 2),
                    "locked_krw": round(locked_krw, 2),
                    "crypto_eval_krw": round(crypto_eval_krw, 2),
                    "total_unrealized_pnl_krw": round(total_pnl_krw, 2),
                    "total_return_pct": round(total_return_pct, 2),
                    "usdt_krw_rate": round(usdt_krw_rate, 2),
                    "asset_count": len(processed_assets)
                },
                "assets": processed_assets
            }
        except Exception as e:
            return {
                "authenticated": False,
                "auth_source": config.UPBIT_AUTH_SOURCE,
                "exchange": "UPBIT",
                "error": str(e),
                "summary": {
                    "total_equity_krw": 0.0,
                    "total_equity_usd": 0.0,
                    "cash_krw": 0.0,
                    "locked_krw": 0.0,
                    "crypto_eval_krw": 0.0,
                    "total_unrealized_pnl_krw": 0.0,
                    "total_return_pct": 0.0,
                    "usdt_krw_rate": 1400.0
                },
                "assets": []
            }
