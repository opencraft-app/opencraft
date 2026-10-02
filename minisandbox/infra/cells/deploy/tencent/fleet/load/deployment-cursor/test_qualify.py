#!/usr/bin/env python3
import importlib.util
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("deployment_cursor_qualification", ROOT / "qualify.py")
assert spec and spec.loader
MODULE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MODULE)


class DeploymentCursorQualificationTests(unittest.TestCase):
	def test_nearest_rank_quantile_is_deterministic(self):
		values = [float(value) for value in range(1, 101)]
		self.assertEqual(MODULE.quantile(values, 0.50), 50)
		self.assertEqual(MODULE.quantile(values, 0.95), 95)
		self.assertEqual(MODULE.quantile(values, 0.99), 99)
		with self.assertRaises(ValueError):
			MODULE.quantile([], 0.99)

	def test_source_binds_the_observed_revision(self):
		value = MODULE.source("revision-a")
		self.assertIn('schema: "cursor-probe/v1"', value)
		self.assertIn('revision: "revision-a"', value)

	def test_publish_is_create_only(self):
		with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
			path = pathlib.Path(temporary) / "receipt.json"
			MODULE.publish_new(path, {"schema": MODULE.SCHEMA, "verdict": "passed"})
			with self.assertRaisesRegex(ValueError, "new absolute"):
				MODULE.publish_new(path, {"schema": MODULE.SCHEMA, "verdict": "passed"})


if __name__ == "__main__":
	unittest.main()
