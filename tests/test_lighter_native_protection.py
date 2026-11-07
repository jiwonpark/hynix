import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from backend.lighter_crypto_bot import LighterCryptoBot
from backend.lighter_native_protection import protection_children
from test_lighter_crypto_bot import FakeLighter


class NativeClient(FakeLighter):
    def __init__(self):
        super().__init__()
        self.placements = []
        self.cancel_race = None
        self.lost_response = False
        self.cancel_error = False

    async def market_detail(self, *args, **kwargs):
        return {**await super().market_detail(*args, **kwargs), 'supported_price_decimals': 2}

    async def create_protection_orders(self, market_id, quantity, side, children):
        self.placements.append(copy.deepcopy(children))
        for child in children:
            self.orders[child['client_order_index']] = {
                'status': 'open', 'order_index': child['client_order_index'],
                'filled_base_amount': 0, 'filled_quote_amount': 0}
        if self.lost_response:
            raise TimeoutError('lost group response')

    async def cancel_protection_order(self, market_id, index):
        if self.cancel_error:
            raise TimeoutError('cancel unavailable')
        if self.cancel_race:
            callback, self.cancel_race = self.cancel_race, None
            callback()
        row = self.orders[index]
        if row['status'] != 'filled':
            row['status'] = 'canceled'


class NativeProtectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'state.json'
        self.client = NativeClient()
        self.bot = LighterCryptoBot(self.client, self.path)
        self.bot.take_profit_fee_rate = AsyncMock(return_value=0)
        self.bot.state.update(use_native_protection=True, use_stop_loss=True,
                              use_hourly_hist=False, use_macd_signal_slope_5m=False)
        self.lot('old', 100)
        self.lot('new', 101)

    def tearDown(self):
        self.tmp.cleanup()

    def lot(self, index, price):
        self.bot.state['tranches'].append(dict(order_id=index, side=1, qty=1, price=price, fee_usd=0))
        self.client.amount += 1

    async def arm(self):
        await self.bot.arm_native_protection()
        return self.bot.state['native_brackets']

    def fill(self, group, child_index=1, qty=1, price=99):
        child = group['children'][child_index]
        row = self.client.orders[child['client_order_index']]
        row.update(status='filled' if qty == 1 else 'canceled', filled_base_amount=qty,
                   filled_quote_amount=qty * price, updated_at=1794000000000)
        self.client.amount -= qty

    async def test_per_slice_oco_and_older_stop_not_lifo(self):
        groups = await self.arm()
        self.assertEqual(len(self.client.placements), 2)
        self.assertTrue(all(len(g['children']) == 2 for g in groups))
        self.fill(groups[0])
        await self.bot.reconcile_native_protection()
        self.assertEqual([t['order_id'] for t in self.bot.state['tranches']], ['new'])
        event = self.bot.state['execution_history'][-1]
        self.assertEqual(event['entry_order_id'], 'old')
        self.assertEqual(event['reason'], 'native_stop_loss')
        self.assertAlmostEqual(event['net_pnl_usd'], -1)
        await self.bot.reconcile_native_protection()
        self.assertEqual(len(self.bot.state['execution_history']), 1)

    async def test_restart_accounts_fill_once(self):
        groups = await self.arm()
        self.fill(groups[0])
        restored = LighterCryptoBot(self.client, self.path)
        await restored.verify_startup()
        self.assertFalse(restored.state['recovery_required'])
        again = LighterCryptoBot(self.client, self.path)
        await again.verify_startup()
        self.assertEqual(len(again.state['execution_history']), 1)

    async def test_partial_fill_reprotects_residual(self):
        groups = await self.arm()
        self.fill(groups[0], qty=.4)
        await self.bot.reconcile_native_protection()
        self.assertAlmostEqual(self.bot.state['tranches'][0]['qty'], .6)
        await self.bot.arm_native_protection()
        self.assertEqual(len(self.client.placements), 3)
        self.assertAlmostEqual(self.bot.state['native_brackets'][-1]['qty'], .6)

    async def test_strategy_exit_cancels_then_rearms_remaining(self):
        groups = copy.deepcopy(await self.arm())
        await self.bot._submit(-1, 0, reduce_only=True, reason='strategy_exit')
        self.assertTrue(all(self.client.orders[c['client_order_index']]['status'] == 'canceled'
                            for g in groups for c in g['children']))
        self.assertEqual(len(self.bot.state['native_brackets']), 1)
        self.assertEqual(self.bot.state['native_brackets'][0]['entry_order_id'], 'old')

    async def test_fill_racing_cancel_is_accounted_before_reduction(self):
        groups = await self.arm()
        self.client.cancel_race = lambda: self.fill(groups[0])
        await self.bot._submit(-1, 0, reduce_only=True, reason='strategy_exit')
        self.assertEqual(self.bot.state['tranches'], [])
        self.assertAlmostEqual(self.client.amount, 0)
        self.assertEqual([e['entry_order_id'] for e in self.bot.state['execution_history']], ['old', 'new'])

    async def test_ambiguous_submission_recovered_without_resubmit(self):
        self.client.lost_response = True
        with self.assertRaises(TimeoutError):
            await self.arm()
        self.assertEqual(len(self.client.placements), 1)
        restored = LighterCryptoBot(self.client, self.path)
        await restored.reconcile_native_protection()
        self.assertEqual(restored.state['native_brackets'][0]['phase'], 'live')
        self.assertEqual(len(self.client.placements), 1)

    async def test_unknown_submission_blocks_no_retry(self):
        groups = await self.arm()
        self.client.orders.pop(groups[0]['children'][0]['client_order_index'])
        with self.assertRaisesRegex(ValueError, 'outcome unavailable'):
            await self.bot.reconcile_native_protection()
        with self.assertRaises(ValueError):
            await self.bot.arm_native_protection()
        self.assertEqual(len(self.client.placements), 2)

    async def test_paused_native_fill_still_reconciled(self):
        groups = await self.arm()
        self.fill(groups[0])
        await self.bot.run_once()
        self.assertEqual(len(self.bot.state['tranches']), 1)

    async def test_paused_partial_native_exit_reprotects_residual(self):
        groups = await self.arm()
        self.fill(groups[0], qty=.4)
        await self.bot.run_once()
        residual = next(g for g in self.bot.state['native_brackets'] if g['entry_order_id'] == 'old')
        self.assertAlmostEqual(residual['qty'], .6)
        self.assertEqual(residual['phase'], 'live')

    async def test_flat_required_for_protection_setting_changes(self):
        with self.assertRaisesRegex(ValueError, 'Close tracked inventory'):
            await self.bot.configure({'use_native_protection': False})
        with self.assertRaisesRegex(ValueError, 'Close tracked inventory'):
            await self.bot.configure({'stop_loss_pct': .5})

    async def test_cancel_failure_withholds_market_exit(self):
        await self.arm()
        self.client.cancel_error = True
        with self.assertRaisesRegex(ValueError, 'cancellation not confirmed'):
            await self.bot._submit(-1, 0, reduce_only=True, reason='strategy_exit')
        self.assertEqual(len(self.bot.state['tranches']), 2)
        self.assertEqual(len(self.bot.state['execution_history']), 0)

    async def test_one_enabled_exit_is_single_conditional(self):
        self.bot.state['use_take_profit'] = False
        groups = await self.arm()
        self.assertTrue(all(len(g['children']) == 1 for g in groups))
        self.assertEqual(groups[0]['children'][0]['kind'], 'stop_loss')

    def test_fee_adjusted_triggers_both_directions(self):
        for side in (1, -1):
            children = protection_children(dict(side=side, qty=2, price=100, fee_usd=.2),
                                          dict(use_take_profit=True, take_profit_pct=1,
                                               use_stop_loss=True, stop_loss_pct=.2), 4, .001, lambda: 1)
            for child, target in zip(children, (1, -.2)):
                px = child['trigger_price']
                net_pct = (side * 2 * (px - 100) - .2 - px * 2 * .001) / 200 * 100
                self.assertGreaterEqual(net_pct + 1e-8, target)
                self.assertLess(net_pct - target, .0002)

class NativeClientSubmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_grouped_submission_has_reduce_only_and_integer_precision(self):
        import sys
        from types import SimpleNamespace
        from unittest.mock import patch, Mock
        from backend.lighter_client import LighterClient
        signer = SimpleNamespace(check_client=lambda: None,
                                 ORDER_TYPE_TAKE_PROFIT=4, ORDER_TYPE_STOP_LOSS=2,
                                 ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL=0,
                                 DEFAULT_28_DAY_ORDER_EXPIRY=-1,
                                 GROUPING_TYPE_ONE_CANCELS_THE_OTHER=2,
                                 create_grouped_orders=AsyncMock(return_value=(None, SimpleNamespace(code=200, tx_hash='ok'), None)),
                                 create_order=AsyncMock(return_value=(None, SimpleNamespace(code=200), None)))
        client = LighterClient()
        client.get_signer = Mock(return_value=signer)
        client.market_detail = AsyncMock(return_value=dict(supported_size_decimals=5,
                supported_price_decimals=1, min_base_amount='.00001', min_quote_amount='10'))
        children = [dict(kind='take_profit', client_order_index=11, trigger_ticks=800000),
                    dict(kind='stop_loss', client_order_index=12, trigger_ticks=790000)]
        with patch.dict(sys.modules, {'lighter.signer_client': SimpleNamespace(CreateOrderTxReq=SimpleNamespace)}):
            await client.create_protection_orders(1, .00129, 1, children)
            grouping, orders = signer.create_grouped_orders.call_args.args
            self.assertEqual(grouping, 2)
            self.assertEqual([o.Type for o in orders], [4, 2])
            self.assertTrue(all(o.ReduceOnly == 1 and o.IsAsk == 1 and o.BaseAmount == 129 for o in orders))
            self.assertEqual(orders[0].TriggerPrice, 800000)
            await client.create_protection_orders(1, .00129, -1, children[:1])
            self.assertEqual(signer.create_order.call_args.args[4], 0)
            self.assertEqual(signer.create_order.call_args.args[7], 1)
            signer.create_grouped_orders.return_value = (None, SimpleNamespace(code=400), None)
            with self.assertRaisesRegex(RuntimeError, 'submission failed'):
                await client.create_protection_orders(1, .00129, 1, children)
