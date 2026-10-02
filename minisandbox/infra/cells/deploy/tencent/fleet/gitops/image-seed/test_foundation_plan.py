#!/usr/bin/env python3

import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
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

    def test_default_and_selected_build_plans_use_canonical_order(self):
        images = MODULE.validate(self.value)
        self.assertEqual(MODULE.select(images, None), sorted(MODULE.REPOSITORIES))
        self.assertEqual(MODULE.select(images, "base-golang"), ["base-golang"])
        self.assertEqual(MODULE.select(images, "runtime-base,base-golang"), ["base-golang", "runtime-base"])

    def test_selection_rejects_empty_unknown_duplicate_and_whitespace(self):
        images = MODULE.validate(self.value)
        for selection in ("", "workers-api", "base-golang,base-golang", "base-golang,", " base-golang"):
            with self.subTest(selection=selection), self.assertRaisesRegex(ValueError, "distinct known"):
                MODULE.select(images, selection)

    def test_cli_subset_still_validates_the_entire_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            lock = Path(temporary) / "lock.json"
            lock.write_text(json.dumps(self.value))
            command = [sys.executable, str(ROOT / "foundation-plan.py"), "--lock", str(lock)]
            valid = subprocess.run(command + ["--repositories", "base-golang"], capture_output=True, text=True)
            self.assertEqual(valid.returncode, 0, valid.stderr)
            self.assertEqual(valid.stdout, "base-golang\n")
            self.value["images"].pop()
            lock.write_text(json.dumps(self.value))
            invalid = subprocess.run(command + ["--repositories", "base-golang"], capture_output=True, text=True)
            self.assertNotEqual(invalid.returncode, 0)
            self.assertEqual(invalid.stdout, "")

    def test_cli_rejects_selection_with_a_field_query(self):
        result = subprocess.run([
            sys.executable, str(ROOT / "foundation-plan.py"), "--lock", str(ROOT / "foundation-images.lock.json"),
            "--repositories", "base-golang", "--repository", "base-golang", "--field", "source",
        ], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_builder_propagates_planner_failure_before_any_build(self):
        source = (ROOT / "build-foundations.sh").read_text()
        start, stop = source.index("plan_args=()\n"), source.index('\nfor repository in "${repositories[@]}"; do')
        script = 'set -euo pipefail\nscript_dir=$1\nlock=$2\n' + source[start:stop] + '\nprintf "planned=%s\\n" "${repositories[@]}"\n'
        for selection in ("", "workers-api", "base-golang,base-golang"):
            env = dict(os.environ, ACTOR_FOUNDATION_REPOSITORIES=selection)
            result = subprocess.run(["bash", "-c", script, "planner", str(ROOT), str(ROOT / "foundation-images.lock.json")],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
