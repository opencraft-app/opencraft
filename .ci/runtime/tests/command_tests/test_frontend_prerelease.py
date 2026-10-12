import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/frontend.yml").is_file())


class FrontendPrereleaseTests(unittest.TestCase):
    def run_prerelease(self, matrix: str, branch: str = "master", fail_release: bool = False):
        workflow = yaml.safe_load((REPO_ROOT / ".ci/frontend.yml").read_text())
        steps = workflow["stages"][0]["jobs"]["release"]["steps"]
        step = next(step for step in steps if step.get("name") == "发布 frontend EdgeOne 北京预发 artifact 矩阵")
        script = step["run"].replace("${{ variables.PIPELINE_MODE }}", "build").replace("${{ ci.branch }}", branch)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".ci").mkdir()
            (root / "frontend").mkdir()
            calls = root / "calls"
            (root / ".ci/init.sh").write_text("""ci_init_repo_root() { :; }
ci_load_edgeone_credentials() { :; }
ci_set_registry_credentials() { :; }
ci_ensure_oras() { :; }
ci_ensure_node() { :; }
ci_ensure_pnpm() { :; }
""")
            pnpm = root / "pnpm"
            pnpm.write_text("""#!/usr/bin/env bash
printf '%s:%s\n' "$1" "$FRONTEND_RELEASE_MATRIX" >> "$CALLS_FILE"
if [[ "$1" == "release:eo:artifact" && "$FAIL_RELEASE" == "1" ]]; then exit 7; fi
""")
            pnpm.chmod(0o755)
            result = subprocess.run(["bash", "-c", script], cwd=root, capture_output=True, text=True, env={
                **os.environ, "REPO_ROOT": str(root), "PNPM_BIN": str(pnpm),
                "FRONTEND_RELEASE_MATRIX": matrix, "CALLS_FILE": str(calls),
                "FAIL_RELEASE": "1" if fail_release else "0",
            })
            return result, calls.read_text().splitlines() if calls.exists() else []

    def test_publishes_both_archived_variants_sequentially(self):
        result, calls = self.run_prerelease("eo:cn-lightvela-prerelease, eo:global-lightvela-prerelease-preview")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[1:], ["release:eo:artifact:eo:cn-lightvela-prerelease", "release:eo:artifact:eo:global-lightvela-prerelease-preview"])

    def test_rejects_cf_and_formal_projects_before_any_install_or_deploy(self):
        for combo in ["cf:cn-lightvela-staging", "eo:cn-lightvela-prod-next", "eo:global-lightvela-intl-prod-next"]:
            with self.subTest(combo=combo):
                result, calls = self.run_prerelease("eo:cn-lightvela-prerelease," + combo)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_empty_matrix_and_playground_skip_shared_project(self):
        for matrix, branch in [(" , ", "master"), ("eo:cn-lightvela-prerelease", "playground/sandbox-bj-1")]:
            result, calls = self.run_prerelease(matrix, branch)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(calls, [])

    def test_first_variant_failure_stops_release(self):
        result, calls = self.run_prerelease("eo:cn-lightvela-prerelease,eo:global-lightvela-prerelease-preview", fail_release=True)
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(calls[1:], ["release:eo:artifact:eo:cn-lightvela-prerelease"])
