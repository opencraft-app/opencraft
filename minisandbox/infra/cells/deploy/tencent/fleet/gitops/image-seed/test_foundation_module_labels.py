#!/usr/bin/env python3
"""Exercise the production label planner with real Bash and file hashes."""

import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
SOURCE = (ROOT / "build-foundations.sh").read_text()
PLAN = SOURCE[SOURCE.index("\tmodule_labels=()\n"):SOURCE.index("\tbuildah bud ")]


class FoundationModuleLabelTests(unittest.TestCase):
    def labels(self, repository, mod=b"module example.invalid/fixture\ngo 1.25.4\n", include_sum=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cells = root / "infra/cells"
            cells.mkdir(parents=True)
            (cells / "go.mod").write_bytes(mod)
            if include_sum:
                (cells / "go.sum").write_bytes(b"fixture checksums\n")
            script = 'set -euo pipefail\nsource_dir=$1\nrepository=$2\n' + PLAN
            script += '\nfor label in "${module_labels[@]}"; do printf "%s\\n" "$label"; done\n'
            return subprocess.run(["bash", "-c", script, "labels", str(root), repository],
                                  capture_output=True, text=True)

    def test_golang_labels_bind_exact_files(self):
        mod = b"module example.invalid/fixture\ngo 1.25.4\n"
        result = self.labels("base-golang", mod)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "--label", "fleet.actor.dev/go-mod-sha256=" + hashlib.sha256(mod).hexdigest(),
            "--label", "fleet.actor.dev/go-sum-sha256=" + hashlib.sha256(b"fixture checksums\n").hexdigest(),
        ])

    def test_other_foundations_do_not_claim_a_module_graph(self):
        for repository in ("base-distroless", "base-tencentcloud-cli", "git-service", "runtime-base"):
            with self.subTest(repository=repository):
                result = self.labels(repository, include_sum=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_changed_graph_changes_identity_and_missing_input_fails_closed(self):
        before = self.labels("base-golang")
        after = self.labels("base-golang", b"module example.invalid/updated\ngo 1.25.4\n")
        self.assertNotEqual(before.stdout, after.stdout)
        missing = self.labels("base-golang", include_sum=False)
        self.assertNotEqual(missing.returncode, 0)
        self.assertEqual(missing.stdout, "")

    def test_planner_follows_source_verification_and_labels_reach_builder(self):
        self.assertLess(SOURCE.index('sha256sum --check "$source_manifest"'), SOURCE.index("\tmodule_labels=()\n"))
        command = SOURCE[SOURCE.index("\tbuildah bud "):SOURCE.index("\tdigest_file=$(mktemp")]
        self.assertIn('"${module_labels[@]}"', command)
        self.assertIn('--build-arg "$build_arg=$source_image"', command)
        # Keep the consumer guard intact instead of accepting an unlabelled base.
        controller = (ROOT.parent.parent / "controller/build-image.sh").read_text()
        self.assertIn('"fleet.actor.dev/go-mod-sha256": sys.argv[1]', controller)
        self.assertIn('"fleet.actor.dev/go-sum-sha256": sys.argv[2]', controller)


if __name__ == "__main__":
    unittest.main()
