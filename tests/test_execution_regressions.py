import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from backend import server


class ExecutionRegressions(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_patch = patch.object(server, 'STATE_FILE', Path(self.tmp.name) / 'state.json')
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)
        self.client = AsyncMock()
        self.client.get_detailed_account_overview.return_value = {
            'authenticated': True, 'positions': [],
            'summary': {'available_margin_usd': 30, 'total_equity_usd': 35},
        }
        self.client_patch = patch.object(server, 'binance_client', self.client)
        self.client_patch.start()
        self.addCleanup(self.client_patch.stop)
        self.bars_patch = patch.object(server, 'get_cached_parity_bars', AsyncMock(return_value=[]))
        self.bars_patch.start()
        self.addCleanup(self.bars_patch.stop)

    async def test_failed_second_leg_records_fill_and_blocks_retry(self):
        self.client.create_order.side_effect = [
            {'status': 'FILLED', 'executedQty': '0.08', 'orderId': 42}, RuntimeError('ETF rejected')]
        first = await server.step_tranche()
        self.assertFalse(first['success'])
        self.assertEqual(first['execution_recovery']['order_adr']['orderId'], 42)
        self.assertFalse(server.load_auto_tranche_state()['enabled'])
        second = await server.step_tranche()
        self.assertTrue(second['recovery_required'])
        self.assertEqual(self.client.create_order.await_count, 2)
        self.assertFalse((await server.toggle_auto_tranche(True))['success'])

    async def test_unknown_first_leg_does_not_submit_etf_or_retry(self):
        self.client.create_order.side_effect = TimeoutError('unknown outcome')
        self.assertTrue((await server.step_tranche())['recovery_required'])
        await server.step_tranche()
        self.assertEqual(self.client.create_order.await_count, 1)

    async def test_success_clears_pending_recovery(self):
        self.client.create_order.side_effect = [
            {'status': 'FILLED', 'executedQty': '0.08'},
            {'status': 'FILLED', 'executedQty': '1.40'}]
        self.assertTrue((await server.step_tranche())['success'])
        self.assertNotIn('execution_recovery', server.load_auto_tranche_state())

    async def test_flat_account_still_returns_both_histories(self):
        async def request(method, path, params, **kwargs):
            if 'ticker' in path:
                return {'price': '1400'}
            return [{'id': 1, 'orderId': 2, 'side': 'BUY', 'qty': '.07', 'price': '195', 'time': 1000}]
        self.client.request.side_effect = request
        result = await server.get_hedged_status()
        self.assertEqual({t['symbol'] for t in result['recent_executions']}, {'SKHYUSDT', 'CSOPSKHYNIX2LUSDT'})

    async def test_split_entry_and_exit_fills_preserve_one_remaining_tranche(self):
        self.client.get_detailed_account_overview.return_value['positions'] = [
            {'symbol': 'SKHYUSDT', 'position_amt': -.09, 'mark_price': 195, 'entry_price': 196},
            {'symbol': 'CSOPSKHYNIX2LUSDT', 'position_amt': 1.6, 'mark_price': 5.7, 'entry_price': 5.6}]
        trades = []
        for i, (order, side, qty) in enumerate([(1, 'SELL', .03), (1, 'SELL', .05), (2, 'SELL', .08), (3, 'BUY', .03), (3, 'BUY', .04)]):
            trades.append({'id': i, 'orderId': order, 'side': side, 'qty': qty, 'price': 195, 'time': int(time.time() * 1000) - 300000 + i})
        async def request(method, path, params, **kwargs):
            if 'ticker' in path:
                return {'price': '1400'}
            return trades if params['symbol'] == 'SKHYUSDT' else []
        self.client.request.side_effect = request
        result = await server.get_hedged_status()
        criteria = result['auto_tranche_criteria']
        self.assertEqual(criteria['speculative_tranches_active'], 1)
        self.assertAlmostEqual(criteria['current_target_tranche']['trim_qty'], .07)
        self.assertEqual(criteria['current_target_tranche']['trade_id'], '1')

    async def test_historical_page_bounds_both_legs_and_markers(self):
        times = [300000 * i for i in range(1, 21)]
        async def request(method, path, params, **kwargs):
            if 'klines' in path:
                self.assertEqual(params['endTime'], times[-1])
                return [[t, 0, 0, 0, '100'] for t in times]
            self.assertIn('endTime', params)
            return [{'time': times[0] - 1, 'side': 'SELL'}, {'time': times[-1] + 300000, 'side': 'BUY'}]
        self.client.request.side_effect = request
        result = await server.get_short_term_parity('5m', 20, times[-1])
        self.assertEqual(len(result['bars']), 20)
        self.assertEqual(result['next_end_time'], times[0] - 1)
        self.assertTrue(result['has_more'])
        self.assertEqual(result['markers'], [])

    async def test_empty_history_stops_pagination_without_latest_fallback(self):
        self.client.request.return_value = []
        result = await server.get_short_term_parity('5m', 20, 1)
        self.assertFalse(result['has_more'])
        self.assertIsNone(result['next_end_time'])
        self.assertEqual(self.client.request.await_count, 3)
