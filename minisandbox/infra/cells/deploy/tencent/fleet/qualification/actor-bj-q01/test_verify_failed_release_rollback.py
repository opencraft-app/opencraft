import copy
import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("verify-failed-release-rollback.py")
SPEC = importlib.util.spec_from_file_location("verify_failed_release_rollback", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


RUNTIME_PREFIX = "actor-fleet-beijing.tencentcloudcr.com/actor-fleet/rivet-runtime@sha256:"
OLD = RUNTIME_PREFIX + "1" * 64
NEW = RUNTIME_PREFIX + "2" * 64


def pod(image):
    return {"image_ids": [image]}


def valid_receipt():
    return {
        "schema": MODULE.SCHEMA,
        "run_id": "a" * 32,
        "verdict": "failed",
        "release_exit_code": 0,
        "public_api_only": True,
        "public_probe": {"failures": [{"error": "request exceeded SLO"}]},
        "cleanup_errors": [],
        "rollback_objects_retained": True,
        "object_refs": [{"id": str(index)} for index in range(32)],
        "rollback_object_refs": [{"id": str(index)} for index in range(32)],
        "target_images": {
            "engine": {"container/engine": NEW},
            "runtime": {"container/workerd": NEW, "container/workerd-host": NEW, "init/prepare-workerd-config": NEW},
        },
        "component_transitions": [
            {"component": "engine", "template_changed": True, "outcome": "changed_complete_rollout"},
            {"component": "runtime", "template_changed": True, "outcome": "changed_complete_rollout"},
        ],
        "release_log": {"bytes": 123, "sha256": "f" * 64},
        "public_worker_before": {"deployment": "same"},
        "public_worker_after": {"deployment": "same"},
        "before": {
            "engine_pods": [pod(OLD), pod(OLD), pod(OLD)],
            "runtime_pods": [
                {"image_ids": [OLD, OLD]},
                {"image_ids": [OLD, OLD]},
                {"image_ids": [OLD, OLD]},
            ],
        },
        "after": {
            "engine_pods": [pod(NEW), pod(NEW), pod(NEW)],
            "runtime_pods": [
                {"image_ids": [NEW, NEW]},
                {"image_ids": [NEW, NEW]},
                {"image_ids": [NEW, NEW]},
            ],
        },
        "timeline": [{
            "engine_pods": [pod(NEW), pod(NEW), pod(NEW)],
            "runtime_pods": [
                {"image_ids": [NEW, NEW]},
                {"image_ids": []},
                {"image_ids": []},
            ],
        }],
    }


class FailedReleaseRollbackTest(unittest.TestCase):
    def test_exact_failed_release_rollback_is_allowed(self):
        result = MODULE.verify(valid_receipt(), OLD, NEW, NEW)
        self.assertEqual(result["rollback_image"], OLD)

    def test_arbitrary_target_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "prior Engine"):
            MODULE.verify(valid_receipt(), RUNTIME_PREFIX + "3" * 64, NEW, NEW)

    def test_release_must_have_completed(self):
        receipt = valid_receipt()
        receipt["release_exit_code"] = 2
        with self.assertRaisesRegex(ValueError, "completed failed release"):
            MODULE.verify(receipt, OLD, NEW, NEW)

    def test_live_candidate_must_match_terminal_receipt(self):
        with self.assertRaisesRegex(ValueError, "target Engine"):
            MODULE.verify(valid_receipt(), OLD, RUNTIME_PREFIX + "3" * 64, NEW)

    def test_pre_convergence_timeline_does_not_block_authoritative_after_snapshot(self):
        result = MODULE.verify(valid_receipt(), OLD, NEW, NEW)
        self.assertEqual(result["live_image"], NEW)

    def test_after_snapshot_must_bind_every_live_host(self):
        receipt = copy.deepcopy(valid_receipt())
        receipt["after"]["runtime_pods"][1] = {"image_ids": []}
        with self.assertRaisesRegex(ValueError, "live Host"):
            MODULE.verify(receipt, OLD, NEW, NEW)

    def test_every_pod_must_bind_the_expected_image(self):
        receipt = copy.deepcopy(valid_receipt())
        receipt["before"]["runtime_pods"][1] = pod(NEW)
        with self.assertRaisesRegex(ValueError, "prior Host"):
            MODULE.verify(receipt, OLD, NEW, NEW)

    def test_legacy_or_non_public_receipt_is_rejected(self):
        receipt = valid_receipt()
        receipt["schema"] = "actor-bj-q01-user-transparent-upgrade/v1"
        with self.assertRaisesRegex(ValueError, "schema"):
            MODULE.verify(receipt, OLD, NEW, NEW)
        receipt = valid_receipt()
        receipt["public_api_only"] = False
        with self.assertRaisesRegex(ValueError, "public /v1"):
            MODULE.verify(receipt, OLD, NEW, NEW)

    def test_candidate_must_be_exact_completed_target(self):
        receipt = valid_receipt()
        receipt["target_images"]["engine"]["container/engine"] = OLD
        with self.assertRaisesRegex(ValueError, "target Engine"):
            MODULE.verify(receipt, OLD, NEW, NEW)
        receipt = valid_receipt()
        receipt["component_transitions"][1]["outcome"] = "unchanged_preserved_existing_ordinals"
        with self.assertRaisesRegex(ValueError, "complete the runtime rollout"):
            MODULE.verify(receipt, OLD, NEW, NEW)


if __name__ == "__main__":
    unittest.main()
