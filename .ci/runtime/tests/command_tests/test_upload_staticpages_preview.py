import sys
import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from support.staticpages_preview import (  # noqa: E402
    DEFAULT_API_URL,
    DEFAULT_PREVIEW_DOMAIN,
    normalize_preview_name,
    preview_name_for_variant,
    staticpages_sha_for_variant,
)


class UploadStaticPagesPreviewTests(unittest.TestCase):
    def test_normalize_frontsandbox_branch_to_dns_label(self) -> None:
        self.assertEqual(normalize_preview_name("frontsandbox/Demo_Feature"), "demo-feature")

    def test_reject_empty_preview_name(self) -> None:
        with self.assertRaisesRegex(ValueError, "cannot derive preview name"):
            normalize_preview_name("frontsandbox/---")

    def test_preview_variant_names_publish_cn_and_intl_pair(self) -> None:
        self.assertEqual(preview_name_for_variant("frontsandbox/Demo_Feature", "cn"), "demo-feature")
        self.assertEqual(preview_name_for_variant("frontsandbox/Demo_Feature", "intl"), "intl-demo-feature")

    def test_intl_prefixed_branch_does_not_double_prefix(self) -> None:
        self.assertEqual(preview_name_for_variant("frontsandbox/intl-demo-feature", "cn"), "demo-feature")
        self.assertEqual(preview_name_for_variant("frontsandbox/intl-demo-feature", "intl"), "intl-demo-feature")

    def test_intl_variant_uses_distinct_staticpages_sha(self) -> None:
        self.assertEqual(staticpages_sha_for_variant("abc123", "cn"), "abc123")
        self.assertEqual(staticpages_sha_for_variant("abc123", "intl"), "abc123-intl")

    def test_staticpages_defaults_use_preview_domain(self) -> None:
        self.assertEqual(DEFAULT_PREVIEW_DOMAIN, "preview.lightclaw.tech")
        self.assertEqual(DEFAULT_API_URL, "https://staticpages-api.preview.lightclaw.tech/api/upload")


if __name__ == "__main__":
    unittest.main()
