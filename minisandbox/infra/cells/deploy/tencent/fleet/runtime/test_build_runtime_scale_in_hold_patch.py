import importlib.util
import json
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("build-runtime-scale-in-hold-patch.py")
SPEC = importlib.util.spec_from_file_location("runtime_scale_in_hold", MODULE_PATH)
assert SPEC and SPEC.loader
hold = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hold)


STATE = "fleet.actor.dev/workerd-host-drain-state"
HOLD = "fleet.actor.dev/runtime-release-hold"
NOW = "2026-10-02T00:00:00Z"


def workload(state=None, existing_hold=None):
    annotations = {}
    if state is not None:
        annotations[STATE] = json.dumps(state, separators=(",", ":"))
    if existing_hold is not None:
        annotations[HOLD] = existing_hold
    return {
        "metadata": {
            "uid": "workload-uid",
            "resourceVersion": "42",
            "annotations": annotations,
        }
    }


class RuntimeScaleInHoldPatchTests(unittest.TestCase):
    def test_idle_acquires_hold_without_rewriting_state(self):
        document = workload({"phase": "Idle", "epoch": 7})
        operations, identity = hold.build(document, "hold-1", NOW)
        self.assertEqual(identity["workload_uid"], "workload-uid")
        self.assertFalse(any(operation.get("path", "").endswith("workerd-host-drain-state") for operation in operations))
        self.assertEqual(operations[-1]["op"], "add")

    def test_observing_is_atomically_reset_before_hold(self):
        document = workload(
            {
                "phase": "Observing",
                "epoch": 8,
                "startedAt": "2026-10-01T23:55:00Z",
                "transitionAt": "2026-10-01T23:55:00Z",
            }
        )
        operations, _ = hold.build(document, "hold-2", NOW)
        self.assertEqual([item["op"] for item in operations], ["test", "test", "test", "replace", "add"])
        reset = json.loads(operations[-2]["value"])
        self.assertEqual(reset["phase"], "Idle")
        self.assertEqual(reset["epoch"], 8)
        self.assertEqual(reset["transitionAt"], NOW)

    def test_selected_or_draining_state_waits(self):
        for phase in ("Selected", "Draining", "ReadyToScaleDown", "ScalingDown", "Converging", "Aborting"):
            with self.subTest(phase=phase), self.assertRaises(hold.HoldWait):
                hold.build(
                    workload(
                        {
                            "phase": phase,
                            "epoch": 9,
                            "targetName": "runtime-4",
                            "targetUID": "uid-4",
                            "fromReplicas": 5,
                            "startedAt": "2026-10-01T23:55:00Z",
                        }
                    ),
                    "hold-3",
                    NOW,
                )

    def test_passive_state_with_target_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "retains a target"):
            hold.build(
                workload({"phase": "Observing", "epoch": 1, "targetName": "runtime-4", "startedAt": NOW}),
                "hold-4",
                NOW,
            )

    def test_unknown_state_field_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "unknown fields"):
            hold.build(
                workload({"phase": "Observing", "epoch": 1, "startedAt": NOW, "future": True}),
                "hold-unknown",
                NOW,
            )

    def test_existing_hold_waits(self):
        with self.assertRaises(hold.HoldWait):
            hold.build(workload({"phase": "Idle", "epoch": 1}, "owned"), "hold-5", NOW)


if __name__ == "__main__":
    unittest.main()
