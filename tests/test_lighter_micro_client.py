import asyncio
import time
import unittest

from backend.lighter_client import LighterClient


class LighterMicroClientTests(unittest.TestCase):
    def setUp(self):
        self.client = self._connected_client()

    @staticmethod
    def _connected_client(**limits):
        client = LighterClient()
        for name, value in limits.items():
            setattr(client, name, value)
        client._micro_market_ids.add(1)
        client._begin_micro_connection()
        return client

    @staticmethod
    def _book(*, nonce=10, timestamp=1_800_000_000, bids=None, asks=None, **extra):
        order_book = {
            "code": 0,
            "nonce": nonce,
            "bids": bids if bids is not None else [
                {"price": "100", "size": "2"},
                {"price": "99", "size": "3"},
            ],
            "asks": asks if asks is not None else [
                {"price": "101", "size": "4"},
                {"price": "102", "size": "5"},
            ],
            **extra,
        }
        return {
            "type": "subscribed/order_book",
            "channel": "order_book:1",
            "timestamp": timestamp,
            "order_book": order_book,
        }

    @staticmethod
    def _trade(trade_id="22", **extra):
        return {
            "trade_id": int(trade_id) if str(trade_id).isdigit() else trade_id,
            "trade_id_str": str(trade_id),
            "type": "trade",
            "market_id": 1,
            "timestamp": int(time.time() * 1000),
            "price": "100.5",
            "size": "0.25",
            "is_maker_ask": True,
            **extra,
        }

    def _ack_book(self, payload=None):
        self.client._handle_micro_stream_message(payload or self._book())

    def _ack_tape(self, trades=None, *, nonce=20, liquidations=None):
        self.client._handle_micro_stream_message({
            "type": "subscribed/trade",
            "channel": "trade:1",
            "nonce": nonce,
            "trades": [] if trades is None else trades,
            "liquidation_trades": [] if liquidations is None else liquidations,
        })

    def _ready(self, *, lookback_ms=1, book=None, bootstrap=None):
        self._ack_book(book)
        self._ack_tape(bootstrap)
        self.client._micro_trade_lookback_ms[1] = lookback_ms
        self.client._micro_warmup_started[1] = (
            time.monotonic() - (lookback_ms + 5) / 1000
        )

    def _snapshot(self, *, depth=20, lookback_ms=1):
        return asyncio.run(
            self.client.micro_market_snapshot(1, depth=depth, trade_lookback_ms=lookback_ms)
        )

    def test_full_snapshot_delta_trade_and_connection_provenance(self):
        self._ready()
        self.client._handle_micro_stream_message({
            "type": "update/order_book",
            "channel": "order_book:1",
            "order_book": {
                "code": 0,
                "begin_nonce": 10,
                "nonce": 12,
                "bids": [
                    {"price": "100", "size": "0"},
                    {"price": "100.5", "size": "6"},
                ],
                "asks": [{"price": "100.8", "size": "7"}],
            },
        })
        self.client._handle_micro_stream_message({
            "type": "update/trade",
            "channel": "trade:1",
            "nonce": 21,
            "trades": [
                self._trade("22", timestamp=int(time.time()), price="100.8"),
                self._trade(
                    "23", price="100.5", size="0.10", is_maker_ask=False
                ),
            ],
            "liquidation_trades": [],
        })

        snapshot = self._snapshot(depth=2)

        self.assertTrue(snapshot["book_valid"])
        self.assertTrue(snapshot["nonce_contiguous"])
        self.assertEqual(snapshot["sequence"], 12)
        self.assertEqual(snapshot["trade_sequence"], 21)
        self.assertEqual(snapshot["exchange_timestamp_ms"], 1_800_000_000_000)
        self.assertEqual([row["price"] for row in snapshot["bids"]], ["100.5", "99"])
        self.assertEqual([row["price"] for row in snapshot["asks"]], ["100.8", "101"])
        self.assertEqual(
            [row["aggressor_side"] for row in snapshot["trades"]], ["buy", "sell"]
        )
        self.assertEqual(snapshot["connection_id"], 1)
        self.assertEqual(snapshot["book_connection_id"], 1)
        self.assertEqual(snapshot["tape_connection_id"], 1)
        self.assertTrue(all(row["connection_id"] == 1 for row in snapshot["trades"]))
        self.assertEqual(snapshot["source"], "LIGHTER_PUBLIC_WS_ORDER_BOOK_TRADE")
        self.assertGreaterEqual(snapshot["quote_age_ms"], 0)

    def test_nonce_gap_fails_closed_and_counts_gap(self):
        self._ack_book(self._book(nonce=100))

        with self.assertRaisesRegex(RuntimeError, "nonce gap"):
            self.client._handle_micro_stream_message({
                "type": "update/order_book",
                "channel": "order_book/1",
                "order_book": {
                    "code": 0,
                    "begin_nonce": 102,
                    "nonce": 103,
                    "bids": [],
                    "asks": [],
                },
            })

        status = self.client.micro_stream_status(1)
        self.assertFalse(status["markets"]["1"]["book_valid"])
        self.assertEqual(status["gap_count"], 1)
        self.assertEqual(status["malformed_message_count"], 1)

    def test_microsecond_exchange_timestamp_is_normalized(self):
        self._ready(book=self._book(timestamp=None, last_updated_at=1_800_000_000_123_000))
        snapshot = self._snapshot()
        self.assertEqual(snapshot["exchange_timestamp_ms"], 1_800_000_000_123)

    def test_bootstrap_seeds_bounded_dedupe_but_never_becomes_live_flow(self):
        historical = self._trade("44")
        self._ack_book()
        self._ack_tape(
            [historical],
            liquidations=[{"trade_id_str": "liquidation-history"}],
        )
        self.client._micro_trade_lookback_ms[1] = 1
        self.client._micro_warmup_started[1] = time.monotonic() - 0.01
        self.assertEqual(len(self.client._micro_trades[1]), 0)

        self.client._handle_micro_stream_message({
            "type": "update/trade",
            "channel": "trade/1",
            "nonce": 21,
            "trades": [historical, self._trade("45", is_maker_ask=False)],
            "liquidation_trades": [{"malformed": "deliberately ignored"}],
        })
        snapshot = self._snapshot()

        self.assertEqual([row["trade_id_str"] for row in snapshot["trades"]], ["45"])
        self.assertEqual(snapshot["trades"][0]["aggressor_side"], "sell")
        status = snapshot["stream"]["markets"]["1"]
        self.assertEqual(status["duplicate_trade_count"], 1)
        self.assertEqual(status["ignored_liquidation_count"], 2)

        bounded = self._connected_client(MICRO_TRADE_ID_LIMIT=2)
        bounded._handle_micro_stream_message(self._book())
        bounded._handle_micro_stream_message({
            "type": "subscribed/trade",
            "channel": "trade:1",
            "nonce": 3,
            "trades": [self._trade("1"), self._trade("2"), self._trade("3")],
            "liquidation_trades": [],
        })
        self.assertEqual(bounded._micro_trade_ids[1], {"2", "3"})

    def test_live_trade_is_ignored_until_both_subscriptions_are_acknowledged(self):
        self._ack_tape()
        update = {
            "type": "update/trade",
            "channel": "trade:1",
            "nonce": 21,
            "trades": [self._trade("50")],
            "liquidation_trades": [],
        }
        self.client._handle_micro_stream_message(update)
        self.assertEqual(len(self.client._micro_trades[1]), 0)
        self.assertEqual(
            self.client.micro_stream_status(1)["markets"]["1"][
                "ignored_pre_ack_trade_count"
            ],
            1,
        )

        self._ack_book()
        # Keep the assertion independent of scheduler speed on constrained hosts.
        # This test is about acknowledgement gating, not a 1 ms retention window.
        lookback_ms = 1_000
        self.client._micro_trade_lookback_ms[1] = lookback_ms
        self.client._micro_warmup_started[1] = time.monotonic() - 1.1
        self.client._handle_micro_stream_message(update)
        self.assertEqual(len(self._snapshot(lookback_ms=lookback_ms)["trades"]), 1)

    def test_configured_lookback_must_warm_before_snapshot_is_consumable(self):
        self._ack_book()
        self._ack_tape()
        self.client._handle_micro_stream_message({
            "type": "update/trade",
            "channel": "trade:1",
            "nonce": 21,
            "trades": [self._trade("60")],
            "liquidation_trades": [],
        })
        with self.assertRaisesRegex(RuntimeError, "warming up"):
            self._snapshot(lookback_ms=1_000)

        self.client._micro_warmup_started[1] = time.monotonic() - 1.1
        snapshot = self._snapshot(lookback_ms=1_000)
        self.assertEqual(len(snapshot["trades"]), 1)
        self.assertTrue(snapshot["stream"]["markets"]["1"]["tape_ready"])

    def test_snapshot_rejects_disconnected_stale_and_previous_epoch_state(self):
        self._ready()
        self.assertEqual(self._snapshot()["connection_id"], 1)

        self.client._end_micro_connection()
        with self.assertRaisesRegex(RuntimeError, "disconnected"):
            self._snapshot()

        self.client._begin_micro_connection()
        self.assertNotIn(1, self.client._micro_books)
        status = self.client.micro_stream_status(1)["markets"]["1"]
        self.assertFalse(status["book_acknowledged"])
        self.assertFalse(status["tape_acknowledged"])
        self.assertIsNone(status["book_connection_id"])

        self._ready()
        self.client._micro_book_times[1] = (
            time.monotonic() - (self.client.MICRO_BOOK_MAX_AGE_MS + 100) / 1000
        )
        with self.assertRaisesRegex(RuntimeError, "stale"):
            self._snapshot()

    def test_snapshot_and_delta_schema_validation_is_fail_closed(self):
        malformed_snapshots = [
            ("code", self._book(), "code"),
            ("nonce", self._book(), "nonce"),
            (
                "crossed",
                self._book(
                    bids=[{"price": "102", "size": "1"}],
                    asks=[{"price": "101", "size": "1"}],
                ),
                "crossed",
            ),
            (
                "nonfinite",
                self._book(bids=[{"price": "NaN", "size": "1"}]),
                "finite",
            ),
            ("empty", self._book(asks=[]), "at least one"),
        ]
        for key, payload, expected in malformed_snapshots:
            with self.subTest(key=key):
                client = self._connected_client()
                if key in {"code", "nonce"}:
                    payload = {**payload, "order_book": dict(payload["order_book"])}
                    payload["order_book"].pop(key)
                with self.assertRaisesRegex(RuntimeError, expected):
                    client._handle_micro_stream_message(payload)
                self.assertFalse(client._micro_book_valid[1])
                self.assertEqual(client.micro_stream_status(1)["malformed_message_count"], 1)

        self._ack_book()
        with self.assertRaisesRegex(RuntimeError, "nonce gap"):
            self.client._handle_micro_stream_message({
                "type": "update/order_book",
                "channel": "order_book:1",
                "order_book": {
                    "code": 0,
                    "nonce": 11,
                    "bids": [],
                    "asks": [],
                },
            })

    def test_live_trades_require_official_schema_and_strict_aggressor_boolean(self):
        invalid_rows = [
            ("boolean", self._trade("70", is_maker_ask="true"), "boolean"),
            ("timestamp", self._trade("71", timestamp=None), "timestamp"),
            ("market", self._trade("72", market_id=2), "market_id"),
            ("market_type", self._trade("72b", market_id="1"), "market_id"),
            ("id", self._trade("73", trade_id_str=None), "trade_id_str"),
            ("finite", self._trade("74", price="Infinity"), "finite"),
        ]
        for label, row, expected in invalid_rows:
            with self.subTest(label=label):
                client = self._connected_client()
                client._handle_micro_stream_message(self._book())
                client._handle_micro_stream_message({
                    "type": "subscribed/trade",
                    "channel": "trade:1",
                    "nonce": 20,
                    "trades": [],
                    "liquidation_trades": [],
                })
                with self.assertRaisesRegex(RuntimeError, expected):
                    client._handle_micro_stream_message({
                        "type": "update/trade",
                        "channel": "trade:1",
                        "nonce": 21,
                        "trades": [row],
                        "liquidation_trades": [],
                    })
                self.assertFalse(client._micro_tape_valid[1])
                self.assertEqual(
                    client.micro_stream_status(1)["markets"]["1"][
                        "malformed_message_count"
                    ],
                    1,
                )

    def test_error_envelopes_and_subscription_timeouts_force_failure(self):
        with self.assertRaisesRegex(RuntimeError, "error envelope"):
            self.client._handle_micro_stream_message({
                "type": "error",
                "error": {"code": 400, "message": "bad subscription"},
            })
        self.assertIn("bad subscription", self.client.micro_stream_status()["last_error"])

        deadline = 100.0
        self.assertIn(
            "connected-envelope timeout",
            self.client._micro_subscription_timeout_reason(False, deadline, now=101.0),
        )
        timeout = self.client._micro_subscription_timeout_reason(
            True, deadline, now=101.0
        )
        self.assertIn("order_book/1", timeout)
        self.assertIn("trade/1", timeout)

    def test_status_exposes_ages_counters_warmup_and_buffer_overflow(self):
        client = self._connected_client(MICRO_TRADE_BUFFER_LIMIT=2)
        client._handle_micro_stream_message(self._book())
        client._handle_micro_stream_message({
            "type": "subscribed/trade",
            "channel": "trade:1",
            "nonce": 20,
            "trades": [],
            "liquidation_trades": [],
        })
        client._micro_trade_lookback_ms[1] = 1_000
        client._micro_warmup_started[1] = time.monotonic() - 1.1
        client._handle_micro_stream_message({
            "type": "update/trade",
            "channel": "trade:1",
            "nonce": 21,
            "trades": [self._trade("80"), self._trade("81"), self._trade("82")],
            "liquidation_trades": [],
        })
        status = client.micro_stream_status(1)
        market = status["markets"]["1"]
        self.assertTrue(status["subscriptions_ready"])
        self.assertTrue(market["book_acknowledged"])
        self.assertTrue(market["tape_acknowledged"])
        self.assertTrue(market["tape_ready"])
        self.assertIsNotNone(market["quote_age_ms"])
        self.assertIsNotNone(market["tape_age_ms"])
        self.assertIsNotNone(market["last_trade_age_ms"])
        self.assertEqual(market["trade_overflow_count"], 1)
        self.assertEqual(market["trade_count_buffered"], 2)
        with self.assertRaisesRegex(RuntimeError, "overflowed"):
            asyncio.run(client.micro_market_snapshot(1, trade_lookback_ms=1_000))


if __name__ == "__main__":
    unittest.main()
