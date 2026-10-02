#!/usr/bin/env python3

import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("run.py")
SPEC = importlib.util.spec_from_file_location("workerd_autoscaling_e2e", MODULE_PATH)
autoscaling = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(autoscaling)


class AutoscalingContractTests(unittest.TestCase):
	def test_desired_replicas_retains_headroom(self):
		self.assertEqual(autoscaling.desired_replicas(0, 3, 1, 10), 1)
		self.assertEqual(autoscaling.desired_replicas(3, 3, 1, 10), 1)
		self.assertEqual(autoscaling.desired_replicas(4, 3, 1, 10), 2)
		self.assertEqual(autoscaling.desired_replicas(31, 3, 1, 10), 10)

	def test_unschedulable_requires_scheduler_condition(self):
		pod = {
			"status": {
				"conditions": [
					{"type": "PodScheduled", "status": "False", "reason": "Unschedulable"}
				]
			}
		}
		self.assertTrue(autoscaling.condition_is_unschedulable(pod))
		pod["status"]["conditions"][0]["reason"] = "SchedulingGated"
		self.assertFalse(autoscaling.condition_is_unschedulable(pod))

	def test_target_must_be_positive(self):
		with self.assertRaisesRegex(ValueError, "positive"):
			autoscaling.desired_replicas(1, 0, 1, 2)

	def test_hpa_is_scale_up_only(self):
		source = MODULE_PATH.read_text()
		self.assertIn('"selectPolicy": "Disabled"', source)
		self.assertNotIn('"scaleDown": {\n\t\t\t\t\t\t"stabilizationWindowSeconds"', source)


if __name__ == "__main__":
	unittest.main()
