import importlib.util
import json
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("user-transparent-upgrade.py")
SPEC = importlib.util.spec_from_file_location("user_transparent_upgrade_summary", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProbeReceiptSummaryTests(unittest.TestCase):
    def test_large_success_stream_has_bounded_receipt_and_exact_coverage(self):
        object_ids = ["{:064x}".format(index) for index in range(32)]
        campaign = MODULE.ProbeCampaign("http://invalid", "worker", object_ids, 20, 0.5, 3)
        for index in range(20000):
            campaign.samples.append({
                "at": "2026-09-08T00:00:{:02d}Z".format(index % 60),
                "object_id": object_ids[index % len(object_ids)],
                "status": 200,
                "seconds": 0.01 + (index % 100) / 10000.0,
                "value": 1,
                "request_id": "request-{:08d}".format(index),
            })
        summary = campaign.receipt_summary()
        encoded = json.dumps(summary, sort_keys=True).encode()
        self.assertLess(len(encoded), 100000)
        self.assertEqual(summary["count"], 20000)
        self.assertEqual(summary["successful_count"], 20000)
        self.assertEqual({item["object_id"] for item in summary["per_object"]}, set(object_ids))
        self.assertEqual(sum(item["count"] for item in summary["per_object"]), 20000)
        self.assertEqual(len(summary["stream_sha256"]), 64)
        self.assertLessEqual(len(summary["diagnostic_samples"]), 32)

    def test_failure_diagnostics_are_bounded_without_losing_failure_count(self):
        object_id = "a" * 64
        campaign = MODULE.ProbeCampaign("http://invalid", "worker", [object_id], 20, 0.5, 3)
        for index in range(100):
            sample = {"object_id": object_id, "seconds": 3.1, "error": "slow-{}".format(index)}
            campaign.samples.append(sample)
            campaign.failures.append(dict(sample))
        summary = campaign.receipt_summary()
        self.assertEqual(summary["failure_count"], 100)
        self.assertEqual(len(summary["failures"]), 64)
        self.assertEqual(summary["failures_truncated"], 36)


if __name__ == "__main__":
    unittest.main()
