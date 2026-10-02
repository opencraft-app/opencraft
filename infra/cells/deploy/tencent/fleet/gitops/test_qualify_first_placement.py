#!/usr/bin/env python3

import importlib.util
import hashlib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("qualify_first_placement", ROOT / "qualify-first-placement.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class FirstPlacementTests(unittest.TestCase):
    OPERATION_ID = "0123456789abcdef0123456789abcdef"

    def evidence(self):
        worker, object_id = MODULE.operation_identity(self.OPERATION_ID)
        route = {
            "schema": "actor-cell-route-publication/v2", "verdict": "passed",
            "convergenceReceiptDigest": "sha256:" + "b" * 64,
            "qualificationChainReceiptDigest": "sha256:" + "c" * 64,
            "activationReceiptDigest": "sha256:" + "d" * 64,
            "adoptionReceiptDigest": "sha256:" + "e" * 64,
            "pool": {"name": "pool", "uid": "pool-uid"},
            "cell": {"name": "cell", "uid": "cell-uid"},
            "datacenter": "actor-bj-k02",
            "routeConfigMap": {"name": "actor-cell-route-cell", "uid": "route-uid"},
        }
        live = {
            "metadata": {"uid": "route-uid"},
            "data": {
                "pool-name": "pool", "pool-uid": "pool-uid", "cell-name": "cell",
                "cell-uid": "cell-uid", "datacenter": "actor-bj-k02",
            },
        }
        object_ref = {"object": "object", "id": object_id, "worker": worker, "class_name": MODULE.CLASS_NAME}
        record = {
            "schema": "rivet-worker-object/v2", "state": "active", "namespace": MODULE.ACTOR_NAMESPACE,
            "object_id": object_id, "worker": worker, "class_name": MODULE.CLASS_NAME, "actor_id": "actor",
            "placement": {
                "pool_name": "pool", "pool_uid": "pool-uid", "cell_name": "cell",
                "cell_uid": "cell-uid", "datacenter": "actor-bj-k02",
                "snapshot_digest": "sha256:" + "a" * 64,
            },
        }
        actor = {
            "actor_id": "actor", "connectable_ts": 1,
            "sleep_ts": None, "destroy_ts": None, "error": None,
        }
        probe = {
            "status": 200, "response_bytes": len(b"qualified"),
            "response_sha256": "sha256:" + hashlib.sha256(b"qualified").hexdigest(),
        }
        live_cell = {
            "metadata": {"name": "actor-bj-k02", "uid": "cell-uid", "generation": 4},
            "spec": {"cellId": "actor-bj-k02", "desiredState": "Ready"},
            "status": {"phase": "Ready", "readyForPlacement": True, "observedGeneration": 4},
        }
        return route, live, object_ref, record, actor, probe, object_id, live_cell

    def test_builds_joinable_receipt(self):
        route, live, object_ref, record, actor, probe, object_id, live_cell = self.evidence()
        result = MODULE.validate_and_build(
            route, live, object_ref, record, [actor], {"id": "version"},
            {"id": "deployment"}, object_id, self.OPERATION_ID, probe, live_cell,
        )
        self.assertEqual((result["schema"], result["verdict"]), ("actor-first-placement/v1", "passed"))
        self.assertEqual(result["operation_id"], self.OPERATION_ID)
        self.assertEqual(result["first_placement"]["registry_record"], record)

    def test_operation_identity_is_deterministic_and_scoped(self):
        first = MODULE.operation_identity(self.OPERATION_ID)
        self.assertEqual(first, MODULE.operation_identity(self.OPERATION_ID))
        self.assertNotEqual(first, MODULE.operation_identity("f" * 32))
        self.assertEqual(first[0], "first-agent-0123456789abcdef")
        with self.assertRaisesRegex(ValueError, "32 lowercase hex"):
            MODULE.operation_identity("A" * 32)

    def test_rejects_another_cell_and_route_replacement(self):
        route, live, object_ref, record, actor, probe, object_id, live_cell = self.evidence()
        record["placement"]["cell_uid"] = "other"
        with self.assertRaisesRegex(ValueError, "cell_uid"):
            MODULE.validate_and_build(
                route, live, object_ref, record, [{"actor_id": "actor"}], {}, {}, object_id,
                self.OPERATION_ID, probe, live_cell,
            )
        route, live, object_ref, record, actor, probe, object_id, live_cell = self.evidence()
        live["metadata"]["uid"] = "replacement"
        with self.assertRaisesRegex(ValueError, "route ConfigMap UID"):
            MODULE.validate_and_build(
                route, live, object_ref, record, [{"actor_id": "actor"}], {}, {}, object_id,
                self.OPERATION_ID, probe, live_cell,
            )

    def test_rejects_live_route_payload_drift(self):
        route, live, object_ref, record, actor, probe, object_id, live_cell = self.evidence()
        live["data"]["datacenter"] = "other"
        with self.assertRaisesRegex(ValueError, "payload"):
            MODULE.validate_and_build(
                route, live, object_ref, record, [{"actor_id": "actor"}], {}, {}, object_id,
                self.OPERATION_ID, probe, live_cell,
            )

    def test_release_evidence_is_not_embedded_in_stable_route(self):
        route, live, object_ref, record, actor, probe, object_id, live_cell = self.evidence()
        self.assertNotIn("qualification-chain-receipt-digest", live["data"])
        route["qualificationChainReceiptDigest"] = "sha256:" + "f" * 64
        result = MODULE.validate_and_build(
            route, live, object_ref, record, [actor], {"id": "version"},
            {"id": "deployment"}, object_id, self.OPERATION_ID, probe, live_cell,
        )
        self.assertEqual(result["verdict"], "passed")

    def test_rejects_split_brain_actor_observation(self):
        route, live, object_ref, record, actor, probe, object_id, live_cell = self.evidence()
        with self.assertRaisesRegex(ValueError, "exactly"):
            MODULE.validate_and_build(
                route, live, object_ref, record,
                [{"actor_id": "actor"}, {"actor_id": "actor-2"}], {}, {},
                object_id, self.OPERATION_ID, probe, live_cell,
            )

    def test_rejects_non_connectable_actor(self):
        route, live, object_ref, record, actor, probe, object_id, live_cell = self.evidence()
        actor["connectable_ts"] = None
        with self.assertRaisesRegex(ValueError, "live and connectable"):
            MODULE.validate_and_build(
                route, live, object_ref, record, [actor], {"id": "version"},
                {"id": "deployment"}, object_id, self.OPERATION_ID, probe, live_cell,
            )

    def test_rejects_failed_functional_probe(self):
        route, live, object_ref, record, actor, probe, object_id, live_cell = self.evidence()
        probe["status"] = 503
        with self.assertRaisesRegex(ValueError, "functional probe"):
            MODULE.validate_and_build(
                route, live, object_ref, record, [actor], {"id": "version"},
                {"id": "deployment"}, object_id, self.OPERATION_ID, probe, live_cell,
            )

    def test_rejects_cell_closed_after_activation(self):
        route, live, object_ref, record, actor, probe, object_id, live_cell = self.evidence()
        live_cell["status"]["readyForPlacement"] = False
        with self.assertRaisesRegex(ValueError, "currently admitted"):
            MODULE.validate_and_build(
                route, live, object_ref, record, [actor], {"id": "version"},
                {"id": "deployment"}, object_id, self.OPERATION_ID, probe, live_cell,
            )

    def test_selects_exact_route_bound_live_cell(self):
        route, _, _, _, _, _, _, live_cell = self.evidence()
        selected = MODULE.select_live_cell(route, {"items": [live_cell]})
        self.assertIs(selected, live_cell)
        live_cell["metadata"]["uid"] = "replacement"
        with self.assertRaisesRegex(ValueError, "exactly"):
            MODULE.select_live_cell(route, {"items": [live_cell]})

    def test_gate_accepts_multiple_cell_inputs_and_derives_engine_from_cell(self):
        source = (ROOT / "qualify-first-placement.py").read_text()
        self.assertIn('action="append", type=pathlib.Path', source)
        self.assertIn('engine_service = explicit_service or f"{cell_name}-engine"', source)
        self.assertIn('selected_cell = str(nested(record, "placement", "cell_name"))', source)
        self.assertIn('Registry selected a Cell outside the qualified route inventory', source)


if __name__ == "__main__":
    unittest.main()
