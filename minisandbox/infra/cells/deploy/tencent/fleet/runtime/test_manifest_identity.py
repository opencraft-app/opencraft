#!/usr/bin/env python3
import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "manifest_identity", ROOT / "manifest-identity.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ManifestIdentityTest(unittest.TestCase):
    def test_identity_does_not_include_source_path(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            left = Path(first, "nats.yaml")
            right = Path(second, "renamed.yaml")
            left.write_bytes(b"same manifest\n")
            right.write_bytes(left.read_bytes())
            self.assertEqual(
                MODULE.identity([left], ["actor-bj-q01"]),
                MODULE.identity([right], ["actor-bj-q01"]),
            )

    def test_content_and_explicit_values_are_identity_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory, "runtime.yaml")
            manifest.write_bytes(b"version: one\n")
            baseline = MODULE.identity([manifest], ["actor-bj-q01", "production"])
            manifest.write_bytes(b"version: two\n")
            self.assertNotEqual(
                baseline,
                MODULE.identity([manifest], ["actor-bj-q01", "production"]),
            )
            self.assertNotEqual(
                baseline,
                MODULE.identity([manifest], ["actor-bj-q02", "production"]),
            )

    def test_framing_prevents_input_boundary_collisions(self):
        self.assertNotEqual(
            MODULE.identity([], ["ab", "c"]),
            MODULE.identity([], ["a", "bc"]),
        )


if __name__ == "__main__":
    unittest.main()
