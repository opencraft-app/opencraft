import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
SCRIPT = REPO_ROOT / ".ci/runtime/commands/publish_frontend_preview.sh"


class PublishFrontendPreviewTests(unittest.TestCase):
    def test_artifact_paths_are_bound_to_frontend_dir_variables(self) -> None:
        source = SCRIPT.read_text()

        self.assertIn('FRONTEND_DIR="$REPO_ROOT/frontend"', source)
        self.assertIn('FRONTEND_DIST_CN_DIR="$FRONTEND_DIR/dist-cn"', source)
        self.assertIn('FRONTEND_DIST_GLOBAL_DIR="$FRONTEND_DIR/dist-global"', source)
        self.assertIn('FRONTEND_NEXT_CN_DIR="$FRONTEND_DIR/out-cn"', source)
        self.assertIn('FRONTEND_NEXT_GLOBAL_DIR="$FRONTEND_DIR/out-global"', source)
        self.assertIn('FRONTEND_PREVIEW_BUILD_KIND="${FRONTEND_PREVIEW_BUILD_KIND:-legacy}"', source)
        self.assertIn('FRONTEND_PREVIEW_CN_ARTIFACT_DIR="$FRONTEND_DIST_CN_DIR"', source)
        self.assertIn('FRONTEND_PREVIEW_INTL_ARTIFACT_DIR="$FRONTEND_DIST_GLOBAL_DIR"', source)
        self.assertIn('FRONTEND_PREVIEW_CN_ARTIFACT_DIR="$FRONTEND_NEXT_CN_DIR"', source)
        self.assertIn('FRONTEND_PREVIEW_INTL_ARTIFACT_DIR="$FRONTEND_NEXT_GLOBAL_DIR"', source)
        self.assertIn('du -sh "$FRONTEND_PREVIEW_CN_ARTIFACT_DIR" "$FRONTEND_PREVIEW_INTL_ARTIFACT_DIR"', source)
        self.assertIn('upload_staticpages_preview cn "$FRONTEND_PREVIEW_CN_ARTIFACT_DIR"', source)
        self.assertIn('upload_staticpages_preview intl "$FRONTEND_PREVIEW_INTL_ARTIFACT_DIR"', source)
        self.assertNotIn("du -sh frontend/dist-cn frontend/dist-global", source)
        self.assertNotIn("upload_staticpages_preview cn frontend/dist-cn", source)
        self.assertNotIn("upload_staticpages_preview intl frontend/dist-global", source)


if __name__ == "__main__":
    unittest.main()
