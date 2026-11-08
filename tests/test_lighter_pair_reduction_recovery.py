import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock
from backend.lighter_bot import LighterPairBot


class PairedReductionRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.client=Mock()
        self.fills=[{'fill_confirmed':True,'filled_size':.3775,'fill_price':127.22,
                     'realized_pnl_usd':1.809571,'fee_usd':0,'fill_time_ms':1793910312033},
                    {'fill_confirmed':True,'filled_size':.055,'fill_price':867.243,
                     'realized_pnl_usd':-2.4563,'fee_usd':0,'fill_time_ms':1793910316287}]
        self.client.execution_fill=AsyncMock(side_effect=lambda *a:self.fills[0] if a[1]==216 else self.fills[1])
        self.client.positions=AsyncMock(return_value=[{'market_id':216,'position':'.38','sign':-1},
                                                     {'market_id':161,'position':'.055','sign':1}])
        self.client.create_market_order=AsyncMock(side_effect=AssertionError('Recovery must not submit orders'))
        self.bot=LighterPairBot(self.client,Path(self.tmp.name)/'state.json')
        self.bot.state.update(enabled=False,execution_blocked=True,blocked_reason='Pending execution requires reconciliation',
            tranches=[{'tranche_id':'older','side':-1,'adr_qty':.3775,'domestic_qty':.055,'entry_ratio':144.86,'notional_usd':50,'time':1000},
                      {'tranche_id':'newer','side':-1,'adr_qty':.38,'domestic_qty':.055,'entry_ratio':144.68,'notional_usd':50,'time':1100}],
            history=[],pending_execution={'completed':True,'reduce_only':True,'side':1,'adr_qty':.3775,'domestic_qty':.055,
                'time':1200,'first_leg':{'client_order_index':11},'second_leg':{'client_order_index':12}})

    def tearDown(self):self.tmp.cleanup()

    async def test_completed_older_tranche_exit_reconciles_once_without_trading(self):
        self.bot.state['risk_capacity']={'active_tranches':2,'current_gross_usd':999}
        remaining=copy.deepcopy(self.bot.state['tranches'][1])
        self.assertTrue(await self.bot._reconcile_confirmed_pending_reduction())
        self.assertEqual(self.bot.state['tranches'],[remaining])
        self.assertIsNone(self.bot.state['pending_execution'])
        self.assertNotIn('risk_capacity',self.bot.state)
        self.assertFalse(self.bot.state['execution_blocked'])
        self.assertFalse(self.bot.state['enabled'])
        self.assertEqual(self.bot.state['history'][-1]['tranche_id'],'older')
        self.assertEqual(self.bot.state['history'][-1]['time'],1793910316)
        self.assertAlmostEqual(self.bot.state['history'][-1]['net_pnl_usd'],-.646729)
        self.client.positions.assert_awaited_once_with(fresh=True)
        self.client.create_market_order.assert_not_awaited()
        self.assertFalse(await self.bot._reconcile_confirmed_pending_reduction())
        self.assertEqual(len(self.bot.state['history']),1)

    async def test_unknown_owner_or_ambiguous_legacy_quantities_remain_blocked(self):
        self.bot.state['pending_execution']['tranche_id']='newer'
        self.assertFalse(await self.bot._reconcile_confirmed_pending_reduction())
        self.bot.state['pending_execution'].pop('tranche_id')
        self.bot.state['tranches'][1]['adr_qty']=.3775
        self.assertFalse(await self.bot._reconcile_confirmed_pending_reduction())
        self.assertEqual(len(self.bot.state['tranches']),2)
        self.assertIsNotNone(self.bot.state['pending_execution'])
        self.client.create_market_order.assert_not_awaited()

    async def test_explicit_owner_disambiguates_equal_sized_tranches(self):
        self.bot.state['tranches'][1]['adr_qty']=.3775
        self.bot.state['pending_execution']['tranche_id']='older'
        self.client.positions.return_value=[{'market_id':216,'position':'.3775','sign':-1},
                                            {'market_id':161,'position':'.055','sign':1}]
        self.assertTrue(await self.bot._reconcile_confirmed_pending_reduction())
        self.assertEqual(self.bot.state['tranches'][0]['tranche_id'],'newer')

    async def test_residual_position_must_match(self):
        self.client.positions.return_value=[]
        self.assertFalse(await self.bot._reconcile_confirmed_pending_reduction())
        self.assertEqual(len(self.bot.state['tranches']),2)
        self.assertEqual(self.bot.state['history'],[])

    async def test_overfill_must_not_be_assigned_to_another_tranche(self):
        self.fills[0]['filled_size']=.38
        self.assertFalse(await self.bot._reconcile_confirmed_pending_reduction())
        self.assertIsNotNone(self.bot.state['pending_execution'])
        self.assertEqual(len(self.bot.state['tranches']),2)

    async def test_reduction_owner_is_persisted_before_submission(self):
        self.client.create_market_order.side_effect=TimeoutError('lost response')
        with self.assertRaises(TimeoutError):
            await self.bot._trade_pair(1,.3775,.055,{'mid':127},{'mid':867},reduce_only=True,tranche_id='older')
        restored=LighterPairBot(self.client,self.bot.state_file)
        self.assertEqual(restored.state['pending_execution']['tranche_id'],'older')
