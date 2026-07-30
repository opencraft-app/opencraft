import tempfile
import textwrap
import unittest
from pathlib import Path
import sys

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops.prod_manual_sync_validation import validate


class ProdManualSyncValidationTests(unittest.TestCase):
    def test_rejects_automated_sync_in_prod_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            app = repo / "argocd/apps/shprod/frontend.yaml"
            app.parent.mkdir(parents=True)
            app.write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    metadata:
                      name: frontend-shprod
                    spec:
                      syncPolicy:
                        automated:
                          prune: true
                          selfHeal: true
                    """
                )
            )

            errors = validate(repo, Path("argocd"))

            self.assertTrue(any("must not enable syncPolicy.automated" in error for error in errors))

    def test_allows_absent_or_false_automated_sync_in_prod_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            apps = repo / "argocd/apps/shprod"
            apps.mkdir(parents=True)
            (apps / "frontend.yaml").write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    metadata:
                      name: frontend-shprod
                    spec:
                      project: shprod-frontend
                    """
                )
            )
            (apps / "payment.yaml").write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    metadata:
                      name: payment-shprod
                    spec:
                      syncPolicy:
                        automated: false
                    """
                )
            )

            self.assertEqual(validate(repo, Path("argocd")), [])

    def test_ignores_automated_sync_outside_prod_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            app = repo / "argocd/apps/beijing-sandbox/frontend.yaml"
            app.parent.mkdir(parents=True)
            app.write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    metadata:
                      name: frontend-beijing-sandbox
                    spec:
                      syncPolicy:
                        automated:
                          prune: true
                    """
                )
            )

            self.assertEqual(validate(repo, Path("argocd")), [])

    def test_ignores_prod_token_in_workspace_parent_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="shprod-workspace-") as tmp:
            repo = Path(tmp)
            app = repo / "argocd/apps/beijing-sandbox/frontend.yaml"
            app.parent.mkdir(parents=True)
            app.write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    metadata:
                      name: frontend-beijing-sandbox
                    spec:
                      syncPolicy:
                        automated:
                          prune: true
                    """
                )
            )

            self.assertEqual(validate(repo, Path("argocd")), [])


if __name__ == "__main__":
    unittest.main()
