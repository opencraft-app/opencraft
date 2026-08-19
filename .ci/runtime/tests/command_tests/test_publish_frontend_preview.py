import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
SCRIPT = REPO_ROOT / ".ci/runtime/commands/publish_frontend_preview.sh"


class PublishFrontendPreviewTests(unittest.TestCase):
    def test_artifact_paths_are_bound_to_frontend_dir_variables(self) -> None:
        source = SCRIPT.read_text()

        self.assertIn('FRONTEND_DIR="$REPO_ROOT/frontend"', source)
        self.assertIn('FRONTEND_NEXT_CN_DIR="$FRONTEND_DIR/out-cn"', source)
        self.assertIn('FRONTEND_NEXT_GLOBAL_DIR="$FRONTEND_DIR/out-global"', source)
        self.assertIn('FRONTEND_PREVIEW_CN_ARTIFACT_DIR="$FRONTEND_NEXT_CN_DIR"', source)
        self.assertIn('FRONTEND_PREVIEW_INTL_ARTIFACT_DIR="$FRONTEND_NEXT_GLOBAL_DIR"', source)
        self.assertIn('rm -rf .next out "$output_dir"', source)
        self.assertIn('du -sh "$FRONTEND_PREVIEW_CN_ARTIFACT_DIR" "$FRONTEND_PREVIEW_INTL_ARTIFACT_DIR"', source)
        self.assertIn('upload_staticpages_preview cn "$FRONTEND_PREVIEW_CN_ARTIFACT_DIR"', source)
        self.assertIn('upload_staticpages_preview intl "$FRONTEND_PREVIEW_INTL_ARTIFACT_DIR"', source)

    def test_kr_preview_keeps_its_api_base_without_a_global_oauth_issuer(self) -> None:
        source = SCRIPT.read_text()

        self.assertNotIn("printf 'https://api.lightvela.ai'", source)
        self.assertNotIn('export VITE_OAUTH_RELAY_ISSUER_BASE_URL="https://api.lightvela.ai"', source)
        self.assertNotIn('export NEXT_PUBLIC_OAUTH_RELAY_ISSUER_BASE_URL="https://api.lightvela.ai"', source)


if __name__ == "__main__":
    unittest.main()
