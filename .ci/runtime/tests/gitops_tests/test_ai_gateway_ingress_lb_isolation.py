import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


class AiGatewayIngressLbIsolationTests(unittest.TestCase):
    def test_sandbox_model_internal_ingress_uses_controller_created_lb(self) -> None:
        base = (REPO_ROOT / "ai-gateway/k8s/base/manifests.yaml").read_text()
        common = (REPO_ROOT / "argocd/services/ai-gateway/common/kustomization.yaml").read_text()

        self.assertNotIn("kubernetes.io/ingress.existLbId", base)
        self.assertNotIn("AI_GATEWAY_MODEL_INTERNAL_LB_ID", common)
        self.assertNotIn("kubernetes.io/ingress.existLbId", common)

        for env in ("beijing-sandbox", "beijing-sandbox-2"):
            with self.subTest(env=env):
                root = REPO_ROOT / "argocd/services/ai-gateway" / env
                self.assertNotIn("AI_GATEWAY_MODEL_INTERNAL_LB_ID", (root / "ai-gateway-platform.env").read_text())
                self.assertNotIn("AI_GATEWAY_MODEL_INTERNAL_LB_ID", (root / "README.md").read_text())
                self.assertNotIn("kubernetes.io/ingress.existLbId", (root / "kustomization.yaml").read_text())

    def test_production_can_still_bind_precreated_model_internal_lb(self) -> None:
        platform = (REPO_ROOT / "argocd/services/ai-gateway/shprod/ai-gateway-platform.env").read_text()
        kustomization = (REPO_ROOT / "argocd/services/ai-gateway/shprod/kustomization.yaml").read_text()

        self.assertIn("AI_GATEWAY_MODEL_INTERNAL_LB_ID=", platform)
        self.assertIn("AI_GATEWAY_MODEL_INTERNAL_LB_ID", kustomization)
        self.assertIn("kubernetes.io/ingress.existLbId", kustomization)
        self.assertIn("create: true", kustomization)


if __name__ == "__main__":
    unittest.main()
