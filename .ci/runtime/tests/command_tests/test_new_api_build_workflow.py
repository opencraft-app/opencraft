import sys
import unittest
from pathlib import Path

import yaml

REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci/runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from contracts.bundles import load_bundle  # noqa: E402
from contracts.release_bundle_manifest import merge_bundle_sources  # noqa: E402


class NewAPIBuildWorkflowTests(unittest.TestCase):
    def test_workflow_only_builds_and_pushes_images(self) -> None:
        workflow_path = REPO_ROOT / ".ci/new-api.yml"
        workflow_text = workflow_path.read_text()
        workflow = yaml.safe_load(workflow_text)

        triggers = workflow.get("on") or workflow.get(True)
        self.assertEqual(triggers["push"]["branches"], ["master"])
        self.assertIn("new-api/**", triggers["push"]["paths"])
        self.assertIn("build_release_image.py", workflow_text)
        self.assertIn("--push", workflow_text)
        self.assertIn("beijing-llmgateway shprod", workflow_text)
        self.assertNotIn("build_and_promote_to_gitops", workflow_text)
        self.assertNotIn("pin_image_to_gitops", workflow_text)
        self.assertNotIn("gitops", workflow_text.lower())
        self.assertNotIn("extends", workflow)

    def test_bundle_has_no_gitops_publish_paths(self) -> None:
        manifest = merge_bundle_sources(RUNTIME_DIR / "bundles")

        for env_name, expected_repo in (
            ("beijing-llmgateway", "lightclaw-bj82.tencentcloudcr.com/llmgateway/new-api"),
            ("shprod", "lightclaw-shprod.tencentcloudcr.com/llmgateway/new-api"),
        ):
            bundle = load_bundle(manifest, "new-api", env_name)
            self.assertEqual(bundle.publish_paths, [])
            self.assertEqual(bundle.image_repo, expected_repo)
            self.assertEqual(bundle.config_contract["mode"], "none")


if __name__ == "__main__":
    unittest.main()
