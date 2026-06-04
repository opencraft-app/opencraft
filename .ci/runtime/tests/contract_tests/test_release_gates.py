import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from contracts.bundles import load_bundle, load_manifest  # noqa: E402
from contracts.release_plan import plan_release_gates  # noqa: E402


class ReleaseGatePlannerTests(unittest.TestCase):
    def test_release_bundle_manifest_exposes_db_contract(self) -> None:
        manifest = load_manifest()
        payment = load_bundle(manifest, "payment", "beijing-sandbox")
        subscription = load_bundle(manifest, "subscription", "beijing-sandbox")
        frontend = load_bundle(manifest, "frontend", "shprod")

        self.assertEqual(payment.db_contract["mode"], "migration")
        self.assertEqual(payment.config_contract["mode"], "gitops")
        self.assertTrue(payment.config_contract["kustomize"])
        self.assertTrue(payment.config_contract["placeholder_scan"])
        self.assertTrue(payment.config_contract["requires_mr"])
        self.assertEqual(payment.db_contract["db_job_service"], "payment")
        self.assertEqual(subscription.db_contract["verifier"]["baseline_checks"][0]["name"], "subscription-plans-free-lite-pro")
        self.assertEqual(frontend.db_contract["mode"], "none")

    def test_payment_migration_change_requires_beijing_db_job(self) -> None:
        with self._repo_with_commit("payment/migrations/202604290001_add_table.up.sql") as (repo_root, source_sha):
            plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="payment",
                env="beijing-sandbox",
                source_sha=source_sha,
                image="example.com/payment:test",
                pin_targets="payment",
            )

        self.assertTrue(plan.migration_changed)
        self.assertTrue(plan.requires_db_job)
        self.assertTrue(plan.requires_db_readiness)
        self.assertFalse(plan.auto_merge_allowed)
        self.assertFalse(plan.auto_sync_allowed)
        self.assertIn("run_gitops_db_job.py", "\n".join(plan.manual_actions))

    def test_payment_db_gate_pass_enables_beijing_auto_merge_and_sync(self) -> None:
        with self._repo_with_commit("payment/migrations/202604290001_add_table.up.sql") as (repo_root, source_sha):
            plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="payment",
                env="beijing-sandbox",
                source_sha=source_sha,
                image="example.com/payment:test",
                pin_targets="payment",
                db_status="passed",
            )

        self.assertTrue(plan.auto_merge_allowed)
        self.assertTrue(plan.auto_sync_allowed)

    def test_payment_db_gate_pass_enables_playground_auto_merge_and_sync(self) -> None:
        with self._repo_with_commit("payment/migrations/202604290001_add_table.up.sql") as (repo_root, source_sha):
            plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="payment",
                env="sandbox-bj-7",
                source_sha=source_sha,
                image="example.com/payment:test",
                pin_targets="payment",
                db_status="passed",
            )

        self.assertEqual(plan.argo_sync, "auto")
        self.assertTrue(plan.auto_merge_allowed)
        self.assertTrue(plan.auto_sync_allowed)

    def test_devcloud_dep_channelgateway_auto_merges_and_syncs(self) -> None:
        with self._repo_with_commit("cloudagent/channelgateway/README.md") as (repo_root, source_sha):
            plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="channelgateway",
                env="devcloud-dep",
                source_sha=source_sha,
                image="example.com/channelgateway:test",
                pin_targets="channelgateway",
            )

        self.assertEqual(plan.argo_sync, "auto")
        self.assertFalse(plan.requires_db_job)
        self.assertFalse(plan.requires_db_readiness)
        self.assertTrue(plan.auto_merge_allowed)
        self.assertTrue(plan.auto_sync_allowed)

    def test_payment_non_migration_change_still_requires_idempotent_db_gate(self) -> None:
        with self._repo_with_commit("payment/internal/api.go") as (repo_root, source_sha):
            plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="payment",
                env="beijing-sandbox",
                source_sha=source_sha,
                image="example.com/payment:test",
                pin_targets="payment",
            )

        self.assertFalse(plan.migration_changed)
        self.assertTrue(plan.requires_db_job)
        self.assertTrue(plan.requires_db_readiness)
        self.assertFalse(plan.auto_merge_allowed)
        self.assertFalse(plan.auto_sync_allowed)

    def test_sandbox_baseline_unknown_blocks_auto_sync(self) -> None:
        with self._repo_with_commit("sandbox/README.md") as (repo_root, source_sha):
            plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="sandbox",
                env="beijing-sandbox",
                source_sha=source_sha,
                image='{"images":{"SANDBOX_MIGRATE_IMAGE":"example.com/sandbox-migrate:test"}}',
                pin_targets="sandbox",
            )

        self.assertFalse(plan.migration_changed)
        self.assertTrue(plan.requires_db_readiness)
        self.assertFalse(plan.auto_sync_allowed)
        self.assertIn("sync-default-pools", "\n".join(plan.manual_actions))

    def test_ctl_supports_automatic_readiness_confirmation(self) -> None:
        with self._repo_with_commit("ctl/internal/api.go") as (repo_root, source_sha):
            plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="ctl",
                env="beijing-sandbox",
                source_sha=source_sha,
                image="example.com/ctl:test",
                pin_targets="ctl",
            )

        self.assertTrue(plan.requires_db_job)
        self.assertTrue(plan.requires_db_readiness)
        self.assertTrue(plan.readiness_supported)
        self.assertFalse(plan.auto_merge_allowed)
        self.assertFalse(plan.auto_sync_allowed)
        self.assertIn("verify_db_contract.py", "\n".join(plan.manual_actions))

    def test_shprod_always_uses_manual_argo_sync(self) -> None:
        with self._repo_with_commit("frontend/src/App.tsx") as (repo_root, source_sha):
            plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="frontend",
                env="shprod",
                source_sha=source_sha,
                image="example.com/frontend:test",
                pin_targets="frontend",
            )

        self.assertEqual(plan.argo_sync, "manual")
        self.assertTrue(plan.auto_merge_allowed)
        self.assertFalse(plan.auto_sync_allowed)
        self.assertIn("manual Argo sync required", "\n".join(plan.manual_actions))

    def test_shprod_db_service_requires_readiness_before_pending_sync(self) -> None:
        with self._repo_with_commit("payment/internal/api.go") as (repo_root, source_sha):
            blocked_plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="payment",
                env="shprod",
                source_sha=source_sha,
                image="example.com/payment:test",
                pin_targets="payment",
            )
            passed_plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="payment",
                env="shprod",
                source_sha=source_sha,
                image="example.com/payment:test",
                pin_targets="payment",
                db_status="passed",
            )

        self.assertEqual(blocked_plan.argo_sync, "manual")
        self.assertTrue(blocked_plan.requires_db_readiness)
        self.assertFalse(blocked_plan.auto_merge_allowed)
        self.assertFalse(blocked_plan.auto_sync_allowed)
        self.assertEqual(passed_plan.argo_sync, "manual")
        self.assertTrue(passed_plan.auto_merge_allowed)
        self.assertFalse(passed_plan.auto_sync_allowed)

    def test_dependency_change_blocks_unordered_service_gateway_auto_sync(self) -> None:
        with self._repo_with_commit("payment/internal/api.go") as (repo_root, source_sha):
            plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="service-gateway",
                env="beijing-sandbox",
                source_sha=source_sha,
                image="example.com/service-gateway:test",
                pin_targets="service-gateway",
            )

        self.assertTrue(plan.release_dependency_changed)
        self.assertFalse(plan.auto_merge_allowed)
        self.assertFalse(plan.auto_sync_allowed)
        self.assertIn("检测到同批依赖服务变更", "\n".join(plan.manual_actions))
        self.assertIn("再重试当前服务发布", "\n".join(plan.manual_actions))

    def test_dependency_trigger_marker_does_not_block_service_gateway_auto_sync(self) -> None:
        with self._repo_with_commit("payment/.ci-trigger") as (repo_root, source_sha):
            plan = plan_release_gates(
                repo_root=repo_root,
                bundle_manifest=REPO_ROOT / ".ci/runtime/release-bundles.manifest",
                service="service-gateway",
                env="beijing-sandbox",
                source_sha=source_sha,
                image="example.com/service-gateway:test",
                pin_targets="service-gateway",
            )

        self.assertFalse(plan.release_dependency_changed)
        self.assertTrue(plan.auto_merge_allowed)
        self.assertTrue(plan.auto_sync_allowed)

    def _repo_with_commit(self, changed_path: str):
        return TempGitRepo(changed_path)


class TempGitRepo:
    def __init__(self, changed_path: str) -> None:
        self.changed_path = changed_path
        self.tempdir: tempfile.TemporaryDirectory[str] | None = None
        self.repo_root: Path | None = None
        self.source_sha = ""

    def __enter__(self) -> tuple[Path, str]:
        self.tempdir = tempfile.TemporaryDirectory()
        self.repo_root = Path(self.tempdir.name)
        self._git("init")
        self._git("config", "user.email", "ci@example.com")
        self._git("config", "user.name", "CI")
        path = self.repo_root / self.changed_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("test\n")
        self._git("add", ".")
        self._git("commit", "-m", "change")
        self.source_sha = self._git_output("rev-parse", "HEAD")
        return self.repo_root, self.source_sha

    def __exit__(self, *_exc_info: object) -> None:
        if self.tempdir is not None:
            self.tempdir.cleanup()

    def _git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=self.repo_root, check=True, capture_output=True, text=True)

    def _git_output(self, *args: str) -> str:
        return subprocess.check_output(["git", *args], cwd=self.repo_root, text=True).strip()


if __name__ == "__main__":
    unittest.main()
