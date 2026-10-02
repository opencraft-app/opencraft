import importlib.util
import pathlib
import unittest


RUN = pathlib.Path(__file__).with_name("run.py")
SPEC = importlib.util.spec_from_file_location("workers_api_ha_e2e", RUN)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WorkersApiHaGateTests(unittest.TestCase):
	def test_digest_is_framed_and_stable(self):
		self.assertNotEqual(MODULE.digest("ab", "c"), MODULE.digest("a", "bc"))
		self.assertEqual(MODULE.digest("worker", "default"), MODULE.digest("worker", "default"))

	def test_gate_uses_a_dynamic_hpa_replica_baseline(self):
		source = RUN.read_text()
		self.assertIn("baseline_replicas = len(pods)", source)
		self.assertIn("len(pods) < 3", source)
		self.assertIn("[204] * baseline_replicas", source)
		self.assertNotIn("exactly three Ready Workers API Pods", source)


if __name__ == "__main__":
	unittest.main()
