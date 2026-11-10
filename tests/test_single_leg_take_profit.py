import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from backend.single_leg_take_profit import net_profit, stop_loss_status, trailing_stop_status
from backend.crypto_bot import CryptoBot
from backend.lighter_crypto_bot import LighterCryptoBot
from backend.server import _run_crypto_backtest_sync


class ProfitMathTests(unittest.TestCase):
    def test_exact_fee_adjusted_long_short_targets(self):
        for side in (1, -1):
            tranches = [{"side": side, "qty": 2, "price": 100, "fee_usd": .1}]
            target = 100 * ((1 + .0005 + .002) / (1 - .0005) if side == 1 else
                            (1 - .0005 - .002) / (1 + .0005))
            result = net_profit(tranches, 2, target, .0005, .2)
            self.assertAlmostEqual(result['net_pct'], .2)
            self.assertTrue(result['pass'])
            self.assertFalse(net_profit(tranches, 2, target - side * .00001, .0005, .2)['pass'])
        zero_fee = net_profit([{"side": 1, "qty": 1, "price": 100, "fee_usd": 0}], 1, 100.2, 0, .2)
        self.assertTrue(zero_fee['pass'])

    def test_net_stop_loss_counts_fees_for_long_and_short(self):
        for side in (1, -1):
            tranche = {"side": side, "qty": 1, "price": 100, "fee_usd": .05}
            quote = 100 - side * .15
            evaluation = net_profit([tranche], 1, quote, .0005, .2)
            self.assertTrue(stop_loss_status(evaluation, .2)["pass"])
            self.assertFalse(stop_loss_status(evaluation, .3)["pass"])
            self.assertEqual(stop_loss_status(evaluation, .2)["target_pct"], -.2)

    def test_trailing_stop_activates_ratchets_and_never_loosens(self):
        holder = {}
        def status(net):
            return trailing_stop_status({"net_pct": net}, holder, .2, .3, .2, .05)
        self.assertEqual(status(.1)["target_pct"], -.2)
        self.assertAlmostEqual(status(.5)["target_pct"], .3)
        self.assertAlmostEqual(status(.52)["target_pct"], .3)  # below minimum ratchet
        self.assertAlmostEqual(status(.8)["target_pct"], .6)
        self.assertFalse(status(.61)["pass"])
        self.assertTrue(status(.59)["pass"])
        self.assertAlmostEqual(holder["stop_trail_peak_pct"], .8)

    def test_replay_stop_loss_independent_of_take_profit_and_entry_stream(self):
        bars = [{"time": 100000+i*300, "value": 100+3*math.sin(i/5)} for i in range(240)]
        kwargs = dict(strategy_mode="ma_proximity", ma_accel_period=4,
                      ma_max_distance_pct=2, use_ma_cross_exit=False)
        baseline = _run_crypto_backtest_sync(bars, True, **kwargs)
        result = _run_crypto_backtest_sync(bars, True, use_stop_loss=True,
                                         take_profit_fee_rate=.0005, **kwargs)
        self.assertEqual(result["entry_signals"], baseline["entry_signals"])
        self.assertEqual(result["take_profit_evaluation"]["state"], "OFF")
        stops = [row for row in result["trades"] if row["reason"] == "net_stop_loss"]
        self.assertTrue(stops)
        self.assertTrue(all(row["net_pnl_pct"] <= -.2 for row in stops))
        unavailable = _run_crypto_backtest_sync(bars, True, use_stop_loss=True, **kwargs)
        self.assertEqual(unavailable["trades"], baseline["trades"])
        self.assertEqual(unavailable["stop_loss_evaluation"]["state"], "UNAVAILABLE")

    def test_lifo_dust_merge_does_not_take_loss_on_older_inventory(self):
        tranches = [{"side": 1, "qty": 1, "price": 110, "fee_usd": .055},
                    {"side": 1, "qty": .01, "price": 100, "fee_usd": .0005}]
        self.assertTrue(net_profit(tranches, .01, 100.4, .0005, .2)['pass'])
        self.assertFalse(net_profit(tranches, .1, 100.4, .0005, .2)['pass'])
        with self.assertRaises(ValueError):
            net_profit(tranches, 2, 100.4, .0005, .2)

    def test_replay_profit_exit_does_not_change_entry_signals(self):
        bars = [{'time': 100000+i*300, 'value': 100 + 3*math.sin(i/5)} for i in range(240)]
        kwargs = dict(strategy_mode='macd_zero_cross', use_macd_signal_zone=False,
                      macd_fast_period=4, macd_slow_period=10, macd_signal_period=3)
        old = _run_crypto_backtest_sync(bars, True, **kwargs)
        new = _run_crypto_backtest_sync(bars, True, use_take_profit=True,
                                      take_profit_fee_rate=.0005, **kwargs)
        self.assertEqual(old['entry_signals'], new['entry_signals'])
        profits = [t for t in new['trades'] if t['reason'] == 'net_take_profit']
        self.assertTrue(profits)
        self.assertTrue(all(t['net_pnl_pct'] >= .2 for t in profits))
        unavailable = _run_crypto_backtest_sync(bars, True, use_take_profit=True, **kwargs)
        self.assertEqual(unavailable['trades'], old['trades'])
        self.assertEqual(unavailable['take_profit_evaluation']['state'], 'UNAVAILABLE')

    def test_replay_trailing_stop_is_real_and_keeps_entry_signal_stream(self):
        bars = [{"time": 100000+i*300, "value": 100+3*math.sin(i/5)} for i in range(240)]
        kwargs = dict(strategy_mode="ma_proximity", ma_accel_period=4,
                      ma_max_distance_pct=2, use_ma_cross_exit=False,
                      use_stop_loss=True, stop_loss_mode="trailing",
                      stop_trail_activation_pct=.2, stop_trail_distance_pct=.1,
                      stop_trail_min_step_pct=.01, take_profit_fee_rate=0)
        baseline = _run_crypto_backtest_sync(bars, True, strategy_mode="ma_proximity",
            ma_accel_period=4, ma_max_distance_pct=2, use_ma_cross_exit=False)
        result = _run_crypto_backtest_sync(bars, True, **kwargs)
        self.assertEqual(result["entry_signals"], baseline["entry_signals"])
        self.assertTrue(any(row["reason"] == "net_stop_loss" and row["net_pnl_pct"] > 0
                            for row in result["trades"]))


