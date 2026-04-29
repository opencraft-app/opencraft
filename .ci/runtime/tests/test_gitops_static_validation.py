import shutil
import tempfile
import textwrap
import unittest
from pathlib import Path
import sys

RUNTIME_DIR = Path(__file__).resolve().parents[1]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops.gitops_static_validation import validate


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

    def test_valid_beijing_sandbox2_catalog_and_publish_closure_passes(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp, env="beijing-sandbox-2")

            errors = validate(
                repo,
                "beijing-sandbox-2",
                repo / ".ci/runtime/release-bundles.yaml",
            )

            self.assertEqual(errors, [])

    def test_explicit_catalog_publish_exemption_passes(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp, env="beijing-sandbox-2")
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
                        publish_paths_by_env: {}
                    catalog_publish_exemptions_by_env:
                      beijing-sandbox-2:
                        argocd/catalogs/sandbox/beijing-sandbox-2/demo.yaml: demo is deploy-only until its image contract is defined.
                    """
                )
            )

            errors = validate(repo, "beijing-sandbox-2", repo / ".ci/runtime/release-bundles.yaml")

            self.assertEqual(errors, [])

    def test_missing_catalog_publish_exemption_fails(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp, env="beijing-sandbox-2")
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
                        publish_paths_by_env: {}
                    """
                )
            )

            errors = validate(repo, "beijing-sandbox-2", repo / ".ci/runtime/release-bundles.yaml")

            self.assertTrue(any("catalog is not covered" in error for error in errors))

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

    def write_valid_repo(self, raw_repo: str | Path, env: str = "beijing-sandbox") -> Path:
        repo = Path(raw_repo)
        (repo / ".ci/runtime").mkdir(parents=True)
        (repo / "argocd/apps/beijing-sandbox").mkdir(parents=True)
        (repo / f"argocd/catalogs/sandbox/{env}").mkdir(parents=True)
        (repo / f"argocd/services/demo/{env}").mkdir(parents=True)
        (repo / "argocd/services/demo/common").mkdir(parents=True)
        (repo / "argocd/services/demo/profiles/sandbox").mkdir(parents=True)
        (repo / f"argocd/secrets/{env}").mkdir(parents=True)

        (repo / ".ci/runtime/release-bundles.yaml").write_text(
            textwrap.dedent(
                f"""\
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
                      {env}:
                        - argocd/services/demo/{env}/**
                        - argocd/services/demo/common/**
                        - argocd/services/demo/profiles/sandbox/**
                        - argocd/apps/beijing-sandbox/sandbox-family-appset.yaml
                        - argocd/catalogs/sandbox/{env}/demo.yaml
                        - argocd/secrets/{env}/demo.sops.yaml
                """
            )
        )
        (repo / "argocd/apps/beijing-sandbox/sandbox-family-appset.yaml").write_text(
            self.appset_text("{{ .sourcePath }}")
        )
        (repo / "argocd/apps/beijing-sandbox/argocd-runtime.yaml").write_text("kind: Application\n")
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
        (repo / f"argocd/services/demo/{env}/kustomization.yaml").write_text(
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
        (repo / f"argocd/services/demo/{env}/ksops-secret-generator.yaml").write_text(
            textwrap.dedent(
                f"""\
                apiVersion: viaduct.ai/v1
                kind: ksops
                files:
                  - ../../../secrets/{env}/demo.sops.yaml
                """
            )
        )
        (repo / "argocd/services/demo/common/kustomization.yaml").write_text(
            "apiVersion: kustomize.config.k8s.io/v1alpha1\nkind: Component\n"
        )
        (repo / "argocd/services/demo/profiles/sandbox/kustomization.yaml").write_text(
            "apiVersion: kustomize.config.k8s.io/v1alpha1\nkind: Component\n"
        )
        (repo / f"argocd/secrets/{env}/demo.sops.yaml").write_text("apiVersion: v1\nkind: Secret\n")
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
