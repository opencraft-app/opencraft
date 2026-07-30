import os
import tempfile
import textwrap
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
import sys

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from tests.helpers import git

from gitops.gitops_kustomize_validation import (
    changed_direct_app_services_from_paths,
    find_placeholders,
    main as kustomize_main,
)


class GitOpsKustomizeValidationTests(unittest.TestCase):
    def test_changed_velagw_base_selects_direct_production_app(self) -> None:
        self.assertEqual(
            changed_direct_app_services_from_paths(
                ["velagw/deploy/k8s/prod/gitops-base/workloads.yaml"],
                "sgprod",
            ),
            {"velagw"},
        )

    def test_find_placeholders_detects_replace_tokens(self) -> None:
        self.assertEqual(find_placeholders("image: REPLACE_IMAGE\nvalue: REPLACE_IMAGE\n"), ["REPLACE_IMAGE"])

    def test_kustomize_validator_rejects_rendered_placeholders(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = self.write_repo(Path(tmp))
            fake_kustomize = repo / "fake-kustomize"
            fake_kustomize.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env bash
                    cat <<'YAML'
                    apiVersion: v1
                    kind: ConfigMap
                    metadata:
                      name: demo
                    data:
                      image: REPLACE_IMAGE
                    YAML
                    """
                )
            )
            fake_kustomize.chmod(0o755)

            exit_code = self.run_main(
                [
                    "validate_gitops_kustomize.py",
                    "--repo-root",
                    str(repo),
                    "--env",
                    "beijing-sandbox",
                    "--kustomize-bin",
                    str(fake_kustomize),
                ]
            )

            self.assertEqual(exit_code, 1)

    def test_kustomize_validator_uses_strict_argo_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = self.write_repo(Path(tmp))
            args_file = repo / "args.txt"
            fake_kustomize = repo / "fake-kustomize"
            fake_kustomize.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    printf '%s\\n' "$@" > {args_file}
                    cat <<'YAML'
                    apiVersion: v1
                    kind: ConfigMap
                    metadata:
                      name: demo
                    YAML
                    """
                )
            )
            fake_kustomize.chmod(0o755)

            exit_code = self.run_main(
                [
                    "validate_gitops_kustomize.py",
                    "--repo-root",
                    str(repo),
                    "--env",
                    "beijing-sandbox",
                    "--kustomize-bin",
                    str(fake_kustomize),
                ]
            )

            self.assertEqual(exit_code, 0)
            args = args_file.read_text().splitlines()
            self.assertIn("build", args)
            self.assertIn("argocd/services/demo/beijing-sandbox", args)
            self.assertIn("--enable-alpha-plugins", args)
            self.assertIn("--enable-exec", args)

    def test_kustomize_validator_loads_sandbox2_catalog_targets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = self.write_repo(Path(tmp), env="beijing-sandbox-2")
            args_file = repo / "args.txt"
            fake_kustomize = repo / "fake-kustomize"
            fake_kustomize.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    printf '%s\\n' "$@" > {args_file}
                    cat <<'YAML'
                    apiVersion: v1
                    kind: ConfigMap
                    metadata:
                      name: demo
                    YAML
                    """
                )
            )
            fake_kustomize.chmod(0o755)

            exit_code = self.run_main(
                [
                    "validate_gitops_kustomize.py",
                    "--repo-root",
                    str(repo),
                    "--env",
                    "beijing-sandbox-2",
                    "--kustomize-bin",
                    str(fake_kustomize),
                ]
            )

            self.assertEqual(exit_code, 0)
            args = args_file.read_text().splitlines()
            self.assertIn("argocd/services/demo/beijing-sandbox-2", args)

    def test_kustomize_validator_loads_playground_catalog_targets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = self.write_repo(Path(tmp), env="sandbox-bj-6")
            args_file = repo / "args.txt"
            fake_kustomize = repo / "fake-kustomize"
            fake_kustomize.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    printf '%s\\n' "$@" > {args_file}
                    cat <<'YAML'
                    apiVersion: v1
                    kind: ConfigMap
                    metadata:
                      name: demo
                    YAML
                    """
                )
            )
            fake_kustomize.chmod(0o755)

            exit_code = self.run_main(
                [
                    "validate_gitops_kustomize.py",
                    "--repo-root",
                    str(repo),
                    "--env",
                    "sandbox-bj-6",
                    "--kustomize-bin",
                    str(fake_kustomize),
                ]
            )

            self.assertEqual(exit_code, 0)
            args = args_file.read_text().splitlines()
            self.assertIn("argocd/services/demo/sandbox-bj-6", args)

    def test_playground_changed_only_validates_changed_catalog_service(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self.write_repo(repo, env="sandbox-bj-6")
            self.write_repo(repo, env="sandbox-bj-6", service="other")
            git(repo, "init")
            git(repo, "config", "user.email", "ci@example.com")
            git(repo, "config", "user.name", "CI")
            git(repo, "add", ".")
            git(repo, "commit", "-m", "base")
            (repo / "argocd/services/demo/sandbox-bj-6/platform.env").write_text("IMAGE=demo\n")
            git(repo, "add", ".")
            git(repo, "commit", "-m", "promote demo")

            args_file = repo / "args.txt"
            fake_kustomize = repo / "fake-kustomize"
            fake_kustomize.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    printf '%s\\n' "$2" >> {args_file}
                    if [ "$2" = "argocd/services/other/sandbox-bj-6" ]; then
                      cat <<'YAML'
                    apiVersion: v1
                    kind: ConfigMap
                    data:
                      image: REPLACE_OTHER_IMAGE
                    YAML
                    else
                      cat <<'YAML'
                    apiVersion: v1
                    kind: ConfigMap
                    metadata:
                      name: demo
                    YAML
                    fi
                    """
                )
            )
            fake_kustomize.chmod(0o755)

            exit_code = self.run_main(
                [
                    "validate_gitops_kustomize.py",
                    "--repo-root",
                    str(repo),
                    "--env",
                    "sandbox-bj-6",
                    "--changed-only",
                    "--kustomize-bin",
                    str(fake_kustomize),
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(args_file.read_text().splitlines(), ["argocd/services/demo/sandbox-bj-6"])

    def test_changed_shared_component_validates_all_service_render_targets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self.write_repo(repo, env="sandbox-bj-6", service="service-gateway")
            (repo / "argocd/services/service-gateway/common").mkdir(parents=True)
            (repo / "argocd/services/service-gateway/common/kustomization.yaml").write_text("kind: Component\n")
            (repo / "argocd/services/service-gateway/shprod").mkdir(parents=True)
            (repo / "argocd/services/service-gateway/shprod/kustomization.yaml").write_text("kind: Kustomization\n")
            git(repo, "init")
            git(repo, "config", "user.email", "ci@example.com")
            git(repo, "config", "user.name", "CI")
            git(repo, "add", ".")
            git(repo, "commit", "-m", "base")
            (repo / "argocd/services/service-gateway/common/kustomization.yaml").write_text(
                "kind: Component\nreplacements: []\n"
            )
            git(repo, "add", ".")
            git(repo, "commit", "-m", "change shared service-gateway common")

            args_file = repo / "args.txt"
            fake_kustomize = repo / "fake-kustomize"
            fake_kustomize.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    printf '%s\\n' "$2" >> {args_file}
                    if [ "$2" = "argocd/services/service-gateway/shprod" ]; then
                      cat <<'YAML'
                    apiVersion: apps/v1
                    kind: Deployment
                    spec:
                      template:
                        spec:
                          containers:
                            - image: REPLACE_SERVICE_GATEWAY_IMAGE
                    YAML
                    else
                      cat <<'YAML'
                    apiVersion: v1
                    kind: ConfigMap
                    metadata:
                      name: service-gateway
                    YAML
                    fi
                    """
                )
            )
            fake_kustomize.chmod(0o755)

            exit_code = self.run_main(
                [
                    "validate_gitops_kustomize.py",
                    "--repo-root",
                    str(repo),
                    "--env",
                    "sandbox-bj-6",
                    "--changed-only",
                    "--kustomize-bin",
                    str(fake_kustomize),
                ]
            )

            self.assertEqual(exit_code, 1)
            self.assertEqual(
                args_file.read_text().splitlines(),
                [
                    "argocd/services/service-gateway/sandbox-bj-6",
                    "argocd/services/service-gateway/shprod",
                ],
            )

    def test_kustomize_validator_accepts_explicit_source_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = self.write_repo(Path(tmp))
            args_file = repo / "args.txt"
            fake_kustomize = repo / "fake-kustomize"
            fake_kustomize.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    printf '%s\\n' "$2" > {args_file}
                    cat <<'YAML'
                    apiVersion: v1
                    kind: ConfigMap
                    metadata:
                      name: demo
                    YAML
                    """
                )
            )
            fake_kustomize.chmod(0o755)

            exit_code = self.run_main(
                [
                    "validate_gitops_kustomize.py",
                    "--repo-root",
                    str(repo),
                    "--env",
                    "shprod",
                    "--source-path",
                    "argocd/services/demo/beijing-sandbox",
                    "--kustomize-bin",
                    str(fake_kustomize),
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(args_file.read_text().strip(), "argocd/services/demo/beijing-sandbox")

    def test_shprod_changed_only_validates_changed_direct_app(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self.write_shprod_direct_app(repo, "admin-gateway")
            self.write_shprod_direct_app(repo, "frontend")
            git(repo, "init")
            git(repo, "config", "user.email", "ci@example.com")
            git(repo, "config", "user.name", "CI")
            git(repo, "add", ".")
            git(repo, "commit", "-m", "base")
            (repo / "argocd/services/frontend/shprod/frontend-platform.env").write_text("FRONTEND_IMAGE=demo\n")
            git(repo, "add", ".")
            git(repo, "commit", "-m", "promote frontend")

            args_file = repo / "args.txt"
            fake_kustomize = repo / "fake-kustomize"
            fake_kustomize.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    printf '%s\\n' "$2" >> {args_file}
                    if [ "$2" = "argocd/services/admin-gateway/shprod" ]; then
                      cat <<'YAML'
                    apiVersion: v1
                    kind: ConfigMap
                    data:
                      host: REPLACE_ADMIN_GATEWAY_PUBLIC_HOST
                    YAML
                    else
                      cat <<'YAML'
                    apiVersion: v1
                    kind: ConfigMap
                    metadata:
                      name: frontend
                    YAML
                    fi
                    """
                )
            )
            fake_kustomize.chmod(0o755)

            exit_code = self.run_main(
                [
                    "validate_gitops_kustomize.py",
                    "--repo-root",
                    str(repo),
                    "--env",
                    "shprod",
                    "--changed-only",
                    "--kustomize-bin",
                    str(fake_kustomize),
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(args_file.read_text().splitlines(), ["argocd/services/frontend/shprod"])

    def test_tkex_direct_app_validates_render_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self.write_direct_app(repo, "tkexsg", "cloudladdergateway")

            args_file = repo / "args.txt"
            fake_kustomize = repo / "fake-kustomize"
            fake_kustomize.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    printf '%s\\n' "$2" > {args_file}
                    cat <<'YAML'
                    apiVersion: platform.stke/v1alpha1
                    kind: StatefulSetPlus
                    metadata:
                      name: lightvela-proxy
                    YAML
                    """
                )
            )
            fake_kustomize.chmod(0o755)

            exit_code = self.run_main(
                [
                    "validate_gitops_kustomize.py",
                    "--repo-root",
                    str(repo),
                    "--env",
                    "tkexsg",
                    "--kustomize-bin",
                    str(fake_kustomize),
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(args_file.read_text().strip(), "argocd/services/cloudladdergateway/tkexsg")

    def test_devcloud_dep_direct_app_validates_render_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self.write_direct_app(repo, "devcloud-dep", "channelgateway")

            args_file = repo / "args.txt"
            fake_kustomize = repo / "fake-kustomize"
            fake_kustomize.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    printf '%s\\n' "$2" > {args_file}
                    cat <<'YAML'
                    apiVersion: apps/v1
                    kind: Deployment
                    metadata:
                      name: channelgateway
                    YAML
                    """
                )
            )
            fake_kustomize.chmod(0o755)

            exit_code = self.run_main(
                [
                    "validate_gitops_kustomize.py",
                    "--repo-root",
                    str(repo),
                    "--env",
                    "devcloud-dep",
                    "--kustomize-bin",
                    str(fake_kustomize),
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(args_file.read_text().strip(), "argocd/services/channelgateway/devcloud-dep")

    def test_shanghai_workers_direct_app_validates_render_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self.write_direct_app(repo, "shanghai-workers", "workers")

            args_file = repo / "args.txt"
            fake_kustomize = repo / "fake-kustomize"
            fake_kustomize.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    printf '%s\\n' "$2" > {args_file}
                    cat <<'YAML'
                    apiVersion: temporal.io/v1alpha1
                    kind: WorkerDeployment
                    metadata:
                      name: rescue-exporter-worker
                    YAML
                    """
                )
            )
            fake_kustomize.chmod(0o755)

            exit_code = self.run_main(
                [
                    "validate_gitops_kustomize.py",
                    "--repo-root",
                    str(repo),
                    "--env",
                    "shanghai-workers",
                    "--kustomize-bin",
                    str(fake_kustomize),
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertEqual(args_file.read_text().strip(), "argocd/services/workers/shanghai-workers")

    def write_repo(self, repo: Path, env: str = "beijing-sandbox", service: str = "demo") -> Path:
        catalog_root = (
            f"argocd/catalogs/playground/beijing-playground/{env}"
            if env.startswith("sandbox-bj-")
            else f"argocd/catalogs/sandbox/{env}"
        )
        (repo / catalog_root).mkdir(parents=True, exist_ok=True)
        (repo / f"argocd/services/{service}/{env}").mkdir(parents=True)
        (repo / f"{catalog_root}/{service}.yaml").write_text(
            textwrap.dedent(
                f"""\
                service: {service}
                env: {env}
                project: {env}
                destinationName: {env}
                namespace: {service}
                sourcePath: argocd/services/{service}/{env}
                """
            )
        )
        (repo / f"argocd/services/{service}/{env}/kustomization.yaml").write_text("kind: Kustomization\n")
        return repo

    def write_shprod_direct_app(self, repo: Path, service: str) -> None:
        self.write_direct_app(repo, "shprod", service)

    def write_direct_app(self, repo: Path, env: str, service: str) -> None:
        (repo / f"argocd/apps/{env}").mkdir(parents=True, exist_ok=True)
        (repo / f"argocd/services/{service}/{env}").mkdir(parents=True, exist_ok=True)
        (repo / f"argocd/apps/{env}/{service}.yaml").write_text(
            textwrap.dedent(
                f"""\
                apiVersion: argoproj.io/v1alpha1
                kind: Application
                metadata:
                  name: {service}-{env}
                spec:
                  source:
                    path: argocd/services/{service}/{env}
                """
            )
        )
        (repo / f"argocd/services/{service}/{env}/kustomization.yaml").write_text("kind: Kustomization\n")


    def run_main(self, argv: list[str]) -> int:
        old_argv = os.sys.argv
        try:
            os.sys.argv = argv
            with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                return kustomize_main()
        finally:
            os.sys.argv = old_argv


if __name__ == "__main__":
    unittest.main()
