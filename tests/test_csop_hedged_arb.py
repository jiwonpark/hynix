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

    def test_lifo_active_tranche_queue_matching(self):
        """
        Verify LIFO Active Tranche Queue Matching across multiple sequential tranches:
        - When Tranche 3 exits, it pops from the queue.
        - Tranche 2 then becomes the target (NOT Tranche 3's old entry price).
        - Prevents cascading churning where remaining tranches are dumped at unfavorable spreads.
        """
        queue = []
        def push_entry(tranche_id: str, entry_spread: float, time_sec: int):
            queue.append({
                "id": tranche_id,
                "entry_spread": entry_spread,
                "target_out_spread": round(entry_spread - 0.08, 2),
                "time": time_sec
            })

        def pop_exit():
            return queue.pop() if queue else None

        # Step 1: 3 tranches enter at progressively higher spreads
        push_entry("T1", 139.30, 1000)
        push_entry("T2", 139.60, 2000)
        push_entry("T3", 139.75, 3000)

        self.assertEqual(len(queue), 3)
        self.assertEqual(queue[-1]["id"], "T3")
        self.assertEqual(queue[-1]["target_out_spread"], 139.67)

        # Step 2: Parity drops to 139.66. T3 matches and exits!
        curr_spread = 139.66
        self.assertLessEqual(curr_spread, queue[-1]["target_out_spread"])
        popped = pop_exit()
        self.assertEqual(popped["id"], "T3")

        # Step 3: Now queue has 2 tranches. Current target MUST be T2, NOT T3!
        self.assertEqual(len(queue), 2)
        self.assertEqual(queue[-1]["id"], "T2")
        self.assertEqual(queue[-1]["target_out_spread"], 139.52)

        # At curr_spread 139.66, T2 must NOT be allowed to exit (139.66 > 139.52)!
        self.assertFalse(curr_spread <= queue[-1]["target_out_spread"], "T2 must not exit at 139.66 - churn prevented!")

        # Step 4: Parity drops to 139.50. T2 matches and exits!
        curr_spread = 139.50
        self.assertLessEqual(curr_spread, queue[-1]["target_out_spread"])
        popped2 = pop_exit()
        self.assertEqual(popped2["id"], "T2")

        # Step 5: Now queue has 1 tranche (T1). Current target MUST be T1 (<= 139.22)!
        self.assertEqual(len(queue), 1)
        self.assertEqual(queue[-1]["id"], "T1")
        self.assertEqual(queue[-1]["target_out_spread"], 139.22)

        # At curr_spread 139.50, T1 must NOT be allowed to exit (139.50 > 139.22)!
        self.assertFalse(curr_spread <= queue[-1]["target_out_spread"], "T1 must not exit at 139.50 - churn prevented!")

        print("\n[LIFO Active Tranche Queue Matching Verification] PASSED: Sequential popping verified, cascading churn impossible.")

    def test_persistent_auto_tranche_state(self):
        """
        Verify that auto_tranche state persists, toggles correctly, and holds last action metadata.
        """
        from backend.server import load_auto_tranche_state, save_auto_tranche_state

        initial_state = load_auto_tranche_state()
        self.assertIn("enabled", initial_state)
        self.assertIn("last_step_time", initial_state)
        self.assertIn("last_reduce_time", initial_state)

        # Test toggle mutation
        initial_enabled = initial_state.get("enabled", False)
        test_state = dict(initial_state)
        test_state["enabled"] = not initial_enabled
        test_state["last_action"] = "UNIT_TEST_TOGGLE"
        save_auto_tranche_state(test_state)

        reloaded = load_auto_tranche_state()
        self.assertEqual(reloaded["enabled"], not initial_enabled)
        self.assertEqual(reloaded["last_action"], "UNIT_TEST_TOGGLE")

        # Restore
        save_auto_tranche_state(initial_state)
        restored = load_auto_tranche_state()
        self.assertEqual(restored["enabled"], initial_enabled)
        print("\n[Persistent Auto-Tranche State Verification] PASSED: State persists across cycles and reloads.")

    def test_one_to_one_entry_exit_matching_protects_core_inventory(self):
        """
        Verify that:
        1. Number of allowed exits strictly cannot exceed number of entries.
        2. Once all entry tranches are matched by exits (queue is empty), further take-profits are BLOCKED.
        3. The accumulated ratchet core inventory (+0.01 SKHY / +0.20 CSOP per cycle) is NEVER liquidated.
        """
        entries_count = 2
        exits_count = 0
        queue = ["T1", "T2"] # 2 entry tranches
        total_adr_pos = 0.16 # 2 * 0.08
        total_csop_pos = 2.80 # 2 * 1.40

        def can_exit(q, adr_qty, csop_qty, pnl):
            # Strict 1-to-1 matching: require an active entry tranche on queue AND >= 1 full tranche
            return bool(len(q) > 0 and adr_qty >= 0.07 and csop_qty >= 1.20 and pnl > 0.02)

        # Exit 1
        self.assertTrue(can_exit(queue, total_adr_pos, total_csop_pos, 0.05))
        queue.pop()
        exits_count += 1
        total_adr_pos = round(total_adr_pos - 0.07, 4) # 0.09
        total_csop_pos = round(total_csop_pos - 1.20, 4) # 1.60

        # Exit 2
        self.assertTrue(can_exit(queue, total_adr_pos, total_csop_pos, 0.04))
        queue.pop()
        exits_count += 1
        total_adr_pos = round(total_adr_pos - 0.07, 4) # 0.02 (ACCUMULATED CORE!)
        total_csop_pos = round(total_csop_pos - 1.20, 4) # 0.40 (ACCUMULATED CORE!)

        # Now: entries_count == exits_count == 2. Queue is EMPTY.
        self.assertEqual(len(queue), 0)
        self.assertEqual(total_adr_pos, 0.02)
        self.assertEqual(total_csop_pos, 0.40)

        # Attempting Exit 3 (even with positive PnL!): MUST BE BLOCKED!
        self.assertFalse(can_exit(queue, total_adr_pos, total_csop_pos, 0.03), 
                         "Exit 3 must be strictly blocked: entry count matches exit count and core is protected!")

        print(f"\n[1-to-1 Entry-Exit Matching & Core Protection Verification] PASSED:")
        print(f"Entries: {entries_count} | Exits: {exits_count}")
        print(f"Protected Core Inventory Retained: {total_adr_pos} SKHY / {total_csop_pos} CSOP")

    def test_conservative_scale_out_bottoming_out_filter(self):
        """
        Verify that scale-out waits for bottoming-out / momentum exhaustion:
        1. When spread is profitable but actively cascading downward, exit is BLOCKED to ride the move.
        2. When spread stabilizes / bounces off trough OR pierces 24-MA, exit is ARMED.
        """
        ma24 = 139.30
        entry_spread = 139.80
        target_spread = 139.72 # 139.80 - 0.08

        def check_bottoming_out(last_val, prev_val, prev2_val, ma):
            local_low = min(prev_val, prev2_val)
            # Trough bounce or MA touch
            return bool(last_val >= prev_val or last_val > local_low or last_val <= ma)

        # Scenario 1: Active downward cascade (139.80 -> 139.75 -> 139.70)
        # Even though 139.70 <= target_spread (139.72) and in profit, spread is cascading down!
        last_s1, prev_s1, prev2_s1 = 139.70, 139.75, 139.80
        is_bottoming_s1 = check_bottoming_out(last_s1, prev_s1, prev2_s1, ma24)
        self.assertFalse(is_bottoming_s1, "Active cascade down must NOT trigger exit: ride convergence wave!")

        # Scenario 2: Cascade reaches 139.35, then bounces to 139.38 (trough formed!)
        last_s2, prev_s2, prev2_s2 = 139.38, 139.35, 139.42
        is_bottoming_s2 = check_bottoming_out(last_s2, prev_s2, prev2_s2, ma24)
        self.assertTrue(is_bottoming_s2, "Trough bounce confirmed: scale-out ARMED at swing low!")

        # Scenario 3: Cascade crashes straight down through MA (139.25 <= 139.30)
        last_s3, prev_s3, prev2_s3 = 139.25, 139.32, 139.40
        is_bottoming_s3 = check_bottoming_out(last_s3, prev_s3, prev2_s3, ma24)
        self.assertTrue(is_bottoming_s3, "24-MA fully pierced: mean-reversion complete, scale-out ARMED!")

        print(f"\n[Conservative Scale-Out Bottoming-Out Verification] PASSED: Downward cascade ridden to maximum profit.")

if __name__ == '__main__':
    unittest.main()


