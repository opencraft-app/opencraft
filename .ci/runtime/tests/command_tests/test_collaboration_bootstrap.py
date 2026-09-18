import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "gitops" / "collaboration_bootstrap.py"


def load_module():
    spec = importlib.util.spec_from_file_location("project_collaboration_bootstrap", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class CollaborationBootstrapProjectionTests(unittest.TestCase):
    def fixture(self) -> Path:
        root = Path(tempfile.mkdtemp())
        candidates = root / "argocd/catalogs/candidates/beijing-sandbox"
        candidates.mkdir(parents=True)
        (candidates / "collaboration-foundation.yaml").write_text(
            "service: collaboration\nenv: beijing-sandbox\nproject: beijing-sandbox\n"
            "destinationName: beijing-sandbox\nnamespace: lightvela-collaboration\n"
            "sourcePath: argocd/services/collaboration/beijing-sandbox-foundation\n"
        )
        (candidates / "collaboration.yaml").write_text(
            "service: collaboration\nenv: beijing-sandbox\nproject: beijing-sandbox\n"
            "destinationName: beijing-sandbox\nnamespace: lightvela-collaboration\n"
            "sourcePath: argocd/services/collaboration/beijing-sandbox\n"
        )
        platform = root / "argocd/services/collaboration/beijing-sandbox"
        platform.mkdir(parents=True)
        (platform / "collaboration-platform.env").write_text(
            "COLLABORATION_IMAGE=REPLACE_COLLABORATION_IMAGE\n"
            "COLLABORATION_DEPLOYED_AT=REPLACE_COLLABORATION_DEPLOYED_AT\n"
            "COLLABORATION_NODE_POOL=general-bj8\n"
            "COLLABORATION_IM_SDK_APP_ID=REPLACE_COLLABORATION_IM_SDK_APP_ID\n"
            "COLLABORATION_IM_ADMIN_USER_ID=REPLACE_COLLABORATION_IM_ADMIN_USER_ID\n"
        )
        secret = root / "argocd/secrets/beijing-sandbox"
        secret.mkdir(parents=True)
        (secret / "collaboration-runtime-secrets.sops.yaml").write_text(
            "apiVersion: v1\nkind: Secret\nstringData:\n  database.dsn: ENC[AES256_GCM,data:x]\nsops:\n  age: []\n"
        )
        return root

    def kwargs(self, root: Path) -> dict:
        return {
            "repo_root": root,
            "image": "lightclaw-bj8.tencentcloudcr.com/lightclaw/collaboration@sha256:" + "a" * 64,
            "sdk_app_id": 1600000000,
            "im_admin_user_id": "administrator",
            "deployed_at": "2026-09-15T13:00:00Z",
        }

    def test_foundation_projection_creates_active_catalog_and_platform_values(self):
        module = load_module()
        root = self.fixture()
        changed = module.project(phase="foundation", **self.kwargs(root))
        active = (root / "argocd/catalogs/sandbox/beijing-sandbox/collaboration.yaml").read_text()
        self.assertIn("beijing-sandbox-foundation", active)
        platform = (root / "argocd/services/collaboration/beijing-sandbox/collaboration-platform.env").read_text()
        self.assertIn("@sha256:" + "a" * 64, platform)
        self.assertIn("COLLABORATION_IM_SDK_APP_ID=1600000000", platform)
        self.assertIn("COLLABORATION_IM_ADMIN_USER_ID=administrator", platform)
        self.assertEqual(
            set(changed),
            {
                "argocd/catalogs/sandbox/beijing-sandbox/collaboration.yaml",
                "argocd/services/collaboration/beijing-sandbox/collaboration-platform.env",
                "argocd/secrets/beijing-sandbox/collaboration-runtime-secrets.sops.yaml",
            },
        )

    def test_runtime_projection_requires_existing_foundation_catalog(self):
        module = load_module()
        root = self.fixture()
        with self.assertRaisesRegex(ValueError, "foundation"):
            module.project(phase="runtime", **self.kwargs(root))
        module.project(phase="foundation", **self.kwargs(root))
        module.project(phase="runtime", **self.kwargs(root))
        active = (root / "argocd/catalogs/sandbox/beijing-sandbox/collaboration.yaml").read_text()
        self.assertIn("argocd/services/collaboration/beijing-sandbox\n", active)
        self.assertNotIn("beijing-sandbox-foundation", active)

    def test_runtime_projection_is_idempotent_when_active_catalog_already_runtime(self):
        module = load_module()
        root = self.fixture()
        module.project(phase="foundation", **self.kwargs(root))
        module.project(phase="runtime", **self.kwargs(root))

        rerun = self.kwargs(root)
        rerun["deployed_at"] = "2026-09-18T08:00:00Z"
        changed = module.project(phase="runtime", **rerun)

        active = (root / "argocd/catalogs/sandbox/beijing-sandbox/collaboration.yaml").read_text()
        self.assertIn("argocd/services/collaboration/beijing-sandbox\n", active)
        platform = (root / "argocd/services/collaboration/beijing-sandbox/collaboration-platform.env").read_text()
        self.assertIn("COLLABORATION_DEPLOYED_AT=2026-09-18T08:00:00Z", platform)
        self.assertIn(
            "argocd/secrets/beijing-sandbox/collaboration-runtime-secrets.sops.yaml",
            changed,
        )

    def test_projection_rejects_mutable_image_or_plaintext_secret(self):
        module = load_module()
        root = self.fixture()
        kwargs = self.kwargs(root)
        kwargs["image"] = "lightclaw-bj8.tencentcloudcr.com/lightclaw/collaboration:latest"
        with self.assertRaisesRegex(ValueError, "digest"):
            module.project(phase="foundation", **kwargs)
        kwargs = self.kwargs(root)
        (root / "argocd/secrets/beijing-sandbox/collaboration-runtime-secrets.sops.yaml").write_text(
            "apiVersion: v1\nkind: Secret\nstringData:\n  database.dsn: plaintext\n"
        )
        with self.assertRaisesRegex(ValueError, "SOPS"):
            module.project(phase="foundation", **kwargs)


if __name__ == "__main__":
    unittest.main()
