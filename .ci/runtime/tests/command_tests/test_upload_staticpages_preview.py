import sys
import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from support.staticpages_preview import DEFAULT_API_URL, DEFAULT_PREVIEW_DOMAIN, normalize_preview_name  # noqa: E402


class UploadStaticPagesPreviewTests(unittest.TestCase):
    def test_normalize_frontsandbox_branch_to_dns_label(self) -> None:
        self.assertEqual(normalize_preview_name("frontsandbox/Demo_Feature"), "demo-feature")

    def test_reject_empty_preview_name(self) -> None:
        with self.assertRaisesRegex(ValueError, "cannot derive preview name"):
            normalize_preview_name("frontsandbox/---")

    def test_staticpages_defaults_use_preview_domain(self) -> None:
        self.assertEqual(DEFAULT_PREVIEW_DOMAIN, "preview.lightclaw.tech")
        self.assertEqual(DEFAULT_API_URL, "https://staticpages-api.preview.lightclaw.tech/api/upload")


if __name__ == "__main__":
    unittest.main()
