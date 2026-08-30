import os
from pathlib import Path
from dotenv import load_dotenv

# Try loading from multiple standard locations
env_locations = [
    Path(__file__).parent / ".env",
    Path(__file__).parent.parent / ".env",
    Path("/home/ubuntu/.env"),
    Path.home() / ".env"
]

for loc in env_locations:
    if loc.is_file():
        load_dotenv(loc, override=False)

def get_env_var(keys: list[str], default: str = "") -> str:
    """Retrieve the first matching environment variable from a list of alias keys."""
    for key in keys:
        val = os.getenv(key)
        if val and val.strip():
            return val.strip()
    return default

class Config:
    # Binance API Credentials
    BINANCE_API_KEY: str = get_env_var([
        "BINANCE_API_KEY", "BINANCE_KEY", "BINANCE_FUTURES_KEY",
        "BINANCE_FUTURES_API_KEY", "API_KEY"
    ])
    
    BINANCE_API_SECRET: str = get_env_var([
        "BINANCE_API_SECRET", "BINANCE_SECRET", "BINANCE_SECRET_KEY",
        "BINANCE_FUTURES_SECRET", "API_SECRET"
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
