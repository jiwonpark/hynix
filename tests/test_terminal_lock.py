import os
import re
import unittest

class TestTerminalLock(unittest.TestCase):
    def setUp(self):
        self.html_path = os.path.join(os.path.dirname(__file__), "..", "index.html")
        self.assertTrue(os.path.exists(self.html_path), f"index.html not found at {self.html_path}")
        with open(self.html_path, "r", encoding="utf-8") as f:
            self.html = f.read()

    def test_dom_elements_present(self):
        """Verify all required DOM elements exist for slide switch, banner, and password modal."""
        # Top slide switch in header
        self.assertIn('id="terminalLockToggleWrap"', self.html)
        self.assertIn('id="terminalLockSwitch"', self.html)
        self.assertIn('id="topLockIcon"', self.html)
        self.assertIn('id="topLockLabel"', self.html)

        # Tab 2 container and read-only banner
        self.assertIn('id="tabContentTrading" class="terminal-read-only"', self.html)
        self.assertIn('id="terminalLockBanner"', self.html)
        self.assertIn('id="lblTerminalLockBannerText"', self.html)
        self.assertIn('id="btnBannerUnlockPrompt"', self.html)

        # Password modal
        self.assertIn('id="terminalPasswordModal"', self.html)
        self.assertIn('id="lblPassModalTitle"', self.html)
        self.assertIn('id="terminalPasswordInput"', self.html)
        self.assertIn('id="terminalPasswordError"', self.html)
        self.assertIn('id="btnCancelUnlock"', self.html)
        self.assertIn('id="btnConfirmUnlock"', self.html)

    def test_password_is_fidelio0(self):
        """Verify the password required is strictly fidelio0!."""
        self.assertIn('correctPassword: "fidelio0!"', self.html)

    def test_terminal_action_controls_decorated(self):
        """Verify mutating controls in Tab 2 are marked with terminal-action-control."""
        expected_controls = [
            'class="tradingModeSwitch terminal-action-control"',
            'id="btnKillSwitch" class="btnTopAction killSwitch terminal-action-control"',
            'id="btnResetPaperBalance" class="terminal-action-control"',
            'id="btnSyncFromBacktest" class="terminal-action-control"',
            'id="btnStepTranche" class="terminal-action-control"',
            'id="btnReduceTranche" class="terminal-action-control"',
            'id="btnEmergencyFlatten" class="terminal-action-control"',
            'id="btnApproveSignal" class="terminal-action-control"',
            'id="btnDismissSignal" class="terminal-action-control"',
            'class="pairOrderTicket terminal-action-control"',
            'id="btnRerunDynamicBacktest" class="terminal-action-control"',
            'id="entryConditionsChecklist"',
            'id="exitConditionsChecklist"',
        ]
        for ctrl in expected_controls:
            self.assertIn(ctrl, self.html)

    def test_i18n_translations(self):
        """Verify bilingual translations for lock badge, modal, and banner."""
        # English translations
        self.assertIn('topLockReadOnly: "Read-Only"', self.html)
        self.assertIn('topLockUnlocked: "Unlocked"', self.html)
        self.assertIn('passModalTitle: "🔒 Unlock Execution Terminal"', self.html)

        # Korean translations
        self.assertIn('topLockReadOnly: "읽기 전용"', self.html)
        self.assertIn('topLockUnlocked: "잠금 해제"', self.html)
        self.assertIn('passModalTitle: "🔒 거래 터미널 잠금 해제"', self.html)

    def test_terminal_lock_manager_structure(self):
        """Verify terminalLockManager object definition and guards in mutating methods."""
        # Manager object
        self.assertIn('const terminalLockManager = {', self.html)
        self.assertIn('isLocked: true', self.html)
        self.assertIn('verifyPassword() {', self.html)
        self.assertIn('setLocked(locked) {', self.html)
        self.assertIn('applyState() {', self.html)

        # Guard checks in mutating actions
        self.assertIn('terminalLockManager.isLocked', self.html)
        self.assertIn('terminalLockManager.init();', self.html)

    def test_read_only_mode_preserves_hover_events_for_tooltips(self):
        """Read-only disables form controls without suppressing label hover events."""
        action_rule = re.search(
            r'\.terminal-read-only \.terminal-action-control \{([^}]*)\}',
            self.html,
            re.S,
        )
        descendant_rule = re.search(
            r'\.terminal-read-only \.terminal-action-control \* \{([^}]*)\}',
            self.html,
            re.S,
        )
        self.assertIsNotNone(action_rule)
        self.assertIsNotNone(descendant_rule)
        self.assertNotIn('pointer-events: none', action_rule.group(1))
        self.assertNotIn('pointer-events: none', descendant_rule.group(1))
        self.assertIn('el.disabled = locked;', self.html)

if __name__ == "__main__":
    unittest.main()
