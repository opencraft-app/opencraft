#!/usr/bin/env python3
import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("cloud_stateless_termination", ROOT / "termination_matrix.py")
assert spec and spec.loader
MODULE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MODULE)


class TerminationMatrixUnitTests(unittest.TestCase):
    def test_replacement_uses_one_snapshot_and_preserves_peer_uid(self):
        class SnapshotClient:
            def __init__(self, uids):
                self.uids = uids
                self.calls = 0

            def json(self, *args):
                self.calls += 1
                return {"items": [
                    {"metadata": {"name": uid, "uid": uid},
                     "status": {"conditions": [{"type": "Ready", "status": "True"}]}}
                    for uid in self.uids
                ]}

        client = SnapshotClient(["u2", "u3"])
        replacement = MODULE.wait_replacement(client, "a", {"u1", "u2"}, "u1", 2, 5)
        self.assertEqual(replacement, {"name": "u3", "uid": "u3"})
        self.assertEqual(client.calls, 1)
        wrong_peer = SnapshotClient(["u1", "u3"])
        with self.assertRaisesRegex(RuntimeError, "unselected Pod"):
            MODULE.wait_replacement(wrong_peer, "a", {"u1", "u2"}, "u1", 2, 5)
        self.assertEqual(wrong_peer.calls, 1)

    def test_identify_holder_requires_one_exact_permit(self):
        self.assertEqual(
            MODULE.identify_holder({("a", "p1"): 0, ("b", "p2"): 1}),
            ("b", "p2"),
        )
        self.assertIsNone(MODULE.identify_holder({("a", "p1"): 1, ("b", "p2"): 1}))
        self.assertIsNone(MODULE.identify_holder({("a", "p1"): 2, ("b", "p2"): 0}))

    def test_parse_cells_requires_two_absolute_unique_paths(self):
        parsed = MODULE.parse_cells(["a=/tmp/a", "b=/tmp/b"])
        self.assertEqual(set(parsed), {"a", "b"})
        with self.assertRaisesRegex(ValueError, "exactly two"):
            MODULE.parse_cells(["a=/tmp/a"])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            MODULE.parse_cells(["a=/tmp/a", "a=/tmp/b"])
        with self.assertRaisesRegex(ValueError, "absolute"):
            MODULE.parse_cells(["a=relative", "b=/tmp/b"])

    def test_error_code_accepts_executor_and_public_shapes(self):
        self.assertEqual(MODULE.error_code({"code": "indeterminate_result"}), "indeterminate_result")
        self.assertEqual(
            MODULE.error_code({"error": {"code": "indeterminate_result"}}),
            "indeterminate_result",
        )
        self.assertIsNone(MODULE.error_code("bad gateway"))

    def test_worker_payload_requires_the_complete_stream(self):
        complete = {
            "marker": "cloud-stateless-termination",
            "delayMs": 15,
            "padding": "x" * 65536,
        }
        self.assertTrue(MODULE.valid_worker_payload(complete, 15))
        complete["padding"] = "x" * 1024
        self.assertFalse(MODULE.valid_worker_payload(complete, 15))


if __name__ == "__main__":
    unittest.main()
