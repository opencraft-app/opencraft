import os
import tempfile
import textwrap
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

from scripts.validate_gitops_kustomize import find_placeholders, main as kustomize_main


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

    def write_repo(self, repo: Path) -> Path:
        (repo / "argocd/catalogs/sandbox/beijing-sandbox").mkdir(parents=True)
        (repo / "argocd/services/demo/beijing-sandbox").mkdir(parents=True)
        (repo / "argocd/catalogs/sandbox/beijing-sandbox/demo.yaml").write_text(
            textwrap.dedent(
                """\
                service: demo
                env: beijing-sandbox
                project: beijing-sandbox
                destinationName: beijing-sandbox
                namespace: demo
                sourcePath: argocd/services/demo/beijing-sandbox
                """
            )
        )
        (repo / "argocd/services/demo/beijing-sandbox/kustomization.yaml").write_text("kind: Kustomization\n")
        return repo

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
