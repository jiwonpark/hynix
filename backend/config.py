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
for loc in keys_json_locations:
    if loc.is_file():
        try:
            with open(loc, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    # Direct top-level or nested under 'binance' / 'binance_futures'
                    json_creds.update(data)
                    if isinstance(data.get("binance"), dict):
                        json_creds.update(data["binance"])
                    if isinstance(data.get("binance_futures"), dict):
                        json_creds.update(data["binance_futures"])
        except Exception:
            pass

def get_config_val(aliases: list[str], default: str = "") -> str:
    """Retrieve credential from env vars first, then from json creds."""
    # Check env vars
    for key in aliases:
        val = os.getenv(key)
        if val and val.strip():
            return val.strip()
    # Check json creds
    for key in aliases:
        val = json_creds.get(key) or json_creds.get(key.lower())
        if val and isinstance(val, str) and val.strip():
            return val.strip()
    return default

class Config:
    # Binance API Credentials
    BINANCE_API_KEY: str = get_config_val([
        "BINANCE_API_KEY", "BINANCE_KEY", "BINANCE_FUTURES_KEY",
        "BINANCE_FUTURES_API_KEY", "API_KEY", "apiKey", "api_key", "key"
    ])
    
    BINANCE_API_SECRET: str = get_config_val([
        "BINANCE_API_SECRET", "BINANCE_SECRET", "BINANCE_SECRET_KEY",
        "BINANCE_FUTURES_SECRET", "API_SECRET", "apiSecret", "api_secret", "secret"
    ])
    
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
