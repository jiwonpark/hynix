import os
import json
from pathlib import Path
from dotenv import load_dotenv

# 1. Try loading from .env files
env_locations = [
    Path(__file__).parent / ".env",
    Path(__file__).parent.parent / ".env",
    Path("/home/ubuntu/.env"),
    Path("/home/ubuntu/arbiter/.env"),
    Path("/home/ubuntu/midas/.env"),
    Path.home() / ".env",
    Path.home() / "arbiter/.env",
    Path.home() / "midas/.env"
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
    Path("/home/ubuntu/midas/keys.json"),
    Path("/home/ubuntu/arbiter/config/keys.json"),
    Path("/home/ubuntu/midas/config/keys.json"),
    Path.home() / "keys.json",
    Path.home() / "arbiter/keys.json",
    Path.home() / "midas/keys.json"
]

json_creds = {}
loaded_binance_source = ""
loaded_upbit_source = ""

def _extract_pair_from_dict(d: dict, key_names: list[str], sec_names: list[str]) -> tuple[str, str]:
    k_val, s_val = "", ""
    for kn in key_names:
        v = d.get(kn)
        if v and isinstance(v, str):
            k_val = v.strip()
            break
    for sn in sec_names:
        v = d.get(sn)
        if v and isinstance(v, str):
            s_val = v.strip()
            break
    return k_val, s_val

for loc in keys_json_locations:
    if loc.is_file():
        try:
            with open(loc, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    # Check nested objects like "exchanges" or "accounts"
                    sub_dicts = [data]
                    for sub_k in ["exchanges", "accounts", "keys"]:
                        if isinstance(data.get(sub_k), dict):
                            sub_dicts.append(data[sub_k])

                    for sd in sub_dicts:
                        # 1. Binance format check
                        for b_key in ["binance", "binance_futures", "binance_usdt"]:
                            val = sd.get(b_key)
                            if isinstance(val, list) and len(val) >= 2:
                                if "BINANCE_API_KEY" not in json_creds:
                                    json_creds["BINANCE_API_KEY"] = str(val[0]).strip()
                                    json_creds["BINANCE_API_SECRET"] = str(val[1]).strip()
                                    loaded_binance_source = str(loc)
                            elif isinstance(val, dict):
                                k, s = _extract_pair_from_dict(
                                    val,
                                    ["api_key", "apiKey", "key", "BINANCE_API_KEY"],
                                    ["api_secret", "apiSecret", "secret", "BINANCE_API_SECRET"]
                                )
                                if k and s and "BINANCE_API_KEY" not in json_creds:
                                    json_creds["BINANCE_API_KEY"] = k
                                    json_creds["BINANCE_API_SECRET"] = s
                                    loaded_binance_source = str(loc)

                        # 2. Upbit format check
                        for u_key in ["upbit", "upbit_spot", "upbit_krw", "upbit_api"]:
                            val = sd.get(u_key)
                            if isinstance(val, list) and len(val) >= 2:
                                if "UPBIT_ACCESS_KEY" not in json_creds:
                                    json_creds["UPBIT_ACCESS_KEY"] = str(val[0]).strip()
                                    json_creds["UPBIT_SECRET_KEY"] = str(val[1]).strip()
                                    loaded_upbit_source = str(loc)
                            elif isinstance(val, dict):
                                k, s = _extract_pair_from_dict(
                                    val,
                                    ["access_key", "open_api_access_key", "accessKey", "api_key", "key", "UPBIT_ACCESS_KEY"],
                                    ["secret_key", "open_api_secret_key", "secretKey", "api_secret", "secret", "UPBIT_SECRET_KEY"]
                                )
                                if k and s and "UPBIT_ACCESS_KEY" not in json_creds:
                                    json_creds["UPBIT_ACCESS_KEY"] = k
                                    json_creds["UPBIT_SECRET_KEY"] = s
                                    loaded_upbit_source = str(loc)

                    # 3. Check top-level keys
                    for k, v in data.items():
                        if isinstance(v, str):
                            json_creds[k] = v.strip()
                            if "binance" in k.lower() and not loaded_binance_source:
                                loaded_binance_source = str(loc)
                            if "upbit" in k.lower() and not loaded_upbit_source:
                                loaded_upbit_source = str(loc)
        except Exception:
            pass

def get_config_val_with_source(aliases: list[str], default_source: str = "", default: str = "") -> tuple[str, str]:
    """Retrieve credential and its origin (env vs json)."""
    # Check env vars
    for key in aliases:
        val = os.getenv(key)
        if val and val.strip():
            return val.strip(), "env"
    # Check json creds
    for key in aliases:
        val = json_creds.get(key) or json_creds.get(key.lower()) or json_creds.get(key.upper())
        if val and isinstance(val, str) and val.strip():
            return val.strip(), default_source or "keys.json"
    return default, "none"

_binance_key, _binance_key_src = get_config_val_with_source([
    "BINANCE_API_KEY", "BINANCE_KEY", "BINANCE_FUTURES_KEY",
    "BINANCE_FUTURES_API_KEY", "API_KEY", "apiKey", "api_key", "key"
], default_source=loaded_binance_source)

_binance_secret, _binance_sec_src = get_config_val_with_source([
    "BINANCE_API_SECRET", "BINANCE_SECRET", "BINANCE_SECRET_KEY",
    "BINANCE_FUTURES_SECRET", "API_SECRET", "apiSecret", "api_secret", "secret"
], default_source=loaded_binance_source)

_upbit_key, _upbit_key_src = get_config_val_with_source([
    "UPBIT_ACCESS_KEY", "UPBIT_OPEN_API_ACCESS_KEY", "UPBIT_KEY",
    "UPBIT_API_KEY", "upbit_access_key", "upbit_key", "access_key"
], default_source=loaded_upbit_source)

_upbit_secret, _upbit_sec_src = get_config_val_with_source([
    "UPBIT_SECRET_KEY", "UPBIT_OPEN_API_SECRET_KEY", "UPBIT_SECRET",
    "UPBIT_API_SECRET", "upbit_secret_key", "upbit_secret", "secret_key"
], default_source=loaded_upbit_source)

class Config:
    # Binance API Credentials
    BINANCE_API_KEY: str = _binance_key
    BINANCE_API_SECRET: str = _binance_secret
    AUTH_SOURCE: str = _binance_key_src if _binance_key else "none"

    # Upbit Open API Credentials
    UPBIT_ACCESS_KEY: str = _upbit_key
    UPBIT_SECRET_KEY: str = _upbit_secret
    UPBIT_AUTH_SOURCE: str = _upbit_key_src if _upbit_key else "none"
    UPBIT_BASE_URL: str = "https://api.upbit.com"

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
