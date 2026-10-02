#!/usr/bin/env python3

import copy
import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("foundation_plan", ROOT / "foundation-plan.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class FoundationPlanTests(unittest.TestCase):
    def setUp(self):
        self.value = json.loads((ROOT / "foundation-images.lock.json").read_text())

    def test_reviewed_lock_is_complete(self):
        result = MODULE.validate(self.value)
        self.assertEqual(set(result), MODULE.REPOSITORIES)
        self.assertTrue(all(item["source"].count("@sha256:") == 1 for item in result.values()))

    def test_rejects_mutable_source(self):
        changed = copy.deepcopy(self.value)
        changed["images"][0]["source"] = "gcr.io/distroless/cc-debian12:nonroot"
        with self.assertRaisesRegex(ValueError, "digest pinned"):
            MODULE.validate(changed)

    def test_rejects_path_escape(self):
        changed = copy.deepcopy(self.value)
        changed["images"][0]["dockerfile"] = "infra/cells/../secret/Dockerfile"
        with self.assertRaisesRegex(ValueError, "unsafe"):
            MODULE.validate(changed)

    def test_rejects_missing_repository(self):
        changed = copy.deepcopy(self.value)
        changed["images"].pop()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            MODULE.validate(changed)


if __name__ == "__main__":
    unittest.main()
