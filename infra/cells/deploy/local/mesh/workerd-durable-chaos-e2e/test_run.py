#!/usr/bin/env python3

import pathlib
import unittest


class DurableChaosRunnerTest(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		cls.source = (pathlib.Path(__file__).parent / "run.py").read_text()

	def test_fault_matrix_is_not_silently_reduced(self):
		for required in (
			"sleep_wake",
			"restart_host",
			"engine_restart",
			"registry_restart_fdb_client_reconnect",
			"workers_api_three_replica_restart",
			"node_drain",
			"interrupted_retry",
		):
			self.assertIn(required, self.source)

	def test_ambiguous_retry_uses_one_stable_key(self):
		self.assertIn('token = f"{self.run_id}:ambiguous-response"', self.source)
		self.assertIn('self.fetch("/slow-increment"', self.source)
		self.assertIn('self.fetch("/increment", method="POST", token=token)', self.source)
		self.assertIn('last.get("replayed") is not True', self.source)

	def test_actor_identity_and_serialization_are_asserted(self):
		self.assertIn("len(records) != 1", self.source)
		self.assertIn("actor_id != self.actor_id", self.source)
		self.assertIn("concurrent_serialization", self.source)


if __name__ == "__main__":
	unittest.main()
