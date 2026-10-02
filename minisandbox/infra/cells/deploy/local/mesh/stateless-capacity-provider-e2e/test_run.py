#!/usr/bin/env python3

import pathlib
import unittest


HERE = pathlib.Path(__file__).resolve().parent


class HarnessContractTest(unittest.TestCase):
	def test_full_load_driven_chain_is_present(self):
		source = (HERE / "run.py").read_text()
		for operation in (
			"self.install_adapter()",
			"self.install_hpa()",
			"self.install_provider()",
			"self.wait_deployment_replicas(2)",
			'self.wait_request_phase("Ready")',
			"self.assert_request_immutable(ready_request)",
			"self.restart_provider()",
			"self.wait_deployment_replicas(1)",
			'self.wait_request_phase("Deleted"',
		):
			self.assertIn(operation, source)

	def test_crd_identity_is_immutable_and_status_backed(self):
		crd = (HERE / "crd.yaml").read_text()
		self.assertIn("StatelessCapacityRequest", crd)
		self.assertIn("status: {}", crd)
		self.assertIn("self == oldSelf", crd)
		self.assertIn("runtimeImageID", crd)
		self.assertIn("podRef", crd)
		self.assertIn("workloadRef", crd)

	def test_adapter_uses_stateless_metric_only(self):
		values = (HERE / "adapter-values.yaml").read_text()
		self.assertIn("rivet_stateless_in_flight_total", values)
		self.assertNotIn("rivet_workerd_active_actors", values)


if __name__ == "__main__":
	unittest.main()
