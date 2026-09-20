"""All exchange calls are mocks: never submit test orders to Upbit."""
import asyncio
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from backend.strategy_lab import UpbitStrategyExecutionEngine, run_ma_stack_backtest
from backend.upbit_client import UpbitAPIError

NOW = 1800000010  # Ten seconds into the next completed 5m boundary.
BOUNDARY = NOW // 300 * 300


def bars(unit, count=80):
    end = BOUNDARY // unit * unit
    return [dict(time=end - (count-i)*unit, open=100, high=100, low=100, close=100, volume=1) for i in range(count)]


def fill(qty=0, price=100, fee=0, state='wait'):
    return dict(uuid='exchange-order', state=state, executed_volume=str(qty), paid_fee=str(fee),
                trades=[dict(volume=str(qty), price=str(price), funds=str(qty*price))] if qty else [])


class OrderSafetyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'state.json'
        self.engine = UpbitStrategyExecutionEngine(self.path)
        self.client = AsyncMock()
        self.client.get_detailed_account_overview.return_value = {'summary': {'cash_krw': 10000000}}
        self.client.get_tickers.return_value = [{'trade_price': 100}]
        self.client.create_order.return_value = {'uuid': 'exchange-order'}
        self.client.get_order.return_value = fill()
        await self.engine.set_mode('live', enable=True)
        self.clock = patch('backend.strategy_lab.time.time', return_value=NOW)
        self.clock.start()

    async def asyncTearDown(self):
        self.clock.stop()
        self.temp.cleanup()

    def holding(self, qty=2, mode='live', id_='entry'):
        return dict(id=id_, market='KRW-BTC', strategy='ma_stack', mode=mode, entry_time=BOUNDARY-600,
                    entry_price=100, coin_qty=qty, entry_notional_krw=qty*100.05, fee_krw=qty*.05)

    def seed(self, **updates):
        state = self.engine.load_state()
        state.update(updates)
        self.engine.save_state(state)

    async def step(self, entry=True, exit_=False, candles=None, hourly=None):
        with patch('backend.strategy_lab.evaluate_strategy_signals', return_value=(entry, exit_, 'test')):
            return await self.engine.execute_step(self.client, candles or bars(300), hourly or bars(3600))

    async def test_timeout_after_buy_then_restart_never_resubmits(self):
        self.client.get_order.side_effect = TimeoutError('read lost')
        await self.step()
        self.engine = UpbitStrategyExecutionEngine(self.path)
        await self.step()
        self.assertEqual(self.client.create_order.await_count, 1)
        self.assertEqual(self.engine.get_status()['active_tranches_count'], 0)
        self.assertIsNotNone(self.engine.load_state()['pending_order'])
        self.client.get_order.side_effect = None
        self.client.get_order.return_value = fill(2, 101, .101, 'done')
        await self.step()
        status = self.engine.get_status()
        self.assertEqual(status['active_tranches_count'], 1)
        self.assertAlmostEqual(status['total_invested_krw'], 202.10)
        await self.step()
        self.assertEqual(self.client.create_order.await_count, 1)

    async def test_lost_submission_recovers_by_durable_identifier_while_paused(self):
        self.client.create_order.side_effect = TimeoutError('lost response')
        await self.step()
        pending = self.engine.load_state()['pending_order']
        self.assertFalse(self.engine.get_status()['enabled'])
        self.assertIsNone(pending['uuid'])
        self.client.get_order.return_value = fill(1, 100, .05, 'cancel')
        self.engine = UpbitStrategyExecutionEngine(self.path)
        await self.engine.reconcile_pending(self.client)
        self.client.get_order.assert_awaited_with(identifier=pending['identifier'])
        self.assertEqual(self.engine.get_status()['total_coin_qty'], 1)
        self.assertEqual(self.client.create_order.await_count, 1)

    async def test_pending_zero_fill_and_partial_buy_use_actual_vwap_cost(self):
        await self.step()
        self.assertEqual(self.engine.get_status()['total_coin_qty'], 0)
        partial = fill(3, 100, .2)
        partial['trades'] = [dict(volume='1', price='90', funds='90'), dict(volume='2', price='105', funds='210')]
        self.client.get_order.return_value = partial
        await self.step()
        await self.step()  # repeated cumulative response is idempotent
        status = self.engine.get_status()
        self.assertEqual(status['active_tranches_count'], 1)
        self.assertAlmostEqual(status['total_invested_krw'], 300.2)
        self.assertEqual(status['active_tranches'][0]['entry_price'], 100)
        self.client.get_order.return_value = fill(4, 101, .202, 'done')
        await self.step()
        self.assertEqual(self.engine.get_status()['total_coin_qty'], 4)
        self.assertEqual(self.client.create_order.await_count, 1)

    async def test_failed_emergency_preserves_inventory_and_history(self):
        self.seed(active_tranches=[self.holding()])
        self.client.create_order.side_effect = UpbitAPIError(400, 'rejected')
        status = await self.engine.emergency_flatten(self.client, 100)
        self.assertFalse(status['enabled'])
        self.assertEqual(status['total_coin_qty'], 2)
        self.assertEqual(status['recent_trades'], [])
        self.assertIsNone(status['pending_order'])

    async def test_emergency_partial_cancellation_preserves_unsold_lifo_cost(self):
        self.seed(active_tranches=[self.holding(2, id_='older'), self.holding(1, id_='newer')])
        self.client.get_order.return_value = fill(.5, 120, .03)
        await self.engine.emergency_flatten(self.client, 120)
        self.assertEqual(self.engine.get_status()['total_coin_qty'], 2.5)
        self.client.get_order.return_value = fill(1.5, 120, .09, 'cancel')
        await self.engine.reconcile_pending(self.client)
        status = self.engine.get_status()
        self.assertEqual(status['total_coin_qty'], 1.5)
        self.assertEqual(status['active_tranches_count'], 1)
        self.assertAlmostEqual(status['active_tranches'][0]['entry_notional_krw'], 150.075)
        self.assertEqual(len(status['recent_trades']), 2)
        self.assertEqual(status['recent_trades'][-1]['id'], 'newer')
        self.assertIsNone(status['pending_order'])
        self.assertEqual(self.client.create_order.await_count, 1)

    async def test_pending_sell_blocks_second_emergency_and_mode_switch(self):
        self.seed(active_tranches=[self.holding()])
        await self.engine.emergency_flatten(self.client, 100)
        await self.engine.emergency_flatten(self.client, 100)
        self.assertEqual(self.client.create_order.await_count, 1)
        self.assertEqual(self.engine.get_status()['total_coin_qty'], 2)
        with self.assertRaises(ValueError):
            await self.engine.set_mode('paper')
        with self.assertRaises(ValueError):
            await self.engine.toggle_enabled(True)

    async def test_paper_live_switch_blocked_both_directions_and_mixed_inventory(self):
        for mode in ('live', 'paper'):
            self.seed(mode=mode, active_tranches=[self.holding(mode=mode)])
            with self.assertRaises(ValueError):
                await self.engine.set_mode('paper' if mode == 'live' else 'live')
        self.seed(mode='paper', active_tranches=[self.holding(mode='live')])
        with self.assertRaises(ValueError):
            await self.engine.emergency_flatten(self.client, 100)
        self.client.create_order.assert_not_awaited()
        self.assertEqual(self.engine.get_status()['total_coin_qty'], 2)

    async def test_profit_gate_blocks_loss_and_below_minimum_but_emergency_bypasses(self):
        self.seed(mode='paper', active_tranches=[self.holding(mode='paper')], min_profit_pct=5)
        for price in (90, 104):
            self.client.get_tickers.return_value = [{'trade_price': price}]
            await self.step(entry=False, exit_=True)
            self.assertEqual(self.engine.get_status()['active_tranches_count'], 1)
        self.client.get_tickers.return_value = [{'trade_price': 106}]
        await self.step(entry=False, exit_=True)
        self.assertEqual(self.engine.get_status()['active_tranches_count'], 0)
        self.seed(active_tranches=[self.holding(mode='paper')])
        await self.engine.emergency_flatten(self.client, 90)
        self.assertEqual(self.engine.get_status()['active_tranches_count'], 0)

    async def test_persist_failure_before_submission_blocks_exchange(self):
        with patch.object(self.engine, 'save_state', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                await self.step()
        self.client.create_order.assert_not_awaited()

    async def test_uuid_persist_failure_recovers_using_saved_intent(self):
        save = self.engine.save_state
        def fail_uuid(state):
            if state.get('pending_order', {}).get('uuid'):
                raise OSError('disk full')
            save(state)
        with patch.object(self.engine, 'save_state', side_effect=fail_uuid):
            with self.assertRaises(OSError):
                await self.step()
        self.engine = UpbitStrategyExecutionEngine(self.path)
        self.client.get_order.return_value = fill(1, 100, .05, 'done')
        await self.step()
        self.assertEqual(self.client.create_order.await_count, 1)
        self.assertEqual(self.engine.get_status()['total_coin_qty'], 1)

    async def test_corrupt_state_does_not_reset_inventory(self):
        self.path.write_text('{broken')
        with self.assertRaises(RuntimeError):
            await self.step()
        self.client.create_order.assert_not_awaited()
        self.assertEqual(self.path.read_text(), '{broken')

    async def test_live_uses_latest_completed_bar_and_only_completed_hour(self):
        five = bars(300) + [dict(time=BOUNDARY, open=999, high=999, low=999, close=999)]
        hour_boundary = BOUNDARY // 3600 * 3600
        hourly = bars(3600) + [dict(time=hour_boundary, open=999, high=999, low=999, close=999)]
        with patch('backend.strategy_lab.evaluate_strategy_signals', return_value=(False, False, 'test')) as signal:
            await self.engine.execute_step(self.client, five, hourly)
        _, five_eval, hour_eval = signal.call_args.args
        self.assertEqual(five_eval['time'], BOUNDARY-300)
        self.assertEqual(hour_eval['time'], hour_boundary-3600)
        self.assertEqual(hour_eval['close'], 100)

    async def test_stale_data_never_trades(self):
        stale = [dict(b, time=b['time']-600) for b in bars(300)]
        await self.step(candles=stale)
        self.client.create_order.assert_not_awaited()


class CandleCausalityTests(unittest.TestCase):
    def test_hour_final_close_cannot_affect_earlier_signals(self):
        five = [dict(time=(i-60)*300, open=100, high=100, low=100, close=100) for i in range(73)]
        old = [dict(time=(i-60)*3600, open=100, high=100, low=100, close=100) for i in range(60)]
        results = []
        for price in (50, 150):
            hourly = old + [dict(time=0, open=100, high=max(price,100), low=min(price,100), close=price)]
            result = run_ma_stack_backtest(five, hourly, entry_5m=False, entry_1h=True, exit_5m=False, exit_1h=False)
            results.append([m for m in result['markers'] if m['time'] < 3600])
        self.assertEqual(results[0], results[1])
        self.assertFalse(results[0])
