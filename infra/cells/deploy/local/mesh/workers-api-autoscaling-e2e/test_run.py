import importlib.util
import pathlib
import unittest


RUN = pathlib.Path(__file__).with_name("run.py")
SPEC = importlib.util.spec_from_file_location("workers_api_autoscaling_e2e", RUN)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AutoscalingGateTests(unittest.TestCase):
	def test_quantity_parses_kubernetes_decimal_quantities(self):
		self.assertEqual(MODULE.quantity("3"), 3)
		self.assertEqual(MODULE.quantity("250m"), 0.25)

	def test_gate_does_not_scale_the_deployment_directly(self):
		source = RUN.read_text()
		self.assertIn('"patch", "horizontalpodautoscaler"', source)
		self.assertNotIn('"scale", "deployment"', source)
		self.assertIn("self.wait_scale_up()", source)
		self.assertIn("self.wait_state(3)", source)


if __name__ == "__main__":
	unittest.main()
