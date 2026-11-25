import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import aiohttp

from backend.lighter_client import LighterClient


class _Message:
    def __init__(self, message_type, payload=None):
        self.type = message_type
        self.data = json.dumps(payload or {})


class _WebSocket:
    def __init__(self, messages):
        self._messages = iter(messages)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._messages)
        except StopIteration as error:
            raise StopAsyncIteration from error

    async def send_json(self, _payload):
        return None


class _WebSocketContext:
    def __init__(self, websocket):
        self.websocket = websocket

    async def __aenter__(self):
        return self.websocket

    async def __aexit__(self, *_args):
        return False


class _Session:
    def __init__(self, websocket):
        self.websocket = websocket

    def ws_connect(self, *_args, **_kwargs):
        return _WebSocketContext(self.websocket)


class LighterLegacyStreamTests(unittest.TestCase):
    @staticmethod
    def _snapshot(depth=2_000):
        return {
            "type": "subscribed/order_book",
            "channel": "order_book:216",
            "order_book": {
                "nonce": 10,
                "bids": [
                    {"price": str(100_000 - index), "size": "1"}
                    for index in range(depth)
                ],
                "asks": [
                    {"price": str(100_001 + index), "size": "1"}
                    for index in range(depth)
                ],
            },
        }

    def test_deep_delta_mutates_indexed_book_in_place_and_keeps_api_shape(self):
        async def run():
            client = LighterClient()
            client.request = AsyncMock()
            client._handle_stream_message(self._snapshot())
            book = client._ws_books[216]
            prices = client._ws_book_prices[216]
            bid_levels_id = id(book["bids"])
            ask_levels_id = id(book["asks"])
            bid_prices_id = id(prices["bids"])
            ask_prices_id = id(prices["asks"])

            client._handle_stream_message({
                "type": "update/order_book",
                "channel": "order_book:216",
                "order_book": {
                    "nonce": 11,
                    "bids": [
                        {"price": "100000", "size": "0"},
                        {"price": "100000.5", "size": "2"},
                    ],
                    "asks": [{"price": "100001", "size": "3"}],
                },
            })

            self.assertEqual(id(book["bids"]), bid_levels_id)
            self.assertEqual(id(book["asks"]), ask_levels_id)
            self.assertEqual(id(prices["bids"]), bid_prices_id)
            self.assertEqual(id(prices["asks"]), ask_prices_id)
            top = await client.order_book(216, 2)
            self.assertEqual(top["nonce"], 10)
            self.assertEqual(
                [row["price"] for row in top["bids"]],
                ["100000.5", "99999"],
            )
            self.assertEqual(
                [row["price"] for row in top["asks"]],
                ["100001", "100002"],
            )
            self.assertEqual(top["asks"][0]["size"], "3")
            top["asks"][0]["size"] = "999"
            self.assertEqual((await client.order_book(216, 1))["asks"][0]["size"], "3")
            client.request.assert_not_awaited()

        asyncio.run(run())

    def test_malformed_delta_does_not_partially_change_last_good_book(self):
        async def run():
            client = LighterClient()
            client._handle_stream_message(self._snapshot(depth=3))
            before = await client.order_book(216, 3)
            updated_at = client._ws_book_times[216]

            with self.assertRaisesRegex(ValueError, "price is not numeric"):
                client._handle_stream_message({
                    "type": "update/order_book",
                    "channel": "order_book:216",
                    "order_book": {
                        "asks": [{"price": "100001", "size": "7"}],
                        "bids": [{"price": "invalid", "size": "2"}],
                    },
                })

            self.assertEqual(await client.order_book(216, 3), before)
            self.assertEqual(client._ws_book_times[216], updated_at)

        asyncio.run(run())

    def test_stream_loop_yields_during_continuously_ready_message_burst(self):
        async def run():
            client = LighterClient()
            client.STREAM_FAIRNESS_MESSAGES = 4
            client.STREAM_FAIRNESS_SECONDS = 60.0
            messages = [
                _Message(
                    aiohttp.WSMsgType.TEXT,
                    {
                        "type": "update/account_all",
                        "channel": "account_all:1",
                        "positions": {},
                    },
                )
                for _ in range(4)
            ]
            messages.append(_Message(aiohttp.WSMsgType.CLOSED))
            client.get_session = AsyncMock(
                return_value=_Session(_WebSocket(messages))
            )
            delays = []

            async def controlled_sleep(delay):
                delays.append(delay)
                if delay:
                    raise asyncio.CancelledError

            with patch("backend.lighter_client.asyncio.sleep", controlled_sleep):
                with self.assertRaises(asyncio.CancelledError):
                    await client._stream_loop()

            self.assertEqual(delays, [0, 1.0])
            self.assertEqual(client._ws_account["positions"], {})

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
