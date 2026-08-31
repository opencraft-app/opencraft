import shutil
import tempfile
import textwrap
import unittest
from pathlib import Path
import sys
from unittest import mock

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops import gitops_static_validation

validate = gitops_static_validation.validate


class GitOpsStaticValidationTests(unittest.TestCase):
    def test_sgprod_internal_service_token_mismatch_fails(self) -> None:
        errors = gitops_static_validation.validate_sgprod_internal_service_token_values(
            ctl_trade_token="ctl-token",
            ctl_shared_token="ctl-token",
            trade_shared_token="trade-token",
        )

        self.assertEqual(
            errors,
            [
                "sgprod internal service token mismatch: "
                "ctl CTL_TRADE_TOKEN must equal trade LIGHTCLAW_INTERNAL_SERVICE_TOKEN"
            ],
        )

    def test_sgprod_ctl_internal_token_alias_mismatch_fails(self) -> None:
        errors = gitops_static_validation.validate_sgprod_internal_service_token_values(
            ctl_trade_token="trade-token",
            ctl_shared_token="stale-token",
            trade_shared_token="trade-token",
        )

        self.assertEqual(
            errors,
            [
                "sgprod internal service token mismatch: "
                "ctl CTL_TRADE_TOKEN must equal ctl LIGHTCLAW_INTERNAL_SERVICE_TOKEN"
            ],
        )

    def test_sgprod_internal_service_token_contract_decrypts_both_secrets(self) -> None:
        with self.repo() as tmp:
            repo = Path(tmp)
            secret_dir = repo / "argocd/secrets/sgprod"
            secret_dir.mkdir(parents=True)
            ctl_secret = secret_dir / "ctl-runtime-secrets.sops.yaml"
            trade_secret = secret_dir / "trade-runtime-secrets.sops.yaml"
            ctl_secret.write_text("encrypted ctl secret\n")
            trade_secret.write_text("encrypted trade secret\n")

            values = {
                (ctl_secret.name, "CTL_TRADE_TOKEN"): "ctl-token",
                (ctl_secret.name, "LIGHTCLAW_INTERNAL_SERVICE_TOKEN"): "ctl-token",
                (trade_secret.name, "LIGHTCLAW_INTERNAL_SERVICE_TOKEN"): "trade-token",
            }
            with mock.patch.object(
                gitops_static_validation,
                "decrypt_sops_secret_value",
                create=True,
                side_effect=lambda path, key: values[(path.name, key)],
            ):
                errors = (
                    gitops_static_validation.validate_sgprod_internal_service_token_contract(
                        repo
                    )
                )

            self.assertEqual(
                errors,
                [
                    "sgprod internal service token mismatch: "
                    "ctl CTL_TRADE_TOKEN must equal trade LIGHTCLAW_INTERNAL_SERVICE_TOKEN"
                ],
            )

    def test_valid_beijing_appset_catalog_and_publish_closure_passes(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)

            errors = validate(
                repo,
                "beijing-sandbox",
                repo / ".ci/runtime/release-bundles.manifest",
            )

            self.assertEqual(errors, [])

    def test_valid_beijing_sandbox2_catalog_and_publish_closure_passes(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp, env="beijing-sandbox-2")

            errors = validate(
                repo,
                "beijing-sandbox-2",
                repo / ".ci/runtime/release-bundles.manifest",
            )

            self.assertEqual(errors, [])

    def test_valid_playground_catalog_passes_without_release_bundle_closure(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp, env="sandbox-bj-6")

            errors = validate(
                repo,
                "sandbox-bj-6",
                repo / ".ci/runtime/release-bundles.manifest",
            )

            self.assertEqual(errors, [])

    def test_valid_tokyo_playground_catalog_passes_without_release_bundle_closure(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp, env="sandbox-jp-1")

            errors = validate(
                repo,
                "sandbox-jp-1",
                repo / ".ci/runtime/release-bundles.manifest",
            )

            self.assertEqual(errors, [])

    def test_explicit_catalog_publish_exemption_passes(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp, env="beijing-sandbox-2")
            (repo / ".ci/runtime/release-bundles.manifest").write_text(
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

            errors = validate(repo, "beijing-sandbox-2", repo / ".ci/runtime/release-bundles.manifest")

            self.assertEqual(errors, [])

    def test_missing_catalog_publish_exemption_fails(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp, env="beijing-sandbox-2")
            (repo / ".ci/runtime/release-bundles.manifest").write_text(
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

            errors = validate(repo, "beijing-sandbox-2", repo / ".ci/runtime/release-bundles.manifest")

            self.assertTrue(any("catalog is not covered" in error for error in errors))

    def test_empty_env_publish_paths_skip_bundle_closure(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)
            manifest = (repo / ".ci/runtime/release-bundles.manifest").read_text()
            manifest += textwrap.dedent(
                """\
                  disabled:
                    owner: disabled
                    source: disabled
                    reason: disabled
                    allowed_paths:
                      - disabled/k8s/base
                    exit_condition: never
                    publish_paths:
                      - argocd/catalogs/playground/beijing-playground/{env}/disabled.yaml
                    publish_paths_by_env:
                      beijing-sandbox: []
                """
            )
            (repo / ".ci/runtime/release-bundles.manifest").write_text(manifest)

            errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.manifest")

            self.assertEqual(errors, [])

    def test_appset_reserved_path_template_fails(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)
            (repo / "argocd/apps/beijing-sandbox/sandbox-family-appset.yaml").write_text(
                self.appset_text("{{ .path }}")
            )

            errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.manifest")

            self.assertTrue(any("must use { .sourcePath }" in error for error in errors))
            self.assertTrue(any("must not use reserved git generator field" in error for error in errors))

    def test_appset_requires_every_playground_catalog_family(self) -> None:
        required_paths = (
            "argocd/catalogs/playground/beijing-playground/*/*.yaml",
            "argocd/catalogs/playground/seoul-playground/*/*.yaml",
            "argocd/catalogs/playground/tokyo-playground/*/*.yaml",
        )
        for required_path in required_paths:
            with self.subTest(required_path=required_path), self.repo() as tmp:
                repo = self.write_valid_repo(tmp)
                appset = repo / "argocd/apps/beijing-sandbox/sandbox-family-appset.yaml"
                appset.write_text(appset.read_text().replace(f"          - path: {required_path}\n", ""))

                errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.manifest")

                self.assertTrue(any(required_path in error for error in errors), msg=errors)

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

            errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.manifest")

            self.assertTrue(any("must use sourcePath, not path" in error for error in errors))

    def test_missing_source_path_fails(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)
            shutil.rmtree(repo / "argocd/services/demo/beijing-sandbox")

            errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.manifest")

            self.assertTrue(any("sourcePath does not exist" in error for error in errors))

    def test_missing_common_or_profile_publish_path_fails(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)
            manifest = (repo / ".ci/runtime/release-bundles.manifest").read_text()
            manifest = manifest.replace("      - argocd/services/demo/common/**\n", "")
            manifest = manifest.replace("      - argocd/services/demo/profiles/sandbox/**\n", "")
            (repo / ".ci/runtime/release-bundles.manifest").write_text(manifest)

            errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.manifest")

            self.assertTrue(any("argocd/services/demo/common" in error for error in errors))
            self.assertTrue(any("argocd/services/demo/profiles/sandbox" in error for error in errors))

    def test_business_leaf_app_fails(self) -> None:
        with self.repo() as tmp:
            repo = self.write_valid_repo(tmp)
            (repo / "argocd/apps/beijing-sandbox/demo.yaml").write_text("kind: Application\n")

            errors = validate(repo, "beijing-sandbox", repo / ".ci/runtime/release-bundles.manifest")

            self.assertTrue(any("forbids business hand-written leaf apps" in error for error in errors))

    def test_sgprod_direct_app_passes(self) -> None:
        with self.repo() as tmp:
            repo = Path(tmp)
            (repo / "argocd/apps/sgprod").mkdir(parents=True)
            (repo / "argocd/services/demo/sgprod").mkdir(parents=True)
            (repo / "argocd/services/demo/sgprod/kustomization.yaml").write_text(
                "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n"
            )
            (repo / "argocd/apps/sgprod/demo.yaml").write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    spec:
                      source:
                        repoURL: git@git.woa.com:wisp/mono2.git
                        targetRevision: gitops
                        path: argocd/services/demo/sgprod
                      destination:
                        name: sgprod
                    """
                )
            )

            errors = validate(repo, "sgprod", repo / ".ci/runtime/release-bundles.manifest")

            self.assertEqual(errors, [])

    def test_shprod_direct_app_allows_declared_dedicated_cluster(self) -> None:
        with self.repo() as tmp:
            repo = Path(tmp)
            (repo / "argocd/apps/shprod").mkdir(parents=True)
            (repo / "argocd/services/velagw/shprod").mkdir(parents=True)
            (repo / "argocd/services/velagw/shprod/kustomization.yaml").write_text(
                "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n"
            )
            (repo / "argocd/projects").mkdir(parents=True)
            (repo / "argocd/projects/shprod-velagw.yaml").write_text(
                "apiVersion: argoproj.io/v1alpha1\nkind: AppProject\nmetadata:\n  name: shprod-velagw\n"
            )
            (repo / "argocd/clusters").mkdir(parents=True)
            (repo / "argocd/clusters/shanghai-llmgateway-prod.yaml").write_text(
                textwrap.dedent(
                    """\
                    apiVersion: lightclaw.dev/v1alpha1
                    kind: ArgoTargetCluster
                    metadata:
                      name: shanghai-llmgateway-prod
                    spec:
                      projectPath: argocd/projects/shprod-velagw.yaml
                      namespaces:
                        - llmgateway
                    """
                )
            )
            (repo / "argocd/apps/shprod/velagw.yaml").write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    spec:
                      project: shprod-velagw
                      source:
                        repoURL: git@git.woa.com:wisp/mono2.git
                        targetRevision: gitops
                        path: argocd/services/velagw/shprod
                      destination:
                        name: shanghai-llmgateway-prod
                        namespace: llmgateway
                    """
                )
            )

            errors = validate(repo, "shprod", repo / ".ci/runtime/release-bundles.manifest")

            self.assertEqual(errors, [])

    def test_shprod_direct_app_rejects_undeclared_dedicated_cluster(self) -> None:
        with self.repo() as tmp:
            repo = Path(tmp)
            (repo / "argocd/apps/shprod").mkdir(parents=True)
            (repo / "argocd/services/velagw/shprod").mkdir(parents=True)
            (repo / "argocd/services/velagw/shprod/kustomization.yaml").write_text(
                "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n"
            )
            (repo / "argocd/apps/shprod/velagw.yaml").write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    spec:
                      project: shprod-velagw
                      source:
                        repoURL: git@git.woa.com:wisp/mono2.git
                        targetRevision: gitops
                        path: argocd/services/velagw/shprod
                      destination:
                        name: missing-cluster
                        namespace: llmgateway
                    """
                )
            )

            errors = validate(repo, "shprod", repo / ".ci/runtime/release-bundles.manifest")

            self.assertTrue(any("missing cluster declaration" in error for error in errors), errors)

    def test_tkex_direct_app_passes(self) -> None:
        with self.repo() as tmp:
            repo = Path(tmp)
            (repo / "argocd/apps/tkexsg").mkdir(parents=True)
            (repo / "argocd/services/demo/tkexsg").mkdir(parents=True)
            (repo / "argocd/services/demo/tkexsg/kustomization.yaml").write_text(
                "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n"
            )
            (repo / "argocd/apps/tkexsg/demo.yaml").write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    spec:
                      source:
                        repoURL: git@git.woa.com:wisp/mono2.git
                        targetRevision: gitops
                        path: argocd/services/demo/tkexsg
                      destination:
                        name: tkexsg
                    """
                )
            )

            errors = validate(repo, "tkexsg", repo / ".ci/runtime/release-bundles.manifest")

            self.assertEqual(errors, [])

    def test_devcloud_dep_direct_app_passes(self) -> None:
        with self.repo() as tmp:
            repo = Path(tmp)
            (repo / "argocd/apps/devcloud-dep").mkdir(parents=True)
            (repo / "argocd/services/channelgateway/devcloud-dep").mkdir(parents=True)
            (repo / "argocd/services/channelgateway/devcloud-dep/kustomization.yaml").write_text(
                "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n"
            )
            (repo / "argocd/apps/devcloud-dep/channelgateway.yaml").write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    spec:
                      source:
                        repoURL: git@git.woa.com:wisp/mono2.git
                        targetRevision: gitops
                        path: argocd/services/channelgateway/devcloud-dep
                      destination:
                        name: devcloud-dep
                    """
                )
            )

            errors = validate(repo, "devcloud-dep", repo / ".ci/runtime/release-bundles.manifest")

            self.assertEqual(errors, [])

    def test_shanghai_workers_direct_app_passes(self) -> None:
        with self.repo() as tmp:
            repo = Path(tmp)
            (repo / "argocd/apps/shanghai-workers").mkdir(parents=True)
            (repo / "argocd/services/workers/shanghai-workers").mkdir(parents=True)
            (repo / "argocd/services/workers/shanghai-workers/kustomization.yaml").write_text(
                "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n"
            )
            (repo / "argocd/apps/shanghai-workers/workers.yaml").write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    spec:
                      source:
                        repoURL: git@git.woa.com:wisp/mono2.git
                        targetRevision: gitops
                        path: argocd/services/workers/shanghai-workers
                      destination:
                        name: shanghai-workers
                    """
                )
            )

            errors = validate(repo, "shanghai-workers", repo / ".ci/runtime/release-bundles.manifest")

            self.assertEqual(errors, [])

    def repo(self) -> tempfile.TemporaryDirectory[str]:
        return tempfile.TemporaryDirectory()

    def write_valid_repo(self, raw_repo: str | Path, env: str = "beijing-sandbox") -> Path:
        repo = Path(raw_repo)
        if env.startswith("sandbox-bj-"):
            catalog_root = f"argocd/catalogs/playground/beijing-playground/{env}"
        elif env.startswith("sandbox-kr-"):
            catalog_root = f"argocd/catalogs/playground/seoul-playground/{env}"
        elif env.startswith("sandbox-jp-"):
            catalog_root = f"argocd/catalogs/playground/tokyo-playground/{env}"
        else:
            catalog_root = f"argocd/catalogs/sandbox/{env}"
        (repo / ".ci/runtime").mkdir(parents=True)
        (repo / "argocd/apps/beijing-sandbox").mkdir(parents=True)
        (repo / catalog_root).mkdir(parents=True)
        (repo / f"argocd/services/demo/{env}").mkdir(parents=True)
        (repo / "argocd/services/demo/common").mkdir(parents=True)
        (repo / "argocd/services/demo/profiles/sandbox").mkdir(parents=True)
        (repo / f"argocd/secrets/{env}").mkdir(parents=True)

        (repo / ".ci/runtime/release-bundles.manifest").write_text(
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
                        - {catalog_root}/demo.yaml
                        - argocd/secrets/{env}/demo.sops.yaml
                """
            )
        )
        (repo / "argocd/apps/beijing-sandbox/sandbox-family-appset.yaml").write_text(
            self.appset_text("{{ .sourcePath }}")
        )
        (repo / "argocd/apps/beijing-sandbox/argocd-runtime.yaml").write_text("kind: Application\n")
        (repo / f"{catalog_root}/demo.yaml").write_text(
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
                      - path: argocd/catalogs/playground/beijing-playground/*/*.yaml
                      - path: argocd/catalogs/playground/seoul-playground/*/*.yaml
                      - path: argocd/catalogs/playground/tokyo-playground/*/*.yaml
              template:
                spec:
                  source:
                    path: '{source_path_template}'
            """
        )


if __name__ == "__main__":
    unittest.main()
