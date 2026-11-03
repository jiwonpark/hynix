import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class LighterCryptoTelemetrySourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        source = (ROOT / "backend" / "server.py").read_text(encoding="utf-8")
        start = source.index('async def get_lighter_crypto_status')
        end = source.index('_lighter_crypto_chart_cache', start)
        cls.status_source = source[start:end]
        bot_start = source.index('async def get_lighter_crypto_bot_status')
        bot_end = source.index('@app.post("/api/lighter-crypto/bot/config")', bot_start)
        cls.bot_status_source = source[bot_start:bot_end]

    def test_account_telemetry_has_a_server_side_deadline(self) -> None:
        self.assertIn("asyncio.wait_for(awaitable, timeout=timeout)", self.status_source)
        self.assertIn("timeout: float = 6.0", self.status_source)

    def test_positions_reuse_the_account_snapshot(self) -> None:
        self.assertIn("lighter_client.positions()", self.status_source)
        self.assertNotIn("positions(fresh=True)", self.status_source)

    def test_bot_settings_survive_trade_history_timeout(self) -> None:
        self.assertIn("asyncio.wait_for(lighter_crypto_bot.reconciled_public_state(), timeout=5.0)", self.bot_status_source)
        self.assertIn("lighter_crypto_bot.public_state()", self.bot_status_source)
        self.assertIn('bot["history_stale"] = True', self.bot_status_source)


if __name__ == "__main__":
    unittest.main()
