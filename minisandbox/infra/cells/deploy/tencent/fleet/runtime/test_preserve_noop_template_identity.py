import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).parent
OLD = "a" * 64
NEW = "b" * 64


def workload(identity, image="example.invalid/runtime@sha256:" + "c" * 64):
    return {
        "apiVersion": "apps/v1", "kind": "StatefulSet",
        "metadata": {"name": "cell-runtime-hosts"},
        "spec": {"template": {"metadata": {"annotations": {
            "fleet.actor.dev/manifest-sha256": identity,
        }}, "spec": {"containers": [{"name": "runtime", "image": image}],
                      "restartPolicy": "Always"}}},
    }


class PreserveNoopIdentityTest(unittest.TestCase):
    def run_case(self, live, candidate, related_same=True, require_noop=False, probe_only=False):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            (root / "live.json").write_text(json.dumps(live))
            (root / "candidate.json").write_text(json.dumps(candidate))
            manifest = root / "manifest.yaml"
            manifest.write_text(
                "apiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n"
                "  name: cell-runtime-hosts\nspec:\n  template:\n    metadata:\n"
                f"      annotations:\n        fleet.actor.dev/manifest-sha256: {NEW}\n"
            )
            (root / "related-live.json").write_text(json.dumps({"data": {"config": "old"}}))
            related = "old" if related_same else "new"
            (root / "related-candidate.json").write_text(json.dumps({"data": {"config": related}}))
            command = [
                "python3", str(ROOT / "preserve-noop-template-identity.py"),
                "--live", str(root / "live.json"), "--candidate", str(root / "candidate.json"),
                "--manifest", str(manifest), "--kind", "StatefulSet", "--name", "cell-runtime-hosts",
                "--related-live", str(root / "related-live.json"),
                "--related-candidate", str(root / "related-candidate.json"),
            ]
            if require_noop:
                command.append("--require-noop")
            if probe_only:
                command.append("--probe-only")
            result = subprocess.run(command, check=False, capture_output=True, text=True)
            return result, manifest.read_text()

    def test_preserves_identity_when_effective_template_and_config_are_equal(self):
        result, manifest = self.run_case(workload(OLD), workload(NEW))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("preserved=true", result.stdout)
        self.assertIn(OLD, manifest)
        self.assertNotIn(NEW, manifest)

    def test_changed_template_does_not_preserve_identity(self):
        result, manifest = self.run_case(workload(OLD), workload(NEW, "example.invalid/changed"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("preserved=false", result.stdout)
        self.assertIn(NEW, manifest)

    def test_changed_related_config_does_not_preserve_identity(self):
        result, manifest = self.run_case(workload(OLD), workload(NEW), related_same=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("preserved=false", result.stdout)
        self.assertIn(NEW, manifest)

    def test_required_noop_fails_before_patching_a_changed_template(self):
        result, manifest = self.run_case(
            workload(OLD), workload(NEW, "example.invalid/changed"), require_noop=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("effective workload differs", result.stderr)
        self.assertIn(NEW, manifest)

    def test_probe_reports_noop_without_patching_manifest(self):
        result, manifest = self.run_case(workload(OLD), workload(NEW), probe_only=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "candidate_identity": NEW,
            "live_identity": OLD,
            "noop": True,
        })
        self.assertIn(NEW, manifest)
        self.assertNotIn(OLD, manifest)

    def test_probe_reports_changed_related_config_without_patching(self):
        result, manifest = self.run_case(
            workload(OLD), workload(NEW), related_same=False, probe_only=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)["noop"])
        self.assertIn(NEW, manifest)


if __name__ == "__main__":
    unittest.main()
