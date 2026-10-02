import json
import pathlib
import unittest

import validate_profile


HERE = pathlib.Path(__file__).resolve().parent


class CapacityProfileTest(unittest.TestCase):
	def test_candidate_has_headroom_for_declared_mixed_load(self):
		profile = validate_profile.load_profile(HERE / "production-agent-v1.json")
		envelope = validate_profile.validate(profile)
		self.assertEqual(envelope["aggregate_two_cell_arrival_rate"], 200)
		self.assertEqual(envelope["aggregate_two_cell_agents"], 2000)
		self.assertLessEqual(envelope["resident_demand"], envelope["resident_usable"])
		self.assertLessEqual(envelope["in_flight_demand"], envelope["in_flight_usable"])

	def test_qualified_requires_all_three_receipts(self):
		profile = json.loads((HERE / "production-agent-v1.json").read_text())
		profile["status"] = "qualified"
		with self.assertRaises(AssertionError):
			validate_profile.validate(profile)


if __name__ == "__main__":
	unittest.main()
