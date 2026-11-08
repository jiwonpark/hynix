import asyncio
import copy
import time
import unittest
from backend.realized_history import read_history_snapshot, apply_history_snapshot

class Client:
    async def close(self): pass

class Reader:
    def __init__(self):
        self.client = Client()
        self.state = {'execution_history': [], 'enabled': True}
    async def reconciled_public_state(self):
        time.sleep(.12)  # Reproduce synchronous SDK work before first await.
        self.state['enabled'] = False
        return copy.deepcopy(self.state)

class HistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_blocking_reader_does_not_block_api_or_mutate_trading_state(self):
        bot = Reader()
        task = asyncio.create_task(read_history_snapshot(bot))
        await asyncio.sleep(.02)
        self.assertFalse(task.done())
        result = await task
        self.assertFalse(result['enabled'])
        self.assertTrue(bot.state['enabled'])

    async def test_stale_snapshot_cannot_hide_new_entries_or_change_positions(self):
        current={'tranches':[{'qty':2}], 'execution_history':[
            {'event':'EXIT','symbol':'BTC','side':-1,'qty':1,'order_id':'x','net_pnl_usd':1},
            {'event':'ENTRY','symbol':'BTC','side':1,'qty':2,'order_id':'new'}]}
        cached={'execution_history':[{'event':'EXIT','symbol':'BTC','side':-1,'qty':1,
            'order_id':'x','net_pnl_usd':3,'pnl_authoritative':True}]}
        apply_history_snapshot(current,cached)
        self.assertEqual(current['verified_realized_pnl_usd'],3)
        self.assertEqual(current['execution_history'][-1]['order_id'],'new')
        self.assertEqual(current['tranches'],[{'qty':2}])
        current['execution_history'][0].update(qty=.5,pnl_authoritative=False)
        apply_history_snapshot(current,cached)
        self.assertEqual(current['verified_exit_count'],0)
