import unittest

from backend.single_leg_direction import entry_direction_allowed, parse_entry_direction_mode


class TestSingleLegDirection(unittest.TestCase):
    def test_two_way_allows_both_entry_sides(self):
        self.assertTrue(entry_direction_allowed("two_way", 1))
        self.assertTrue(entry_direction_allowed("two_way", -1))

    def test_long_and_short_only_are_directional(self):
        self.assertTrue(entry_direction_allowed("long_only", 1))
        self.assertFalse(entry_direction_allowed("long_only", -1))
        self.assertFalse(entry_direction_allowed("short_only", 1))
        self.assertTrue(entry_direction_allowed("short_only", -1))

    def test_spread_vocabulary_is_rejected_for_single_leg_bots(self):
        with self.assertRaisesRegex(ValueError, "entry_direction_mode must be one of"):
            parse_entry_direction_mode("short_spread_only")


if __name__ == "__main__":
    unittest.main()
