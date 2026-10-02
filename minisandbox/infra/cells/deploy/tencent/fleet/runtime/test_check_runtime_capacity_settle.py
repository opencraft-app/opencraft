import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("check-runtime-capacity-settle.py")
SPEC = importlib.util.spec_from_file_location("runtime_capacity_settle", MODULE_PATH)
assert SPEC and SPEC.loader
settle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(settle)


def machine_set(annotations=None):
    return {"metadata": {"name": "np-runtime0", "uid": "machineset-uid", "annotations": annotations or {}}}


def nodes(*items):
    return {"items": list(items)}


class RuntimeCapacitySettleTests(unittest.TestCase):
    def test_accepts_settled_capacity(self):
        self.assertIsNone(settle.wait_reason(machine_set(), nodes()))

    def test_waits_for_machine_intent(self):
        reason = settle.wait_reason(
            machine_set({"fleet.actor.dev/runtime-capacity-downscale-intent": "owned"}),
            nodes(),
        )
        self.assertIn("intent", reason)

    def test_waits_for_node_annotation_or_taint(self):
        for node in (
            {
                "metadata": {
                    "name": "node-a",
                    "annotations": {"fleet.actor.dev/runtime-capacity-drain": "owned"},
                }
            },
            {
                "metadata": {"name": "node-b"},
                "spec": {"taints": [{"key": "fleet.actor.dev/runtime-capacity-drain"}]},
            },
        ):
            with self.subTest(node=node["metadata"]["name"]):
                self.assertIn("scale-down fence", settle.wait_reason(machine_set(), nodes(node)))

    def test_malformed_inventory_fails_closed(self):
        with self.assertRaises(ValueError):
            settle.wait_reason({"metadata": {}}, nodes())
        with self.assertRaises(ValueError):
            settle.wait_reason(machine_set(), {"items": "not-a-list"})


if __name__ == "__main__":
    unittest.main()
