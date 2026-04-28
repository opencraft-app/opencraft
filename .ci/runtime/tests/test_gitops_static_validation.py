import shutil
import tempfile
import textwrap
import unittest
from pathlib import Path
import sys

RUNTIME_DIR = Path(__file__).resolve().parents[1]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from validate_gitops_static import validate


class GitOpsStaticValidationTests(unittest.TestCase):
    def test_valid_beijing_appset_catalog_and_publish_closure_passes(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)

            errors = validate(
                repo,
                "beijing-sandbox",
                repo / ".ci/runtime/release-bundles.yaml",
            )

            self.assertEqual(errors, [])

    def test_appset_reserved_path_template_fails(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)
            (repo / "argocd/apps/beijing-sandbox/sandbox-family-appset.yaml").write_text(
                self.appset_text("{{ .path }}")
            )

            errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.yaml")

            self.assertTrue(any("must use { .sourcePath }" in error for error in errors))
            self.assertTrue(any("must not use reserved git generator field" in error for error in errors))

    def test_catalog_path_field_fails(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)
            (repo / "argocd/catalogs/sandbox/beijing-sandbox/demo.yaml").write_text(
                textwrap.dedent(
                    """\
                    service: demo
                    env: beijing-sandbox
                    project: beijing-sandbox
                    destinationName: beijing-sandbox
                    namespace: demo
                    path: argocd/services/demo/beijing-sandbox
                    sourcePath: argocd/services/demo/beijing-sandbox
                    """
                )
            )

            errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.yaml")

            self.assertTrue(any("must use sourcePath, not path" in error for error in errors))

    def test_missing_source_path_fails(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)
            shutil.rmtree(repo / "argocd/services/demo/beijing-sandbox")

            errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.yaml")

            self.assertTrue(any("sourcePath does not exist" in error for error in errors))

    def test_missing_common_or_profile_publish_path_fails(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)
            manifest = (repo / ".ci/runtime/release-bundles.yaml").read_text()
            manifest = manifest.replace("      - argocd/services/demo/common/**\n", "")
            manifest = manifest.replace("      - argocd/services/demo/profiles/sandbox/**\n", "")
            (repo / ".ci/runtime/release-bundles.yaml").write_text(manifest)

            errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.yaml")

            self.assertTrue(any("argocd/services/demo/common" in error for error in errors))
            self.assertTrue(any("argocd/services/demo/profiles/sandbox" in error for error in errors))

    def test_business_leaf_app_fails(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)
            (repo / "argocd/apps/beijing-sandbox/demo.yaml").write_text("kind: Application\n")

            errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.yaml")

            self.assertTrue(any("forbids business hand-written leaf apps" in error for error in errors))

    def repo(self) -> tempfile.TemporaryDirectory[str]:
        return tempfile.TemporaryDirectory()

    def write_valid_repo(self, raw_repo: str | Path) -> Path:
        repo = Path(raw_repo)
        (repo / ".ci/runtime").mkdir(parents=True)
        (repo / "argocd/apps/beijing-sandbox").mkdir(parents=True)
        (repo / "argocd/catalogs/sandbox/beijing-sandbox").mkdir(parents=True)
        (repo / "argocd/services/demo/beijing-sandbox").mkdir(parents=True)
        (repo / "argocd/services/demo/common").mkdir(parents=True)
        (repo / "argocd/services/demo/profiles/sandbox").mkdir(parents=True)
        (repo / "argocd/secrets/beijing-sandbox").mkdir(parents=True)

        (repo / ".ci/runtime/release-bundles.yaml").write_text(
            textwrap.dedent(
                """\
                bundles:
                  demo:
                    owner: demo
                    source: demo
                    reason: demo
                    allowed_paths:
                      - demo/k8s/base
                    exit_condition: never
                    publish_paths:
                      - argocd/services/demo/{env}/**
                      - argocd/apps/{env}/demo.yaml
                    publish_paths_by_env:
                      beijing-sandbox:
                        - argocd/services/demo/beijing-sandbox/**
                        - argocd/services/demo/common/**
                        - argocd/services/demo/profiles/sandbox/**
                        - argocd/apps/beijing-sandbox/sandbox-family-appset.yaml
                        - argocd/catalogs/sandbox/beijing-sandbox/demo.yaml
                        - argocd/secrets/beijing-sandbox/demo.sops.yaml
                """
            )
        )
        (repo / "argocd/apps/beijing-sandbox/sandbox-family-appset.yaml").write_text(
            self.appset_text("{{ .sourcePath }}")
        )
        (repo / "argocd/apps/beijing-sandbox/argocd-runtime.yaml").write_text("kind: Application\n")
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
        (repo / "argocd/services/demo/beijing-sandbox/kustomization.yaml").write_text(
            textwrap.dedent(
                """\
                apiVersion: kustomize.config.k8s.io/v1beta1
                kind: Kustomization
                components:
                  - ../common
                  - ../profiles/sandbox
                generators:
                  - ksops-secret-generator.yaml
                """
            )
        )
        (repo / "argocd/services/demo/beijing-sandbox/ksops-secret-generator.yaml").write_text(
            textwrap.dedent(
                """\
                apiVersion: viaduct.ai/v1
                kind: ksops
                files:
                  - ../../../secrets/beijing-sandbox/demo.sops.yaml
                """
            )
        )
        (repo / "argocd/services/demo/common/kustomization.yaml").write_text(
            "apiVersion: kustomize.config.k8s.io/v1alpha1\nkind: Component\n"
        )
        (repo / "argocd/services/demo/profiles/sandbox/kustomization.yaml").write_text(
            "apiVersion: kustomize.config.k8s.io/v1alpha1\nkind: Component\n"
        )
        (repo / "argocd/secrets/beijing-sandbox/demo.sops.yaml").write_text("apiVersion: v1\nkind: Secret\n")
        return repo

    def appset_text(self, source_path_template: str) -> str:
        return textwrap.dedent(
            f"""\
            apiVersion: argoproj.io/v1alpha1
            kind: ApplicationSet
            metadata:
              name: sandbox-family
            spec:
              generators:
                - git:
                    files:
                      - path: argocd/catalogs/sandbox/*/*.yaml
              template:
                spec:
                  source:
                    path: '{source_path_template}'
            """
        )


if __name__ == "__main__":
    unittest.main()
