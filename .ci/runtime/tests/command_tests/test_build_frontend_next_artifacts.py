import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
SOURCE = REPO_ROOT / ".ci/runtime/commands/build_frontend_next_artifacts.sh"
SHA = "a" * 40


class FrontendNextHostedTests(unittest.TestCase):
    def run_build(self, *, password="test-registry-secret", expected_sha=SHA):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            command = root / ".ci/runtime/commands/build_frontend_next_artifacts.sh"
            command.parent.mkdir(parents=True)
            command.write_text(SOURCE.read_text())
            (root / "opencraft").mkdir()
            (root / "frontend").mkdir()
            binary = root / "bin"
            binary.mkdir()
            git = binary / "git"
            git.write_text(f"#!/bin/bash\nprintf '%s\\n' '{SHA}'\n")
            git.chmod(0o755)
            tool = binary / "tool"
            tool.write_text('''#!/bin/bash
set -eu
printf '%s:%s:%s\\n' "${PWD##*/}" "$*" "${FRONTEND_ARTIFACT_SOURCE_SHA:-}" >> "$REPO_ROOT/events"
if [[ "$*" == 'run build:embedded-workbench:release' ]]; then
  mkdir -p apps/workbench-web/dist-embedded-workbench/.vite
  touch apps/workbench-web/dist-embedded-workbench/embedded-workbench.js
  touch apps/workbench-web/dist-embedded-workbench/.vite/manifest.json
fi
''')
            tool.chmod(0o755)
            (root / ".ci/init.sh").write_text('''ci_init_repo_root() { export REPO_ROOT; }
ci_require_commands() { :; }
ci_ensure_oras() { echo oras >> "$REPO_ROOT/events"; }
ci_ensure_node() { export NODE_BIN="$REPO_ROOT/bin/tool" NPM_BIN="$REPO_ROOT/bin/tool"; }
ci_ensure_pnpm() { export PNPM_BIN="$REPO_ROOT/bin/tool"; }
''')
            env = {**os.environ, "PATH": f"{binary}:{os.environ['PATH']}",
                   "REGISTRY_USERNAME": "test", "REGISTRY_PASSWORD": password,
                   "FRONTEND_ARTIFACT_MATRIX": "eo:cn-lightvela-prod-next",
                   "FRONTEND_ARTIFACT_REPOSITORY": "registry.invalid/frontend-pages",
                   "FRONTEND_NEXT_EXPECTED_SHA": expected_sha}
            result = subprocess.run(["bash", str(command)], env=env, capture_output=True, text=True)
            events = (root / "events").read_text() if (root / "events").exists() else ""
            return result, events

    def test_build_embedded_workbench_before_frontend_artifacts(self):
        result, events = self.run_build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(events.index("opencraft:run build:embedded-workbench:release"),
                        events.index("frontend:build:release-artifacts"))
        self.assertIn(f"frontend:build:release-artifacts:{SHA}", events)
        self.assertNotIn("test-registry-secret", result.stdout + result.stderr + events)

    def test_missing_or_unresolved_credential_fails_before_downloads(self):
        for password in ("", "${{ settings.TCR_SHPROD_PASSWORD }}"):
            with self.subTest(password=password):
                result, events = self.run_build(password=password)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("requires injected REGISTRY_PASSWORD", result.stderr)
                self.assertEqual(events, "")

    def test_checkout_mismatch_fails_before_downloads(self):
        result, events = self.run_build(expected_sha="b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checkout does not match", result.stderr)
        self.assertEqual(events, "")

    def test_pipeline_uses_public_runner_and_manual_build_only(self):
        workflow = yaml.safe_load((REPO_ROOT / ".ci/frontend-next.yml").read_text())
        # YAML 1.1 parses the Stream key 'on' as True.
        triggers = workflow.get("on", workflow.get(True))
        self.assertEqual(triggers, {"manual": "enabled"})
        self.assertEqual(len(workflow["stages"]), 1)
        jobs = workflow["stages"][0]["jobs"]
        self.assertEqual(set(jobs), {"build"})
        self.assertEqual(jobs["build"]["runs-on"], {"self-hosted": False, "pool-name": "docker"})
        self.assertEqual(jobs["build"]["steps"][-1]["run"],
                         "bash .ci/runtime/commands/build_frontend_next_artifacts.sh")


if __name__ == "__main__":
    unittest.main()
