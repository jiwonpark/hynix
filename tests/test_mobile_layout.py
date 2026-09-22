import pathlib
import unittest


HTML = (pathlib.Path(__file__).resolve().parents[1] / "index.html").read_text()


class MobileLayoutTests(unittest.TestCase):
    def test_phone_breakpoint_contains_page_and_sizes_navigation(self):
        self.assertIn("/* Phone layout:", HTML)
        self.assertIn("@media (max-width: 640px)", HTML)
        self.assertIn("overflow: hidden;", HTML)
        self.assertIn("flex: 0 0 150px;", HTML)
        self.assertIn("min-height: 50px;", HTML)

    def test_dense_modules_have_mobile_overflow_or_single_column_rules(self):
        self.assertIn(".deepDiveGrid,", HTML)
        self.assertIn(".mobileTableScroll", HTML)
        self.assertIn("#simulationPeriodBadge", HTML)
        self.assertIn(".newsFilterSwitch", HTML)

    def test_selected_nav_is_brought_into_view(self):
        self.assertIn('activeNav.scrollIntoView({ behavior: "smooth"', HTML)


if __name__ == "__main__":
    unittest.main()
