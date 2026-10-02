#!/usr/bin/env python3
import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("publish_cell_route", ROOT / "publish-cell-route.py")
assert spec is not None and spec.loader is not None
MODULE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MODULE)
DIGEST = "sha256:" + "a" * 64


def fixtures():
    convergence = {
        "schema": "actor-cell-argo-convergence/v1", "verdict": "passed",
        "argo": {"project": "actor-cell-bootstrap", "registrationScope": "production"},
        "cell": {"id": "actor-bj-k02", "uid": "spoke-uid", "generation": 1},
        "fleetBinding": {
            "poolName": "pool-a", "poolUid": "pool-uid", "claimName": "claim-a",
            "claimUid": "claim-uid", "className": "class-a", "datacenterName": "default",
            "scaleOutEpoch": 1, "profileDigest": DIGEST,
        },
    }
    pool = {"metadata": {"name": "pool-a", "uid": "pool-uid"}}
    claim = {
        "metadata": {"name": "claim-a", "uid": "claim-uid"}, "spec": {"poolRef": {"name": "pool-a", "uid": "pool-uid"}},
        "status": {"phase": "Bound", "placementDecision": {"logicalCellName": "cell-a"},
                   "cellRef": {"uid": "logical-uid"}, "spokeCellRef": {"uid": "spoke-uid"}},
    }
    cell = {"metadata": {"name": "cell-a", "uid": "logical-uid", "labels": {"fleet.actor.dev/pool": "pool-a"}},
            "status": {"spokeCellRef": {"uid": "spoke-uid"}}}
    qualification = {
        "schema": "actor-cell-qualification-chain/v1", "verdict": "passed",
        "cell": {"id": "actor-bj-k02", "spoke_uid": "spoke-uid"},
        "pool": {"name": "pool-a", "uid": "pool-uid"},
        "construction": {"argo_convergence_receipt_digest": DIGEST},
        "qualification": {"control_receipt_digest": DIGEST, "release_digest": DIGEST},
        "placement_opened": False, "operator_activation_required": True,
    }
    activation = {
        "schema": "actor-cell-qualification-activation/v1", "verdict": "passed",
        "cell": "actor-bj-k02", "cell_identity": {"uid": "spoke-uid"},
        "desired_state": "Ready", "ready_for_placement": True,
        "control_receipt_sha256": "a" * 64,
        "qualification": {"release_digest": DIGEST},
    }
    adoption = {
        "schema": "actor-cell-claim-adoption/v2", "verdict": "passed",
        "cell": {"name": "actor-bj-k02", "uid": "spoke-uid"},
        "pool": {"name": "pool-a", "uid": "pool-uid"},
        "claim": {"name": "claim-a", "uid": "claim-uid"},
        "evidence": {"convergence": DIGEST, "qualification": DIGEST, "activation": DIGEST},
    }
    return convergence, qualification, activation, adoption, pool, claim, cell


def build(*, namespace="workers-api-system"):
    convergence, qualification, activation, adoption, pool, claim, cell = fixtures()
    return MODULE.build_route(
        convergence, DIGEST, qualification, DIGEST, activation, DIGEST,
        adoption, DIGEST, pool, claim, cell, namespace,
    )


class RouteTest(unittest.TestCase):
    def test_binds_complete_identity(self):
        route = build()
        self.assertTrue(route["immutable"])
        self.assertEqual(route["metadata"]["name"], "actor-cell-route-cell-a")
        self.assertEqual(route["data"]["datacenter"], "default")
        self.assertNotIn("qualification-chain-receipt-digest", route["data"])
        self.assertNotIn("activation-receipt-digest", route["data"])
        self.assertNotIn("adoption-receipt-digest", route["data"])
        self.assertNotIn("annotations", route["metadata"])

    def test_rejects_spoke_replacement(self):
        convergence, qualification, activation, adoption, pool, claim, cell = fixtures()
        claim["status"]["spokeCellRef"]["uid"] = "replacement"
        with self.assertRaisesRegex(ValueError, "Argo convergence"):
            MODULE.build_route(
                convergence, DIGEST, qualification, DIGEST, activation, DIGEST,
                adoption, DIGEST, pool, claim, cell, "workers-api-system",
            )

    def test_rejects_non_production_registration(self):
        convergence, qualification, activation, adoption, pool, claim, cell = fixtures()
        convergence["argo"]["registrationScope"] = "applicationset-e2e"
        with self.assertRaisesRegex(ValueError, "production Cell registration"):
            MODULE.build_route(
                convergence, DIGEST, qualification, DIGEST, activation, DIGEST,
                adoption, DIGEST, pool, claim, cell, "workers-api-system",
            )

    def test_rejects_unreviewed_activation_or_adoption(self):
        convergence, qualification, activation, adoption, pool, claim, cell = fixtures()
        activation["control_receipt_sha256"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "reviewed qualification chain"):
            MODULE.build_route(
                convergence, DIGEST, qualification, DIGEST, activation, DIGEST,
                adoption, DIGEST, pool, claim, cell, "workers-api-system",
            )

    def test_rejects_adoption_from_another_activation(self):
        convergence, qualification, activation, adoption, pool, claim, cell = fixtures()
        adoption["evidence"]["activation"] = "sha256:" + "b" * 64
        with self.assertRaisesRegex(ValueError, "Claim adoption"):
            MODULE.build_route(
                convergence, DIGEST, qualification, DIGEST, activation, DIGEST,
                adoption, DIGEST, pool, claim, cell, "workers-api-system",
            )

    def test_rejects_claim_that_is_not_bound(self):
        convergence, qualification, activation, adoption, pool, claim, cell = fixtures()
        claim["status"]["phase"] = "Pending"
        with self.assertRaisesRegex(ValueError, "not Bound"):
            MODULE.build_route(
                convergence, DIGEST, qualification, DIGEST, activation, DIGEST,
                adoption, DIGEST, pool, claim, cell, "workers-api-system",
            )
        activation["control_receipt_sha256"] = "a" * 64
        adoption["claim"]["uid"] = "another-claim"
        with self.assertRaisesRegex(ValueError, "Claim adoption"):
            MODULE.build_route(
                convergence, DIGEST, qualification, DIGEST, activation, DIGEST,
                adoption, DIGEST, pool, claim, cell, "workers-api-system",
            )

    def test_existing_route_is_exact(self):
        route = build()
        actual = {**route, "metadata": {**route["metadata"], "uid": "route-uid", "resourceVersion": "7"}}
        MODULE.verify_existing(route, actual)
        actual["data"] = {**route["data"], "datacenter": "dc-b"}
        with self.assertRaisesRegex(ValueError, "data"):
            MODULE.verify_existing(route, actual)

    def test_receipt_replay_is_exact_and_never_overwrites(self):
        receipt = {"schema": "actor-cell-route-publication/v2", "verdict": "passed"}
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            path = Path(directory) / "route.json"
            self.assertEqual(MODULE.publish_or_verify(path, receipt), "published")
            self.assertEqual(MODULE.publish_or_verify(path, receipt), "verified")
            with self.assertRaisesRegex(ValueError, "differs"):
                MODULE.publish_or_verify(path, {**receipt, "verdict": "failed"})
            self.assertEqual(MODULE.load(path, "route"), receipt)

if __name__ == "__main__":
    unittest.main()
