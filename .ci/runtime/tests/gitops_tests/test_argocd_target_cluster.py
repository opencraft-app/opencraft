import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
import sys

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops.argocd_target_cluster import (
    cluster_payload_from_kubeconfig,
    load_yaml_mapping,
    validate_project_manifest,
)


class ArgoTargetClusterTests(unittest.TestCase):
    def test_builds_cluster_payload_from_client_cert_kubeconfig(self) -> None:
        with TemporaryDirectory() as tmp:
            kubeconfig = Path(tmp) / "kubeconfig"
            kubeconfig.write_text(
                textwrap.dedent(
                    """
                    apiVersion: v1
                    current-context: cls-ftjhqdjt
                    clusters:
                      - name: cls-ftjhqdjt
                        cluster:
                          server: https://example.invalid:443
                          certificate-authority-data: ca-data
                    contexts:
                      - name: cls-ftjhqdjt
                        context:
                          cluster: cls-ftjhqdjt
                          user: ci-user
                    users:
                      - name: ci-user
                        user:
                          client-certificate-data: cert-data
                          client-key-data: key-data
                    """
                )
            )

            payload = cluster_payload_from_kubeconfig(
                kubeconfig,
                "beijing-sandbox-2",
                "https://example.invalid:443",
            )

        self.assertEqual(payload["name"], "beijing-sandbox-2")
        self.assertEqual(payload["server"], "https://example.invalid:443")
        tls = payload["config"]["tlsClientConfig"]
        self.assertEqual(tls["caData"], "ca-data")
        self.assertEqual(tls["certData"], "cert-data")
        self.assertEqual(tls["keyData"], "key-data")

    def test_rejects_project_rbac_resources_not_supported_by_argocd(self) -> None:
        project = load_yaml_mapping(Path("argocd/projects/beijing-sandbox-2.yaml"))
        validate_project_manifest(project, Path("argocd/projects/beijing-sandbox-2.yaml"))

        project["spec"]["roles"][0]["policies"].append(
            "p, proj:beijing-sandbox-2:mono-observe, projects, get, beijing-sandbox-2, allow"
        )
        with self.assertRaisesRegex(ValueError, "unsupported Argo project RBAC resource 'projects'"):
            validate_project_manifest(project, Path("argocd/projects/beijing-sandbox-2.yaml"))


if __name__ == "__main__":
    unittest.main()
