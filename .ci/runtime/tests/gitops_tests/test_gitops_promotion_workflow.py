import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci/runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops.promotion_policy import policy_for_branch  # noqa: E402
from gitops.shprod_sync_preflight import build_verify_command, parse_trailers  # noqa: E402

APPROVED_GATE_VARS = {
    "GATE_IMAGE_STATUS",
    "GATE_IMAGE_PIN_PAYLOAD",
    "GATE_IMAGE_DIGESTS_JSON",
    "GATE_CONFIG_STATUS",
    "GATE_DB_STATUS",
    "GATE_REQUIRES_DB_READINESS",
    "GATE_AUTO_MERGE_ALLOWED",
    "GATE_AUTO_SYNC_ALLOWED",
    "GATE_ARGO_SYNC",
    "GATE_RELEASE_DEPENDENCY_CHANGED",
    "GATE_MANUAL_ACTIONS",
}


class GitOpsPromotionWorkflowTests(unittest.TestCase):
    def test_sandbox2_branch_is_matched_before_sandbox1(self) -> None:
        sandbox2_policy = policy_for_branch("promote-beijing-sandbox-2-ctl-tag")
        sandbox1_policy = policy_for_branch("promote-beijing-sandbox-ctl-tag")

        self.assertIsNotNone(sandbox2_policy)
        self.assertIsNotNone(sandbox1_policy)
        self.assertEqual(sandbox2_policy.env, "beijing-sandbox-2")
        self.assertEqual(sandbox1_policy.env, "beijing-sandbox")
        self.assertEqual(sandbox2_policy.kustomize_mode.value, "full")

    def test_all_auto_stages_route_sandbox2_promote_branches(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()
        policy = policy_for_branch("promote-beijing-sandbox-2-ctl-tag")

        self.assertIsNotNone(policy)
        self.assertEqual(policy.env, "beijing-sandbox-2")
        self.assertTrue(policy.auto_merge)
        self.assertTrue(policy.cleanup_source_branch)
        self.assertIn("merge_gitops_promotion.py", workflow)
        self.assertIn("verify_gitops_promotion.py", workflow)
        self.assertIn("cleanup_gitops_promotion.py", workflow)

    def test_playground_promote_branches_validate_changed_kustomize_only(self) -> None:
        policy = policy_for_branch("promote-sandbox-bj-7-service-gateway-tag")

        self.assertIsNotNone(policy)
        self.assertEqual(policy.env, "sandbox-bj-7")
        self.assertEqual(policy.kustomize_mode.value, "changed_only")
        self.assertEqual(policy.kustomize_args, ["--changed-only"])
        self.assertEqual(policy.verify_mode.value, "argo_convergence")
        self.assertTrue(policy.auto_merge)

    def test_promotion_workflow_uses_shared_bootstrap_helper(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()
        helper = (REPO_ROOT / ".ci/runtime/gitops_promotion_bootstrap.sh").read_text()

        self.assertNotIn("ci_materialize_runtime_files", workflow)
        self.assertNotIn("ci_prepare_runtime_ref", workflow)
        self.assertNotIn("ci_materialize_runtime_manifest", workflow)
        self.assertEqual(workflow.count("source .ci/runtime/gitops_promotion_bootstrap.sh"), 4)
        self.assertEqual(workflow.count("ci_bootstrap_gitops_promotion_runtime"), 4)
        self.assertEqual(workflow.count("ci_resolve_gitops_promotion_runtime_ref"), 4)
        self.assertEqual(workflow.count("ci_resolve_gitops_promotion_source_branch"), 4)
        self.assertNotIn('--source-branch "${{ ci.branch }}"', workflow)
        self.assertIn("resolved_runtime_ref=", workflow)
        self.assertIn('ci_materialize_runtime_manifest "${runtime_dir}" ".ci/runtime/materialize-files.txt"', helper)
        self.assertIn("ci_gitops_promotion_trailer()", helper)
        self.assertIn("Release-runtime-commit", helper)
        self.assertIn("Release-source-branch", helper)
        self.assertIn("ci_resolve_gitops_promotion_source_branch()", helper)
        self.assertIn("BK_CI_REPO_GIT_WEBHOOK_SOURCE_BRANCH", helper)
        self.assertIn("refs/heads/promote-*", helper)
        self.assertIn("GitOps 合并后验收", workflow)
        self.assertIn("按环境策略自动合并 GitOps MR", workflow)

    def test_promotion_workflow_uses_full_checkout_history(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()

        self.assertEqual(workflow.count("fetchDepth: 0"), 4)
        self.assertNotIn("fetchDepth: 50", workflow)

    def test_build_and_promote_fans_out_auto_pin_envs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake_bin = Path(tmp)
            pins_file = fake_bin / "pins.log"
            fake_python = fake_bin / "python3"
            fake_pin = fake_bin / "pin_image_to_gitops.sh"
            fake_python.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/bash
                    if [[ "$1" == "{REPO_ROOT}/.ci/runtime/commands/build_release_image.py" ]]; then
                      env_name=""
                      output_file=""
                      while [[ $# -gt 0 ]]; do
                        case "$1" in
                          --env)
                            env_name="$2"
                            shift 2
                            ;;
                          --image-output-file)
                            output_file="$2"
                            shift 2
                            ;;
                          *)
                            shift
                            ;;
                        esac
                      done
                      printf '{{"images":{{"SANDBOX_API_IMAGE":"example.com/%s:test-tag"}}}}\\n' "$env_name" > "$output_file"
                      exit 0
                    fi
                    exec "{sys.executable}" "$@"
                    """
                )
            )
            fake_pin.write_text(
                textwrap.dedent(
                    """\
                    #!/bin/bash
                    printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" >> "$PIN_LOG_FILE"
                    """
                )
            )
            fake_python.chmod(0o755)
            fake_pin.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "TCR_BEIJING_PASSWORD": "fake-password",
                    "BUILD_TAG_OVERRIDE": "test-tag",
                    "DEPLOYED_AT": "2026-04-29T00:00:00Z",
                    "PIN_SCRIPT_OVERRIDE": str(fake_pin),
                    "PIN_LOG_FILE": str(pins_file),
                }
            )

            result = subprocess.run(
                [
                    "/bin/bash",
                    str(REPO_ROOT / ".ci/runtime/build_and_promote_to_gitops.sh"),
                    "sandbox",
                    "sandbox",
                    "beijing-sandbox,beijing-sandbox-2",
                    "beijing-sandbox,beijing-sandbox-2",
                ],
                cwd=REPO_ROOT,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )

            pins = pins_file.read_text().splitlines()
            self.assertEqual(len(pins), 2)
            self.assertIn("sandbox\tsandbox\tbeijing-sandbox\t", pins[0])
            self.assertIn("example.com/beijing-sandbox:test-tag", pins[0])
            self.assertIn("sandbox\tsandbox\tbeijing-sandbox-2\t", pins[1])
            self.assertIn("example.com/beijing-sandbox-2:test-tag", pins[1])
            self.assertIn("发布产物已生成：可复制下面参数手动 promote", result.stdout)
            self.assertIn("PIPELINE_MODE=promote TARGET_ENV=beijing-sandbox SOURCE_SHA=", result.stdout)
            self.assertIn("PIPELINE_MODE=promote TARGET_ENV=beijing-sandbox-2 SOURCE_SHA=", result.stdout)

    def test_build_without_auto_pin_prints_manual_promote_hint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake_bin = Path(tmp)
            fake_python = fake_bin / "python3"
            fake_python.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/bash
                    if [[ "$1" == "{REPO_ROOT}/.ci/runtime/commands/build_release_image.py" ]]; then
                      env_name=""
                      output_file=""
                      while [[ $# -gt 0 ]]; do
                        case "$1" in
                          --env)
                            env_name="$2"
                            shift 2
                            ;;
                          --image-output-file)
                            output_file="$2"
                            shift 2
                            ;;
                          *)
                            shift
                            ;;
                        esac
                      done
                      printf 'registry.example.com/frontend:test-tag\\n' > "$output_file"
                      exit 0
                    fi
                    exec "{sys.executable}" "$@"
                    """
                )
            )
            fake_python.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "TCR_SHPROD_PASSWORD": "fake-password",
                    "BUILD_TAG_OVERRIDE": "test-tag",
                    "DEPLOYED_AT": "2026-04-29T00:00:00Z",
                }
            )

            result = subprocess.run(
                [
                    "/bin/bash",
                    str(REPO_ROOT / ".ci/runtime/build_and_promote_to_gitops.sh"),
                    "frontend",
                    "frontend",
                    "shprod",
                    "none",
                ],
                cwd=REPO_ROOT,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )

            source_ref = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, text=True).strip()
            self.assertIn("发布产物已生成：可复制下面参数手动 promote", result.stdout)
            self.assertIn(f"SOURCE_SHA:\x1b[0m {source_ref}", result.stdout)
            self.assertIn("镜像 tag:\x1b[0m test-tag", result.stdout)
            self.assertIn("镜像:\x1b[0m registry.example.com/frontend:test-tag", result.stdout)
            self.assertIn(f"PIPELINE_MODE=promote TARGET_ENV=shprod SOURCE_SHA={source_ref}", result.stdout)
            self.assertIn(
                f"promote_bundle_image_to_gitops.sh frontend frontend shprod {source_ref}",
                result.stdout,
            )

    def test_pin_script_uses_materialized_runtime_after_gitops_checkout(self) -> None:
        script = (REPO_ROOT / ".ci/runtime/pin_image_to_gitops.sh").read_text()

        self.assertIn('cp -R "$REPO_ROOT/.ci/runtime" "$bootstrap_dir/.ci/runtime"', script)
        self.assertIn('RUNTIME_COMMAND_DIR="$bootstrap_dir/.ci/runtime/commands"', script)
        self.assertNotIn("BOOTSTRAP_FILES", script)
        self.assertNotIn('git -C "$REPO_ROOT" add "$bootstrap_file"', script)
        self.assertNotIn('".ci/gitops-promotion.yml"', script)
        self.assertNotIn('".ci/runtime/gitops_promotion_bootstrap.sh"', script)
        self.assertEqual(script.count('python3 "$RUNTIME_COMMAND_DIR/run_release_gates.py"'), 1)
        self.assertNotIn('python3 "$RUNTIME_COMMAND_DIR/plan_release_gates.py"', script)
        self.assertNotIn('python3 "$RUNTIME_COMMAND_DIR/verify_image_exists.py"', script)
        self.assertNotIn('python3 "$RUNTIME_COMMAND_DIR/verify_db_contract.py"', script)
        self.assertNotIn('python3 "$RUNTIME_COMMAND_DIR/validate_gitops_static.py"', script)
        self.assertNotIn('python3 "$RUNTIME_COMMAND_DIR/validate_gitops_kustomize.py"', script)
        self.assertNotIn("run_image_gate", script)
        self.assertNotIn("start_config_gate", script)
        self.assertNotIn("wait_config_gate", script)
        self.assertIn('python3 "$RUNTIME_COMMAND_DIR/project_release_bundle.py"', script)
        self.assertIn('python3 "$RUNTIME_COMMAND_DIR/update_image_pin.py"', script)
        self.assertIn("GitOps 发布意图：准备把镜像推进到", script)
        self.assertIn("Release-gate-image-status:", script)
        self.assertIn("Release-gate-config-status:", script)
        self.assertIn("Release-gate-auto-merge:", script)
        self.assertIn("Release-id: ${RELEASE_ID}", script)
        self.assertIn("Release-created-at: ${DEPLOYED_AT}", script)
        self.assertIn("Release-source-branch: ${PROMOTE_BRANCH}", script)
        self.assertIn("Release-runtime-ref: ${RELEASE_RUNTIME_REF}", script)
        self.assertIn("Release-runtime-commit: ${RELEASE_RUNTIME_COMMIT}", script)
        self.assertIn("Release-bundle: ${BUNDLE_SERVICE}", script)
        self.assertIn("Release-target-env: ${ENV_NAME}", script)
        self.assertIn("Release-pin-targets: ${SERVICE_ARG}", script)
        self.assertIn("Release-image: ${IMAGE}", script)
        self.assertIn("Release-image-pin: ${PIN_IMAGE}", script)
        self.assertIn("Release-image-digests: ${GATE_IMAGE_DIGESTS_JSON}", script)
        self.assertIn('--image "$PIN_IMAGE"', script)

    def test_pin_script_consumes_only_approved_gate_variables(self) -> None:
        script = (REPO_ROOT / ".ci/runtime/pin_image_to_gitops.sh").read_text()
        found_gate_vars = set(re.findall(r"\bGATE_[A-Z_]+\b", script))

        self.assertEqual(found_gate_vars, APPROVED_GATE_VARS)
        self.assertNotIn("GATE_DB_MODE", found_gate_vars)
        self.assertNotIn("GATE_REQUIRES_DB_JOB", found_gate_vars)
        self.assertNotIn("GATE_DB_JOB_SERVICE", found_gate_vars)
        self.assertNotIn("GATE_READINESS_SUPPORTED", found_gate_vars)
        self.assertNotIn("GATE_RELEASE_DEPENDENCIES", found_gate_vars)

    def test_prod_promote_branches_are_not_removed_by_automation(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()
        pin_script = (REPO_ROOT / ".ci/runtime/pin_image_to_gitops.sh").read_text()
        for branch in ["promote-shprod-lightclaw-auth-tag", "promote-sgprod-lightclaw-auth-tag"]:
            with self.subTest(branch=branch):
                policy = policy_for_branch(branch)

                self.assertIsNotNone(policy)
                self.assertFalse(policy.cleanup_source_branch)
                self.assertEqual(policy.verify_mode.value, "merge_only")
                self.assertEqual(policy.kustomize_mode.value, "changed_only")
                self.assertEqual(policy.required_argo_sync, "manual")
        self.assertIn("cleanup_gitops_promotion.py", workflow)
        self.assertIn("北京收敛与上海待同步验收", workflow)
        self.assertIn('case "$ENV_NAME" in', pin_script)
        self.assertIn("shprod)", pin_script)
        self.assertIn("sgprod)", pin_script)
        self.assertIn("MR_ARGS+=(--remove-source-branch)", pin_script)
        self.assertIn("进入${ENV_DISPLAY_NAME}待同步状态", pin_script)

    def test_shprod_workflow_avoids_unsupported_stage_check_in(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()

        self.assertNotIn("check-in:", workflow)
        self.assertNotIn("上海生产人工 Sync 审批", workflow)
        self.assertNotIn("人工审批后 DB readiness 只读校验", workflow)
        self.assertNotIn("校验人工 Argo sync 前 DB readiness", workflow)
        self.assertIn("不执行 migration，不执行 Argo sync", (REPO_ROOT / ".ci/runtime/gitops/shprod_sync_preflight.py").read_text())

    def test_shprod_preflight_parses_release_context_trailers(self) -> None:
        trailers = parse_trailers(
            textwrap.dedent(
                """\
                进入上海正式待同步状态：frontend

                Release-bundle: frontend
                Release-target-env: shprod
                Release-pin-targets: frontend
                Release-image: lightclaw-shprod.tencentcloudcr.com/lightclaw/frontend:frontend-abc
                Release-gate-argo-sync: manual
                Source-revision: abcdef
                """
            )
        )

        self.assertEqual(trailers["Release-bundle"], "frontend")
        self.assertEqual(trailers["Release-target-env"], "shprod")
        self.assertEqual(trailers["Release-pin-targets"], "frontend")
        self.assertEqual(trailers["Release-gate-argo-sync"], "manual")

    def test_shprod_preflight_builds_readonly_db_verify_command(self) -> None:
        command = build_verify_command(
            runtime_dir=REPO_ROOT / ".ci/runtime",
            repo_root=REPO_ROOT,
            bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
            service="payment",
            env="shprod",
            apply=True,
            wait=True,
            timeout_seconds=123,
        )

        self.assertIn(str(REPO_ROOT / ".ci/runtime/commands/verify_db_contract.py"), command)
        self.assertIn("--service", command)
        self.assertIn("payment", command)
        self.assertIn("--env", command)
        self.assertIn("shprod", command)
        self.assertIn("--apply", command)
        self.assertIn("--wait", command)
        self.assertNotIn("run_gitops_db_job.py", " ".join(command))


if __name__ == "__main__":
    unittest.main()
