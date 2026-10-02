#!/usr/bin/env python3

import importlib.util
import pathlib
import unittest


MODULE = pathlib.Path(__file__).with_name("run.py")
SPEC = importlib.util.spec_from_file_location("workerd_host_drain_failure_e2e", MODULE)
failure = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(failure)


class FailureHarnessContractTest(unittest.TestCase):
	def test_runner_config_round_trip_strips_read_only_protocol_version(self):
		body = failure.runner_config_body(
			{
				"runner_configs": {
					"workerd": {
						"datacenters": {
							"local-runtime-a": {
								"normal": {"actor_eviction_delay": 0},
								"protocol_version": 6,
							}
						}
					}
				}
			}
		)
		self.assertEqual(
			body,
			{"datacenters": {"local-runtime-a": {"normal": {"actor_eviction_delay": 0}}}},
		)

	def test_eviction_delay_changes_only_selected_datacenter(self):
		body = {
			"datacenters": {
				"local-runtime-a": {"normal": {"actor_eviction_delay": 0}},
				"local-runtime-b": {"normal": {"actor_eviction_delay": 0}},
			}
		}
		updated = failure.with_eviction_delay(body, "local-runtime-a", 5)
		self.assertEqual(updated["datacenters"]["local-runtime-a"]["normal"]["actor_eviction_delay"], 5)
		self.assertEqual(updated["datacenters"]["local-runtime-b"]["normal"]["actor_eviction_delay"], 0)
		self.assertEqual(body["datacenters"]["local-runtime-a"]["normal"]["actor_eviction_delay"], 0)

	def test_all_six_failure_gates_are_present(self):
		source = MODULE.read_text()
		for scenario in (
			"scenario_demand_burst",
			"scenario_controller_restarts",
			"scenario_management_unavailable",
			"scenario_uid_replacement",
			"scenario_scale_up_race",
			"scenario_timeout",
		):
			self.assertIn(f"self.{scenario}()", source)


if __name__ == "__main__":
	unittest.main()
