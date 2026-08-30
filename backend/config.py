import os
import json
from pathlib import Path
from dotenv import load_dotenv

# 1. Try loading from .env files
env_locations = [
    Path(__file__).parent / ".env",
    Path(__file__).parent.parent / ".env",
    Path("/home/ubuntu/.env"),
    Path.home() / ".env"
]

for loc in env_locations:
    if loc.is_file():
        load_dotenv(loc, override=False)

# 2. Try loading from keys.json files
keys_json_locations = [
    Path(__file__).parent / "keys.json",
    Path(__file__).parent.parent / "keys.json",
    Path("/home/ubuntu/keys.json"),
    Path("/home/ubuntu/arbiter/keys.json"),
    Path.home() / "keys.json"
]

json_creds = {}
loaded_json_source = ""
for loc in keys_json_locations:
    if loc.is_file():
        try:
            with open(loc, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    # 1. Check list format: "binance": ["API_KEY", "API_SECRET"]
                    for b_key in ["binance", "binance_futures", "binance_usdt"]:
                        val = data.get(b_key)
                        if isinstance(val, list) and len(val) >= 2:
                            json_creds["BINANCE_API_KEY"] = str(val[0]).strip()
                            json_creds["BINANCE_API_SECRET"] = str(val[1]).strip()
                            loaded_json_source = str(loc)
                        elif isinstance(val, dict):
                            k = val.get("api_key") or val.get("key") or val.get("apiKey") or val.get("BINANCE_API_KEY")
                            s = val.get("api_secret") or val.get("secret") or val.get("apiSecret") or val.get("BINANCE_API_SECRET")
                            if k and s:
                                json_creds["BINANCE_API_KEY"] = str(k).strip()
                                json_creds["BINANCE_API_SECRET"] = str(s).strip()
                                loaded_json_source = str(loc)
                    
                    # 2. Check top-level keys
                    for k, v in data.items():
                        if isinstance(v, str):
                            json_creds[k] = v.strip()
                            if "binance" in k.lower():
                                loaded_json_source = str(loc)
        except Exception:
            pass

def get_config_val_with_source(aliases: list[str], default: str = "") -> tuple[str, str]:
    """Retrieve credential and its origin (env vs json)."""
    # Check env vars
    for key in aliases:
        val = os.getenv(key)
        if val and val.strip():
            return val.strip(), "env"
    # Check json creds
    for key in aliases:
        val = json_creds.get(key) or json_creds.get(key.lower())
        if val and isinstance(val, str) and val.strip():
            return val.strip(), loaded_json_source or "keys.json"
    return default, "none"

_api_key, _key_src = get_config_val_with_source([
    "BINANCE_API_KEY", "BINANCE_KEY", "BINANCE_FUTURES_KEY",
    "BINANCE_FUTURES_API_KEY", "API_KEY", "apiKey", "api_key", "key"
])

_api_secret, _sec_src = get_config_val_with_source([
    "BINANCE_API_SECRET", "BINANCE_SECRET", "BINANCE_SECRET_KEY",
    "BINANCE_FUTURES_SECRET", "API_SECRET", "apiSecret", "api_secret", "secret"
])

class Config:
    # Binance API Credentials
    BINANCE_API_KEY: str = _api_key
    BINANCE_API_SECRET: str = _api_secret
    AUTH_SOURCE: str = _key_src if _api_key else "none"
    # Testnet vs Production
    USE_TESTNET: bool = os.getenv("BINANCE_USE_TESTNET", "false").lower() in ("true", "1", "yes")
    
    @property
    def BASE_URL(self) -> str:
        if self.USE_TESTNET:
            return "https://testnet.binancefuture.com"
        return "https://fapi.binance.com"
    
    # Server Config
    HOST: str = os.getenv("BACKEND_HOST", "0.0.0.0")
    PORT: int = int(os.getenv("BACKEND_PORT", "8000"))

config = Config()
