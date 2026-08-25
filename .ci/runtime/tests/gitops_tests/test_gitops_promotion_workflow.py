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

    def test_korea_playground_promote_branches_use_same_auto_policy(self) -> None:
        policy = policy_for_branch("promote-sandbox-kr-1-service-gateway-tag")

        self.assertIsNotNone(policy)
        self.assertEqual(policy.env, "sandbox-kr-1")
        self.assertEqual(policy.display_name, "韩国 Playground sandbox-kr-1")
        self.assertEqual(policy.kustomize_args, ["--changed-only"])
        self.assertTrue(policy.auto_merge)

    def test_tokyo_playground_promote_branches_merge_without_sync_during_onboarding(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()
        policy = policy_for_branch("promote-sandbox-jp-1-service-gateway-tag")

        self.assertIsNotNone(policy)
        self.assertEqual(policy.env, "sandbox-jp-1")
        self.assertEqual(policy.display_name, "东京 Playground sandbox-jp-1")
        self.assertEqual(policy.kustomize_args, ["--changed-only"])
        self.assertEqual(policy.verify_mode.value, "merge_only")
        self.assertTrue(policy.auto_merge)
        self.assertFalse(policy.auto_sync)
        self.assertTrue(policy.cleanup_source_branch)
        self.assertEqual(policy.required_argo_sync, "manual")
        self.assertIn("promote-sandbox-jp-*", workflow)

    def test_devcloud_dep_promote_branches_auto_merge_like_beijing(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()
        pin_script = (REPO_ROOT / ".ci/runtime/pin_image_to_gitops.sh").read_text()
        policy = policy_for_branch("promote-devcloud-dep-channelgateway-tag")

        self.assertIsNotNone(policy)
        self.assertEqual(policy.env, "devcloud-dep")
        self.assertTrue(policy.auto_merge)
        self.assertTrue(policy.auto_sync)
        self.assertTrue(policy.cleanup_source_branch)
        self.assertEqual(policy.verify_mode.value, "argo_convergence")
        self.assertEqual(policy.kustomize_mode.value, "full")
        self.assertIn("promote-devcloud-dep-*", workflow)
        self.assertIn("devcloud-dep) printf 'DevCloud dep' ;;", pin_script)

    def test_shanghai_workers_promote_branches_auto_merge_like_beijing(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()
        policy = policy_for_branch(
            "promote-shanghai-workers-workers-rescue-exporter-workers-hermes-importer-workers-570650e0406c"
        )

        self.assertIsNotNone(policy)
        self.assertEqual(policy.env, "shanghai-workers")
        self.assertTrue(policy.auto_merge)
        self.assertTrue(policy.auto_sync)
        self.assertTrue(policy.cleanup_source_branch)
        self.assertEqual(policy.verify_mode.value, "argo_convergence")
        self.assertEqual(policy.kustomize_mode.value, "full")
        self.assertIn("promote-shanghai-workers-*", workflow)

    def test_beijing_llmgateway_promote_branches_auto_merge_like_beijing(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()
        pin_script = (REPO_ROOT / ".ci/runtime/pin_image_to_gitops.sh").read_text()
        policy = policy_for_branch("promote-beijing-llmgateway-velagw-tag")

        self.assertIsNotNone(policy)
        self.assertEqual(policy.env, "beijing-llmgateway")
        self.assertTrue(policy.auto_merge)
        self.assertTrue(policy.auto_sync)
        self.assertTrue(policy.cleanup_source_branch)
        self.assertEqual(policy.verify_mode.value, "argo_convergence")
        self.assertEqual(policy.kustomize_mode.value, "full")
        self.assertIn("promote-beijing-llmgateway-*", workflow)
        self.assertIn("beijing-llmgateway) printf '北京 LLMGateway 测试' ;;", pin_script)

    def test_promotion_workflow_uses_shared_bootstrap_helper(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()
        helper = (REPO_ROOT / ".ci/runtime/gitops_promotion_bootstrap.sh").read_text()

        self.assertIn("promote-beijing-sandbox-*", workflow)
        self.assertIn("promote-beijing-sandbox-2-*", workflow)
        self.assertIn("promote-sandbox-bj-*", workflow)
        self.assertIn("promote-sandbox-kr-*", workflow)
        self.assertIn("promote-sandbox-jp-*", workflow)
        self.assertIn("promote-devcloud-dep-*", workflow)
        self.assertIn("promote-shanghai-workers-*", workflow)
        self.assertIn("promote-beijing-llmgateway-*", workflow)
        self.assertNotIn("- promote-*", workflow)
        self.assertNotIn("promote-shprod-*", workflow)
        self.assertNotIn("promote-sgprod-*", workflow)
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
        self.assertIn("does not contain .ci/init.sh; falling back to", helper)
        self.assertIn('ci_bootstrap_prepare_runtime_ref "${CI_RUNTIME_FALLBACK_REF:-origin/master}"', helper)
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
            self.assertIn("发布产物已生成：当前构建没有待人工确认的正式环境 promote", result.stdout)
            self.assertIn("发布方式：\x1b[0mauto-pin", result.stdout)
            self.assertIn("北京沙箱 DB 变更过程：", result.stdout)
            self.assertIn("GitOps release gate 自动执行受控 DB job -> DB readiness 只读校验 -> 自动合并/收敛", result.stdout)
            self.assertNotIn("PIPELINE_MODE=promote TARGET_ENV=beijing-sandbox SOURCE_SHA=", result.stdout)
            self.assertNotIn("DB 变更先执行 CI：", result.stdout)

    def test_playground_auto_pin_suppresses_prod_followups(self) -> None:
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
                      printf 'registry.example.com/%s:test-tag\\n' "$env_name" > "$output_file"
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
                    "gateway-dashboard",
                    "gateway-dashboard",
                    "sandbox-bj-7",
                    "sandbox-bj-7",
                ],
                cwd=REPO_ROOT,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )

            self.assertIn("发布产物已生成：当前构建没有待人工确认的正式环境 promote", result.stdout)
            self.assertIn("Playground 发布后续：", result.stdout)
            self.assertIn("无需生产人工审批；不展示生产 DB migration 参数", result.stdout)
            self.assertNotIn("生产发布确认", result.stdout)

    def test_build_and_auto_pin_can_be_split_for_ci_visibility(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake_bin = Path(tmp)
            image_dir = fake_bin / "images"
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
                      printf 'registry.example.com/%s:test-tag\\n' "$env_name" > "$output_file"
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
            base_env = os.environ.copy()
            base_env.update(
                {
                    "PATH": f"{fake_bin}:{base_env['PATH']}",
                    "TCR_BEIJING_PASSWORD": "fake-password",
                    "TCR_SHPROD_PASSWORD": "fake-password",
                    "BUILD_TAG_OVERRIDE": "test-tag",
                    "DEPLOYED_AT": "2026-04-29T00:00:00Z",
                    "PIN_SCRIPT_OVERRIDE": str(fake_pin),
                    "PIN_LOG_FILE": str(pins_file),
                    "RELEASE_IMAGE_DIR": str(image_dir),
                }
            )

            build_env = base_env | {"BUILD_ONLY": "true"}
            build_result = subprocess.run(
                [
                    "/bin/bash",
                    str(REPO_ROOT / ".ci/runtime/build_and_promote_to_gitops.sh"),
                    "gateway-dashboard",
                    "gateway-dashboard",
                    "beijing-sandbox,shprod",
                    "beijing-sandbox",
                ],
                cwd=REPO_ROOT,
                env=build_env,
                check=True,
                capture_output=True,
                text=True,
            )

            self.assertEqual((image_dir / "beijing-sandbox").read_text().strip(), "registry.example.com/beijing-sandbox:test-tag")
            self.assertEqual((image_dir / "shprod").read_text().strip(), "registry.example.com/shprod:test-tag")
            self.assertIn("build-only mode", build_result.stdout)
            self.assertFalse(pins_file.exists())

            auto_pin_env = base_env | {"AUTO_PIN_ONLY": "true"}
            auto_pin_result = subprocess.run(
                [
                    "/bin/bash",
                    str(REPO_ROOT / ".ci/runtime/build_and_promote_to_gitops.sh"),
                    "gateway-dashboard",
                    "gateway-dashboard",
                    "beijing-sandbox,shprod",
                    "beijing-sandbox",
                ],
                cwd=REPO_ROOT,
                env=auto_pin_env,
                check=True,
                capture_output=True,
                text=True,
            )

            pins = pins_file.read_text().splitlines()
            self.assertEqual(len(pins), 1)
            self.assertIn("gateway-dashboard\tgateway-dashboard\tbeijing-sandbox\tregistry.example.com/beijing-sandbox:test-tag", pins[0])
            self.assertIn("北京测试 DB 变更检查 / GitOps auto-pin 独立步骤", auto_pin_result.stdout)
            self.assertIn("环境级 DB 变更检查：beijing-sandbox", auto_pin_result.stdout)
            self.assertNotIn("可发布版本汇总", auto_pin_result.stdout)

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
            self.assertIn("可发布版本汇总", result.stdout)
            self.assertIn("发布产物已生成：构建 CI 会在人工确认后自动 promote 正式环境", result.stdout)
            self.assertIn("CI：\x1b[0m构建 frontend", result.stdout)
            self.assertIn(f"SOURCE_SHA={source_ref}", result.stdout)
            self.assertIn("镜像 tag：\x1b[0mtest-tag", result.stdout)
            self.assertIn("镜像：\x1b[0mregistry.example.com/frontend:test-tag", result.stdout)
            self.assertIn(f"PIPELINE_MODE=promote TARGET_ENV=shprod SOURCE_SHA={source_ref}", result.stdout)
            self.assertIn(f"DB 变更参数:\x1b[0m SERVICE=frontend TARGET_ENV=shprod SOURCE_SHA={source_ref} TIMEOUT_SECONDS=1800", result.stdout)
            self.assertIn(
                f"promote_bundle_image_to_gitops.sh frontend frontend shprod {source_ref}",
                result.stdout,
            )

    def test_manual_promote_fans_out_csv_target_envs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake_bin = Path(tmp)
            source_repo = fake_bin / "source"
            fake_runtime = fake_bin / "runtime"
            fake_runtime_commands = fake_runtime / "commands"
            pins_file = fake_bin / "pins.log"
            fake_python = fake_bin / "python3"
            fake_pin = fake_bin / "pin_image_to_gitops.sh"
            fake_resolver = fake_runtime_commands / "resolve_release_bundle.py"
            fake_runtime_commands.mkdir(parents=True)
            fake_resolver.touch()
            (source_repo / "ctl/migrations").mkdir(parents=True)
            (source_repo / "ctl/migrations/000028_test.up.sql").write_text("SELECT 1;\n")
            subprocess.run(["git", "init"], cwd=source_repo, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.name", "CI Test"], cwd=source_repo, check=True)
            subprocess.run(["git", "config", "user.email", "ci-test@example.com"], cwd=source_repo, check=True)
            subprocess.run(["git", "add", "."], cwd=source_repo, check=True)
            subprocess.run(["git", "commit", "-m", "source"], cwd=source_repo, check=True, capture_output=True)
            fake_python.write_text(
                textwrap.dedent(
                    f"""\
                    #!/bin/bash
                    if [[ "$1" == "{fake_resolver}" ]]; then
                      env_name=""
                      tag=""
                      while [[ $# -gt 0 ]]; do
                        case "$1" in
                          --env)
                            env_name="$2"
                            shift 2
                            ;;
                          --tag)
                            tag="$2"
                            shift 2
                            ;;
                          *)
                            shift
                            ;;
                        esac
                      done
                      printf 'BUILD_IMAGE=%q\\n' "registry.example.com/admin-gateway-${{env_name}}:${{tag}}"
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
                    migration_count="$(find "$REPO_ROOT/ctl/migrations" -maxdepth 1 -name '*.up.sql' 2>/dev/null | wc -l | tr -d '[:space:]')"
                    printf '%s\t%s\t%s\n' "$3" "$REPO_ROOT" "$migration_count" >> "$PIN_LOG_FILE"
                    mv "$REPO_ROOT/ctl/migrations" "$REPO_ROOT/ctl/migrations.promoted" 2>/dev/null || true
                    """
                )
            )
            fake_python.chmod(0o755)
            fake_pin.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}:{env['PATH']}",
                    "RUNTIME_COMMAND_DIR": str(fake_runtime_commands),
                    "PIN_SCRIPT_OVERRIDE": str(fake_pin),
                    "PIN_LOG_FILE": str(pins_file),
                    "REPO_ROOT": str(source_repo),
                }
            )

            source_ref = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source_repo, text=True
            ).strip()
            subprocess.run(
                [
                    "/bin/bash",
                    str(REPO_ROOT / ".ci/runtime/promote_bundle_image_to_gitops.sh"),
                    "admin-gateway",
                    "admin-gateway",
                    "shprod,sgprod",
                    source_ref,
                ],
                cwd=source_repo,
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )

            pins = pins_file.read_text().splitlines()
            self.assertEqual(len(pins), 2)
            shprod_env, shprod_root, shprod_migrations = pins[0].split("\t")
            sgprod_env, sgprod_root, sgprod_migrations = pins[1].split("\t")
            self.assertEqual(shprod_env, "shprod")
            self.assertEqual(sgprod_env, "sgprod")
            self.assertNotEqual(shprod_root, sgprod_root)
            self.assertEqual(shprod_migrations, "1")
            self.assertEqual(sgprod_migrations, "1")

    def test_pin_script_uses_materialized_runtime_after_gitops_checkout(self) -> None:
        script = (REPO_ROOT / ".ci/runtime/pin_image_to_gitops.sh").read_text()

        self.assertIn('REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"', script)
        self.assertIn('CI_INIT_SCRIPT="${CI_INIT_SCRIPT:-$SCRIPT_DIR/../init.sh}"', script)
        self.assertIn('source "$CI_INIT_SCRIPT"', script)
        self.assertNotIn('source "${REPO_ROOT}/.ci/init.sh"', script)
        self.assertIn('runtime_snapshot="$(ci_create_runtime_snapshot "$runtime_source_ci_dir")"', script)
        self.assertIn('bootstrap_dir="$runtime_snapshot"', script)
        self.assertNotIn('cp -R "$REPO_ROOT/.ci/runtime" "$bootstrap_dir/.ci/runtime"', script)
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

    def test_promote_bundle_resolves_metadata_from_runtime_snapshot(self) -> None:
        script = (REPO_ROOT / ".ci/runtime/promote_bundle_image_to_gitops.sh").read_text()

        self.assertIn('RUNTIME_COMMAND_DIR="${RUNTIME_COMMAND_DIR:-$SCRIPT_DIR/commands}"', script)
        self.assertIn('python3 "$RUNTIME_COMMAND_DIR/resolve_release_bundle.py"', script)
        self.assertNotIn('python3 "$REPO_ROOT/.ci/runtime/commands/resolve_release_bundle.py"', script)
        self.assertIn('PIN_SCRIPT="${PIN_SCRIPT_OVERRIDE:-$SCRIPT_DIR/pin_image_to_gitops.sh}"', script)
        self.assertIn('CI_RUNTIME_REF="${CI_RUNTIME_REF:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD', script)
        self.assertIn('CI_RUNTIME_COMMIT="${CI_RUNTIME_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD', script)
        self.assertIn("export CI_RUNTIME_REF CI_RUNTIME_COMMIT", script)

    def test_build_auto_pin_uses_runtime_snapshot_for_pin_loop(self) -> None:
        script = (REPO_ROOT / ".ci/runtime/build_and_promote_to_gitops.sh").read_text()

        self.assertIn('CI_RUNTIME_REF="${CI_RUNTIME_REF:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD', script)
        self.assertIn('CI_RUNTIME_COMMIT="${CI_RUNTIME_COMMIT:-$SOURCE_REF}"', script)
        self.assertIn("export CI_RUNTIME_REF CI_RUNTIME_COMMIT", script)
        self.assertIn('prepare_pin_runtime_snapshot', script)
        self.assertIn('PIN_RUNTIME_SNAPSHOT="$(ci_create_runtime_snapshot "$REPO_ROOT/.ci")"', script)
        self.assertNotIn('cp "$REPO_ROOT/.ci/init.sh" "$PIN_RUNTIME_SNAPSHOT/.ci/init.sh"', script)
        self.assertNotIn('cp -R "$REPO_ROOT/.ci/runtime" "$PIN_RUNTIME_SNAPSHOT/.ci/runtime"', script)
        self.assertIn('PIN_SCRIPT="$PIN_RUNTIME_SNAPSHOT/.ci/runtime/pin_image_to_gitops.sh"', script)
        self.assertIn('prepare_pin_runtime_snapshot\n\nIFS=\',\' read -r -a AUTO_ENVS <<<"$AUTO_PIN_ENVS"', script)

    def test_pin_script_resets_frontend_build_generated_files_before_dirty_guard(self) -> None:
        script = (REPO_ROOT / ".ci/runtime/pin_image_to_gitops.sh").read_text()

        self.assertIn("reset_known_build_side_effects_before_rewrite", script)
        self.assertIn("frontend/next-env.d.ts", script)
        self.assertIn("frontend/public/fonts/HYRuiYiSong-45J.subset.woff2", script)
        self.assertLess(
            script.index("reset_known_build_side_effects_before_rewrite\n\nif ! git"),
            script.index("repository has uncommitted changes; refuse to rewrite branch state"),
        )

    def test_prod_promote_fanout_pins_runtime_before_branch_checkouts(self) -> None:
        template = (REPO_ROOT / ".ci/templates/service-release.yml").read_text()

        self.assertIn('SOURCE_SHA="$(git rev-parse HEAD)"', template)
        self.assertIn('CI_RUNTIME_REF="${CI_RUNTIME_REF:-${{ ci.branch }}}"', template)
        self.assertIn('CI_RUNTIME_COMMIT="${CI_RUNTIME_COMMIT:-$SOURCE_SHA}"', template)
        self.assertIn("export CI_RUNTIME_REF CI_RUNTIME_COMMIT", template)
        self.assertLess(
            template.index('export CI_RUNTIME_REF CI_RUNTIME_COMMIT'),
            template.index('PROMOTE_BUNDLE_SCRIPT="$RUNTIME_SNAPSHOT/.ci/runtime/promote_bundle_image_to_gitops.sh"'),
        )

    def test_pin_script_consumes_only_approved_gate_variables(self) -> None:
        script = (REPO_ROOT / ".ci/runtime/pin_image_to_gitops.sh").read_text()
        found_gate_vars = set(re.findall(r"\bGATE_[A-Z_]+\b", script))

        self.assertEqual(found_gate_vars, APPROVED_GATE_VARS)
        self.assertNotIn("GATE_DB_MODE", found_gate_vars)
        self.assertNotIn("GATE_REQUIRES_DB_JOB", found_gate_vars)
        self.assertNotIn("GATE_DB_JOB_SERVICE", found_gate_vars)
        self.assertNotIn("GATE_READINESS_SUPPORTED", found_gate_vars)
        self.assertNotIn("GATE_RELEASE_DEPENDENCIES", found_gate_vars)

    def test_pin_script_prints_green_skip_notice_for_noop_promote(self) -> None:
        script = (REPO_ROOT / ".ci/runtime/pin_image_to_gitops.sh").read_text()

        self.assertIn("green_log()", script)
        self.assertIn("printf '\\033[32m%s\\033[0m\\n' \"$*\"", script)
        self.assertIn("GitOps promote 跳过：${reason}", script)
        self.assertIn("处理结果：不会创建 GitOps promote MR，也不会触发 Argo sync。", script)
        self.assertIn('gitops_skip_notice "仅 *_DEPLOYED_AT 时间戳变化，镜像 pin 与 deploy-facing 配置未变化。"', script)
        self.assertIn('gitops_skip_notice "投影后没有 GitOps staged diff。"', script)

    def test_prod_promote_branches_are_not_removed_by_automation(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()
        prod_template = (REPO_ROOT / ".ci/templates/gitops-promotion-prod.yml").read_text()
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
        self.assertNotIn("cleanup_gitops_promotion.py", prod_template)
        self.assertIn("确认 ${{ parameters.DISPLAY_NAME }} GitOps 待同步", prod_template)
        self.assertIn('case "$ENV_NAME" in', pin_script)
        self.assertIn("shprod)", pin_script)
        self.assertIn("sgprod)", pin_script)
        self.assertIn("MR_ARGS+=(--remove-source-branch)", pin_script)
        self.assertIn("进入${ENV_DISPLAY_NAME}待同步状态", pin_script)

    def test_prod_promote_workflows_are_independent_per_env_without_db_apply(self) -> None:
        workflow = (REPO_ROOT / ".ci/gitops-promotion.yml").read_text()
        shprod_workflow = (REPO_ROOT / ".ci/gitops-promotion-shprod.yml").read_text()
        sgprod_workflow = (REPO_ROOT / ".ci/gitops-promotion-sgprod.yml").read_text()
        prod_template = (REPO_ROOT / ".ci/templates/gitops-promotion-prod.yml").read_text()

        self.assertNotIn("check-in:", workflow)
        self.assertIn("promote-shprod-*", shprod_workflow)
        self.assertIn("TARGET_ENV: shprod", shprod_workflow)
        self.assertIn("promote-sgprod-*", sgprod_workflow)
        self.assertIn("TARGET_ENV: sgprod", sgprod_workflow)
        self.assertIn("check-in:", prod_template)
        self.assertNotIn("Dry-run ${{ parameters.DISPLAY_NAME }} DB migration", prod_template)
        self.assertNotIn("执行 ${{ parameters.DISPLAY_NAME }} DB migration", prod_template)
        self.assertNotIn("run_prod_db_migration.py", prod_template)
        self.assertNotIn("--skip-if-no-migration-change", prod_template)
        self.assertNotIn("--apply", prod_template)
        self.assertIn("生产 DB migration 子流水线已经完成", prod_template)
        self.assertIn("不会再次执行 DB migration", prod_template)
        self.assertIn("本审批不影响另一个生产环境", prod_template)
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
