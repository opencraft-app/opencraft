import os
import subprocess
import tempfile
import textwrap
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
import sys

RUNTIME_DIR = Path(__file__).resolve().parents[1]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops.gitops_kustomize_validation import find_placeholders, main as kustomize_main


class GitOpsKustomizeValidationTests(unittest.TestCase):
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

    def test_shprod_changed_only_validates_changed_direct_app(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self.write_shprod_direct_app(repo, "admin-gateway")
            self.write_shprod_direct_app(repo, "frontend")
            self.git(repo, "init")
            self.git(repo, "config", "user.email", "ci@example.com")
            self.git(repo, "config", "user.name", "CI")
            self.git(repo, "add", ".")
            self.git(repo, "commit", "-m", "base")
            (repo / "argocd/services/frontend/shprod/frontend-platform.env").write_text("FRONTEND_IMAGE=demo\n")
            self.git(repo, "add", ".")
            self.git(repo, "commit", "-m", "promote frontend")

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

    def write_repo(self, repo: Path, env: str = "beijing-sandbox") -> Path:
        (repo / f"argocd/catalogs/sandbox/{env}").mkdir(parents=True)
        (repo / f"argocd/services/demo/{env}").mkdir(parents=True)
        (repo / f"argocd/catalogs/sandbox/{env}/demo.yaml").write_text(
            textwrap.dedent(
                f"""\
                service: demo
                env: {env}
                project: {env}
                destinationName: {env}
                namespace: demo
                sourcePath: argocd/services/demo/{env}
                """
            )
        )
        (repo / f"argocd/services/demo/{env}/kustomization.yaml").write_text("kind: Kustomization\n")
        return repo

    def write_shprod_direct_app(self, repo: Path, service: str) -> None:
        (repo / "argocd/apps/shprod").mkdir(parents=True, exist_ok=True)
        (repo / f"argocd/services/{service}/shprod").mkdir(parents=True, exist_ok=True)
        (repo / f"argocd/apps/shprod/{service}.yaml").write_text(
            textwrap.dedent(
                f"""\
                apiVersion: argoproj.io/v1alpha1
                kind: Application
                metadata:
                  name: {service}-shprod
                spec:
                  source:
                    path: argocd/services/{service}/shprod
                """
            )
        )
        (repo / f"argocd/services/{service}/shprod/kustomization.yaml").write_text("kind: Kustomization\n")

    def git(self, repo: Path, *args: str) -> None:
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)

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
