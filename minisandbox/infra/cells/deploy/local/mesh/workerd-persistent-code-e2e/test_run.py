import importlib.util
import pathlib
import unittest


SPEC = importlib.util.spec_from_file_location("persistent_code_e2e", pathlib.Path(__file__).with_name("run.py"))
e2e = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(e2e)


class PersistentCodeE2ETests(unittest.TestCase):
	def test_worker_source_uses_only_public_storage_capability(self):
		self.assertIn("env.RIVET_STORAGE.sql.exec", e2e.WORKER_SOURCE)
		self.assertIn('path === "/increment"', e2e.WORKER_SOURCE)
		self.assertNotIn("env.ACTOR", e2e.WORKER_SOURCE)
		self.assertNotIn("RIVET_WORKERD_TOKEN", e2e.WORKER_SOURCE)
		self.assertEqual(e2e.COMPATIBILITY_DATE, "2026-08-14")

	def test_ready_requires_ready_true(self):
		self.assertTrue(e2e.ready({"status": {"conditions": [{"type": "Ready", "status": "True"}]}}))
		self.assertFalse(e2e.ready({"status": {"conditions": [{"type": "Ready", "status": "False"}]}}))


if __name__ == "__main__":
	unittest.main()
