#!/usr/bin/env python3

import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("run.py")
SPEC = importlib.util.spec_from_file_location("workerd_capacity_e2e", MODULE_PATH)
capacity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capacity)


class CapacityContractTests(unittest.TestCase):
	def test_exact_owners_rejects_duplicates(self):
		with self.assertRaisesRegex(RuntimeError, "invalid registry owners"):
			capacity.validate_exact_owners(
				{"actor-a": ["host-0", "host-1"]}, ["actor-a"], ["host-0", "host-1"]
			)

	def test_packing_trajectory_accepts_a_valid_binpack_path(self):
		trajectory = [
			{"counts": {"host-0": 1, "host-1": 0}},
			{"counts": {"host-0": 2, "host-1": 0}},
			{"counts": {"host-0": 2, "host-1": 1}},
			{"counts": {"host-0": 2, "host-1": 2}},
		]
		self.assertEqual(
			capacity.validate_packing_trajectory(trajectory, ["host-0", "host-1"], 2),
			("host-0", "host-1"),
		)

	def test_packing_trajectory_accepts_stochastic_ring_dedupe(self):
		trajectory = [
			{"counts": {"host-0": 1, "host-1": 0}},
			{"counts": {"host-0": 1, "host-1": 1}},
			{"counts": {"host-0": 2, "host-1": 1}},
			{"counts": {"host-0": 2, "host-1": 2}},
		]
		self.assertEqual(
			capacity.validate_packing_trajectory(trajectory, ["host-0", "host-1"], 2),
			("host-0", "host-1"),
		)

	def test_host_capacity_rejects_oversubscription(self):
		with self.assertRaisesRegex(RuntimeError, "exceeded capacity"):
			capacity.validate_host_capacity(
				{"host-0": {"host_max_active_actors": 4, "host_active_actors": 5}}, 4
			)

	def test_actor_error_accepts_wire_enum_shapes(self):
		self.assertEqual(capacity.actor_error_name("no_envoys"), "no_envoys")
		self.assertEqual(capacity.actor_error_name({"no_envoys": {}}), "no_envoys")


if __name__ == "__main__":
	unittest.main()
