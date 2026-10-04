#!/usr/bin/env python3
"""Exercise the real verification entry point outside a relocated source tree."""

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class VerifyRunnerTest(unittest.TestCase):
    def test_verification_is_independent_of_cwd_and_dotted_source_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="workers-api-relocation.", dir="/data/tmp") as raw:
            temporary = Path(raw)
            source = temporary / "reviewed.source.v1" / "fleet"
            copied = source / "workers-api"
            ignored = shutil.ignore_patterns("__pycache__", "*.pyc")
            shutil.copytree(ROOT, copied, ignore=ignored)
            shutil.copytree(ROOT.parent / "gitops" / "image-seed", source / "gitops" / "image-seed", ignore=ignored)
            shutil.copytree(ROOT.parent / "tat", source / "tat", ignore=ignored)
            (source / "runtime").mkdir()
            shutil.copy2(ROOT.parent / "runtime" / "ensure-stateless-auth.sh", source / "runtime" / "ensure-stateless-auth.sh")
            operator_cwd = temporary / "operator"
            operator_cwd.mkdir()
            result = subprocess.run(
                ["bash", str(copied / "verify.sh")], cwd=operator_cwd,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "TMPDIR": "/data/tmp"},
                capture_output=True, text=True, timeout=90,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("workers-api production manifest: PASS", result.stdout)
            test_counts = [int(count) for count in re.findall(r"Ran (\d+) tests", result.stderr)]
            self.assertEqual(len(test_counts), 2)
            self.assertGreaterEqual(test_counts[0], 23)
            self.assertGreaterEqual(test_counts[1], 15)


if __name__ == "__main__":
    unittest.main()
