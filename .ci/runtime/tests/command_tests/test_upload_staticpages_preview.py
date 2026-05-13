import sys
import tarfile
import tempfile
import unittest
from io import StringIO
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from support.staticpages_preview import (  # noqa: E402
    DEFAULT_API_URL,
    DEFAULT_PREVIEW_DOMAIN,
    ARCHIVE_MEDIA_TYPE,
    UploadProgressReader,
    format_bytes,
    normalize_preview_name,
    preview_name_for_variant,
    staticpages_sha_for_variant,
    write_tar_gzip_archive,
)


class UploadStaticPagesPreviewTests(unittest.TestCase):
    def test_normalize_frontsandbox_branch_to_dns_label(self) -> None:
        self.assertEqual(normalize_preview_name("frontsandbox/Demo_Feature"), "demo-feature")

    def test_normalize_playground_branch_to_env_preview_name(self) -> None:
        self.assertEqual(normalize_preview_name("playground/sandbox-bj-7"), "sandbox-bj-7")

    def test_reject_empty_preview_name(self) -> None:
        with self.assertRaisesRegex(ValueError, "cannot derive preview name"):
            normalize_preview_name("frontsandbox/---")

    def test_preview_variant_names_publish_cn_and_intl_pair(self) -> None:
        self.assertEqual(preview_name_for_variant("frontsandbox/Demo_Feature", "cn"), "demo-feature")
        self.assertEqual(preview_name_for_variant("frontsandbox/Demo_Feature", "intl"), "intl-demo-feature")

    def test_playground_preview_variant_names_publish_env_pair(self) -> None:
        self.assertEqual(preview_name_for_variant("playground/sandbox-bj-7", "cn"), "sandbox-bj-7")
        self.assertEqual(preview_name_for_variant("playground/sandbox-bj-7", "intl"), "intl-sandbox-bj-7")

    def test_master_branch_publishes_stable_preview_pair(self) -> None:
        self.assertEqual(normalize_preview_name("master"), "master")
        self.assertEqual(preview_name_for_variant("master", "cn"), "master")
        self.assertEqual(preview_name_for_variant("master", "intl"), "intl-master")

    def test_intl_prefixed_branch_does_not_double_prefix(self) -> None:
        self.assertEqual(preview_name_for_variant("frontsandbox/intl-demo-feature", "cn"), "demo-feature")
        self.assertEqual(preview_name_for_variant("frontsandbox/intl-demo-feature", "intl"), "intl-demo-feature")

    def test_intl_variant_uses_distinct_staticpages_sha(self) -> None:
        self.assertEqual(staticpages_sha_for_variant("abc123", "cn"), "abc123")
        self.assertEqual(staticpages_sha_for_variant("abc123", "intl"), "abc123-intl")

    def test_staticpages_defaults_use_preview_domain(self) -> None:
        self.assertEqual(DEFAULT_PREVIEW_DOMAIN, "preview.lightclaw.tech")
        self.assertEqual(DEFAULT_API_URL, "https://staticpages-api.preview.lightclaw.tech/api/upload")

    def test_default_archive_media_type_is_tar_gzip(self) -> None:
        self.assertEqual(ARCHIVE_MEDIA_TYPE, "application/vnd.lightvela.staticpages.archive.v1.tar+gzip")

    def test_write_tar_gzip_archive_preserves_relative_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact_dir = root / "dist"
            (artifact_dir / "assets").mkdir(parents=True)
            (artifact_dir / "index.html").write_text("<html></html>")
            (artifact_dir / "assets" / "app.js").write_text("console.log('ok')")
            archive_path = root / "dist.tar.gz"

            write_tar_gzip_archive(
                archive_path,
                artifact_dir,
                sorted(path for path in artifact_dir.rglob("*") if path.is_file()),
            )

            with tarfile.open(archive_path, "r:gz") as archive:
                self.assertEqual(sorted(archive.getnames()), ["assets/app.js", "index.html"])

    def test_format_bytes_uses_binary_units(self) -> None:
        self.assertEqual(format_bytes(512), "512 B")
        self.assertEqual(format_bytes(1536), "1.5 KiB")
        self.assertEqual(format_bytes(2 * 1024 * 1024), "2.0 MiB")

    def test_upload_progress_reader_reports_completion(self) -> None:
        class Raw:
            def __init__(self) -> None:
                self.chunks = [b"abc", b"de", b""]

            def read(self, size: int = -1) -> bytes:
                return self.chunks.pop(0)

        output = StringIO()
        ticks = iter([0.0, 3.0, 6.0])
        reader = UploadProgressReader(
            Raw(),
            total_bytes=5,
            enabled=True,
            label="cn/tar.gz",
            output=output,
            now=lambda: next(ticks),
        )

        self.assertEqual(reader.read(), b"abc")
        self.assertEqual(reader.read(), b"de")
        self.assertEqual(reader.read(), b"")
        logs = output.getvalue()
        self.assertIn("cn/tar.gz 上传进度", logs)
        self.assertIn("100.0%", logs)


if __name__ == "__main__":
    unittest.main()
