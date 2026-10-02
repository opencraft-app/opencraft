import copy
import hashlib
import importlib.util
import json
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("verify-user-transparent-rollback.py")
SPEC = importlib.util.spec_from_file_location("verify_user_transparent_rollback", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
PREFIX = "lightclaw-bj82.tencentcloudcr.com/actor-fleet/"
OLD = PREFIX + "rivet-runtime@sha256:" + "1" * 64
NEW = PREFIX + "rivet-runtime@sha256:" + "2" * 64
METRICS = PREFIX + "workerd-metrics@sha256:" + "3" * 64
NATS = PREFIX + "nats@sha256:" + "4" * 64
CONTROL = PREFIX + "actor-fleet-controller@sha256:" + "5" * 64


def targets(runtime):
    return {
        "engine": {"container/engine": runtime},
        "runtime": {"init/prepare-workerd-config": runtime, "container/workerd": runtime,
                    "container/workerd-host": runtime, "container/workerd-metrics": METRICS},
        "nats": {"container/nats": NATS},
        "capacity": {"container/controller": CONTROL},
        "reporter": {"container/reporter": CONTROL},
    }


def object_refs():
    return [{"object": "object", "id": hashlib.sha256(str(index).encode()).hexdigest(),
             "worker": "q01-platform-upgrade-gate", "class_name": "Agent"} for index in range(32)]


def failed_receipt():
    refs = object_refs()
    worker = {"object": "worker", "name": "q01-platform-upgrade-gate", "deployment_id": "d1"}
    return {
        "schema": "actor-bj-q01-user-transparent-upgrade/v2", "run_id": "a" * 32,
        "verdict": "failed", "release_exit_code": 0, "public_api_only": True,
        "rollback_objects_retained": True, "object_refs": refs, "rollback_object_refs": refs,
        "target_images": targets(NEW), "public_worker_after": worker,
    }


def transition(component, changed):
    return {"component": component, "template_changed": changed,
            "outcome": "changed_complete_rollout" if changed else "unchanged_preserved_exact_uid_set",
            "before_pod_uids": [component + "-old"], "after_pod_uids": [component + "-new" if changed else component + "-old"]}


def valid_receipt():
    failed = failed_receipt()
    failed_bytes = json.dumps(failed, sort_keys=True).encode()
    refs = object_refs()
    worker = failed["public_worker_after"]
    successful = [{"object_id": ref["id"], "count": 1, "successful": 1, "failed": 0,
                   "max_seconds": 0.05} for ref in refs]
    receipt = {
        "schema": "actor-bj-q01-user-transparent-rollback/v3", "cell": "actor-bj-q01",
        "namespace": "actor-fdb-cell-system", "run_id": "b" * 32, "verdict": "passed",
        "release_exit_code": 0, "public_api_only": True, "worker": "q01-platform-upgrade-gate",
        "availability_contract": "post_convergence_zero_failure_state_continuity",
        "release_finished_at": "2026-09-14T12:00:00+00:00",
        "rollback_probe_started_at": "2026-09-14T12:00:01+00:00",
        "rollback_probe_finished_at": "2026-09-14T12:00:11+00:00",
        "object_refs": refs, "cleanup_errors": [], "rollback_objects_retained": False,
        "failed_release": {"sha256": hashlib.sha256(failed_bytes).hexdigest(), "run_id": failed["run_id"],
                           "candidate_images": targets(NEW)},
        "candidate_probe": [{"object_id": ref["id"], "error": "candidate failure"} for ref in refs],
        "target_images": targets(OLD),
        "after": {**{component + "_images": images for component, images in targets(OLD).items()},
                  "ledger": {"cell": "actor-bj-q01", "namespace": "actor-fdb-cell-system",
                             "releaseId": "sha256:" + "6" * 64}},
        "component_transitions": [transition(name, name in ("engine", "runtime", "capacity", "reporter"))
                                  for name in ("engine", "runtime", "nats", "capacity", "reporter")],
        "public_worker_before": worker, "public_worker_after": worker,
        "rollback_probe": {"schema": "bounded-probe-summary/v1", "stream_sha256": "e" * 64,
                           "count": len(refs), "successful_count": len(refs), "failure_count": 0,
                           "failures": [], "failures_truncated": 0, "per_object": successful,
                           "p99_seconds": 0.05, "max_seconds": 0.05},
        "state_continuity": [{"object_id": ref["id"], "read_seconds": 0.04,
                              "write_seconds": 0.06, "value": 2} for ref in refs],
        "release_log": {"bytes": 100, "sha256": "f" * 64},
        "cleanup_issued": True,
    }
    receipt["pre_cleanup_verification"] = MODULE.verify(
        receipt, failed_bytes, OLD, require_pre_cleanup=False
    )
    return receipt, failed_bytes


class RollbackReceiptTests(unittest.TestCase):
    def test_exact_public_rollback_passes(self):
        receipt, failed = valid_receipt()
        result = MODULE.verify(receipt, failed, OLD)
        self.assertEqual(result["objects"], 32)

    def test_wrong_failed_receipt_or_runtime_is_rejected(self):
        receipt, failed = valid_receipt()
        with self.assertRaises(AssertionError):
            MODULE.verify(receipt, failed + b"\n", OLD)
        with self.assertRaises(AssertionError):
            MODULE.verify(receipt, failed, NEW)

    def test_transient_candidate_failure_need_not_reproduce(self):
        receipt, failed = valid_receipt()
        receipt["candidate_probe"] = [
            {"object_id": ref["id"], "status": 200, "value": 1,
             "seconds": 0.05, "request_id": "candidate-" + str(index)}
            for index, ref in enumerate(receipt["object_refs"])
        ]
        receipt["pre_cleanup_verification"] = MODULE.verify(
            receipt, failed, OLD, require_pre_cleanup=False
        )
        self.assertEqual(MODULE.verify(receipt, failed, OLD)["objects"], 32)

    def test_any_public_failure_during_rollback_is_rejected(self):
        receipt, failed = valid_receipt()
        failure = {"object_id": receipt["object_refs"][0]["id"], "error": "request timeout"}
        receipt["rollback_probe"]["failures"].append(failure)
        receipt["rollback_probe"]["count"] += 1
        receipt["rollback_probe"]["failure_count"] = 1
        receipt["rollback_probe"]["per_object"][0]["count"] += 1
        receipt["rollback_probe"]["per_object"][0]["failed"] = 1
        with self.assertRaises(AssertionError):
            MODULE.verify(receipt, failed, OLD)

    def test_malformed_candidate_probe_or_lost_object_is_rejected(self):
        receipt, failed = valid_receipt()
        receipt["candidate_probe"][0] = {"object_id": receipt["object_refs"][0]["id"], "value": 1}
        with self.assertRaises(AssertionError):
            MODULE.verify(receipt, failed, OLD)
        receipt, failed = valid_receipt()
        receipt["state_continuity"].pop()
        with self.assertRaises(AssertionError):
            MODULE.verify(receipt, failed, OLD)

    def test_failed_cleanup_or_worker_drift_is_rejected(self):
        receipt, failed = valid_receipt()
        receipt["cleanup_errors"] = ["injected"]
        with self.assertRaises(AssertionError):
            MODULE.verify(receipt, failed, OLD)
        receipt, failed = valid_receipt()
        receipt["public_worker_after"] = {"object": "worker", "name": "changed"}
        with self.assertRaises(AssertionError):
            MODULE.verify(receipt, failed, OLD)

    def test_cleanup_requires_matching_pre_delete_verification(self):
        receipt, failed = valid_receipt()
        receipt.pop("pre_cleanup_verification")
        with self.assertRaises((AssertionError, KeyError)):
            MODULE.verify(receipt, failed, OLD)
        receipt, failed = valid_receipt()
        receipt["pre_cleanup_verification"]["objects"] = 31
        with self.assertRaises(AssertionError):
            MODULE.verify(receipt, failed, OLD)

    def test_nats_must_not_roll_but_release_bound_control_components_may(self):
        receipt, failed = valid_receipt()
        self.assertEqual(MODULE.verify(receipt, failed, OLD)["objects"], 32)
        receipt["component_transitions"][2] = transition("nats", True)
        with self.assertRaises(AssertionError):
            MODULE.verify(receipt, failed, OLD)


if __name__ == "__main__":
    unittest.main()
