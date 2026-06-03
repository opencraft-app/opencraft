import textwrap
import unittest
import os
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import sys

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from tests.helpers import git

from gitops.playground_environment import (
    CatalogApp,
    DEFAULT_FROM_ENV,
    appset_file_globs,
    apply_runtime_secret_value_overrides,
    bootstrap_database_job_manifest,
    build_playground_clone_plan,
    build_playground_bootstrap_plan,
    check_appset_refs,
    check_catalog,
    check_playground_contract_main,
    create_playground_main,
    fetch_origin_refs,
    PlaygroundRuntimeSecretValues,
    PLAYGROUND_RUNTIME_SECRET_FILE,
    PLAYGROUND_RUNTIME_SECRET_NAME,
    PLAYGROUND_PULL_SECRET_NAMES,
    playground_database_grants,
    load_yaml_mapping,
    render_clone_text,
    resolve_playground_runtime_recipients,
    run_playground_db_jobs,
    target_conflicts,
    validate_clone_plan,
    write_clone_plan,
)


class PlaygroundEnvironmentTests(unittest.TestCase):
    def test_default_template_source_includes_frontend(self) -> None:
        self.assertEqual(DEFAULT_FROM_ENV, "sandbox-bj-5")

    def test_runtime_secret_overrides_align_sandbox_mysql_password_to_root_password(self) -> None:
        payload = {
            "kind": "Secret",
            "stringData": {
                "MYSQL_USER": "root",
                "MYSQL_PASSWORD": "old-sandbox-password",
                "REDIS_PASSWORD": "old-redis-password",
            },
        }
        values = PlaygroundRuntimeSecretValues(mysql_root_password="new-root-password", redis_password="new-redis-password")

        apply_runtime_secret_value_overrides(payload, Path("sandbox-runtime-secrets.sops.yaml"), values)

        self.assertEqual(payload["stringData"]["MYSQL_PASSWORD"], "new-root-password")
        self.assertEqual(payload["stringData"]["REDIS_PASSWORD"], "new-redis-password")

    def test_runtime_secret_overrides_leave_non_sandbox_mysql_passwords_unchanged(self) -> None:
        payload = {
            "kind": "Secret",
            "stringData": {
                "MYSQL_ROOT_PASSWORD": "service-root-password",
                "REDIS_PASSWORD": "old-redis-password",
            },
        }
        values = PlaygroundRuntimeSecretValues(mysql_root_password="new-root-password", redis_password="new-redis-password")

        apply_runtime_secret_value_overrides(payload, Path("ai-gateway-runtime-secrets.sops.yaml"), values)

        self.assertEqual(payload["stringData"]["MYSQL_ROOT_PASSWORD"], "service-root-password")
        self.assertEqual(payload["stringData"]["REDIS_PASSWORD"], "new-redis-password")

    def test_appset_globs_include_sandbox_and_playground(self) -> None:
        appset = load_yaml_mapping(
            textwrap.dedent(
                """
                apiVersion: argoproj.io/v1alpha1
                kind: ApplicationSet
                spec:
                  generators:
                    - git:
                        files:
                          - path: argocd/catalogs/sandbox/*/*.yaml
                          - path: argocd/catalogs/playground/beijing-playground/*/*.yaml
                """
            ),
            "appset",
        )

        self.assertEqual(
            appset_file_globs(appset),
            {
                "argocd/catalogs/sandbox/*/*.yaml",
                "argocd/catalogs/playground/beijing-playground/*/*.yaml",
            },
        )

    def test_check_appset_refs_fails_when_playground_glob_is_missing(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-b", "master")
            appset = repo / "argocd/apps/beijing-sandbox/sandbox-family-appset.yaml"
            appset.parent.mkdir(parents=True)
            appset.write_text(
                textwrap.dedent(
                    """
                    apiVersion: argoproj.io/v1alpha1
                    kind: ApplicationSet
                    spec:
                      generators:
                        - git:
                            files:
                              - path: argocd/catalogs/sandbox/*/*.yaml
                    """
                )
            )
            git(repo, "add", ".")
            git(repo, "commit", "-m", "appset")

            result = check_appset_refs(
                repo,
                ["HEAD"],
                "argocd/apps/beijing-sandbox/sandbox-family-appset.yaml",
                (
                    "argocd/catalogs/sandbox/*/*.yaml",
                    "argocd/catalogs/playground/beijing-playground/*/*.yaml",
                ),
            )

        self.assertEqual(result.status, "fail")
        self.assertIn("missing generator globs", result.lines[0])
        self.assertTrue(result.actions)

    def test_check_catalog_loads_playground_apps(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-b", "master")
            catalog = repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-3/ctl.yaml"
            catalog.parent.mkdir(parents=True)
            catalog.write_text(
                textwrap.dedent(
                    """
                    service: ctl
                    env: sandbox-bj-3
                    project: beijing-playground
                    destinationName: beijing-playground
                    namespace: lightvela-playground-sandbox-bj-3
                    sourcePath: argocd/services/ctl/sandbox-bj-3
                    """
                )
            )
            git(repo, "add", ".")
            git(repo, "commit", "-m", "catalog")

            result, apps = check_catalog(repo, "HEAD", "argocd/catalogs/playground/beijing-playground/sandbox-bj-3")

        self.assertEqual(result.status, "ok")
        self.assertEqual(
            apps,
            [
                CatalogApp(
                    app_name="ctl-sandbox-bj-3",
                    service="ctl",
                    env="sandbox-bj-3",
                    project="beijing-playground",
                    destination_name="beijing-playground",
                    namespace="lightvela-playground-sandbox-bj-3",
                    source_path="argocd/services/ctl/sandbox-bj-3",
                    catalog_file="argocd/catalogs/playground/beijing-playground/sandbox-bj-3/ctl.yaml",
                )
            ],
        )

    def test_fetch_origin_refs_skips_non_origin_refs(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-b", "master")

            result = fetch_origin_refs(repo, ["HEAD", "gitops"])

        self.assertEqual(result.status, "warn")
        self.assertIn("skipped fetch", result.lines[0])

    def test_create_playground_dry_run_does_not_write_files(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)

            stdout = StringIO()
            with redirect_stdout(stdout):
                exit_code = create_playground_main(
                    ["--repo-root", str(repo), "--from-env", "sandbox-bj-3", "--to-env", "sandbox-bj-4"]
                )

            self.assertEqual(exit_code, 0)
            self.assertFalse((repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-4").exists())
            self.assertIn("dry-run", stdout.getvalue())
            self.assertIn("需要 Agent/人工确认", stdout.getvalue())
            self.assertIn("风险提示", stdout.getvalue())

    def test_create_playground_from_source_checkout_prints_gitops_hint(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / ".git").mkdir()

            stderr = StringIO()
            with redirect_stderr(stderr):
                exit_code = create_playground_main(["--repo-root", str(repo), "--to-env", "sandbox-bj-6"])

            self.assertEqual(exit_code, 1)
            message = stderr.getvalue()
            self.assertIn("不能在 master 源码 checkout 里直接跑默认命令", message)
            self.assertIn(".ci/runtime/create_playground_from_gitops.sh", message)
            self.assertIn("--repo-root /tmp/mono2-gitops", message)

    def test_create_playground_write_generates_render_closure(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)

            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")
            written = write_clone_plan_for_test(plan)

            catalog_files = list((repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-4").glob("*.yaml"))
            service_dirs = list((repo / "argocd/services").glob("*/sandbox-bj-4"))
            secret_files = list((repo / "argocd/secrets/sandbox-bj-4").glob("*.sops.yaml"))
            secret_readme = (repo / "argocd/secrets/sandbox-bj-4/README.md").read_text()
            self.assertEqual(len(catalog_files), 12)
            self.assertEqual(len(service_dirs), 12)
            self.assertEqual(len(secret_files), 4)
            self.assertGreater(len(written), 20)
            self.assertIn("sandbox-bj-4", secret_readme)
            self.assertNotIn("sandbox-bj-3", secret_readme)

            catalog = (repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-4/ai-gateway.yaml").read_text()
            self.assertIn("env: sandbox-bj-4", catalog)
            self.assertIn("namespace: lightvela-playground-sandbox-bj-4", catalog)
            self.assertIn("sourcePath: argocd/services/ai-gateway/sandbox-bj-4", catalog)

            service = (repo / "argocd/services/ai-gateway/sandbox-bj-4/patch-playground-db.yaml").read_text()
            self.assertIn("AI_GATEWAY_DB: ai_gateway_sandbox_bj_4", service)
            self.assertNotIn("sandbox-bj-3", service)

            gateway = (repo / "argocd/services/service-gateway/sandbox-bj-4/config.yaml").read_text()
            self.assertIn("http://lightclaw-auth.lightvela-playground-sandbox-bj-4.svc.cluster.local", gateway)

            sandbox_env = (repo / "argocd/services/sandbox/sandbox-bj-4/sandbox-platform.env").read_text()
            self.assertIn("SANDBOX_INGRESSPROXY_PUBLIC_HOST=*.sandbox-bj-4.lightclaw.tech", sandbox_env)
            self.assertIn("SANDBOX_INGRESSPROXY_HEALTHCHECK_HOST=sandbox-bj-4.lightclaw.tech", sandbox_env)
            self.assertIn("SANDBOX_INGRESSPROXY_TLS_SECRET_NAME=sandbox-bj-4-lightclaw-tech-wildcard-tls", sandbox_env)
            self.assertIn('REDIS_ROUTE_PREFIX: "route:sandbox-bj-4:"', (repo / "argocd/services/sandbox/sandbox-bj-4/patch-playground-db-redis.yaml").read_text())
            self.assertIn(
                "SANDBOX_MYSQL_HOST=mysql.lightvela-playground-sandbox-bj-4.svc.cluster.local",
                sandbox_env,
            )
            self.assertIn(
                "SANDBOX_REDIS_ADDR=redis.lightvela-playground-sandbox-bj-4.svc.cluster.local:6379",
                sandbox_env,
            )

            env_bootstrap = repo / "argocd/services/env-bootstrap/sandbox-bj-4"
            kustomization = load_yaml_mapping((env_bootstrap / "kustomization.yaml").read_text(), "kustomization")
            self.assertIn("mysql.yaml", kustomization["resources"])
            self.assertIn("redis.yaml", kustomization["resources"])
            self.assertIn("ksops-runtime-secrets-generator.yaml", kustomization["generators"])
            self.assertNotIn("ksops-runtime-secrets-generator.yaml", kustomization["resources"])
            self.assertIn(
                f"../../../secrets/sandbox-bj-4/{PLAYGROUND_RUNTIME_SECRET_FILE}",
                (env_bootstrap / "ksops-runtime-secrets-generator.yaml").read_text(),
            )
            runtime_secret = (repo / f"argocd/secrets/sandbox-bj-4/{PLAYGROUND_RUNTIME_SECRET_FILE}").read_text()
            self.assertIn(f"name: {PLAYGROUND_RUNTIME_SECRET_NAME}", runtime_secret)
            self.assertIn("MYSQL_ROOT_PASSWORD: ENC[", runtime_secret)
            self.assertIn("REDIS_PASSWORD: ENC[", runtime_secret)
            self.assertNotIn("LIGHTCLAW_AUTH_DB_PASSWORD", runtime_secret)
            mysql_runtime = (env_bootstrap / "mysql.yaml").read_text()
            redis_runtime = (env_bootstrap / "redis.yaml").read_text()
            self.assertIn("kind: StatefulSet", mysql_runtime)
            self.assertIn("name: mysql", mysql_runtime)
            self.assertIn(PLAYGROUND_RUNTIME_SECRET_NAME, mysql_runtime)
            self.assertNotIn("lightclaw-auth-secrets", mysql_runtime)
            self.assertIn("volumeClaimTemplates", mysql_runtime)
            self.assertIn("kind: StatefulSet", redis_runtime)
            self.assertIn("name: redis", redis_runtime)
            self.assertIn(PLAYGROUND_RUNTIME_SECRET_NAME, redis_runtime)
            self.assertNotIn("sandbox-runtime-secrets", redis_runtime)
            self.assertIn("volumeClaimTemplates", redis_runtime)
            self.assertIn("storage: 10Gi", redis_runtime)
            self.assertIn("--appendonly yes", redis_runtime)
            serviceaccount = (env_bootstrap / "serviceaccount.yaml").read_text()
            for name in PLAYGROUND_PULL_SECRET_NAMES:
                self.assertIn(f"name: {name}", serviceaccount)
            pull_secret = load_yaml_mapping(
                (repo / "argocd/secrets/sandbox-bj-4/tcr-bj8-lightclaw-secret.sops.yaml").read_text(),
                "pull-secret",
            )
            self.assertEqual(pull_secret["metadata"]["namespace"], "lightvela-playground-sandbox-bj-4")
            self.assertEqual(pull_secret["metadata"]["name"], "tcr.bj8-lightclaw-secret")

    def test_ctl_rewrite_points_to_namespace_local_stateful_services(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")
            rendered = render_clone_text(
                textwrap.dedent(
                    """
                    data:
                      server_conf_rewrite.toml: |
                        [db]
                        host = "10.31.192.4"
                        password = "old"
                        database = "ctl_sandbox_bj_3"

                        [redis]
                        host = "10.31.192.2"
                        pass = "old"
                    """
                ),
                plan,
                PlaygroundRuntimeSecretValues(mysql_root_password="mysql-root", redis_password="redis-pass"),
            )

        self.assertIn('host = "mysql.lightvela-playground-sandbox-bj-4.svc.cluster.local"', rendered)
        self.assertIn('host = "redis.lightvela-playground-sandbox-bj-4.svc.cluster.local"', rendered)
        self.assertNotIn('password = "old"', rendered)
        self.assertNotIn('pass = "old"', rendered)

    def test_create_playground_conflicts_fail_without_force(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")
            write_clone_plan_for_test(plan)

            self.assertTrue(target_conflicts(plan))
            with self.assertRaises(FileExistsError):
                write_clone_plan_for_test(plan)

    def test_create_playground_rewrites_sops_secret_metadata_without_decrypting_payload(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")
            write_clone_plan_for_test(plan)

            target = repo / "argocd/secrets/sandbox-bj-4/tcr-bj8-lightclaw-secret.sops.yaml"
            payload = load_yaml_mapping(target.read_text(), "target")

            self.assertEqual(payload["metadata"]["namespace"], "lightvela-playground-sandbox-bj-4")
            self.assertEqual(payload["metadata"]["name"], "tcr.bj8-lightclaw-secret")
            self.assertEqual(payload["stringData"][".dockerconfigjson"], "ENC[AES256_GCM,data:registry]")

    def test_create_playground_validation_rejects_unmapped_source_residue(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            stale_file = repo / "argocd/services/ctl/sandbox-bj-3/stale-domain.yaml"
            stale_file.write_text("host: unmapped-bj83.lightclaw.tech\n")

            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")
            errors = validate_clone_plan(plan)

        self.assertTrue(any("source environment residue" in error for error in errors), errors)

    def test_create_playground_validation_rejects_catalog_sourcepath_without_generated_service(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            broken_catalog = repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-3/ctl.yaml"
            broken_catalog.write_text(
                textwrap.dedent(
                    """
                    service: ctl
                    env: sandbox-bj-3
                    project: beijing-playground
                    destinationName: beijing-playground
                    namespace: lightvela-playground-sandbox-bj-3
                    sourcePath: argocd/services/missing/sandbox-bj-3
                    environmentModel: playground
                    playgroundCluster: beijing-playground
                    """
                ).lstrip()
            )

            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")
            errors = validate_clone_plan(plan)

        self.assertTrue(any("sourcePath" in error and "generated service dirs" in error for error in errors), errors)

    def test_contract_checker_passes_static_contract_with_warnings(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            write_clone_plan_for_test(build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4"))

            stdout = StringIO()
            with redirect_stdout(stdout):
                exit_code = check_playground_contract_main(["--repo-root", str(repo), "--env", "sandbox-bj-4"])

        self.assertEqual(exit_code, 0)
        self.assertIn("Playground catalog contract: OK", stdout.getvalue())
        self.assertIn("Playground network contract: WARN", stdout.getvalue())

    def test_contract_checker_accepts_fully_encrypted_pull_secret_metadata(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            write_clone_plan_for_test(build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4"))
            for filename in ("tcr-bj8-lightclaw-secret.sops.yaml", "tcr-ccr-clawhub-secret.sops.yaml"):
                path = repo / f"argocd/secrets/sandbox-bj-4/{filename}"
                payload = load_yaml_mapping(path.read_text(), path.as_posix())
                payload["metadata"]["name"] = "ENC[AES256_GCM,data:name]"
                payload["metadata"]["namespace"] = "ENC[AES256_GCM,data:namespace]"
                path.write_text(yaml_dump_for_test(payload))

            stdout = StringIO()
            with redirect_stdout(stdout):
                exit_code = check_playground_contract_main(["--repo-root", str(repo), "--env", "sandbox-bj-4"])

        self.assertEqual(exit_code, 0)
        self.assertNotIn("must generate Secret", stdout.getvalue())

    def test_contract_checker_warns_for_qcloud_cert_ids_until_tls_probe_runs(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            write_clone_plan_for_test(build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4"))
            cert_file = repo / "argocd/services/service-gateway/sandbox-bj-4/tls-secrets.yaml"
            cert_file.write_text("stringData:\n  qcloud_cert_id: copied-cert\n")

            stdout = StringIO()
            with redirect_stdout(stdout):
                exit_code = check_playground_contract_main(["--repo-root", str(repo), "--env", "sandbox-bj-4"])

        self.assertEqual(exit_code, 0)
        self.assertIn("Playground network contract: WARN", stdout.getvalue())
        self.assertIn("--check-tls", stdout.getvalue())

    def test_contract_checker_rejects_wrong_sandbox_public_host(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            write_clone_plan_for_test(build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4"))
            sandbox_env = repo / "argocd/services/sandbox/sandbox-bj-4/sandbox-platform.env"
            sandbox_env.write_text(sandbox_env.read_text().replace("*.sandbox-bj-4.lightclaw.tech", "*.sandbox-bj-3.lightclaw.tech"))

            stdout = StringIO()
            with redirect_stdout(stdout):
                exit_code = check_playground_contract_main(["--repo-root", str(repo), "--env", "sandbox-bj-4"])

        self.assertEqual(exit_code, 1)
        self.assertIn("SANDBOX_INGRESSPROXY_PUBLIC_HOST", stdout.getvalue())

    def test_create_playground_can_set_project_and_cluster_independently(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            plan = build_playground_clone_plan(
                repo,
                "sandbox-bj-3",
                "sandbox-bj-4",
                cluster_name="playground-cluster-2",
                project="playground-project-2",
            )
            write_clone_plan_for_test(plan)

            catalog = load_yaml_mapping(
                (repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-4/ctl.yaml").read_text(),
                "catalog",
            )

        self.assertEqual(catalog["project"], "playground-project-2")
        self.assertEqual(catalog["destinationName"], "playground-cluster-2")
        self.assertEqual(catalog["playgroundCluster"], "playground-cluster-2")

    def test_render_clone_text_rewrites_identity_isolation_and_domains(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")

            rendered = render_clone_text(
                "sandbox-bj-3 sandbox_bj_3 lightvela-playground-sandbox-bj-3 "
                "lightclaw-auth.lightvela-playground-sandbox-bj-3.svc.cluster.local "
                "api-bj83.lightclaw.tech *.sandbox-bj83.lightclaw.tech sandbox-bj83-lightclaw-tech-wildcard-tls",
                plan,
            )

        self.assertIn("sandbox-bj-4", rendered)
        self.assertIn("sandbox_bj_4", rendered)
        self.assertIn("lightvela-playground-sandbox-bj-4", rendered)
        self.assertIn("api-sandbox-bj-4.lightclaw.tech", rendered)
        self.assertIn("*.sandbox-bj-4.lightclaw.tech", rendered)
        self.assertIn("sandbox-bj-4-lightclaw-tech-wildcard-tls", rendered)
        self.assertNotIn("sandbox-bj-3", rendered)
        self.assertNotIn("bj83", rendered)

    def test_playground_database_grants_are_env_scoped(self) -> None:
        grants = playground_database_grants("sandbox-bj-4")

        self.assertEqual(
            [grant.database for grant in grants],
            [
                "ctl_sandbox_bj_4",
                "lightclaw_auth_sandbox_bj_4",
                "lightclaw_payment_sandbox_bj_4",
                "ai_gateway_sandbox_bj_4",
                "lightclaw_subscription_sandbox_bj_4",
                "cvm_sandbox_bj_4",
            ],
        )

    def test_korea_playground_database_grants_are_env_scoped(self) -> None:
        grants = playground_database_grants("sandbox-kr-1")

        self.assertEqual(
            [grant.database for grant in grants],
            [
                "ctl_sandbox_kr_1",
                "lightclaw_auth_sandbox_kr_1",
                "lightclaw_payment_sandbox_kr_1",
                "ai_gateway_sandbox_kr_1",
                "lightclaw_subscription_sandbox_kr_1",
                "cvm_sandbox_kr_1",
            ],
        )

    def test_bootstrap_manifest_uses_secret_refs_without_plain_secret_values(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-b", "master")
            git(repo, "commit", "--allow-empty", "-m", "root")

            plan = build_playground_bootstrap_plan(
                repo,
                "sandbox-bj-4",
                kubeconfig=Path("/tmp/kubeconfig"),
                mysql_host="10.31.192.4",
            )
            manifest = bootstrap_database_job_manifest(plan)
            rendered = yaml_dump_for_test(manifest)

        self.assertIn("db-bootstrap-sandbox-bj-4", rendered)
        self.assertIn("playground-runtime-secrets", rendered)
        self.assertIn("PAYMENT_DB_PASSWORD", rendered)
        self.assertIn("ctl_sandbox_bj_4", rendered)
        self.assertNotIn("replace-with-secret", rendered)

    def test_korea_bootstrap_manifest_uses_env_scoped_ctl_database(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-b", "master")
            git(repo, "commit", "--allow-empty", "-m", "root")

            plan = build_playground_bootstrap_plan(
                repo,
                "sandbox-kr-1",
                kubeconfig=Path("/tmp/kubeconfig"),
                mysql_host="10.31.192.4",
            )
            manifest = bootstrap_database_job_manifest(plan)
            rendered = yaml_dump_for_test(manifest)

        self.assertIn("db-bootstrap-sandbox-kr-1", rendered)
        self.assertIn("ctl_sandbox_kr_1", rendered)
        self.assertNotIn("ctl_sandbox_bj", rendered)

    def test_create_playground_missing_sops_fails_before_writes(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")

            with patch.dict(os.environ, {"PATH": "", "SOPS_AGE_KEY_FILE": "", "SOPS_AGE_KEY": ""}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "missing required command: sops"):
                    write_clone_plan(plan)

            self.assertFalse((repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-4").exists())
            self.assertFalse((repo / "argocd/secrets/sandbox-bj-4").exists())

    def test_create_playground_runtime_secret_encryption_failure_leaves_no_writes(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")

            def failing_encryptor(_plan):
                raise RuntimeError("synthetic encrypt failure")

            with self.assertRaisesRegex(RuntimeError, "synthetic encrypt failure"):
                write_clone_plan(plan, runtime_secret_encryptor=failing_encryptor)

            self.assertFalse((repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-4").exists())
            self.assertFalse((repo / "argocd/secrets/sandbox-bj-4").exists())

    def test_create_playground_missing_sops_recipient_leaves_no_writes(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            for path in (repo / "argocd/secrets/sandbox-bj-3").glob("*.sops.yaml"):
                path.write_text("encrypted: no-recipient\n")
            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")

            def recipient_check_encryptor(_plan):
                resolve_playground_runtime_recipients(_plan)
                return b"unreachable\n"

            with self.assertRaisesRegex(RuntimeError, "missing SOPS age recipient"):
                write_clone_plan(plan, runtime_secret_encryptor=recipient_check_encryptor)

            self.assertFalse((repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-4").exists())

    def test_contract_checker_rejects_missing_runtime_secret(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            write_clone_plan_for_test(build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4"))
            (repo / f"argocd/secrets/sandbox-bj-4/{PLAYGROUND_RUNTIME_SECRET_FILE}").unlink()

            stdout = StringIO()
            with redirect_stdout(stdout):
                exit_code = check_playground_contract_main(["--repo-root", str(repo), "--env", "sandbox-bj-4"])

        self.assertEqual(exit_code, 1)
        self.assertIn(PLAYGROUND_RUNTIME_SECRET_FILE, stdout.getvalue())

    def test_contract_checker_rejects_broad_runtime_secret_refs(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            write_clone_plan_for_test(build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4"))
            mysql_runtime = repo / "argocd/services/env-bootstrap/sandbox-bj-4/mysql.yaml"
            mysql_runtime.write_text(mysql_runtime.read_text().replace(PLAYGROUND_RUNTIME_SECRET_NAME, "lightclaw-auth-secrets"))

            stdout = StringIO()
            with redirect_stdout(stdout):
                exit_code = check_playground_contract_main(["--repo-root", str(repo), "--env", "sandbox-bj-4"])

        self.assertEqual(exit_code, 1)
        self.assertIn("must not use broad service secrets", stdout.getvalue())

    def test_run_playground_db_jobs_reads_root_password_from_runtime_secret(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-b", "master")
            git(repo, "commit", "--allow-empty", "-m", "root")
            plan = build_playground_bootstrap_plan(
                repo,
                "sandbox-bj-4",
                kubeconfig=Path("/tmp/kubeconfig"),
                mysql_host="mysql.lightvela-playground-sandbox-bj-4.svc.cluster.local",
            )

            with (
                patch("gitops.playground_environment.secret_value_from_cluster", return_value="root-password") as secret,
                patch("gitops.playground_environment.subprocess.run") as run,
            ):
                run_playground_db_jobs(plan, set(), 1, 1)

        secret.assert_called_once_with(
            plan.kubeconfig,
            plan.namespace,
            PLAYGROUND_RUNTIME_SECRET_NAME,
            "MYSQL_ROOT_PASSWORD",
            1,
        )
        self.assertEqual(run.call_count, len(plan.db_jobs))
        self.assertTrue(all(call.kwargs["env"]["CTL_TEST_MYSQL_PASSWORD"] == "root-password" for call in run.call_args_list))

def create_playground_fixture(repo: Path) -> None:
    services = (
        "admin-gateway",
        "ai-gateway",
        "ctl",
        "env-bootstrap",
        "gateway-dashboard",
        "lightclaw-auth",
        "nextgen-dashboard",
        "payment",
        "sandbox",
        "service-gateway",
        "session",
        "subscription",
    )
    catalog_dir = repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-3"
    catalog_dir.mkdir(parents=True)
    for service in services:
        (catalog_dir / f"{service}.yaml").write_text(
            textwrap.dedent(
                f"""
                service: {service}
                env: sandbox-bj-3
                project: beijing-playground
                destinationName: beijing-playground
                namespace: lightvela-playground-sandbox-bj-3
                sourcePath: argocd/services/{service}/sandbox-bj-3
                environmentModel: playground
                playgroundCluster: beijing-playground
                """
            ).lstrip()
        )
        service_dir = repo / "argocd/services" / service / "sandbox-bj-3"
        service_dir.mkdir(parents=True)
        (service_dir / "kustomization.yaml").write_text(
            textwrap.dedent(
                """
                resources:
                  - ../common
                patches:
                  - path: patch-playground-db.yaml
                """
            ).lstrip()
        )
        (service_dir / "README.md").write_text("sandbox-bj-3 service closure\n")

    (repo / "argocd/services/ai-gateway/sandbox-bj-3/patch-playground-db.yaml").write_text(
        "AI_GATEWAY_DB: ai_gateway_sandbox_bj_3\n"
    )
    (repo / "argocd/services/service-gateway/sandbox-bj-3/config.yaml").write_text(
        "auth_service_url: http://lightclaw-auth.lightvela-playground-sandbox-bj-3.svc.cluster.local\n"
    )
    (repo / "argocd/services/sandbox/sandbox-bj-3/sandbox-platform.env").write_text(
        textwrap.dedent(
            """
            SANDBOX_INGRESSPROXY_PUBLIC_HOST=*.sandbox-bj83.lightclaw.tech
            SANDBOX_INGRESSPROXY_HEALTHCHECK_HOST=sandbox-bj83.lightclaw.tech
            SANDBOX_INGRESSPROXY_TLS_SECRET_NAME=sandbox-bj83-lightclaw-tech-wildcard-tls
            SANDBOX_MYSQL_HOST=10.31.192.4
            SANDBOX_REDIS_ADDR=10.31.192.10:6379
            """
        ).lstrip()
    )
    (repo / "argocd/services/sandbox/sandbox-bj-3/patch-playground-db-redis.yaml").write_text(
        textwrap.dedent(
            """
            MYSQL_DB: cvm_sandbox_bj_3
            REDIS_ROUTE_PREFIX: "route:sandbox-bj-3:"
            """
        ).lstrip()
    )
    secret_dir = repo / "argocd/secrets/sandbox-bj-3"
    secret_dir.mkdir(parents=True)
    (secret_dir / "ai-gateway-runtime-secrets.sops.yaml").write_text(
        textwrap.dedent(
            """
            encrypted: sandbox-bj-3
            sops:
              age:
                - recipient: age1testrecipient
                  enc: test
            """
        ).lstrip()
    )
    for filename, secret_name in (
        ("tcr-bj8-lightclaw-secret.sops.yaml", "tcr.bj8-lightclaw-secret"),
        ("tcr-ccr-clawhub-secret.sops.yaml", "tcr.ccr-clawhub-secret"),
    ):
        (secret_dir / filename).write_text(
            textwrap.dedent(
                f"""
                apiVersion: v1
                kind: Secret
                metadata:
                  name: {secret_name}
                  namespace: lightvela-playground-sandbox-bj-3
                  annotations:
                    managed-by: harness-ci-sandbox-bj-3-bootstrap
                type: kubernetes.io/dockerconfigjson
                stringData:
                  .dockerconfigjson: ENC[AES256_GCM,data:registry]
                sops:
                  age:
                    - recipient: age1testrecipient
                      enc: test
                """
            ).lstrip()
        )
    (secret_dir / "README.md").write_text("secret notes for sandbox-bj-3\n")


def fake_runtime_secret_encryptor(plan) -> bytes:
    return textwrap.dedent(
        f"""
        apiVersion: v1
        kind: Secret
        metadata:
          name: {PLAYGROUND_RUNTIME_SECRET_NAME}
          namespace: {plan.namespace}
        type: Opaque
        stringData:
          MYSQL_ROOT_PASSWORD: ENC[AES256_GCM,data:mysql-root]
          REDIS_PASSWORD: ENC[AES256_GCM,data:redis]
        sops:
          age:
            - recipient: age1testrecipient
              enc: test
        """
    ).lstrip().encode()


def write_clone_plan_for_test(plan, *, force: bool = False):
    return write_clone_plan(plan, force=force, runtime_secret_encryptor=fake_runtime_secret_encryptor)


def yaml_dump_for_test(payload: object) -> str:
    import yaml

    return yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)


if __name__ == "__main__":
    unittest.main()
