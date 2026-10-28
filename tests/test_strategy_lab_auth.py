import asyncio
from types import SimpleNamespace
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from backend import server, terminal_auth


class ASGIClient:
    """Exercise HTTP routing without starting the application's exchange workers."""
    async def request(self, method, path, json=None, headers=None):
        payload = __import__('json').dumps(json).encode() if json is not None else b''
        scope = dict(type='http', asgi={'version':'3.0', 'spec_version':'2.4'}, http_version='1.1',
                     method=method, scheme='https', path=path, raw_path=path.encode(), query_string=b'',
                     root_path='', server=('test',443), client=('127.0.0.1',1234),
                     headers=[(k.lower().encode(),v.encode()) for k,v in (headers or {}).items()])
        sent = False
        messages = []
        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {'type':'http.request','body':payload,'more_body':False}
            await asyncio.Event().wait()
        async def send(message):
            messages.append(message)
        await asyncio.wait_for(server.app(scope, receive, send), timeout=5)
        code = next(m['status'] for m in messages if m['type']=='http.response.start')
        body = b''.join(m.get('body',b'') for m in messages if m['type']=='http.response.body')
        response_headers = next(m['headers'] for m in messages if m['type']=='http.response.start')
        return SimpleNamespace(status_code=code, headers={k.decode().lower(): v.decode() for k,v in response_headers},
                               json=lambda: __import__('json').loads(body))

    async def post(self, path, **kwargs):
        return await self.request('POST', path, **kwargs)

    async def get(self, path, **kwargs):
        return await self.request('GET', path, **kwargs)


class StrategyLabAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'auth.json'
        self.remember_path = Path(self.temp.name) / 'remember.json'
        salt = bytes.fromhex('0123456789abcdef0123456789abcdef')
        self.path.write_text(json.dumps(dict(salt=salt.hex(), hash=hashlib.scrypt(b'test-only-password', salt=salt, n=16384, r=8, p=1).hex())))
        self.env = patch.dict(os.environ, {'TERMINAL_AUTH_FILE': str(self.path),
                                        'TERMINAL_REMEMBER_FILE': str(self.remember_path)})
        self.env.start()
        terminal_auth._sessions.clear()
        terminal_auth._attempts.clear()
        # No context manager: do not start lifespan/exchange workers in tests.
        self.client = ASGIClient()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()
        terminal_auth._sessions.clear()
        terminal_auth._attempts.clear()

    async def test_every_registered_strategy_lab_mutation_rejects_unauthorized_calls(self):
        routes = [r for r in server.app.routes if getattr(r, 'path', '').startswith('/api/strategy-lab/') and 'POST' in r.methods]
        self.assertEqual(len(routes), 6)
        for route in routes:
            with self.subTest(route=route.path):
                response = (await self.client.post(route.path, json={}))
                self.assertEqual(response.status_code, 401)
                response = (await self.client.post(route.path, json={}, headers={'Authorization': 'Bearer invalid'}))
                self.assertEqual(response.status_code, 401)

    async def test_tab2_scaling_mutation_requires_unlock(self):
        payload = {'short_spread_multiplier': 1.25, 'long_spread_multiplier': 1.5}
        self.assertEqual(
            (await self.client.post('/api/trade/update_scaling', json=payload)).status_code,
            401,
        )
        unlocked = await self.client.post(
            '/api/terminal-auth/unlock', json={'password': 'test-only-password'})
        headers = {'Authorization': 'Bearer ' + unlocked.json()['token']}
        with patch.object(server, 'STATE_FILE', Path(self.temp.name) / 'scaling.json'):
            response = await self.client.post(
                '/api/trade/update_scaling', json=payload, headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json()['success'])
            saved = server.load_auto_tranche_state()
            self.assertEqual(saved['short_spread_multiplier'], 1.25)
            self.assertEqual(saved['long_spread_multiplier'], 1.5)

    async def test_unlock_authorizes_then_lock_revokes(self):
        self.assertFalse((await self.client.get('/api/terminal-auth/status')).json()['authorized'])
        self.assertEqual((await self.client.post('/api/terminal-auth/unlock', json={'password':'wrong'})).status_code, 401)
        response = (await self.client.post('/api/terminal-auth/unlock', json={'password':'test-only-password'}))
        self.assertEqual(response.status_code, 200)
        headers = {'Authorization': 'Bearer ' + response.json()['token']}
        self.assertTrue((await self.client.get('/api/terminal-auth/status', headers=headers)).json()['authorized'])
        with patch.object(server.strategy_execution_engine, 'set_mode', new_callable=AsyncMock) as mutate:
            mutate.return_value = {'mode':'paper'}
            body = dict(mode='paper', enable=True, strategy='ou_quant', options={'entry_ou_z':True})
            response = (await self.client.post('/api/strategy-lab/set-mode', json=body, headers=headers))
            self.assertTrue(response.json()['success'])
            mutate.assert_awaited_once_with('paper', enable=True, strategy='ou_quant', options={'entry_ou_z':True})
        (await self.client.post('/api/terminal-auth/lock', headers=headers))
        self.assertEqual((await self.client.post('/api/strategy-lab/toggle-bot', json={}, headers=headers)).status_code, 401)

    async def test_expiry_missing_config_and_rate_limit(self):
        response = (await self.client.post('/api/terminal-auth/unlock', json={'password':'test-only-password'}))
        headers = {'Authorization': 'Bearer ' + response.json()['token']}
        for token in terminal_auth._sessions:
            terminal_auth._sessions[token] = 0
        self.assertEqual((await self.client.post('/api/strategy-lab/clear-history', headers=headers)).status_code, 401)
        self.path.unlink()
        self.assertEqual((await self.client.post('/api/terminal-auth/unlock', json={'password':'test-only-password'})).status_code, 401)
        for _ in range(3):
            (await self.client.post('/api/terminal-auth/unlock', json={'password':'wrong'}))
        self.assertEqual((await self.client.post('/api/terminal-auth/unlock', json={'password':'wrong'})).status_code, 429)

    async def test_same_browser_can_resume_for_day_after_lock_and_restart(self):
        self.assertEqual((await self.client.post('/api/terminal-auth/resume')).status_code, 401)
        unlocked = await self.client.post('/api/terminal-auth/unlock', json={'password':'test-only-password'})
        self.assertEqual(unlocked.status_code, 200)
        self.assertEqual(unlocked.json()['remembered_for'], 86400)
        cookie = unlocked.headers['set-cookie']
        self.assertIn('HttpOnly', cookie)
        self.assertIn('Secure', cookie)
        self.assertIn('SameSite=strict', cookie)
        self.assertIn('Max-Age=86400', cookie)
        cookie_header = {'Cookie': cookie.split(';', 1)[0]}
        self.assertNotIn(cookie_header['Cookie'].split('=', 1)[1], self.remember_path.read_text())
        if os.name != 'nt':
            self.assertEqual(self.remember_path.stat().st_mode & 0o777, 0o600)
        old_headers = {'Authorization': 'Bearer ' + unlocked.json()['token']}
        await self.client.post('/api/terminal-auth/lock', headers=old_headers)
        self.assertFalse((await self.client.get('/api/terminal-auth/status', headers=old_headers)).json()['authorized'])
        terminal_auth._sessions.clear()  # Simulate a backend restart.
        self.assertEqual((await self.client.post('/api/terminal-auth/resume')).status_code, 401)
        resumed = await self.client.post('/api/terminal-auth/resume', headers=cookie_header)
        self.assertEqual(resumed.status_code, 200)
        new_headers = {'Authorization': 'Bearer ' + resumed.json()['token']}
        self.assertTrue((await self.client.get('/api/terminal-auth/status', headers=new_headers)).json()['authorized'])
        forgotten = await self.client.post('/api/terminal-auth/forget', headers={**cookie_header, **new_headers})
        self.assertEqual(forgotten.status_code, 200)
        self.assertEqual((await self.client.post('/api/terminal-auth/resume', headers=cookie_header)).status_code, 401)
        self.assertFalse((await self.client.get('/api/terminal-auth/status', headers=new_headers)).json()['authorized'])

    async def test_expired_remembered_browser_requires_password(self):
        unlocked = await self.client.post('/api/terminal-auth/unlock', json={'password':'test-only-password'})
        cookie_header = {'Cookie': unlocked.headers['set-cookie'].split(';', 1)[0]}
        remembered = json.loads(self.remember_path.read_text())
        remembered['sessions'] = {key: 1 for key in remembered['sessions']}
        self.remember_path.write_text(json.dumps(remembered))
        self.assertEqual((await self.client.post('/api/terminal-auth/resume', headers=cookie_header)).status_code, 401)

    async def test_password_rotation_invalidates_remembered_browser(self):
        unlocked = await self.client.post('/api/terminal-auth/unlock', json={'password':'test-only-password'})
        cookie_header = {'Cookie': unlocked.headers['set-cookie'].split(';', 1)[0]}
        config = json.loads(self.path.read_text())
        config['hash'] = '0' * 128
        self.path.write_text(json.dumps(config))
        self.assertEqual((await self.client.post('/api/terminal-auth/resume', headers=cookie_header)).status_code, 401)
