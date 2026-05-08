import textwrap
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
import sys

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from tests.helpers import git

from gitops.playground_environment import (
    CatalogApp,
    appset_file_globs,
    bootstrap_database_job_manifest,
    build_playground_clone_plan,
    build_playground_bootstrap_plan,
    check_appset_refs,
    check_catalog,
    create_playground_main,
    fetch_origin_refs,
    playground_database_grants,
    load_yaml_mapping,
    render_clone_text,
    target_conflicts,
    write_clone_plan,
)


class PlaygroundEnvironmentTests(unittest.TestCase):
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
                exit_code = create_playground_main(["--repo-root", str(repo), "--to-env", "sandbox-bj-4"])

            self.assertEqual(exit_code, 0)
            self.assertFalse((repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-4").exists())
            self.assertIn("dry-run", stdout.getvalue())
            self.assertIn("需要 Agent/人工确认", stdout.getvalue())
            self.assertIn("风险提示", stdout.getvalue())

    def test_create_playground_write_generates_render_closure(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)

            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")
            written = write_clone_plan(plan)

            catalog_files = list((repo / "argocd/catalogs/playground/beijing-playground/sandbox-bj-4").glob("*.yaml"))
            service_dirs = list((repo / "argocd/services").glob("*/sandbox-bj-4"))
            secret_files = list((repo / "argocd/secrets/sandbox-bj-4").glob("*.sops.yaml"))
            secret_readme = (repo / "argocd/secrets/sandbox-bj-4/README.md").read_text()
            self.assertEqual(len(catalog_files), 12)
            self.assertEqual(len(service_dirs), 12)
            self.assertEqual(len(secret_files), 2)
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

    def test_create_playground_conflicts_fail_without_force(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")
            write_clone_plan(plan)

            self.assertTrue(target_conflicts(plan))
            with self.assertRaises(FileExistsError):
                write_clone_plan(plan)

    def test_create_playground_copies_secret_bytes_without_rewriting_content(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = Path(tmp)
            create_playground_fixture(repo)
            plan = build_playground_clone_plan(repo, "sandbox-bj-3", "sandbox-bj-4")
            write_clone_plan(plan)

            source = repo / "argocd/secrets/sandbox-bj-3/ai-gateway-runtime-secrets.sops.yaml"
            target = repo / "argocd/secrets/sandbox-bj-4/ai-gateway-runtime-secrets.sops.yaml"
            self.assertEqual(source.read_bytes(), target.read_bytes())
            self.assertIn("sandbox-bj-3", target.read_text())

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
            write_clone_plan(plan)

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
        self.assertIn("lightclaw-auth-secrets", rendered)
        self.assertIn("PAYMENT_DB_PASSWORD", rendered)
        self.assertIn("ctl_sandbox_bj_4", rendered)
        self.assertNotIn("replace-with-secret", rendered)

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
    (secret_dir / "ai-gateway-runtime-secrets.sops.yaml").write_text("encrypted: sandbox-bj-3\n")
    (secret_dir / "tcr-ccr-clawhub-secret.sops.yaml").write_text("encrypted: registry\n")
    (secret_dir / "README.md").write_text("secret notes for sandbox-bj-3\n")


def yaml_dump_for_test(payload: object) -> str:
    import yaml

    return yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)


if __name__ == "__main__":
    unittest.main()
