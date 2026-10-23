import tempfile
import unittest
from pathlib import Path
from backend.crypto_bot import CryptoBot
from backend.lighter_crypto_bot import LighterCryptoBot
from backend.entry_count_limit import parse_entry_count_limit, has_entry_slot
from test_crypto_bot_live import FakeBinance
from test_lighter_crypto_bot import FakeLighter


class EntryCountTests(unittest.IsolatedAsyncioTestCase):
    async def test_configuration_round_trip_and_validation_for_both_venues(self):
        for cls, fake in [(CryptoBot, FakeBinance), (LighterCryptoBot, FakeLighter)]:
            with tempfile.TemporaryDirectory() as directory:
                client=fake(); path=Path(directory)/'state.json'; bot=cls(client,path)
                self.assertEqual(bot.state['max_tranches'],5)
                for value in [1,2,3,4,5,6,7,8,9,10,20,100,None,'unlimited']:
                    await bot.configure({'max_tranches':value})
                    expected=None if value in (None,'unlimited') else value
                    restored=cls(client,path)
                    self.assertEqual(restored.state['max_tranches'],expected)
                    self.assertEqual(restored.public_state()['risk_capacity']['max_tranches'],expected)
                for value in [0,-1,101,1.5,True,'invalid']:
                    with self.assertRaises(ValueError):
                        await bot.configure({'max_tranches':value})
                    self.assertIsNone(bot.state['max_tranches'])

    async def test_finite_count_and_unlimited_keep_leverage_and_margin_guards(self):
        for cls, fake in [(CryptoBot, FakeBinance), (LighterCryptoBot, FakeLighter)]:
            with self.subTest(venue=cls.__name__), tempfile.TemporaryDirectory() as directory:
                client=fake();bot=cls(client,Path(directory)/'state.json')
                await bot.configure({'max_tranches':6})
                for _ in range(6):
                    bot.state['last_order_time']=0
                    await bot.manual_entry(1,50)
                self.assertEqual(len(bot.state['tranches']),6)
                bot.state['last_order_time']=0
                with self.assertRaisesRegex(ValueError,'Tranche capacity'):
                    await bot.manual_entry(1,50)
                await bot.configure({'max_tranches':None})
                await bot.manual_entry(1,50)
                self.assertEqual(len(bot.state['tranches']),7)
                bot.state['last_order_time']=0
                if cls is CryptoBot:
                    client.account['summary']['total_equity_usd']=10
                else:
                    client.collateral=10
                with self.assertRaisesRegex(ValueError,'cap'):
                    await bot.manual_entry(1,50)
                if cls is CryptoBot:
                    client.account['summary'].update(total_equity_usd=1000,available_margin_usd=0)
                else:
                    client.collateral=1000
                    client.extra_positions=[{'market_id':999,'allocated_margin':1000}]
                with self.assertRaisesRegex(ValueError,'margin'):
                    await bot.manual_entry(1,50)
                self.assertEqual(len(bot.state['tranches']),7)

    def test_large_unlimited_count_is_not_an_alias_for_one_hundred(self):
        self.assertTrue(has_entry_slot({'max_tranches':None,'tranches':[{}]*1000}))
        self.assertFalse(has_entry_slot({'max_tranches':100,'tranches':[{}]*100}))
