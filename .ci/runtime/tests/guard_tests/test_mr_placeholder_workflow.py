import os
import subprocess
import tempfile
import unittest

import yaml
from pathlib import Path

REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


class MRPlaceholderWorkflowTests(unittest.TestCase):
    def test_every_ci_job_uses_the_domestic_runner_pool(self) -> None:
        parameterized_pool = "${{ parameters.RUNNER_POOL_NAME }}"
        for workflow_path in sorted((REPO_ROOT / ".ci").glob("**/*.yml")):
            with self.subTest(workflow=workflow_path.relative_to(REPO_ROOT)):
                for line_number, line in enumerate(workflow_path.read_text().splitlines(), start=1):
                    stripped = line.strip()
                    if not stripped.startswith("pool-name:"):
                        continue
                    pool_name = stripped.partition(":")[2].strip()
                    if pool_name == parameterized_pool:
                        self.assertEqual(
                            workflow_path,
                            REPO_ROOT / ".ci/templates/service-release.yml",
                            f"parameterized runner pool at {workflow_path}:{line_number}",
                        )
                        continue
                    self.assertEqual(
                        pool_name,
                        "cn-pool",
                        f"non-domestic runner pool at {workflow_path}:{line_number}",
                    )

        service_release = (REPO_ROOT / ".ci/templates/service-release.yml").read_text()
        runner_parameter = service_release.split("  - name: RUNNER_POOL_NAME\n", 1)[1].split("  - name:", 1)[0]
        self.assertIn("    default: cn-pool", runner_parameter)

    def test_runs_on_the_domestic_runner_pool(self) -> None:
        workflow = (REPO_ROOT / ".ci/mr-placeholder.yml").read_text()

        job_block = workflow.split("      changed_guards:\n", 1)[1].split("        steps:\n", 1)[0]
        self.assertIn("          pool-name: cn-pool", job_block)
        self.assertNotIn("          pool-name: env", job_block)

    def test_only_mr_events_trigger_the_placeholder_check(self) -> None:
        workflow = (REPO_ROOT / ".ci/mr-placeholder.yml").read_text()

        trigger_block = workflow.split("on:\n", 1)[1].split("\nstages:\n", 1)[0]
        self.assertNotIn("  push:", trigger_block)
        self.assertIn("  mr:\n", trigger_block)
        self.assertIn("    action: [ open, reopen, push-update ]", trigger_block)
        self.assertIn("    report-commit-check: true", trigger_block)
        self.assertIn("    block-mr: true", trigger_block)

    def test_new_mr_updates_cancel_older_checks_for_the_same_branch(self) -> None:
        workflow = (REPO_ROOT / ".ci/mr-placeholder.yml").read_text()

        concurrency_block = workflow.split("concurrency:\n", 1)[1].split("\nstages:\n", 1)[0]
        self.assertIn("  group: mr-placeholder-${{ ci.branch }}", concurrency_block)
        self.assertIn("  cancel-in-progress: true", concurrency_block)
        self.assertIn("  queue-length: 1", concurrency_block)

    def test_checkout_disables_virtual_merge_branch(self) -> None:
        workflow = (REPO_ROOT / ".ci/mr-placeholder.yml").read_text()

        checkout_block = workflow.split("checkout: self", 1)[1].split("          - name: 校验并修复 MR checkout", 1)[0]
        self.assertIn("fetchDepth: 50", checkout_block)
        self.assertIn("enableVirtualMergeBranch: false", checkout_block)
        self.assertIn("enableSubmodule: false", checkout_block)

    def test_ci_only_candidate_guard_fallback_is_constrained(self) -> None:
        workflow = (REPO_ROOT / ".ci/mr-placeholder.yml").read_text()

        self.assertIn("GIT_WOA_PRIVATE_TOKEN: ${{ settings.GIT_WOA_PRIVATE_TOKEN }}", workflow)
        self.assertIn("source .ci/init.sh", workflow)
        self.assertIn("ci_git_fetch_origin master", workflow)
        self.assertIn("CI_EXPECTED_BRANCH='${{ ci.branch }}'", workflow)
        self.assertIn("CI_EXPECTED_SHA='${{ ci.sha }}'", workflow)
        self.assertIn('ci_git_fetch_origin master "$CI_EXPECTED_BRANCH"', workflow)
        self.assertIn('CI_ACTUAL_SHA="$(git rev-parse HEAD)"', workflow)
        self.assertIn('git reset --hard "$CI_EXPECTED_SHA"', workflow)
        self.assertIn("git clean -ffd", workflow)
        self.assertIn('test "$(git rev-parse HEAD)" = "$CI_EXPECTED_SHA"', workflow)
        self.assertLess(workflow.index("checkout: self"), workflow.index("校验并修复 MR checkout"))
        self.assertLess(workflow.index("校验并修复 MR checkout"), workflow.index("派发变更目录约束"))
        self.assertNotIn("git fetch origin master", workflow)
        init_script = (REPO_ROOT / ".ci/init.sh").read_text()
        self.assertIn("CI_GIT_FETCH_REMOTE_URL:-git@git.woa.com:wisp/mono2.git", init_script)
        self.assertIn("+refs/heads/${arg}:refs/remotes/origin/${arg}", init_script)
        self.assertIn('export CI_RUNTIME_REF="origin/master"', workflow)
        self.assertIn('git rev-parse "${CI_RUNTIME_REF}"', workflow)
        self.assertNotIn("ci_prepare_runtime_ref origin/master", workflow)
        self.assertIn("--trusted-ref origin/master", workflow)
        self.assertIn('--changed-files-file "$CHANGED_FILES_FILE"', workflow)
        self.assertIn("trusted guard 失败，检查是否允许 .ci 自修复 fallback", workflow)
        self.assertIn("grep -Ev '^\\s*$|^\\.ci(/|$)'", workflow)
        self.assertIn("存在非 .ci/** 变更，禁止 fallback", workflow)
        self.assertIn("[[ ! -f .ci/checks/guard.sh ]]", workflow)
        self.assertIn("bash .ci/checks/guard.sh", workflow)
        self.assertIn('GUARD_NAME="ci-runtime-candidate"', workflow)

    def test_checkout_restores_stale_tracked_files_even_at_expected_head(self) -> None:
        workflow = yaml.safe_load((REPO_ROOT / ".ci/mr-placeholder.yml").read_text())
        steps = workflow["stages"][0]["jobs"]["changed_guards"]["steps"]
        script = next(step["run"] for step in steps if step.get("name") == "校验并修复 MR checkout")
        for staged in (False, True):
            with self.subTest(staged=staged), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                def git(*args):
                    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()
                git("init", "-q")
                git("config", "user.name", "fixture")
                git("config", "user.email", "fixture@example.invalid")
                (root / ".ci").mkdir()
                (root / ".ci/init.sh").write_text("ci_git_fetch_origin() { return 0; }\n")
                source = root / "frontend/src/contexts/runtime-config-context.tsx"
                target = root / "opencraft/plugins/lightvela-hermes/src/upstream/mono2/contexts/runtime-config-context.tsx"
                for file in (source, target):
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_text("expected snapshot\n")
                git("add", ".")
                git("commit", "-qm", "expected source and generated snapshot")
                sha = git("rev-parse", "HEAD")
                source.write_text("residual source from reused workspace\n")
                target.write_text("old generated snapshot\n")
                if staged:
                    git("add", "frontend", "opencraft")
                (root / "stale-untracked.ts").write_text("residual file")
                self.assertEqual(git("rev-parse", "HEAD"), sha)
                run_script = script.replace("${{ ci.branch }}", "fixture").replace("${{ ci.sha }}", sha)
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", run_script],
                                        cwd=root, env=os.environ.copy(), capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(git("rev-parse", "HEAD"), sha)
                self.assertEqual(git("status", "--porcelain"), "")
                for file in (source, target):
                    self.assertEqual(file.read_text(), "expected snapshot\n")

    def test_opencraft_guard_bootstraps_node_before_sync(self) -> None:
        guard = (REPO_ROOT / ".ci/checks/opencraft_guard.sh").read_text()
        self.assertIn("source .ci/init.sh", guard)
        self.assertIn("ci_init_repo_root", guard)
        self.assertIn('if [[ "$(uname -s)" == "Linux" ]]; then\n  ci_ensure_node\nfi', guard)
        self.assertLess(guard.index("ci_ensure_node"), guard.index("node opencraft/scripts/sync-mono2-agent-console.mjs --check"))


if __name__ == "__main__":
    unittest.main()
