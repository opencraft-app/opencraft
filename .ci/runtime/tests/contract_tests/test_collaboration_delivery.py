import copy
import contextlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
sys.path.insert(0, str(REPO_ROOT / ".ci/runtime"))

from contracts.release_plan import plan_release_gates
from contracts.bundles import load_bundle, load_manifest, require_build_metadata
from harness_ci import db_job
from gates.config import validate_activation_inputs, validate_config
from gates import db_contract_verifier


class CollaborationDeliveryTests(unittest.TestCase):
    def test_runtime_promotion_rejects_catalog_still_pointing_to_foundation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = root / "bundles.manifest"
            manifest.write_text(yaml.safe_dump({"bundles": {"collaboration": {
                "config_contract": {"active_catalog": {"path": "catalog.yaml",
                    "source_path": "argocd/services/collaboration/{env}"}},
            }}}))
            catalog = root / "catalog.yaml"
            catalog.write_text("sourcePath: argocd/services/collaboration/beijing-sandbox-foundation\n")
            with self.assertRaisesRegex(ValueError, "runtime catalog sourcePath"):
                validate_activation_inputs(root, manifest, "collaboration", "beijing-sandbox")
            catalog.write_text("sourcePath: argocd/services/collaboration/beijing-sandbox\n")
            validate_activation_inputs(root, manifest, "collaboration", "beijing-sandbox")

    def test_promotion_rejects_empty_admin_or_invalid_im_app_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_file = root / "platform.env"
            source = root / "argocd/services/collaboration/beijing-sandbox"
            source.mkdir(parents=True)
            (source / "kustomization.yaml").write_text("resources: []\n")
            manifest = root / "bundles.manifest"
            manifest.write_text(yaml.safe_dump({"bundles": {"collaboration": {
                "config_contract": {"platform_env": {"path": "platform.env", "required_keys": ["ADMIN"],
                                                       "positive_int_keys": ["SDK_APP_ID"]}},
            }}}))
            for payload in ("ADMIN=\nSDK_APP_ID=1600000000\n", "ADMIN=test-admin\nSDK_APP_ID=not-an-id\n"):
                env_file.write_text(payload)
                with mock.patch("gates.config.run_logged") as run:
                    with self.assertRaisesRegex(ValueError, "invalid platform input"):
                        validate_config(repo_root=root, init_repo_root=root, runtime_command_dir=root,
                                        bundle_manifest=manifest, pin_targets="collaboration", env="beijing-sandbox")
                    run.assert_not_called()

    def test_beijing_build_pipeline_and_materialized_bundle_do_not_auto_publish(self):
        workflow = yaml.safe_load((REPO_ROOT / ".ci/collaboration.yml").read_text())
        params = workflow["extends"]["parameters"]
        trigger = workflow.get("on", workflow.get(True))
        self.assertEqual(trigger["push"]["branches"], ["master"])
        self.assertEqual(params["MASTER_BUILD_ENVS"], "beijing-sandbox")
        self.assertEqual(params["MASTER_AUTO_PIN_ENVS"], "none")
        self.assertIs(params["ENABLE_MASTER_PROD_PROMOTE"], False)
        manifest = load_manifest()
        bundle = require_build_metadata(load_bundle(manifest, "collaboration", "beijing-sandbox"))
        self.assertEqual(bundle.build_context, "collaboration")
        for env in ("shprod", "sgprod", "sandbox-bj-7", "sandbox-kr-1", "sandbox-jp-1"):
            with self.assertRaises(ValueError):
                require_build_metadata(load_bundle(manifest, "collaboration", env))
        self.assertIn(".ci/runtime/bundles/collaboration.bundle",
                      (REPO_ROOT / ".ci/runtime/materialize-files.txt").read_text().splitlines())

    def test_beijing_bootstrap_pipeline_is_manual_two_phase_and_never_auto_merges(self):
        workflow_path = REPO_ROOT / ".ci/collaboration-bootstrap.yml"
        workflow = yaml.safe_load(workflow_path.read_text())
        trigger = workflow.get("on", workflow.get(True))
        self.assertEqual(trigger, {"manual": "enabled"})
        self.assertEqual(workflow["variables"]["BOOTSTRAP_PHASE"]["value"], "foundation")
        self.assertEqual(workflow["variables"]["COLLABORATION_IM_SDK_APP_ID"]["value"], "1600137234")
        self.assertIn("@sha256:", workflow["variables"]["COLLABORATION_IMAGE"]["value"])
        self.assertEqual(len(workflow["stages"]), 3)
        self.assertIn("check-in", workflow["stages"][1])
        branch_guard = "${{ ci.branch }} == master"
        self.assertEqual(workflow["stages"][1].get("if"), branch_guard)
        self.assertEqual(workflow["stages"][2].get("if"), branch_guard)
        text = workflow_path.read_text()
        self.assertEqual(text.count("ci_ensure_go"), 2)
        self.assertEqual(text.count("ci_ensure_tccli"), 1)
        apply_script = workflow["stages"][2]["jobs"]["apply"]["steps"][-1]["run"]
        self.assertIn("ci_ensure_pyyaml", apply_script)
        self.assertLess(apply_script.index("ci_ensure_tccli"), apply_script.index("ci_ensure_pyyaml"))
        self.assertLess(apply_script.index("ci_ensure_pyyaml"), apply_script.index("python3 scripts/export_ssm_to_sops.py"))
        apply_env = workflow["stages"][2]["jobs"]["apply"]["env"]
        self.assertEqual(
            apply_env["DB_JOB_KUBECONFIG_B64"],
            "${{ settings.DB_JOB_KUBECONFIG_B64.password }}",
        )
        init_script = (REPO_ROOT / ".ci/init.sh").read_text()
        self.assertIn("ci_ensure_pyyaml()", init_script)
        self.assertIn('"PyYAML==${version}"', init_script)
        self.assertIn('export PATH="${install_dir}/venv/bin:${PATH}"', init_script)
        for required in (
            "bootstrap-collaboration",
            "--apply",
            "export_ssm_to_sops.py",
            "run_gitops_db_job.py",
            "verify_db_contract.py",
            "promote_collaboration_bootstrap_to_gitops.sh",
            "DB_JOB_KUBECONFIG_B64",
            "COLLABORATION_IM_CREDENTIAL.password",
        ):
            self.assertIn(required, text)
        for forbidden in ("--allow-database-password-reset", "--allow-im-secret-rotation", "--env shprod", "--env sgprod"):
            self.assertNotIn(forbidden, text)

    def test_collaboration_recovery_jobs_use_native_fail_closed_cli(self):
        plan = db_job.SERVICE_SPECS[("collaboration", "recovery-plan")]
        apply = db_job.SERVICE_SPECS[("collaboration", "recovery-apply")]
        common = ["/usr/local/bin/chatserver", "database", "recover-empty-baseline",
                  "--database-driver", "mysql", "--database-dsn-file",
                  "/var/run/secrets/collaboration/database.dsn"]
        self.assertEqual(plan["command"], common)
        self.assertEqual(apply["command"], common + ["--apply"])
        for spec in (plan, apply):
            self.assertEqual(spec["namespace"], "lightvela-collaboration")
            self.assertEqual(spec["volumes"][0]["secret"]["items"], [
                {"key": "database.dsn", "path": "database.dsn"},
            ])
            self.assertTrue(spec["containerSecurityContext"]["readOnlyRootFilesystem"])
            self.assertTrue(spec["successLogMarkers"])

        workflow = yaml.safe_load((REPO_ROOT / ".ci/collaboration-recovery.yml").read_text())
        trigger = workflow.get("on", workflow.get(True))
        self.assertEqual(trigger, {"manual": "enabled"})
        self.assertEqual(len(workflow["stages"]), 3)
        self.assertIn("check-in", workflow["stages"][1])
        branch_guard = "${{ ci.branch }} == master"
        self.assertEqual(workflow["stages"][1].get("if"), branch_guard)
        self.assertEqual(workflow["stages"][2].get("if"), branch_guard)
        for stage_index, job_name in ((0, "plan"), (2, "apply")):
            env = workflow["stages"][stage_index]["jobs"][job_name]["env"]
            self.assertEqual(env, {
                "DB_JOB_KUBECONFIG_B64": "${{ settings.DB_JOB_KUBECONFIG_B64.password }}",
            })
        workflow_text = (REPO_ROOT / ".ci/collaboration-recovery.yml").read_text()
        for forbidden in ("COLLABORATION_IM_CREDENTIAL", "SOPS_AGE_KEY", "GIT_WOA_PRIVATE_TOKEN",
                          "ci_load_tencentcloud_credentials", "promote_collaboration_bootstrap_to_gitops"):
            self.assertNotIn(forbidden, workflow_text)

        script = (REPO_ROOT / ".ci/runtime/commands/run_collaboration_baseline_recovery.sh").read_text()
        self.assertIn("run_recovery_job recovery-plan", script)
        self.assertLess(script.index("run_recovery_job recovery-apply"),
                        script.rindex("run_recovery_job recovery-plan"))
        self.assertIn("--env beijing-sandbox", script)
        self.assertIn("@sha256:[0-9a-f]{64}", script)
        for forbidden in ("kubectl exec", "mysql ", "sops", "tccli"):
            self.assertNotIn(forbidden, script)
        script_path = REPO_ROOT / ".ci/runtime/commands/run_collaboration_baseline_recovery.sh"
        invalid_cases = (
            [],
            ["plan", "short", "registry.example/collaboration@sha256:" + "a" * 64, "1800"],
            ["plan", "a" * 40, "registry.example/collaboration:latest", "1800"],
            ["apply", "a" * 40, "registry.example/collaboration@sha256:" + "b" * 64, "never"],
        )
        for args in invalid_cases:
            result = subprocess.run(["bash", str(script_path), *args], cwd=REPO_ROOT,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, (args, result.stdout, result.stderr))

    def test_collaboration_bootstrap_gitops_script_reuses_projector_and_creates_reviewable_mr(self):
        script = (REPO_ROOT / ".ci/runtime/promote_collaboration_bootstrap_to_gitops.sh").read_text()
        for required in (
            "project_release_bundle.py",
            "project_collaboration_bootstrap.py",
            "gitops_merge_request.py",
            "--target-branch \"$GITOPS_BRANCH\"",
            "--force-with-lease",
            "--remove-source-branch",
            "foundation 只创建 Namespace、ServiceAccount 和加密 Secret",
        ):
            self.assertIn(required, script)
        for forbidden in ("kubectl apply", "git push --force ", "merge_gitops", "--auto-merge"):
            self.assertNotIn(forbidden, script)
        materialized = (REPO_ROOT / ".ci/runtime/materialize-files.txt").read_text().splitlines()
        self.assertIn(".ci/runtime/commands/project_collaboration_bootstrap.py", materialized)

    def test_argo_candidate_waits_outside_appset_and_ssm_covers_all_runtime_files(self):
        root = REPO_ROOT / "argocd/catalogs/candidates/beijing-sandbox"
        candidate = yaml.safe_load((root / "collaboration.yaml").read_text())
        self.assertEqual(candidate["sourcePath"], "argocd/services/collaboration/beijing-sandbox")
        self.assertEqual(candidate["namespace"], "lightvela-collaboration")
        active_catalog = "argocd/catalogs/sandbox/beijing-sandbox/collaboration.yaml"
        self.assertFalse((REPO_ROOT / active_catalog).exists())
        bundle_source = yaml.safe_load(
            (REPO_ROOT / ".ci/runtime/bundles/collaboration.bundle").read_text()
        )
        publish_paths = bundle_source["bundles"]["collaboration"]["publish_paths_by_env"][
            "beijing-sandbox"
        ]
        self.assertNotIn(active_catalog, publish_paths)
        catalog_policy = yaml.safe_load(
            (REPO_ROOT / ".ci/runtime/bundles/_catalogs.bundle").read_text()
        )
        exemption = catalog_policy["catalog_publish_exemptions_by_env"]["beijing-sandbox"][
            active_catalog
        ]
        self.assertIn("two-phase bootstrap", exemption)
        self.assertIn("must not overwrite", exemption)
        appset = (REPO_ROOT / "argocd/apps/beijing-sandbox/sandbox-family-appset.yaml").read_text()
        self.assertNotIn("catalogs/candidates", appset)
        spec = yaml.safe_load((REPO_ROOT / "scripts/ssm_manifest.collaboration.beijing-sandbox.yaml").read_text())
        self.assertEqual(set(spec["items"][0]["required_keys"]), {
            "database.dsn", "jwt.key", "gateway.token", "im-secret.key", "im-identity.key", "im-callback.token",
        })
        foundation = yaml.safe_load((root / "collaboration-foundation.yaml").read_text())
        self.assertEqual(foundation["service"], candidate["service"])
        self.assertEqual(foundation["sourcePath"], "argocd/services/collaboration/beijing-sandbox-foundation")
        source = REPO_ROOT / foundation["sourcePath"]
        composition = yaml.safe_load((source / "kustomization.yaml").read_text())
        self.assertEqual(composition["resources"], ["namespace.yaml", "serviceaccount.yaml"])
        self.assertNotIn("components", composition)

    def test_runtime_overlay_resolves_values_without_adding_a_migration_workload(self):
        binary = shutil.which("kustomize")
        if not binary:
            self.skipTest("kustomize is required for offline source rendering")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shutil.copytree(REPO_ROOT / "collaboration/k8s/base", root / "collaboration/k8s/base")
            shutil.copytree(REPO_ROOT / "argocd/services/collaboration", root / "argocd/services/collaboration")
            overlay = root / "argocd/services/collaboration/beijing-sandbox"
            spec = yaml.safe_load((overlay / "kustomization.yaml").read_text())
            # A synthetic Secret replaces only the external KSOPS dependency; no runtime credential is read.
            spec.pop("generators")
            spec["resources"] = ["fixture-secret.yaml"]
            (overlay / "kustomization.yaml").write_text(yaml.safe_dump(spec, sort_keys=False))
            (overlay / "fixture-secret.yaml").write_text(yaml.safe_dump({
                "apiVersion": "v1", "kind": "Secret", "metadata": {"name": "collaboration-runtime-secrets"},
                "stringData": {"database.dsn": "synthetic-test-value"},
            }))
            (overlay / "collaboration-platform.env").write_text(
                "COLLABORATION_IMAGE=registry.example/collaboration@sha256:" + "a" * 64 + "\n"
                "COLLABORATION_DEPLOYED_AT=test-release\nCOLLABORATION_NODE_POOL=general-bj8\n"
                "COLLABORATION_IM_SDK_APP_ID=1600000000\nCOLLABORATION_IM_ADMIN_USER_ID=test-admin\n")
            result = subprocess.run([binary, "build", str(overlay)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("REPLACE_", result.stdout)
            resources = list(yaml.safe_load_all(result.stdout))
            self.assertEqual(sum(item["kind"] == "Deployment" for item in resources), 1)
            self.assertEqual(sum(item["kind"] == "Service" for item in resources), 1)
            self.assertFalse(any(item["kind"] == "Job" for item in resources))
            deployment = next(item for item in resources if item["kind"] == "Deployment")
            args = deployment["spec"]["template"]["spec"]["containers"][0]["args"]
            self.assertEqual(args[args.index("--im-sdk-app-id") + 1], "1600000000")
            self.assertEqual(args[args.index("--im-admin-user-id") + 1], "test-admin")
            self.assertIn("--collaboration-only", args)

    def test_foundation_overlay_renders_with_argocd_default_load_restriction(self):
        binary = shutil.which("kustomize")
        if not binary:
            self.skipTest("kustomize is required for offline source rendering")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            overlay = root / "argocd/services/collaboration/beijing-sandbox-foundation"
            shutil.copytree(REPO_ROOT / "argocd/services/collaboration/beijing-sandbox-foundation", overlay)
            namespace = root / "collaboration/k8s/base/namespace.yaml"
            namespace.parent.mkdir(parents=True)
            shutil.copyfile(REPO_ROOT / "collaboration/k8s/base/namespace.yaml", namespace)
            service_account_path = root / "argocd/services/collaboration/common/serviceaccount.yaml"
            service_account_path.parent.mkdir(parents=True)
            shutil.copyfile(REPO_ROOT / "argocd/services/collaboration/common/serviceaccount.yaml", service_account_path)
            # Replace only the external KSOPS input; no credential or runtime workload is read.
            spec = yaml.safe_load((overlay / "kustomization.yaml").read_text())
            spec.pop("generators")
            (overlay / "kustomization.yaml").write_text(yaml.safe_dump(spec, sort_keys=False))
            result = subprocess.run([binary, "build", str(overlay)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            resources = [item for item in yaml.safe_load_all(result.stdout) if item]
            self.assertEqual({(item["kind"], item["metadata"]["name"]) for item in resources}, {
                ("Namespace", "lightvela-collaboration"), ("ServiceAccount", "default"),
            })
            rendered_service_account = next(item for item in resources if item["kind"] == "ServiceAccount")
            self.assertEqual(rendered_service_account["metadata"]["namespace"], "lightvela-collaboration")
            self.assertEqual(yaml.safe_load((overlay / "namespace.yaml").read_text()),
                             yaml.safe_load(namespace.read_text()))
            self.assertEqual(yaml.safe_load((overlay / "serviceaccount.yaml").read_text()),
                             yaml.safe_load(service_account_path.read_text()))

    def test_native_readiness_resolves_candidate_image_from_deploy_platform(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            platform = root / "argocd/services/collaboration/beijing-sandbox/collaboration-platform.env"
            platform.parent.mkdir(parents=True)
            image = "registry.example/collaboration@sha256:" + "b" * 64
            platform.write_text(f"COLLABORATION_IMAGE={image}\nCOLLABORATION_NODE_POOL=general-bj8\n")
            output = io.StringIO()
            with mock.patch.object(sys, "argv", ["verify", "--repo-root", str(root), "--service", "collaboration",
                                                 "--env", "beijing-sandbox"]), \
                    mock.patch.object(db_contract_verifier, "build_job_manifest", wraps=db_contract_verifier.build_job_manifest) as build, \
                    contextlib.redirect_stdout(output):
                self.assertEqual(db_contract_verifier.main(), 0)
            self.assertEqual(build.call_args.args[2]["image"], image)
            self.assertEqual(build.call_args.args[2]["command"][4], "mysql")
            audit = json.loads(output.getvalue())
            self.assertEqual(audit["verification_mode"], "service-command")
            self.assertIsNone(audit["expected_schema_version"])

    def test_promotion_fails_before_validation_when_argo_activation_inputs_are_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "argocd/services/collaboration/beijing-sandbox"
            source.mkdir(parents=True)
            (source / "kustomization.yaml").write_text("resources: []\n")
            manifest = root / "bundles.manifest"
            manifest.write_text(yaml.safe_dump({"bundles": {"collaboration": {
                "config_contract": {"required_files": ["argocd/catalogs/sandbox/{env}/collaboration.yaml"]},
            }}}))
            with mock.patch("gates.config.run_logged") as run:
                with self.assertRaisesRegex(FileNotFoundError, "required activation input"):
                    validate_config(repo_root=root, init_repo_root=root, runtime_command_dir=root,
                                    bundle_manifest=manifest, pin_targets="collaboration", env="beijing-sandbox")
                run.assert_not_called()

    def test_first_release_runs_idempotent_migration_even_when_latest_diff_has_no_sql(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = root / "bundles.manifest"
            manifest.write_text(yaml.safe_dump({"bundles": {"collaboration": {
                "db_contract": {"mode": "migration", "always_run_migration": True,
                                "migration_operation": "migration", "verifier": {"mode": "service-command"}},
            }}}))
            with mock.patch("contracts.release_plan.changed_files_for_revision", return_value=[]):
                plan = plan_release_gates(repo_root=root, bundle_manifest=manifest, service="collaboration",
                                          env="beijing-sandbox", source_sha="source", image="candidate-image",
                                          pin_targets="collaboration")
            self.assertTrue(plan.requires_db_job)
            self.assertTrue(plan.requires_db_readiness)
            self.assertFalse(plan.auto_merge_allowed)

    def test_migration_job_mounts_only_database_dsn_and_uses_native_cli(self):
        spec = copy.deepcopy(db_job.SERVICE_SPECS[("collaboration", "migration")])
        manifest = db_job.build_job_manifest("collaboration", "migration", "source", "tester", spec,
                                             "candidate-image", job_name="collaboration-migrate-test")
        pod = manifest["spec"]["template"]["spec"]
        container = pod["containers"][0]
        self.assertEqual(container["command"][:3], ["/usr/local/bin/chatserver", "database", "migrate"])
        self.assertEqual(container["command"][4], "mysql")
        self.assertNotIn("envFrom", container)
        self.assertEqual(pod["volumes"][0]["secret"]["items"], [{"key": "database.dsn", "path": "database.dsn"}])
        self.assertTrue(pod["securityContext"]["runAsNonRoot"])
        self.assertTrue(container["volumeMounts"][0]["readOnly"])
