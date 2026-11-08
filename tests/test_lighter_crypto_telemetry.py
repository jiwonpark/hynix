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
        cls.ui_source = (ROOT / "lighter-crypto-tab.js").read_text(encoding="utf-8")

    def test_account_telemetry_never_waits_for_exchange_rest(self) -> None:
        self.assertIn("lighter_client.account_telemetry_snapshot()", self.status_source)
        self.assertNotIn("await lighter_client.account_status()", self.status_source)
        self.assertIn("asyncio.create_task(_refresh_lighter_account_cache())", self.status_source)

    def test_positions_reuse_the_account_snapshot(self) -> None:
        self.assertIn('positions = account.get("positions") or []', self.status_source)
        self.assertNotIn("lighter_client.positions(", self.status_source)

    def test_account_snapshot_exposes_source_age_and_staleness(self) -> None:
        self.assertIn('"account_source": snapshot.get("source")', self.status_source)
        self.assertIn('"account_updated_ms": updated_at_ms or None', self.status_source)
        self.assertIn('"positions_updated_ms": snapshot.get("positions_updated_ms")', self.status_source)
        self.assertIn('"collateral_updated_ms": snapshot.get("collateral_updated_ms")', self.status_source)
        self.assertIn('"account_stale": account_stale', self.status_source)

    def test_account_status_piggybacks_authoritative_bot_settings(self) -> None:
        self.assertGreaterEqual(
            self.status_source.count('"bot": lighter_crypto_bot.public_state()'),
            3,
        )
        self.assertIn("if (status?.bot) this.updateBotStatus(status.bot, status)", self.ui_source)

    def test_saved_bot_settings_retry_is_bounded_and_deduplicated(self) -> None:
        self.assertIn("if (this.botStatusPromise) return this.botStatusPromise", self.ui_source)
        self.assertIn('api("/api/lighter-crypto/bot/status", { timeoutMs: 35000 })', self.ui_source)
        self.assertIn("this.scheduleBotStatusRetry()", self.ui_source)

    def test_bot_settings_survive_trade_history_timeout(self) -> None:
        self.assertIn("lighter_crypto_bot.public_state()", self.bot_status_source)
        self.assertNotIn("_refresh_lighter_crypto_history_snapshot", self.bot_status_source)
        self.assertNotIn("await lighter_crypto_bot.reconciled_public_state()", self.bot_status_source)
        self.assertIn('bot["history_stale"] = history_stale', self.bot_status_source)

    def test_binance_and_lighter_status_share_nonblocking_history_contract(self) -> None:
        source = (ROOT / "backend" / "server.py").read_text(encoding="utf-8")
        start = source.index('async def get_crypto_bot_status')
        end = source.index('@app.post("/api/crypto/bot/reconcile")', start)
        crypto_status = source[start:end]
        self.assertIn("crypto_bot.public_state()", crypto_status)
        self.assertNotIn("_refresh_crypto_history_snapshot", crypto_status)
        self.assertNotIn("await crypto_bot.reconciled_public_state()", crypto_status)

    def test_history_refresh_is_started_independently_of_status_requests(self):
        source = (ROOT / "backend" / "server.py").read_text()
        self.assertIn('realized_history_worker(_refresh_crypto_history_snapshot)', source)
        self.assertIn('realized_history_worker(_refresh_lighter_crypto_history_snapshot)', source)
        self.assertIn('await read_history_snapshot(lighter_crypto_bot)', source)
        self.assertIn('apply_history_snapshot(bot, _lighter_crypto_history_cache)', source)

    def test_tab_activation_does_not_start_replay_before_account_is_ready(self) -> None:
        start = self.ui_source.index("async onTabActivated()")
        end = self.ui_source.index("resetChartView()", start)
        activation = self.ui_source[start:end]
        self.assertIn("if (this.accountDataReady)", activation)
        self.assertIn("this.runBacktestIfChanged()", activation)
        self.assertNotIn("this.runBacktest().catch", activation)

    def test_successful_account_retry_starts_deferred_replay(self) -> None:
        start = self.ui_source.index("async refresh()")
        end = self.ui_source.index("renderTrends(trends)", start)
        refresh = self.ui_source[start:end]
        self.assertIn(
            "if (freshAccountReady && !this.replayLoading && !this.latestReplayConditionResult)",
            refresh,
        )
        self.assertIn("this.runBacktestIfChanged()", refresh)

    def test_account_snapshot_has_a_contention_tolerant_bounded_deadline(self) -> None:
        self.assertIn("{ timeoutMs: 35000 }", self.ui_source)
        self.assertIn("Request timed out after ${Math.round(timeoutMs / 1000)} seconds", self.ui_source)

    def test_failed_refresh_preserves_last_authenticated_snapshot(self) -> None:
        self.assertIn("const previousStatus = this.liveVenue?.authenticated === true", self.ui_source)
        self.assertIn("{ ...previousStatus, success: true, account_stale: true", self.ui_source)
        self.assertIn("refresh failed: ${refreshError} · retrying", self.ui_source)


if __name__ == "__main__":
    unittest.main()
