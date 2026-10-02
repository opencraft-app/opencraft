import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import yaml


SCRIPT = Path(__file__).with_name("render-image-update.py")
SPEC = importlib.util.spec_from_file_location("render_image_update", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RenderImageUpdateTest(unittest.TestCase):
    def desired(self, root: Path, image: str) -> Path:
        desired = root / "desired"
        desired.mkdir()
        for name in MODULE.EXPECTED:
            (desired / name).write_text("{}\n")
        deployment = {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": {"name": "worker-registry"},
            "spec": {"template": {"spec": {"containers": [{"name": "worker-registry", "image": image}]}}},
        }
        (desired / "worker-registry.yaml").write_text(yaml.safe_dump(deployment))
        (desired / "evidence.json").write_text(json.dumps({"schema": "actor-regional-code-plane-desired-evidence/v1", "managementId": "c01"}))
        return desired

    def inventory(self, root: Path, ref: str) -> Path:
        path = root / "images.json"
        path.write_text(json.dumps({"images": [{"repository": "worker-registry", "ref": ref}]}))
        return path

    def test_changes_only_registry_and_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = "registry.test/fleet/worker-registry@sha256:" + "a" * 64
            new = "registry.test/fleet/worker-registry@sha256:" + "b" * 64
            desired = self.desired(root, old)
            before = MODULE.inventory(desired)
            files, receipt = MODULE.render(desired, self.inventory(root, new), "worker-registry")
            changed = {name for name, digest in before.items() if digest != MODULE.sha(files[name])}
            self.assertEqual(changed, {"worker-registry.yaml", "evidence.json"})
            self.assertEqual(receipt["verdict"], "passed")
            self.assertEqual(receipt["update"]["from"], old)
            self.assertEqual(receipt["update"]["to"], new)

    def test_rejects_repository_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = "registry.test/fleet/worker-registry@sha256:" + "a" * 64
            new = "other.test/fleet/worker-registry@sha256:" + "b" * 64
            with self.assertRaisesRegex(ValueError, "changes the registry repository"):
                MODULE.render(self.desired(root, old), self.inventory(root, new), "worker-registry")

    def test_rejects_mutable_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = "registry.test/fleet/worker-registry@sha256:" + "a" * 64
            with self.assertRaisesRegex(ValueError, "digest-pinned"):
                MODULE.render(self.desired(root, old), self.inventory(root, "registry.test/fleet/worker-registry:latest"), "worker-registry")


if __name__ == "__main__":
    unittest.main()
