#!/usr/bin/env python3
"""Run the actual shell entry points against local, fail-closed API doubles."""

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import test_host_autoscaling as manifests
import test_host_drain_profile as profiles


ROOT = Path(__file__).resolve().parent
IMAGE = "registry.example/actor-fleet/actor-fleet-controller@sha256:" + "1" * 64


class HostDrainScriptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="host-drain-script-", dir="/data/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.kubectl = self.bin / "kubectl"
        shutil.copyfile(ROOT / "testdata" / "host_drain_kubectl_double.py", self.kubectl)
        self.kubectl.chmod(0o700)
        self.production_bundle = manifests.HostAutoscalingManifestTests().render()
        self.production = next(item for item in self.production_bundle if item["kind"] == "Deployment")
        self.env = {
            key: value for key, value in os.environ.items()
            if key in ("PATH", "LANG", "LC_ALL", "PYTHONPATH")
        }
        self.env.update({
            "PATH": str(self.bin) + os.pathsep + self.env.get("PATH", os.defpath),
            "TMPDIR": str(self.root), "PYTHONDONTWRITEBYTECODE": "1",
            "DRAIN_TEST_ROOT": str(self.root), "KUBECONFIG": str(self.root / "synthetic-config"),
            "RIVET_CELL_NAME": "actor-bj-a01", "RIVET_CELL_NAMESPACE": "actor-fdb-cell-system",
            "RIVET_REPORTER_IMAGE": IMAGE, "RUNTIME_CAPACITY_MIN_REPLICAS": "3",
        })
        # Execute fixture with exactly the test interpreter, not an ambient Python.
        content = self.kubectl.read_text()
        self.kubectl.write_text("#!" + sys.executable + "\n" + content.split("\n", 1)[1])

    def invoke(self, script, **environment):
        return subprocess.run(
            ["bash", str(script)], env=self.env | environment,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10,
        )

    def calls(self):
        path = self.root / "calls.ndjson"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def applied(self):
        return json.loads((self.root / "bundle.json").read_text())["items"]

    def test_default_install_preserves_production_manifest(self):
        result = self.invoke(ROOT / "install-host-autoscaling.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.applied(), self.production_bundle)
        self.assertFalse(any("--dry-run=client" in args for args in self.calls()))
        self.assertIn("profile=production", result.stdout)
        self.assertTrue(any(args[-1] == "json" for args in self.calls()))

    def test_exploration_install_and_production_restore(self):
        result = self.invoke(
            ROOT / "install-host-autoscaling.sh",
            RUNTIME_HOST_DRAIN_PROFILE="exploration", AUTONOMY_OPERATION_LOCK_HELD="1",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = copy.deepcopy(self.production_bundle)
        for index, document in enumerate(expected):
            if document["kind"] == "Deployment":
                expected[index] = profiles.PROFILE.render_profile(document, "exploration")
        self.assertEqual(self.applied(), expected)
        self.assertIn("profile=exploration", result.stdout)
        self.assertTrue(any("--dry-run=client" in args for args in self.calls()))
        # The same real installer restores production; no remembered object patch.
        restored = self.invoke(ROOT / "install-host-autoscaling.sh")
        self.assertEqual(restored.returncode, 0, restored.stderr)
        self.assertEqual(self.applied(), self.production_bundle)

    def test_modes_fail_before_any_api_call(self):
        cases = [
            ("install-host-autoscaling.sh", {"RUNTIME_HOST_DRAIN_PROFILE": "unknown"}, 2),
            ("install-host-autoscaling.sh", {"RUNTIME_HOST_DRAIN_PROFILE": "exploration"}, 75),
            ("install.sh", {"RUNTIME_HOST_DRAIN_PROFILE": "unknown"}, 2),
            ("install.sh", {"RUNTIME_HOST_DRAIN_PROFILE": "exploration"}, 75),
            ("install.sh", {"RUNTIME_HOST_DRAIN_PROFILE": "exploration", "RIVET_RUNTIME_PROFILE": "e2e-fast", "AUTONOMY_OPERATION_LOCK_HELD": "1"}, 2),
            ("release-runtime.sh", {"RUNTIME_HOST_DRAIN_PROFILE": "exploration"}, 2),
            ("release-runtime.sh", {"RUNTIME_HOST_DRAIN_PROFILE": "unknown"}, 2),
        ]
        for name, environment, status in cases:
            with self.subTest(script=name, environment=environment):
                result = self.invoke(ROOT / name, **environment)
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertEqual(self.calls(), [])
                self.assertFalse((self.root / "bundle.json").exists())

    def test_installer_rejects_live_drift_and_api_failure(self):
        for mode in ("timer-drift", "malformed", "get-failed"):
            with self.subTest(mode=mode):
                result = self.invoke(ROOT / "install-host-autoscaling.sh", DRAIN_TEST_LIVE_MODE=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("autoscaling converged:", result.stdout)

    def qualification_boundary(self, live, *, mode="normal", profile="production", caller="production"):
        (self.root / "live.json").write_text(json.dumps(live))
        runtime = self.root / "runtime"
        runtime.mkdir(exist_ok=True)
        operations = self.root / "operations"
        operations.mkdir(exist_ok=True)
        for name in ("qualify-runtime.sh", "host-drain-profile.py"):
            shutil.copyfile(ROOT / name, runtime / name)
        scripts = {
            operations / "with-autonomy-operation-lock.sh":
                '#!/usr/bin/env bash\nset -euo pipefail\necho lock >> "$DRAIN_TEST_ROOT/events"\nexport AUTONOMY_OPERATION_LOCK_HELD=1\n[[ $1 == -- ]]\nshift\nexec "$@"\n',
            operations / "assert-autonomy-control.sh":
                '#!/usr/bin/env bash\nset -euo pipefail\n[[ $AUTONOMY_OPERATION_LOCK_HELD == 1 ]]\necho control >> "$DRAIN_TEST_ROOT/events"\n',
            runtime / "with-runtime-scale-in-hold.sh":
                '#!/usr/bin/env bash\nset -euo pipefail\necho hold >> "$DRAIN_TEST_ROOT/events"\necho qualification_hold_boundary_reached\nexit 0\n',
        }
        for path, content in scripts.items():
            path.write_text(content)
            path.chmod(0o700)
        (runtime / "qualify-runtime.sh").chmod(0o700)
        return self.invoke(
            runtime / "qualify-runtime.sh", DRAIN_TEST_LIVE_MODE=mode,
            QUALIFICATION_PROFILE=profile, RUNTIME_HOST_DRAIN_PROFILE=caller,
        )

    def test_qualification_rejects_actual_exploration_before_hold(self):
        live = profiles.PROFILE.render_profile(self.production, "exploration")
        for profile in ("production", "production-cell"):
            with self.subTest(profile=profile):
                result = self.qualification_boundary(live, profile=profile, caller="production")
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn("qualification_hold_boundary_reached", result.stdout)
        self.assertNotIn("hold", (self.root / "events").read_text().splitlines())

    def test_production_qualification_checks_live_after_operation_lock(self):
        result = self.qualification_boundary(self.production)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "events").read_text().splitlines(), ["lock", "control", "get-deployment", "hold"])
        self.assertIn("qualification_hold_boundary_reached", result.stdout)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.calls()[0][-4:], ["deployment", "actor-bj-a01-host-drain", "-o", "json"])

    def test_qualification_fails_closed_on_invalid_live_state(self):
        for mode in ("timer-drift", "malformed", "get-failed"):
            with self.subTest(mode=mode):
                result = self.qualification_boundary(self.production, mode=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("qualification_hold_boundary_reached", result.stdout)
        self.assertNotIn("hold", (self.root / "events").read_text().splitlines())

    def test_fast_data_path_remains_development_not_production_profile(self):
        result = self.qualification_boundary(
            profiles.PROFILE.render_profile(self.production, "exploration"), profile="e2e-fast", caller="exploration",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertIn("qualification_hold_boundary_reached", result.stdout)


if __name__ == "__main__":
    unittest.main()
