import pathlib
import sys
import unittest
from unittest.mock import AsyncMock, patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient
from backend.server import app, lighter_pair_bot

class TestLighterTab2Ux(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_lighter_endpoints_registered(self):
        routes = [route.path for route in app.routes]
        self.assertIn("/api/lighter/status", routes)
        self.assertIn("/api/lighter/step_tranche", routes)
        self.assertIn("/api/lighter/reduce_tranche", routes)
        self.assertIn("/api/lighter/flatten", routes)
        self.assertIn("/api/lighter/order", routes)

    def test_unauthorized_requests_rejected(self):
        res = self.client.post("/api/lighter/bot/config", json={})
        self.assertEqual(res.status_code, 401)
        res = self.client.post("/api/lighter/bot/toggle", json={"enabled": False})
        self.assertEqual(res.status_code, 401)
        res = self.client.post("/api/lighter/step_tranche", json={})
        self.assertEqual(res.status_code, 401)
        res = self.client.post("/api/lighter/reduce_tranche", json={})
        self.assertEqual(res.status_code, 401)
        res = self.client.post("/api/lighter/flatten", json={})
        self.assertEqual(res.status_code, 401)

    @patch("backend.server.terminal_authorized", return_value=True)
    def test_step_tranche_rejects_unsafe_parameters(self, mock_auth):
        with patch.object(lighter_pair_bot, "execute_manual_tranche", new_callable=AsyncMock) as mock_step:
            for payload in ({"side": 0, "notional_usd": 25}, {"side": -1, "notional_usd": 501}):
                res = self.client.post("/api/lighter/step_tranche", json=payload)
                self.assertEqual(res.status_code, 400)
            mock_step.assert_not_awaited()

    @patch("backend.server.terminal_authorized", return_value=True)
    def test_authorized_step_tranche(self, mock_auth):
        with patch.object(lighter_pair_bot, "execute_manual_tranche", new_callable=AsyncMock) as mock_step:
            mock_step.return_value = {"side": -1, "adr_qty": 0.13, "domestic_qty": 0.013}
            res = self.client.post("/api/lighter/step_tranche", json={"side": -1, "notional_usd": 25})
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertTrue(data.get("success"))
            self.assertIn("tranche", data)

    @patch("backend.server.terminal_authorized", return_value=True)
    def test_authorized_reduce_tranche(self, mock_auth):
        with patch.object(lighter_pair_bot, "execute_manual_reduce", new_callable=AsyncMock) as mock_red:
            mock_red.return_value = {"side": 1, "adr_qty": 0.13}
            res = self.client.post("/api/lighter/reduce_tranche", json={})
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertTrue(data.get("success"))

    @patch("backend.server.terminal_authorized", return_value=True)
    def test_authorized_flatten(self, mock_auth):
        with patch.object(lighter_pair_bot, "flatten_all", new_callable=AsyncMock) as mock_flat:
            mock_flat.return_value = {"closed": []}
            res = self.client.post("/api/lighter/flatten", json={})
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertTrue(data.get("success"))

if __name__ == "__main__":
    unittest.main()
