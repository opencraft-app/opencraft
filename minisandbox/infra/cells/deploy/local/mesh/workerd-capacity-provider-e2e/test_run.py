#!/usr/bin/env python3

import pathlib
import unittest


HERE = pathlib.Path(__file__).resolve().parent


class HarnessContractTest(unittest.TestCase):
	def test_full_chain_is_present(self):
		source = (HERE / "run.py").read_text()
		for operation in (
			"self.install_hpa()",
			"self.install_provider()",
			'self.wait_request_phase("Ready")',
			"self.assert_request_identity_immutable(ready_request)",
			"self.restart_provider()",
			"self.install_controller()",
			"self.wait_serial_scale_down(target)",
			'self.wait_request_phase("Deleted")',
			'"repeat_scale_up"',
		):
			self.assertIn(operation, source)

	def test_crd_is_test_scoped_and_status_backed(self):
		crd = (HERE / "crd.yaml").read_text()
		self.assertIn("local.fleet.actor.dev", crd)
		self.assertIn("status: {}", crd)
		self.assertIn("podRef", crd)
		self.assertIn("workloadRef", crd)
		self.assertIn("self == oldSelf", crd)


if __name__ == "__main__":
	unittest.main()
