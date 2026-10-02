#!/usr/bin/env python3

import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BUILDER = load(
    "runtime_release_qualification_builder",
    Path(__file__).with_name("build-runtime-release-qualification.py"),
)
LEDGER_TESTS = load(
    "release_ledger_fixtures", ROOT / "operations" / "test_release_ledger.py"
)
LEDGER = load("release_ledger", ROOT / "operations" / "release_ledger.py")


class PassingUpgradeVerifier:
    @staticmethod
    def verify(document, expected_runtime):
        if document["target_images"]["runtime"]["container/workerd"] != expected_runtime:
            raise ValueError("runtime mismatch")


class PassingRollbackVerifier:
    @staticmethod
    def verify(document, failed_bytes, expected_runtime):
        if document["target_images"]["runtime"]["container/workerd"] != expected_runtime:
            raise ValueError("runtime mismatch")
        json.loads(failed_bytes)


class RuntimeReleaseQualificationTests(unittest.TestCase):
    def setUp(self):
        fixture = LEDGER_TESTS.ReleaseLedgerTests("test_matching_release_is_ready")
        fixture.setUp()
        self.ledger = fixture.ledger
        self.scope = LEDGER.release_qualification_scope(self.ledger)
        self.upgrade = {
            "schema": "actor-bj-q01-user-transparent-upgrade/v3",
            "cell": self.ledger["cell"],
            "run_id": "upgrade-run",
            "target_images": self.scope["targetImages"],
        }
        self.failed = {
            "schema": "actor-bj-q01-user-transparent-upgrade/v3",
            "cell": self.ledger["cell"],
            "run_id": "failed-run",
            "target_images": {
                **self.scope["targetImages"],
                "engine": {
                    "container/engine": "registry.invalid/runtime@sha256:" + "0" * 64
                },
            },
        }
        self.rollback = {
            "schema": "actor-bj-q01-user-transparent-rollback/v2",
            "cell": self.ledger["cell"],
            "run_id": "rollback-run",
            "finished_at": "2026-09-13T00:00:00Z",
            "target_images": self.scope["targetImages"],
        }

    def encode(self, value):
        return (json.dumps(value, sort_keys=True) + "\n").encode()

    def build(self):
        return BUILDER.build(
            self.ledger,
            self.encode(self.upgrade),
            self.encode(self.rollback),
            self.encode(self.failed),
            "canary-cell-uid",
            modules=(PassingUpgradeVerifier, PassingRollbackVerifier),
        )

    def test_certificate_binds_exact_artifact_and_three_raw_receipts(self):
        certificate = self.build()
        self.assertEqual(certificate["scope"], self.scope)
        self.assertEqual(
            certificate["evidence"]["upgrade"]["sha256"],
            hashlib.sha256(self.encode(self.upgrade)).hexdigest(),
        )
        self.assertEqual(
            certificate["evidence"]["semanticRollback"]["failedReceiptSha256"],
            hashlib.sha256(self.encode(self.failed)).hexdigest(),
        )
        self.assertEqual(
            certificate["evidenceSha256"], BUILDER.canonical_digest(certificate)
        )

    def test_upgrade_for_different_auxiliary_image_is_rejected(self):
        self.upgrade["target_images"]["nats"]["container/nats"] = (
            "registry.invalid/nats@sha256:" + "f" * 64
        )
        with self.assertRaisesRegex(ValueError, "exact Runtime artifact set"):
            self.build()

    def test_semantic_candidate_must_differ(self):
        self.failed["target_images"] = self.scope["targetImages"]
        with self.assertRaisesRegex(ValueError, "did not differ"):
            self.build()


if __name__ == "__main__":
    unittest.main()
