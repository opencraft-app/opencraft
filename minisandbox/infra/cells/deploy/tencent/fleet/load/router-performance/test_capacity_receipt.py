import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).parent
CHECKS = (
    "loadReceiptPassed", "exactObjectCleanupPassed", "initialLowCapacity",
    "tenThousandActiveSustained", "automaticScaleUpObserved", "activeCapacityReady",
    "safeDrainObserved", "finalLowCapacity",
)


def capacity():
    return {
        "schema": "actor-ten-thousand-active-qualification/v1", "verdict": "passed",
        "expected": {"active": 10000}, "checks": dict.fromkeys(CHECKS, True),
    }


class CapacityReceiptTest(unittest.TestCase):
    def run_gate(self, value, collector=False):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            receipt = root / "capacity.json"
            receipt.write_text(json.dumps(value))
            if collector:
                # An invalid load exposes whether capacity validation was bypassed.
                load = root / "load.json"
                load.write_text("{}")
                output = root / "output"
                result = subprocess.run([
                    sys.executable, str(ROOT / "capture.py"),
                    "--qualification-receipt", str(receipt), "--load-receipt", str(load),
                    "--output-directory", str(output), "--prometheus-url", "http://127.0.0.1:1",
                ], capture_output=True, text=True, timeout=5)
                self.assertFalse(output.exists())
                return result
            script = (ROOT / "run-on-builder.sh").read_text().split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
            return subprocess.run([
                sys.executable, "-", str(ROOT / "capture.py"), str(receipt),
            ], input=script, capture_output=True, text=True, timeout=5)

    def assert_rejected(self, value):
        for collector in (False, True):
            with self.subTest(collector=collector):
                result = self.run_gate(value, collector)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("qualification receipt", result.stderr)

    def test_empty_partial_and_non_map_checks_are_rejected(self):
        for checks in ({}, {"finalLowCapacity": True}, None, [], "passed"):
            with self.subTest(checks=checks):
                value = capacity()
                value["checks"] = checks
                self.assert_rejected(value)
        for missing in CHECKS:
            value = capacity()
            value["checks"].pop(missing)
            self.assert_rejected(value)

    def test_every_check_requires_a_literal_true(self):
        for result in (False, "false", "true", 1, None, {}, [True]):
            value = capacity()
            value["checks"]["safeDrainObserved"] = result
            self.assert_rejected(value)
        value = capacity()
        value["checks"]["capacityIdentityStable"] = False
        self.assert_rejected(value)

    def test_cardinality_requires_a_real_integer(self):
        for active in (9999, True, "10000", 10000.0, float("nan"), float("inf"), None):
            value = capacity()
            value["expected"]["active"] = active
            self.assert_rejected(value)
        for expected in (None, [], "10000"):
            value = capacity()
            value["expected"] = expected
            self.assert_rejected(value)

    def test_complete_checks_and_additional_true_checks_pass(self):
        for additional in ({}, {"capacityTraceValid": True, "capacityIdentityStable": True}):
            value = capacity()
            value["checks"].update(additional)
            result = self.run_gate(value)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_schema_verdict_and_root_shape_are_exact(self):
        for value in (None, [], "passed"):
            self.assert_rejected(value)
        for key, wrong in (("schema", "different/v1"), ("verdict", "failed")):
            value = capacity()
            value[key] = wrong
            self.assert_rejected(value)


if __name__ == "__main__":
    unittest.main()
