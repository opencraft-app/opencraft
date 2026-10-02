#!/usr/bin/env python3

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE = Path(__file__).with_name("adopt-cell.py")
SPEC = importlib.util.spec_from_file_location("adopt_cell", MODULE)
ADOPT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(ADOPT)


class AdoptCellTests(unittest.TestCase):
    def fixtures(self):
        digest = lambda value: "sha256:" + value * 64
        convergence = {
            "schema": "actor-cell-argo-convergence/v1", "verdict": "passed",
            "cell": {"id": "actor-bj-a01", "uid": "cell-uid", "profileDigest": digest("a")},
            "platformClusterUid": "cluster-uid",
            "fleetBinding": {
                "poolName": "pool", "poolUid": "pool-uid", "claimName": "claim", "claimUid": "claim-uid",
                "className": "class", "datacenterName": "default", "profileDigest": digest("a"),
            },
        }
        activation = {
            "schema": "actor-cell-qualification-activation/v1", "verdict": "passed", "cell": "actor-bj-a01",
            "finished_at": "2026-09-10T12:35:03Z", "desired_state": "Ready", "ready_for_placement": True,
            "cell_identity": {"uid": "cell-uid", "profile_digest": digest("a")},
            "control_receipt_sha256": "c" * 64,
            "qualification": {"release_digest": digest("b")},
        }
        qualification = {
            "schema": "actor-cell-qualification-chain/v1", "verdict": "passed",
            "cell": {"id": "actor-bj-a01", "spoke_uid": "cell-uid"},
            "pool": {"name": "pool", "uid": "pool-uid"},
            "construction": {"argo_convergence_receipt_digest": digest("d")},
            "qualification": {
                "release_digest": digest("b"), "control_receipt_digest": digest("c"),
            },
            "placement_opened": False, "operator_activation_required": True,
        }
        return convergence, qualification, activation

    def test_evidence_builds_an_immutable_uid_fenced_registration(self):
        convergence, qualification, activation = self.fixtures()
        identity = ADOPT.validate_evidence(
            convergence, qualification, activation,
            "sha256:" + "d" * 64, "sha256:" + "e" * 64,
        )
        registration = ADOPT.build_registration(
            identity, "credential", "credential-uid",
            "sha256:" + "d" * 64, "sha256:" + "e" * 64, "sha256:" + "f" * 64,
        )
        self.assertEqual(registration["spec"]["claimRef"], {"name": "claim", "uid": "claim-uid"})
        self.assertEqual(registration["spec"]["spokeCellRef"]["uid"], "cell-uid")
        self.assertEqual(registration["spec"]["credentialSecretRef"]["uid"], "credential-uid")
        self.assertEqual(registration["spec"]["datacenterName"], "default")
        self.assertEqual(registration["metadata"]["labels"]["fleet.actor.dev/claim-uid"], "claim-uid")
        self.assertEqual(
            registration["spec"]["evidence"]["qualificationChainReceiptDigest"],
            "sha256:" + "e" * 64,
        )

    def test_registration_identity_excludes_rotatable_release_evidence(self):
        convergence, qualification, activation = self.fixtures()
        identity = ADOPT.validate_evidence(
            convergence, qualification, activation,
            "sha256:" + "d" * 64, "sha256:" + "e" * 64,
        )
        old = ADOPT.build_registration(
            identity, "credential", "credential-uid",
            "sha256:" + "d" * 64, "sha256:" + "e" * 64, "sha256:" + "f" * 64,
        )["spec"]
        new = json.loads(json.dumps(old))
        new["evidence"]["releaseDigest"] = "sha256:" + "9" * 64
        new["registeredAt"] = "2026-09-11T00:00:00Z"
        self.assertEqual(ADOPT.registration_identity(old), ADOPT.registration_identity(new))
        new["spokeCellRef"]["uid"] = "replacement"
        self.assertNotEqual(ADOPT.registration_identity(old), ADOPT.registration_identity(new))

    def test_registration_evidence_rotation_is_uid_and_resource_version_fenced(self):
        desired = {
            "metadata": {
                "name": "actor-bj-a01", "namespace": "actor-fleet-system",
                "labels": {"fleet.actor.dev/claim-uid": "claim-uid"},
            },
            "spec": {
                "provider": "TerraformArgo", "claimRef": {"uid": "claim-uid"},
                "poolRef": {"uid": "pool-uid"}, "spokeClusterRef": {"uid": "cluster-uid"},
                "spokeCellRef": {"uid": "cell-uid"},
                "credentialSecretRef": {"uid": "credential-uid"}, "datacenterName": "default",
                "evidence": {"releaseDigest": "sha256:" + "b" * 64},
                "registeredAt": "2026-09-11T00:00:00Z",
            },
        }
        existing = json.loads(json.dumps(desired))
        existing["metadata"].update({"uid": "registration-uid", "resourceVersion": "42"})
        existing["spec"]["evidence"] = {"releaseDigest": "sha256:" + "a" * 64}
        existing["spec"]["registeredAt"] = "2026-09-10T00:00:00Z"
        rotated = json.loads(json.dumps(desired))
        rotated["metadata"].update({"uid": "registration-uid", "resourceVersion": "43"})
        with mock.patch.object(ADOPT, "create_or_get", return_value=existing), mock.patch.object(
            ADOPT, "kubectl", return_value=rotated
        ) as kubectl:
            result = ADOPT.create_or_rotate_registration(Path("/kubeconfig"), desired)
        self.assertEqual(result["spec"], desired["spec"])
        patch = json.loads(kubectl.call_args.args[-1])
        self.assertEqual(patch[0], {"op": "test", "path": "/metadata/uid", "value": "registration-uid"})
        self.assertEqual(patch[1], {"op": "test", "path": "/metadata/resourceVersion", "value": "42"})
        self.assertEqual([item["path"] for item in patch[-2:]], ["/spec/evidence", "/spec/registeredAt"])

    def test_registration_rotation_rejects_identity_drift(self):
        desired = {
            "metadata": {"name": "actor-bj-a01", "namespace": "actor-fleet-system", "labels": {}},
            "spec": {field: field for field in ADOPT.REGISTRATION_IDENTITY_FIELDS},
        }
        desired["spec"].update({"evidence": {}, "registeredAt": "2026-09-11T00:00:00Z"})
        existing = json.loads(json.dumps(desired))
        existing["metadata"].update({"uid": "uid", "resourceVersion": "42"})
        existing["spec"]["spokeCellRef"] = "replacement"
        with mock.patch.object(ADOPT, "create_or_get", return_value=existing), mock.patch.object(
            ADOPT, "kubectl"
        ) as kubectl:
            with self.assertRaisesRegex(ValueError, "identity differs"):
                ADOPT.create_or_rotate_registration(Path("/kubeconfig"), desired)
        kubectl.assert_not_called()

    def test_activation_uid_or_readiness_mismatch_is_rejected(self):
        convergence, qualification, activation = self.fixtures()
        activation["cell_identity"]["uid"] = "recreated"
        with self.assertRaisesRegex(ValueError, "UIDs differ"):
            ADOPT.validate_evidence(
                convergence, qualification, activation,
                "sha256:" + "d" * 64, "sha256:" + "e" * 64,
            )

    def test_unreviewed_qualification_is_rejected(self):
        convergence, qualification, activation = self.fixtures()
        qualification["qualification"]["release_digest"] = "sha256:" + "f" * 64
        with self.assertRaisesRegex(ValueError, "reviewed qualification chain"):
            ADOPT.validate_evidence(
                convergence, qualification, activation,
                "sha256:" + "d" * 64, "sha256:" + "e" * 64,
            )

    def test_invalid_engine_datacenter_is_rejected(self):
        convergence, qualification, activation = self.fixtures()
        convergence["fleetBinding"]["datacenterName"] = "INVALID/name"
        with self.assertRaisesRegex(ValueError, "DNS label"):
            ADOPT.validate_evidence(
                convergence, qualification, activation,
                "sha256:" + "d" * 64, "sha256:" + "e" * 64,
            )
        convergence, qualification, activation = self.fixtures()
        activation["ready_for_placement"] = False
        with self.assertRaisesRegex(ValueError, "did not finish Ready"):
            ADOPT.validate_evidence(
                convergence, qualification, activation,
                "sha256:" + "d" * 64, "sha256:" + "e" * 64,
            )

    def test_spoke_role_cannot_touch_machinesets_or_secrets(self):
        rbac = MODULE.with_name("adoption-spoke-rbac.yaml").read_text()
        self.assertNotIn("machinesets", rbac)
        self.assertNotIn("resources: [secrets]", rbac)
        self.assertIn("resourceNames: [__CELL_ID__]", rbac)
        self.assertIn("verbs: [get, update]", rbac)

    def test_receipt_replay_requires_exact_stable_adoption(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            path = Path(directory) / "adoption.json"
            receipt = {
                "schema": "actor-cell-claim-adoption/v2", "verdict": "passed",
                "cell": {"name": "actor-bj-a01", "uid": "cell-uid"},
                "issuedAt": "2026-09-10T12:35:03.123456Z",
            }
            self.assertEqual(ADOPT.publish_or_verify(path, receipt), "published")
            replay = {**receipt, "issuedAt": "2026-09-10T12:36:00Z"}
            self.assertEqual(ADOPT.publish_or_verify(path, replay), "verified")
            stored = json.loads(path.read_text())
            self.assertEqual(stored["issuedAt"], receipt["issuedAt"])
            replay["cell"] = {"name": "actor-bj-a01", "uid": "replacement"}
            with self.assertRaisesRegex(ValueError, "differs"):
                ADOPT.publish_or_verify(path, replay)


if __name__ == "__main__":
    unittest.main()
