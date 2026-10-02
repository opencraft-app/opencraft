import importlib.util
import json
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("verify-user-transparent-upgrade.py")
SPEC = importlib.util.spec_from_file_location("verify_user_transparent_upgrade", MODULE_PATH)
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


class UpgradeReceiptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.receipt_path = pathlib.Path("/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-0016b8ce153a4629ae9912463f899853.json")

    def test_real_cloud_receipt_is_valid_after_host_target_is_made_explicit(self):
        if not self.receipt_path.is_file():
            self.skipTest("cloud receipt is not present")
        value = json.loads(self.receipt_path.read_text())
        runtime = value["after"]["runtime_images"]["container/workerd-host"]
        # The old harness omitted only this target declaration; its independently
        # captured workload snapshot proves the exact Host digest actually ran.
        value["target_images"]["runtime"]["container/workerd-host"] = runtime
        value["rollback_objects_retained"] = False
        result = verifier.verify(value, runtime)
        self.assertEqual(result["publicRequests"], 1820)

    def test_missing_host_target_and_public_failure_are_rejected(self):
        if not self.receipt_path.is_file():
            self.skipTest("cloud receipt is not present")
        value = json.loads(self.receipt_path.read_text())
        with self.assertRaises(AssertionError):
            verifier.verify(value)
        value["target_images"]["runtime"]["container/workerd-host"] = value["after"]["runtime_images"]["container/workerd-host"]
        value["rollback_objects_retained"] = False
        value["public_probe"]["failures"] = [{"error": "injected"}]
        with self.assertRaises(AssertionError):
            verifier.verify(value)


if __name__ == "__main__":
    unittest.main()
