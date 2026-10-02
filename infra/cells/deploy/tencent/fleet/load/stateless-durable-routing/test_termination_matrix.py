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
