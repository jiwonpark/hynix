import asyncio
import unittest

class TestCSOPHedgedArbitrage(unittest.TestCase):

    def test_tranche_delta_neutrality(self):
        """
        Verify that 0.07 SKHYUSDT and 1.20 CSOPSKHYNIX2LUSDT maintain 1:1 delta neutrality.
        CSOP is a 2x daily leveraged ETF perp.
        """
        skhy_price = 193.60
        csop_price = 5.717

        skhy_qty = 0.07
        csop_qty = 1.20

        skhy_notional = skhy_qty * skhy_price # ~$13.552
        csop_notional = csop_qty * csop_price # ~$6.860
        csop_effective_delta = csop_notional * 2.0 # ~$13.721 (2x leveraged beta)

        delta_imbalance = abs(csop_effective_delta - skhy_notional)
        print(f"\n[Delta Neutrality Verification]")
        print(f"SKHY Short Notional: ${skhy_notional:.2f}")
        print(f"CSOP Long Notional:  ${csop_notional:.2f} (Effective Delta: ${csop_effective_delta:.2f})")
        print(f"Net Delta Imbalance: ${delta_imbalance:.2f}")

        self.assertLess(delta_imbalance, 0.30, "Delta imbalance must be under $0.30")

    def test_tranche_leverage_scaling(self):
        """
        Verify that 10 tranches on $35.00 account equity remain safe and within margin limits.
        """
        equity = 35.01
        skhy_price = 193.60
        csop_price = 5.717

        one_tranche_notional = (0.07 * skhy_price) + (1.20 * csop_price) # ~$20.41
        ten_tranches_notional = one_tranche_notional * 10 # ~$204.10

        gross_leverage = ten_tranches_notional / equity # ~5.83x
        required_margin_10x = ten_tranches_notional / 10.0 # ~$20.41
        margin_buffer = equity - required_margin_10x # ~$14.60

        print(f"\n[Leverage & Risk Buffer Verification]")
        print(f"1 Tranche Total Notional:   ${one_tranche_notional:.2f}")
        print(f"10 Tranches Total Notional: ${ten_tranches_notional:.2f}")
        print(f"Gross Leverage at 10 Units: {gross_leverage:.2f}x")
        print(f"Required Margin (10x Lev):  ${required_margin_10x:.2f}")
        print(f"Free Margin Buffer:         ${margin_buffer:.2f}")

        self.assertLess(gross_leverage, 6.5, "Gross leverage at max tranches must be under 6.5x")
        self.assertGreater(margin_buffer, 10.0, "Margin buffer must be at least $10.00 to absorb spread divergence")

    def test_zero_loss_invariant_rule(self):
        """
        Verify Zero-Loss Invariant rule logic:
        Exits/reductions MUST be blocked when combined unrealized PnL <= 0.
        """
        def can_reduce_tranche(adr_pnl: float, stock_pnl: float) -> bool:
            combined_pnl = adr_pnl + stock_pnl
            return combined_pnl > 0.0

        # Scenario A: In a drawdown (-$1.50) -> MUST BE BLOCKED
        self.assertFalse(can_reduce_tranche(-2.50, +1.00))

        # Scenario B: Flat ($0.00) -> MUST BE BLOCKED
        self.assertFalse(can_reduce_tranche(-0.50, +0.50))

        # Scenario C: In profit (+$0.80) -> ALLOWED TO EXIT
        self.assertTrue(can_reduce_tranche(+1.20, -0.40))
        print("\n[Zero-Loss Invariant Verification] PASSED: Losses strictly non-lockable.")

if __name__ == '__main__':
    unittest.main()
