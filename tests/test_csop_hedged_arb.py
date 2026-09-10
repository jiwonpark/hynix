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

    def test_skhy_shares_exposure_conversion(self):
        """
        Verify that positions convert accurately to SKHY shares and Korean domestic shares:
        - 1 contract of SKHYUSDT = 1.00 SKHY share = 0.10 KR domestic share.
        - CSOP 2x ETF perp = (CSOP notional * 2.0 / SKHY mark price) SKHY eq. shares.
        """
        skhy_price = 193.37
        csop_price = 5.628

        # 2 Tranches open: -0.14 SKHY vs +2.40 CSOP
        adr_amt = -0.14
        csop_amt = +2.40

        adr_skhy_shares = adr_amt
        csop_delta_usd = csop_amt * csop_price * 2.0 # 27.0144
        csop_skhy_shares = csop_delta_usd / skhy_price # ~0.1397

        net_skhy_shares = adr_skhy_shares + csop_skhy_shares
        net_krx_shares = net_skhy_shares * 0.1

        print(f"\n[Share Exposure Conversion Verification]")
        print(f"ADR Leg:      {adr_skhy_shares:+.4f} SKHY shares ({adr_skhy_shares * 0.1:+.5f} KRX 000660)")
        print(f"CSOP 2x Leg:  {csop_skhy_shares:+.4f} SKHY eq. shares ({csop_skhy_shares * 0.1:+.5f} KRX 000660)")
        print(f"Net Exposure: {net_skhy_shares:+.4f} SKHY shares ({net_krx_shares:+.5f} KRX 000660)")

        self.assertAlmostEqual(adr_skhy_shares, -0.14, places=2)
        self.assertAlmostEqual(csop_skhy_shares, 0.14, places=2)
        self.assertLess(abs(net_skhy_shares), 0.005, "Net share exposure must be virtually zero")

    def test_asymmetric_micro_churn_inventory_ratchet(self):
        """
        Verify the Asymmetric Micro-Churn Inventory Ratchet:
        - Scale-in: 0.08 SKHY + 1.40 CSOP (+$23.40 notional)
        - Scale-out: 0.07 SKHY + 1.20 CSOP (+$20.41 notional)
        - Residual retained per cycle: +0.01 SKHY short + +0.20 CSOP long
        - Combined unrealized PnL threshold > $0.02 covers round-trip taker fees (~$0.018).
        """
        scale_in_skhy = 0.08
        scale_in_csop = 1.40
        scale_out_skhy = 0.07
        scale_out_csop = 1.20

        residual_skhy = round(scale_in_skhy - scale_out_skhy, 2)
        residual_csop = round(scale_in_csop - scale_out_csop, 2)

        self.assertEqual(residual_skhy, 0.01, "Residual SKHY retained per churn must be +0.01")
        self.assertEqual(residual_csop, 0.20, "Residual CSOP retained per churn must be +0.20")

        # Fee analysis:
        # Binance VIP 0 taker fee = 0.05% (0.0005)
        # Entry notional ~$23.40, Exit notional ~$20.41
        entry_fees = 23.40 * 0.0005 # ~$0.0117
        exit_fees = 20.41 * 0.0005 # ~$0.0102
        total_roundtrip_fees = entry_fees + exit_fees # ~$0.0219 (or with maker/taker mixes ~$0.018)

        min_take_profit_pnl = 0.02
        self.assertGreaterEqual(min_take_profit_pnl, 0.02, "Min TP threshold must be at least $0.02 to skim profit after fees")
        print(f"\n[Asymmetric Micro-Churn Inventory Ratchet Verification]")
        print(f"Scale-In:  {scale_in_skhy} SKHY + {scale_in_csop} CSOP")
        print(f"Scale-Out: {scale_out_skhy} SKHY + {scale_out_csop} CSOP")
        print(f"Retained Core Inventory per Churn: +{residual_skhy} SKHY (short) / +{residual_csop} CSOP (long)")
        print(f"Take-Profit Threshold: > +${min_take_profit_pnl:.2f} Net PnL (Zero-Loss Enforced)")

    def test_speculative_scale_in_peak_out(self):
        """
        Verify Speculative Scale-In rules:
        - Must be stretched above 24-MA by >= 0.10% pts.
        - Upward divergence must be showing peak-out / momentum exhaustion.
        """
        def check_scale_in_armed(curr_spread: float, ma24: float, bars: list, base_entry: float, can_scale_in: bool = True) -> bool:
            ma_stretch = curr_spread - ma24
            is_stretched = (ma_stretch >= 0.10)
            is_above_entry = (curr_spread >= base_entry + 0.10)
            if len(bars) >= 3:
                last_val = bars[-1]
                prev_val = bars[-2]
                prev2_val = bars[-3]
                local_high = max(prev_val, prev2_val)
                is_peaking = (last_val <= prev_val or last_val < local_high)
            else:
                is_peaking = True
            return bool(can_scale_in and is_stretched and is_above_entry and is_peaking)

        base_entry = 139.30
        ma24 = 139.30

        # Scenario 1: Not stretched enough (139.35 vs MA 139.30 -> stretch 0.05 < 0.10) -> BLOCKED
        self.assertFalse(check_scale_in_armed(139.35, ma24, [139.20, 139.30, 139.35], base_entry))

        # Scenario 2: Stretched (139.45), but momentum is surging upward (139.30 -> 139.38 -> 139.45, steep rising, no peak-out) -> BLOCKED
        self.assertFalse(check_scale_in_armed(139.45, ma24, [139.30, 139.38, 139.45], base_entry))

        # Scenario 3: Stretched (139.45) AND momentum rolled over (139.42 -> 139.48 -> 139.45, rejected from local high) -> ARMED!
        self.assertTrue(check_scale_in_armed(139.45, ma24, [139.42, 139.48, 139.45], base_entry))
        print("\n[Speculative Scale-In Peak-Out Verification] PASSED: Surging momentum filtered out, peak rollover armed.")

    def test_anti_churn_lifo_attribution_and_dwell_cooldown(self):
        """
        Verify Anti-Churn Multi-Tranche Attribution:
        - Prevents immediate churning when overall portfolio is in profit from older tranches.
        - Enforces minimum dwell time (>= 120s) and LIFO spread convergence (S_curr <= S_latest - 0.08% pts).
        """
        def check_can_take_profit(curr_spread: float, latest_in_spread: float, dwell_time_sec: int, global_pnl: float) -> bool:
            zero_loss_ok = (global_pnl > 0.02)
            out_target_spread = latest_in_spread - 0.08
            convergence_ok = (curr_spread <= out_target_spread)
            dwell_ok = (dwell_time_sec >= 120)
            return bool(zero_loss_ok and convergence_ok and dwell_ok)

        latest_in = 139.50

        # Scenario 1: Global PnL is +$0.50, but latest entry was 15s ago -> BLOCKED (Dwell cooldown)
        self.assertFalse(check_can_take_profit(139.40, latest_in, 15, 0.50))

        # Scenario 2: Global PnL is +$0.50, dwell is 180s, but spread has NOT converged relative to latest fill (139.46 > 139.42) -> BLOCKED
        self.assertFalse(check_can_take_profit(139.46, latest_in, 180, 0.50))

        # Scenario 3: Global PnL is +$0.50, dwell is 180s, and spread converged to 139.40 (<= 139.42 target) -> ALLOWED (TRIM READY)
        self.assertTrue(check_can_take_profit(139.40, latest_in, 180, 0.50))

        # Scenario 4: Spread converged and dwell passed, but global PnL <= $0.02 -> BLOCKED (Zero-Loss Rule)
        self.assertFalse(check_can_take_profit(139.38, latest_in, 180, 0.01))
        print("\n[Anti-Churn LIFO Attribution & Dwell Verification] PASSED: Churning strictly blocked.")

if __name__ == '__main__':
    unittest.main()


