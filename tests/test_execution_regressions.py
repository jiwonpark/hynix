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

    def ma_bars(self, values):
        end = int(time.time() // 300) * 300
        return [{'time': end - (len(values) - 1 - i) * 300, 'value': v} for i, v in enumerate(values)]

    async def test_exit_alignment_strict_order_and_data_requirements(self):
        downward = self.ma_bars([141 - i * .01 for i in range(60)])
        self.assertTrue(server.exit_ma_alignment(downward)['downward'])
        for values in ([140 + i * .01 for i in range(60)], [140] * 60,
                       [140] * 36 + [142] * 17 + [139] * 7):
            self.assertFalse(server.exit_ma_alignment(self.ma_bars(values))['downward'])
        self.assertFalse(server.exit_ma_alignment(downward[-59:])['ready'])
        self.assertFalse(server.exit_ma_alignment([])['downward'])
        self.assertFalse(server.exit_ma_alignment(self.ma_bars([float('nan')] * 60))['ready'])
        for bar in downward:
            bar['time'] -= 900
        self.assertFalse(server.exit_ma_alignment(downward)['ready'])

    async def test_auto_exit_requires_downward_stack_alongside_existing_guards(self):
        overview = self.client.get_detailed_account_overview.return_value
        overview['positions'] = [
            {'symbol': 'SKHYUSDT', 'position_amt': -.08, 'mark_price': 193.2, 'entry_price': 196, 'unrealized_pnl': 1, 'notional': 15},
            {'symbol': 'CSOPSKHYNIX2LUSDT', 'position_amt': 1.4, 'mark_price': 5.7, 'entry_price': 5.6, 'notional': 8}]
        bars = self.ma_bars([141 - i * .01 for i in range(60)])
        server.get_cached_parity_bars.return_value = bars
        async def request(method, path, params, **kwargs):
            if 'ticker' in path:
                return {'price': '1400'}
            if params['symbol'] == 'SKHYUSDT':
                return [{'id': 1, 'orderId': 1, 'side': 'SELL', 'qty': .08, 'price': 196, 'commission': .001,
                         'time': bars[0]['time'] * 1000}]
            return [{'id': 1, 'orderId': 1, 'side': 'BUY', 'qty': 1.4, 'price': 5.6, 'commission': .001,
                     'time': bars[0]['time'] * 1000 + 1000}]
        self.client.request.side_effect = request
        criteria = (await server.get_hedged_status())['auto_tranche_criteria']
        self.assertTrue(criteria['can_take_profit'])
        server.get_cached_parity_bars.assert_awaited_with('5m', 60)
        server.get_cached_parity_bars.return_value = self.ma_bars([141] * 60)
        criteria = (await server.get_hedged_status())['auto_tranche_criteria']
        self.assertFalse(criteria['can_take_profit'])
        self.assertEqual(criteria['status_take_profit'], 'AWAITING_DOWNWARD_MA_STACK')
        server.get_cached_parity_bars.return_value = bars
        overview['positions'][0]['unrealized_pnl'] = -1
        self.assertTrue((await server.get_hedged_status())['auto_tranche_criteria']['can_take_profit'])
        # Account profit cannot subsidize a losing target tranche.
        overview['positions'][0]['unrealized_pnl'] = 100
        overview['positions'][0]['mark_price'] = 205
        result = await server.get_hedged_status()
        self.assertFalse(result['eligible_for_take_profit'])
        self.assertFalse(result['auto_tranche_criteria']['can_take_profit'])

    async def test_manual_exit_uses_shared_criteria_and_emergency_bypasses(self):
        positions = [
            {'symbol': 'SKHYUSDT', 'position_amt': -.08, 'unrealized_pnl': 1},
            {'symbol': 'CSOPSKHYNIX2LUSDT', 'position_amt': 1.4}]
        self.client.get_detailed_account_overview.return_value['positions'] = positions
        self.client.create_order.return_value = {'status': 'FILLED'}
        status = {'adr_position': positions[0], 'stock_position': positions[1],
                  'auto_tranche_criteria': {'can_take_profit': False, 'status_take_profit': 'LOCKED_AWAITING_PROFIT'}}
        with patch.object(server, 'get_hedged_status', AsyncMock(return_value=status)):
            self.assertFalse((await server.reduce_tranche())['success'])
            self.client.create_order.assert_not_awaited()
            status['auto_tranche_criteria']['can_take_profit'] = True
            self.assertTrue((await server.reduce_tranche())['success'])
            self.assertEqual(self.client.create_order.await_count, 2)
            status['auto_tranche_criteria']['can_take_profit'] = False
            self.assertTrue((await server.reduce_tranche(force=True))['success'])

    async def test_successful_entry_records_both_order_ids(self):
        self.client.create_order.side_effect = [
            {'status': 'FILLED', 'executedQty': '0.08', 'orderId': 101},
            {'status': 'FILLED', 'executedQty': '1.40', 'orderId': 202}]
        self.assertTrue((await server.step_tranche())['success'])
        self.assertEqual(server.load_auto_tranche_state()['entry_order_pairs'],
                         [{'adr_order_id': '101', 'stock_order_id': '202'}])
