from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[4]
AUTH_GITOPS = REPO_ROOT / "argocd" / "services" / "lightclaw-auth"


class ShadowBindingAdminTestingConfigTest(unittest.TestCase):
    def test_sandbox_bj_7_enables_the_matching_testing_environment(self) -> None:
        patch = (AUTH_GITOPS / "sandbox-bj-7" / "patch-shadowbinding.yaml").read_text(encoding="utf-8")
        self.assertIn('SHADOW_BINDING_ADMIN_ENABLED: "true"', patch)
        self.assertIn('SHADOW_BINDING_ADMIN_ENVIRONMENT: "sandbox-bj-7"', patch)

    def test_no_other_auth_environment_enables_shadow_binding_admin(self) -> None:
        enabled = []
        for patch in AUTH_GITOPS.glob("*/patch-shadowbinding.yaml"):
            if 'SHADOW_BINDING_ADMIN_ENABLED: "true"' in patch.read_text(encoding="utf-8"):
                enabled.append(patch.parent.name)
        self.assertEqual(enabled, ["sandbox-bj-7"])


if __name__ == "__main__":
    unittest.main()
