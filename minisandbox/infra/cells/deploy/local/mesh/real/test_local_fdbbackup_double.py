#!/usr/bin/env python3
import os
import pathlib
import subprocess
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("local-fdbbackup-double")
BASE = "file:///var/lib/actor-runtime/local-fdbbackup/catalog"
GENERATION = f"{BASE}/restorable-generation-0001"


class LocalFdbbackupDoubleTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.env = os.environ.copy()
        self.env.update(
            {
                "RIVET_LOCAL_BACKUP_FENCE_DOUBLE": "qualification-only",
                "RIVET_LOCAL_BACKUP_FENCE_STATE_DIR": self.temporary.name,
            }
        )

    def run_double(self, *arguments, check=True):
        return subprocess.run(
            [SCRIPT, *arguments],
            env=self.env,
            check=check,
            capture_output=True,
            text=True,
        )

    def test_refuses_to_run_outside_qualification(self):
        env = dict(self.env)
        env.pop("RIVET_LOCAL_BACKUP_FENCE_DOUBLE")
        result = subprocess.run(
            [SCRIPT, "--version"], env=env, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 64)
        self.assertIn("qualification-only", result.stderr)

    def test_unarmed_catalog_is_empty(self):
        self.assertEqual(self.run_double("list", "-b", BASE).stdout, "")

    def test_armed_catalog_matches_controller_grammar(self):
        self.run_double("arm", "18446744073709551615")
        self.assertEqual(
            self.run_double("list", "-b", BASE).stdout.strip(), GENERATION
        )
        self.run_double(
            "expire",
            "-d",
            GENERATION,
            "--delete-before-days",
            "7",
            "--min-restorable-days",
            "7",
        )
        description = self.run_double("describe", "-d", GENERATION).stdout
        self.assertIn(f"URL: {GENERATION}\n", description)
        self.assertIn("Restorable: true\n", description)
        self.assertIn("MinRestorableVersion: 18446744073709551615\n", description)
        self.assertIn("MaxRestorableVersion: 18446744073709551615\n", description)

    def test_malformed_state_and_unknown_generation_fail_closed(self):
        pathlib.Path(self.temporary.name, "minimum-restorable-version").write_text(
            "not-a-version\n"
        )
        self.assertNotEqual(self.run_double("list", "-b", BASE, check=False).returncode, 0)
        self.assertNotEqual(
            self.run_double("describe", "-d", f"{BASE}/wrong", check=False).returncode,
            0,
        )


if __name__ == "__main__":
    unittest.main()
