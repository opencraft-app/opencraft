"""Offline verifier policy; no Kubernetes, registry or credential access."""

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import verify_receipt as verifier


ROOT = Path(__file__).parent


def intent():
    return {"schema": "minisandbox-tke-eviction-api-intent/v1",
            "clusterNamespaceUid": "reviewed-cluster", "nodeUid": "reviewed-node",
            "serverVersion": "v1.30.0-tke.22", "fixtureImage": "reviewed-image",
            "adapterHashes": {name: "a" * 64 for name in
                              ("controller.go", "topology_adapter.go", "topology_capacity.go")}}


def receipt():
    value = {"schema": "minisandbox-host-eviction-api/v1", "verdict": "passed",
             "scope": verifier.SCOPE, "claimEligible": False,
             "intraServerConditionDeleteWindowObserved": False,
             "checks": dict.fromkeys(verifier.CHECKS, True), "intentSha256": "reviewed-hash",
             "clusterNamespaceUid": "reviewed-cluster", "controlNodeUid": "reviewed-node",
             "serverVersion": "v1.30.0-tke.22", "image": "reviewed-image",
             "adapterHashes": intent()["adapterHashes"]}
    for field in ("namespace", "namespaceUid", "workloadUid", "webhookUid", "originalPodUid",
                  "originalRv", "cancellationRv", "conditionRv", "afterConditionCancellationRv",
                  "replacementPodUid"):
        value[field] = "fixture-" + field
    return value


class ReceiptTests(unittest.TestCase):
    def rejects(self, value):
        with self.assertRaises(ValueError):
            verifier.validate(value, intent(), "reviewed-hash")

    def test_complete_primitive_evidence(self):
        verifier.validate(receipt(), intent(), "reviewed-hash")

    def test_skipped_empty_failed_or_local_receipts_are_rejected(self):
        for key, wrong in (("verdict", "failed"), ("scope", "local-real-api-primitives"),
                           ("scope", "production-qualification"), ("schema", "unknown"),
                           ("claimEligible", True), ("claimEligible", 0),
                           ("intraServerConditionDeleteWindowObserved", None)):
            with self.subTest(key=key, wrong=wrong):
                value = receipt()
                value[key] = wrong
                self.rejects(value)
        self.rejects({})

    def test_each_check_requires_literal_true_and_all_are_required(self):
        for name in verifier.CHECKS:
            for wrong in (False, 1, "true", None):
                value = receipt()
                value["checks"][name] = wrong
                self.rejects(value)
            value = receipt()
            value["checks"].pop(name)
            self.rejects(value)
        value = receipt()
        value["checks"]["unexpected_failed_check"] = False
        self.rejects(value)

    def test_identity_binding_and_actual_transitions_required(self):
        for name in ("intentSha256", "clusterNamespaceUid", "controlNodeUid", "serverVersion", "image", "adapterHashes"):
            value = receipt()
            value[name] = "different"
            self.rejects(value)
        for name in ("namespaceUid", "webhookUid", "replacementPodUid", "cancellationRv"):
            value = receipt()
            value.pop(name)
            self.rejects(value)
        for original, successor in (("originalPodUid", "replacementPodUid"),
                                    ("originalRv", "cancellationRv"),
                                    ("conditionRv", "afterConditionCancellationRv")):
            value = receipt()
            value[successor] = value[original]
            self.rejects(value)

    def test_cli_requires_the_exact_document_hash_and_regular_files(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            base = Path(temporary)
            expected = base / "intent.json"
            expected.write_text(json.dumps(intent()))
            value = receipt()
            value["intentSha256"] = hashlib.sha256(expected.read_bytes()).hexdigest()
            actual = base / "receipt.json"
            actual.write_text(json.dumps(value))
            args = ["python3", str(ROOT / "verify_receipt.py"), "--intent", str(expected), "--receipt", str(actual)]
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("claim_eligible=false", result.stdout)
            expected.write_text(json.dumps(intent(), indent=2))
            self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
            expected.write_text(json.dumps(intent()))
            actual.write_text(json.dumps(value)[:-1] + ',"verdict":"passed"}')
            self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
            actual.unlink()
            actual.symlink_to(expected)
            self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
