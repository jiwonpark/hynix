import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

class TestTerminalSync(unittest.TestCase):
    def test_index_html_bot_sync_logic(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        
        # Must have setDaemonAutoTranche
        self.assertIn("async setDaemonAutoTranche(enabled)", html)
        self.assertIn("toggle_auto_tranche?enabled=${enabled}", html)
        
        # Must have applyModeUI
        self.assertIn("applyModeUI(mode)", html)
        self.assertIn('$("chkAutoPeriodic48h").checked = (mode === "live")', html)
        
        # setMode must call setDaemonAutoTranche
        self.assertIn("await this.setDaemonAutoTranche(wantDaemonEnabled)", html)
        self.assertIn("const currentDaemonEnabled = Boolean(this.state.daemonAutoEnabled)", html)
        self.assertIn("this.state.daemonAutoEnabled = isDaemonOn", html)
        self.assertNotIn('const currentDaemonEnabled = Boolean($("chkAutoPeriodic48h")?.checked)', html)
        
        # Lock manager modal must open on attempt to toggle while locked
        self.assertIn("terminalLockManager.openPasswordModal()", html)
        
        # chkAutoPeriodic48h must delegate to setMode
        self.assertIn('const targetMode = isChecked ? "live" : "paper"', html)
        self.assertIn('await this.setMode(targetMode)', html)
        
        # fetchHedgedStatus must reconcile authoritative mode and display paused status
        self.assertIn("○ EC2 DAEMON PAUSED", html)
        self.assertIn("const authoritativeMode = isDaemonOn ? \"live\" : (this.state.mode === \"live\" ? \"paper\" : this.state.mode)", html)
        self.assertIn("this.applyModeUI(authoritativeMode)", html)

        # Prominent Master Auto-Trading Banner & Nav Pill
        self.assertIn('id="autoTradeMasterBanner"', html)
        self.assertIn('class="autoTradeToggleSwitch', html)
        self.assertIn('id="navLighterLivePill"', html)
        self.assertIn('navPill.className = "navLivePill active"', html)
        self.assertIn('navPill.textContent = "● EC2 AUTO ON"', html)

    def test_lighter_tab_lock_guard(self):
        script = (ROOT / "lighter-tab.js").read_text(encoding="utf-8")
        
        # toggleLiveBot must check terminal lock and trigger password modal
        self.assertIn("window.terminalLockManager?.openPasswordModal?.()", script)
        self.assertIn("if (window.terminalLockManager?.isLocked)", script)

        # Tab 3 Lighter must update navLighterLivePill and autoTradeMasterBanner
        self.assertIn('navLighterPill.className = "navLivePill active"', script)
        self.assertIn('navLighterPill.textContent = "● GRID AUTO ON"', script)
        self.assertIn('const banner = lid("autoTradeMasterBanner")', script)

if __name__ == "__main__":
    unittest.main()