class LiveProfitTests(unittest.IsolatedAsyncioTestCase):
    async def test_binance_checks_before_candle_and_uses_filled_entry_fees(self):
        with tempfile.TemporaryDirectory() as folder:
            client = AsyncMock()
            async def request(method, path, params, signed=False):
                if path.endswith('commissionRate'): return {'takerCommissionRate': '.0005'}
                if path.endswith('userTrades'): return [{'orderId': 7, 'qty': '1', 'commission': '.05', 'commissionAsset': 'USDT'}]
                self.fail('Should take profit without fetching candles')
            client.request.side_effect = request
            bot = CryptoBot(client, Path(folder)/'state.json')
            bot.state.update(enabled=True, last_evaluated_candle=9999999999,
                             tranches=[{'side':1,'qty':1,'price':100,'order_id':'7'}])
            bot._book = AsyncMock(return_value=(100.31,100.32))
            bot._submit = AsyncMock()
            await bot.run_once()
            bot._submit.assert_awaited_once_with(-1,0,reduce_only=True,reason='net_take_profit')
            self.assertGreater(bot.state['take_profit_evaluation']['net_pct'], .2)
            bot.state['use_take_profit'] = False
            self.assertFalse(await bot.check_net_exits())

    async def test_stop_loss_only_uses_executable_exit_quote(self):
        with tempfile.TemporaryDirectory() as folder:
            for cls, side in ((CryptoBot, 1), (LighterCryptoBot, -1)):
                client = AsyncMock()
                bot = cls(client, Path(folder)/cls.__name__)
                await bot.configure({"use_take_profit": False, "use_stop_loss": True, "stop_loss_pct": .2})
                bot.state["tranches"] = [{"side": side, "qty": 1, "price": 100, "order_id": "7", "fee_usd": 0}]
                bot.take_profit_fee_rate = AsyncMock(return_value=0)
                client.request.return_value = [{"orderId": 7, "qty": 1, "commission": 0, "commissionAsset": "USDT"}]
                bot._book = AsyncMock(return_value=(99.7, 100.3))
                bot._market = AsyncMock(return_value=(1, {"min_base_amount": ".001", "min_quote_amount": "5"}, .001))
                bot._submit = AsyncMock()
                self.assertTrue(await bot.check_net_exits())
                bot._submit.assert_awaited_once_with(-side, 0, reduce_only=True, reason="net_stop_loss")
                self.assertEqual(bot.state["take_profit_evaluation"]["state"], "OFF")
                self.assertAlmostEqual(bot.state["stop_loss_evaluation"]["net_pct"], -.3)

    async def test_quote_recheck_prevents_submitting_when_profit_disappears(self):
        import asyncio
        from decimal import Decimal
        with tempfile.TemporaryDirectory() as folder:
            for cls in (CryptoBot, LighterCryptoBot):
                client = AsyncMock()
                client.execution_lock = asyncio.Lock()
                bot = cls(client, Path(folder)/f"recheck-{cls.__name__}.json")
                bot.state['tranches'] = [{'side':1,'qty':1,'price':100,'order_id':'7','fee_usd':0}]
                bot._book = AsyncMock(return_value=(100.1,100.11))
                if cls is CryptoBot:
                    bot._account_position = AsyncMock(return_value=({},1))
                    bot._exchange_rules = AsyncMock(return_value=(Decimal('.001'),Decimal('.001'),Decimal('5')))
                else:
                    bot._account_position = AsyncMock(return_value=({},1,[]))
                    bot._market = AsyncMock(return_value=(1, {'mark_price':100.1,'min_base_amount':'.001','min_quote_amount':'5'},.001))
                bot.take_profit_evaluation = AsyncMock(return_value={'pass':False})
                with self.assertRaisesRegex(ValueError,'no longer meets'):
                    await bot._submit(-1,0,reduce_only=True,reason='net_take_profit')
                bot.state["use_stop_loss"] = True
                bot.stop_loss_evaluation = AsyncMock(return_value={"pass": False})
                with self.assertRaisesRegex(ValueError, "no longer meets net stop-loss"):
                    await bot._submit(-1, 0, reduce_only=True, reason="net_stop_loss")
                client.create_order.assert_not_awaited()
                client.create_market_order.assert_not_awaited()
                self.assertIsNone(bot.state['pending_order'])

    async def test_unavailable_fee_never_assumed_zero(self):
        with tempfile.TemporaryDirectory() as folder:
            bot = CryptoBot(AsyncMock(), Path(folder)/'state.json')
            bot.state['tranches'] = [{'side':1,'qty':1,'price':100,'order_id':'7'}]
            bot._book = AsyncMock(return_value=(101,101.01))
            bot.take_profit_fee_rate = AsyncMock(side_effect=ValueError('Fee service offline'))
            bot._submit = AsyncMock()
            self.assertFalse(await bot.check_net_exits())
            bot._submit.assert_not_awaited()
            self.assertEqual(bot.state['take_profit_evaluation']['state'],'UNAVAILABLE')

    async def test_both_bots_persist_config_and_reject_invalid_threshold(self):
        with tempfile.TemporaryDirectory() as folder:
            for cls in (CryptoBot,LighterCryptoBot):
                path=Path(folder)/f'{cls.__name__}.json'
                bot=cls(AsyncMock(),path)
                await bot.configure({'use_take_profit':False,'take_profit_pct':.35})
                restored=cls(AsyncMock(),path)
                self.assertFalse(restored.public_state()['strategy_params']['use_take_profit'])
                self.assertEqual(restored.public_state()['strategy_params']['take_profit_pct'],.35)
                with self.assertRaises(ValueError): await bot.configure({'take_profit_pct':float('nan')})
                bot.state['enabled']=True
                with self.assertRaises(ValueError): await bot.configure({'take_profit_pct':.4})

    async def test_lighter_standard_zero_fees_and_reject_unverified_tier(self):
        with tempfile.TemporaryDirectory() as folder:
            client=AsyncMock()
            bot=LighterCryptoBot(client,Path(folder)/'state.json')
            client._account_snapshot.return_value={'account_type':0}
            self.assertEqual(await bot.take_profit_fee_rate(),0)
            bot._take_profit_rate_cache=None
            client._account_snapshot.return_value={'account_type':1}
            with self.assertRaises(ValueError): await bot.take_profit_fee_rate()
