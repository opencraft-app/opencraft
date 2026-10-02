import importlib.util
import json
import pathlib
import sys
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("verify_runtime_floor.py")
SPEC = importlib.util.spec_from_file_location("verify_runtime_floor", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
floor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = floor
SPEC.loader.exec_module(floor)


class RuntimeFloorTests(unittest.TestCase):
    def documents(self, replicas=4):
        cell = "actor-bj-a01"
        engine = {
            "metadata": {"generation": 7},
            "spec": {"replicas": 6},
            "status": {
                "observedGeneration": 7,
                "readyReplicas": 6,
                "availableReplicas": 6,
                "updatedReplicas": 6,
            },
        }
        runtime = {
            "metadata": {
                "name": f"{cell}-runtime-hosts",
                "generation": 11,
                "annotations": {
                    "fleet.actor.dev/workerd-host-drain-state": json.dumps(
                        {"phase": "Idle", "epoch": 9}
                    )
                },
            },
            "spec": {"replicas": replicas},
            "status": {
                "observedGeneration": 11,
                "readyReplicas": replicas,
                "currentReplicas": replicas,
                "updatedReplicas": replicas,
                "currentRevision": "runtime-abc",
                "updateRevision": "runtime-abc",
            },
        }
        hpa = {
            "spec": {
                "minReplicas": replicas,
                "maxReplicas": 301,
                "scaleTargetRef": {
                    "apiVersion": "apps/v1",
                    "kind": "StatefulSet",
                    "name": f"{cell}-runtime-hosts",
                },
            },
            "status": {
                "conditions": [
                    {"type": "AbleToScale", "status": "True"},
                    {"type": "ScalingActive", "status": "True"},
                ]
            },
        }
        return cell, engine, runtime, hpa

    def test_accepts_current_floor_and_future_higher_floor(self):
        for replicas in (4, 5):
            with self.subTest(replicas=replicas):
                cell, engine, runtime, hpa = self.documents(replicas)
                self.assertEqual(
                    floor.validate_documents(cell, engine, runtime, hpa),
                    {"engine_replicas": 6, "runtime_floor": replicas},
                )

    def test_rejects_legacy_three_host_floor(self):
        cell, engine, runtime, hpa = self.documents(3)
        with self.assertRaisesRegex(ValueError, "production minimum"):
            floor.validate_documents(cell, engine, runtime, hpa)

    def test_rejects_partially_ready_runtime(self):
        cell, engine, runtime, hpa = self.documents()
        runtime["status"]["readyReplicas"] = 3
        with self.assertRaisesRegex(ValueError, "authoritative HPA floor"):
            floor.validate_documents(cell, engine, runtime, hpa)

    def test_rejects_active_drain_or_release(self):
        cell, engine, runtime, hpa = self.documents()
        runtime["metadata"]["annotations"]["fleet.actor.dev/runtime-release-hold"] = "release-1"
        with self.assertRaisesRegex(ValueError, "release hold"):
            floor.validate_documents(cell, engine, runtime, hpa)
        runtime["metadata"]["annotations"].pop("fleet.actor.dev/runtime-release-hold")
        runtime["metadata"]["annotations"]["fleet.actor.dev/workerd-host-drain-state"] = json.dumps(
            {"phase": "Selected"}
        )
        with self.assertRaisesRegex(ValueError, "not Idle"):
            floor.validate_documents(cell, engine, runtime, hpa)

    def test_rejects_wrong_hpa_target_or_inactive_metric(self):
        cell, engine, runtime, hpa = self.documents()
        hpa["spec"]["scaleTargetRef"]["name"] = "other"
        with self.assertRaisesRegex(ValueError, "exact Cell StatefulSet"):
            floor.validate_documents(cell, engine, runtime, hpa)
        cell, engine, runtime, hpa = self.documents()
        hpa["status"]["conditions"][1]["status"] = "False"
        with self.assertRaisesRegex(ValueError, "active metric"):
            floor.validate_documents(cell, engine, runtime, hpa)


if __name__ == "__main__":
    unittest.main()
