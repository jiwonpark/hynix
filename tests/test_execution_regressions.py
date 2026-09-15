import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, call, patch

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
        async def default_request(method, path, params, **kwargs):
            if 'ticker' in path:
                return {'price': '190' if params.get('symbol') == 'SKHYUSDT' else '5.6'}
            return []
        self.client.request.side_effect = default_request
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

    async def test_scale_in_rejects_speculative_stack_at_capacity(self):
        status = {'tranches_active': 10, 'auto_tranche_criteria': {'tranches_max': 10}}
        with patch.object(server, 'get_hedged_status', AsyncMock(return_value=status)):
            result = await server.step_tranche()
        self.assertFalse(result['success'])
        self.assertIn('Speculative tranche capacity', result['error'])
        self.client.create_order.assert_not_awaited()

    async def test_flat_account_still_returns_both_histories(self):
        requested = []
        async def request(method, path, params, **kwargs):
            if 'ticker' in path:
                return {'price': '1400'}
            requested.append(params)
            return [{'id': 1, 'orderId': 2, 'side': 'BUY', 'qty': '.07', 'price': '195', 'time': 1000}]
        self.client.request.side_effect = request
        result = await server.get_hedged_status()
        self.assertEqual({t['symbol'] for t in result['recent_executions']}, {'SKHYUSDT', 'CSOPSKHYNIX2LUSDT'})
        self.assertEqual(len(requested), 2)
        self.assertTrue(all(params['limit'] == 1000 for params in requested))
        self.assertTrue(all('startTime' not in params for params in requested))

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
        self.assertEqual(self.client.request.await_count, 4)

    async def test_daily_chart_uses_daily_klines_and_valid_trade_history_window(self):
        times = [86400000 * i for i in range(1, 21)]
        requests = []
        async def request(method, path, params, **kwargs):
            requests.append((path, params))
            if 'klines' in path:
                return [[timestamp, 0, 0, 0, '100'] for timestamp in times]
            return []
        self.client.request.side_effect = request
        result = await server.get_short_term_parity('1d', 20)
        self.assertEqual(result['interval'], '1d')
        self.assertEqual(len(result['bars']), 20)
        kline_params = [params for path, params in requests if 'klines' in path]
        self.assertTrue(all(params['interval'] == '1d' for params in kline_params))
        trade_params = [params for path, params in requests if 'userTrades' in path]
        self.assertEqual(len(trade_params), 1)
        self.assertNotIn('startTime', trade_params[0])
        self.assertNotIn('endTime', trade_params[0])

    async def test_hourly_and_four_hour_chart_intervals(self):
        for interval in ('1h', '4h'):
            with self.subTest(interval=interval):
                self.client.reset_mock()
                requests = []
                step = 3600000 if interval == '1h' else 14400000
                times = [step * i for i in range(1, 21)]
                async def request(method, path, params, **kwargs):
                    requests.append((path, params))
                    if 'klines' in path:
                        return [[timestamp, 0, 0, 0, '100'] for timestamp in times]
                    return []
                self.client.request.side_effect = request
                result = await server.get_short_term_parity(interval, 20)
                self.assertEqual(result['interval'], interval)
                kline_params = [params for path, params in requests if 'klines' in path]
                self.assertTrue(all(params['interval'] == interval for params in kline_params))
                first_trade = next(params for path, params in requests if 'userTrades' in path)
                if interval == '1h':
                    self.assertIn('startTime', first_trade)
                    self.assertIn('endTime', first_trade)
                else:
                    self.assertNotIn('startTime', first_trade)
                    self.assertNotIn('endTime', first_trade)

    async def test_entry_chart_marker_shows_minimum_net_profit(self):
        times = [300000 * i for i in range(1, 21)]
        async def request(method, path, params, **kwargs):
            if 'klines' in path:
                return [[t, 0, 0, 0, '100'] for t in times]
            if params['symbol'] == 'CSOPSKHYNIX2LUSDT':
                return [{'id': 2, 'orderId': 3, 'time': times[5] + 1000, 'side': 'BUY',
                         'price': '5.55', 'qty': '1.40', 'commission': '.001'}]
            return [{'id': 1, 'orderId': 2, 'time': times[5], 'side': 'SELL',
                     'price': '191.25', 'qty': '.08', 'commission': '.001'}]
        self.client.request.side_effect = request
        result = await server.get_short_term_parity('5m', 20)
        self.assertEqual(len(result['markers']), 1)
        marker = result['markers'][0]
        self.assertEqual(marker['minimum_net_profit_usd'], .02)
        self.assertEqual(marker['convergence_target_spread'], 999.92)
        self.assertNotIn('minimum_profit_spread', marker)
        self.assertAlmostEqual(marker['pnl_model']['adr_entry_price'], 191.25)
        self.assertAlmostEqual(marker['pnl_model']['stock_entry_price'], 5.55)
        self.assertEqual(marker['pnl_model']['threshold_usd'], .02)
        self.assertNotIn('Min net', marker['hoverText'])

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
        self.assertGreater(criteria['tranches_max'], 10)
        self.assertEqual(
            criteria['tranches_max'],
            criteria['tranches_active'] + criteria['tranches_remaining'])
        self.assertIs(criteria['active_tranche_stack'], criteria['active_tranches_queue'])
        self.assertEqual(len(criteria['active_tranche_stack']), 1)
        stack_top = criteria['active_tranche_stack'][-1]
        self.assertEqual(stack_top['paired_stock_order_id'], '1')
        self.assertEqual(stack_top['minimum_net_profit_usd'], .02)
        self.assertTrue(stack_top['profit_estimate_available'])
        self.assertIsNotNone(stack_top['estimated_net_pnl_usd'])
        self.assertIn(call('5m', 60), server.get_cached_parity_bars.await_args_list)
        self.assertIn(call('1h', 60), server.get_cached_parity_bars.await_args_list)
        flat_bars = self.ma_bars([141] * 60)
        server.get_cached_parity_bars.side_effect = (
            lambda interval, limit: bars if interval == '5m' else flat_bars)
        criteria = (await server.get_hedged_status())['auto_tranche_criteria']
        self.assertTrue(criteria['exit_ma_alignment_5m']['downward'])
        self.assertFalse(criteria['exit_ma_alignment_1h']['downward'])
        self.assertFalse(criteria['is_exit_ma_aligned'])
        self.assertFalse(criteria['can_take_profit'])
        server.get_cached_parity_bars.side_effect = None
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

        # Backtest profit switches cannot authorize a losing live exit.
        server.save_auto_tranche_state({'condition_toggles': {
            key: False for key in server.MANDATORY_LIVE_CONDITIONS}})
        criteria = (await server.get_hedged_status())['auto_tranche_criteria']
        self.assertFalse(criteria['can_take_profit'])
        self.assertEqual(criteria['status_take_profit'], 'LOCKED_AWAITING_PROFIT')
        self.assertTrue(criteria['live_condition_toggles']['exit_net_profit'])
        self.assertFalse((await server.reduce_tranche())['success'])
        self.client.create_order.assert_not_awaited()

        # Explicit timeframe switches override the legacy combined switch.
        overview['positions'][0]['mark_price'] = 193.2
        server.get_cached_parity_bars.return_value = flat_bars
        server.save_auto_tranche_state({'condition_toggles': {
            'exit_ma_stack': False, 'exit_ma_stack_5m': True,
            'exit_ma_stack_1h': False, 'exit_bottoming_out': False}})
        criteria = (await server.get_hedged_status())['auto_tranche_criteria']
        self.assertFalse(criteria['can_take_profit'])
        self.assertEqual(criteria['status_take_profit'], 'AWAITING_DOWNWARD_MA_STACK')
        state = server.load_auto_tranche_state()
        state['condition_toggles']['exit_ma_stack_5m'] = False
        server.save_auto_tranche_state(state)
        criteria = (await server.get_hedged_status())['auto_tranche_criteria']
        self.assertFalse(criteria['is_exit_ma_aligned'])
        self.assertTrue(criteria['effective_exit_ma_aligned'])
        self.assertTrue(criteria['can_take_profit'])
        self.assertEqual(criteria['status_take_profit'], 'TRIM_READY')

    async def test_disabled_live_guards_still_protect_core_and_available_margin(self):
        server.save_auto_tranche_state({'condition_toggles': {
            key: False for key in server.MANDATORY_LIVE_CONDITIONS}})
        overview = self.client.get_detailed_account_overview.return_value
        overview['summary'] = {'available_margin_usd': 1, 'total_equity_usd': 500}
        overview['positions'] = [
            {'symbol': 'SKHYUSDT', 'position_amt': -.03, 'mark_price': 195},
            {'symbol': 'CSOPSKHYNIX2LUSDT', 'position_amt': .4, 'mark_price': 5.6}]
        criteria = (await server.get_hedged_status())['auto_tranche_criteria']
        self.assertFalse(criteria['can_take_profit'])
        self.assertEqual(criteria['status_take_profit'], 'CORE_INVENTORY_RETAINED')
        self.assertFalse(criteria['can_scale_in'])
        self.assertFalse(criteria['has_scale_in_margin'])
        self.assertEqual(criteria['free_margin_buffer_usd'], 1)
        self.assertFalse((await server.step_tranche())['success'])
        self.assertFalse((await server.reduce_tranche())['success'])
        self.client.create_order.assert_not_awaited()

    async def test_forced_reduction_clamps_each_remaining_leg(self):
        async def filled_order(symbol, side, quantity, order_type, **kwargs):
            self.assertTrue(kwargs['reduce_only'])
            return {'status': 'FILLED', 'executedQty': str(quantity)}
        self.client.create_order.side_effect = filled_order
        for adr, stock in [(.03, .4), (.08, .4), (.03, 1.4)]:
            with self.subTest(adr=adr, stock=stock):
                self.client.create_order.reset_mock()
                self.client.get_detailed_account_overview.return_value['positions'] = [
                    {'symbol': 'SKHYUSDT', 'position_amt': -adr},
                    {'symbol': 'CSOPSKHYNIX2LUSDT', 'position_amt': stock}]
                self.assertTrue((await server.reduce_tranche(force=True))['success'])
                self.assertEqual(self.client.create_order.await_args_list, [
                    call('SKHYUSDT', 'BUY', min(.07, adr), 'MARKET', reduce_only=True),
                    call('CSOPSKHYNIX2LUSDT', 'SELL', min(1.2, stock), 'MARKET', reduce_only=True)])

    async def test_forced_reduction_rejects_invalid_directions_and_quantities(self):
        for adr, stock in [(.08, 1.4), (-.08, -1.4), (0, 1.4),
                           (float('nan'), 1.4), (-.08, float('inf'))]:
            with self.subTest(adr=adr, stock=stock):
                self.client.get_detailed_account_overview.return_value['positions'] = [
                    {'symbol': 'SKHYUSDT', 'position_amt': adr},
                    {'symbol': 'CSOPSKHYNIX2LUSDT', 'position_amt': stock}]
                self.assertFalse((await server.reduce_tranche(force=True))['success'])
        self.client.create_order.assert_not_awaited()
        self.assertNotIn('execution_recovery', server.load_auto_tranche_state())

    async def test_manual_exit_uses_shared_criteria_and_emergency_bypasses(self):
        positions = [
            {'symbol': 'SKHYUSDT', 'position_amt': -.08, 'unrealized_pnl': 1},
            {'symbol': 'CSOPSKHYNIX2LUSDT', 'position_amt': 1.4}]
        self.client.get_detailed_account_overview.return_value['positions'] = positions
        async def filled_order(symbol, side, quantity, order_type, **kwargs):
            return {'status': 'FILLED', 'executedQty': str(quantity)}
        self.client.create_order.side_effect = filled_order
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

    async def test_failed_second_reduction_leg_records_fill_and_blocks_retry(self):
        positions = [
            {'symbol': 'SKHYUSDT', 'position_amt': -.08},
            {'symbol': 'CSOPSKHYNIX2LUSDT', 'position_amt': 1.4}]
        status = {'adr_position': positions[0], 'stock_position': positions[1],
                  'auto_tranche_criteria': {'can_take_profit': True}}
        self.client.create_order.side_effect = [
            {'status': 'FILLED', 'executedQty': '0.07', 'orderId': 301},
            RuntimeError('ETF reduction rejected')]
        with patch.object(server, 'get_hedged_status', AsyncMock(return_value=status)):
            first = await server.reduce_tranche()
            self.assertFalse(first['success'])
            recovery = first['execution_recovery']
            self.assertEqual(recovery['operation'], 'REDUCE_TRANCHE')
            self.assertEqual(recovery['order_adr']['orderId'], 301)
            self.assertFalse(server.load_auto_tranche_state()['enabled'])
            second = await server.reduce_tranche()
            self.assertTrue(second['recovery_required'])
            self.assertEqual(self.client.create_order.await_count, 2)
            self.assertFalse((await server.toggle_auto_tranche(True))['success'])

    async def test_unknown_first_reduction_leg_does_not_submit_etf(self):
        positions = [
            {'symbol': 'SKHYUSDT', 'position_amt': -.08},
            {'symbol': 'CSOPSKHYNIX2LUSDT', 'position_amt': 1.4}]
        self.client.get_detailed_account_overview.return_value['positions'] = positions
        self.client.create_order.side_effect = TimeoutError('unknown reduction outcome')
        first = await server.reduce_tranche(force=True)
        self.assertTrue(first['recovery_required'])
        self.assertEqual(first['execution_recovery']['phase'], 'ADR_SUBMITTING')
        await server.reduce_tranche(force=True)
        self.assertEqual(self.client.create_order.await_count, 1)

    async def test_partial_reduction_fill_is_not_reported_as_success(self):
        positions = [
            {'symbol': 'SKHYUSDT', 'position_amt': -.08},
            {'symbol': 'CSOPSKHYNIX2LUSDT', 'position_amt': 1.4}]
        self.client.get_detailed_account_overview.return_value['positions'] = positions
        self.client.create_order.return_value = {
            'status': 'PARTIALLY_FILLED', 'executedQty': '0.03', 'orderId': 401}
        result = await server.reduce_tranche(force=True)
        self.assertFalse(result['success'])
        self.assertTrue(result['recovery_required'])
        self.assertEqual(result['execution_recovery']['order_adr']['orderId'], 401)
        self.assertEqual(self.client.create_order.await_count, 1)

    async def test_successful_entry_records_both_order_ids(self):
        self.client.create_order.side_effect = [
            {'status': 'FILLED', 'executedQty': '0.08', 'orderId': 101},
            {'status': 'FILLED', 'executedQty': '1.40', 'orderId': 202}]
        self.assertTrue((await server.step_tranche())['success'])
        self.assertEqual(server.load_auto_tranche_state()['entry_order_pairs'],
                         [{'adr_order_id': '101', 'stock_order_id': '202'}])
