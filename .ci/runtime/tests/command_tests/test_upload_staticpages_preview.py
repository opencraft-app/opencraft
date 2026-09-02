import sys
import tarfile
import tempfile
import unittest
import json
import urllib.error
from argparse import Namespace
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from support.staticpages_preview import (  # noqa: E402
    DEFAULT_API_URL,
    DEFAULT_PREVIEW_DOMAIN,
    ARCHIVE_MEDIA_TYPE,
    ReleaseBundle,
    UploadProgressReader,
    build_release_packs,
    format_bytes,
    normalize_preview_name,
    preview_name_for_variant,
    publish_release_packs,
    staticpages_sha_for_variant,
    upload,
    write_tar_gzip_archive,
)


class UploadStaticPagesPreviewTests(unittest.TestCase):
    def test_normalize_frontsandbox_branch_to_dns_label(self) -> None:
        self.assertEqual(normalize_preview_name("frontsandbox/Demo_Feature"), "demo-feature")

    def test_normalize_playground_branch_to_env_preview_name(self) -> None:
        self.assertEqual(normalize_preview_name("playground/sandbox-bj-7"), "sandbox-bj-7")
        self.assertEqual(normalize_preview_name("playground/sandbox-kr-1"), "sandbox-kr-1")

    def test_reject_empty_preview_name(self) -> None:
        with self.assertRaisesRegex(ValueError, "cannot derive preview name"):
            normalize_preview_name("frontsandbox/---")

    def test_preview_variant_names_publish_cn_and_intl_pair(self) -> None:
        self.assertEqual(preview_name_for_variant("frontsandbox/Demo_Feature", "cn"), "demo-feature")
        self.assertEqual(preview_name_for_variant("frontsandbox/Demo_Feature", "intl"), "intl-demo-feature")

    def test_playground_preview_variant_names_publish_env_pair(self) -> None:
        self.assertEqual(preview_name_for_variant("playground/sandbox-bj-7", "cn"), "sandbox-bj-7")
        self.assertEqual(preview_name_for_variant("playground/sandbox-bj-7", "intl"), "intl-sandbox-bj-7")
        self.assertEqual(preview_name_for_variant("playground/sandbox-kr-1", "cn"), "sandbox-kr-1")
        self.assertEqual(preview_name_for_variant("playground/sandbox-kr-1", "intl"), "intl-sandbox-kr-1")

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

    def test_release_packs_are_deterministic_and_map_each_file_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact_dir = root / "dist"
            (artifact_dir / "assets").mkdir(parents=True)
            (artifact_dir / "index.html").write_text("<html></html>")
            (artifact_dir / "assets" / "app.js").write_text("console.log('ok')")

            first = build_release_packs(artifact_dir, root / "packs-first", target_bytes=64, max_bytes=256)
            second = build_release_packs(artifact_dir, root / "packs-second", target_bytes=64, max_bytes=256)

            self.assertEqual(
                json.dumps(first.manifest, sort_keys=True),
                json.dumps(second.manifest, sort_keys=True),
            )
            self.assertEqual(
                [path.read_bytes() for path in first.pack_paths],
                [path.read_bytes() for path in second.pack_paths],
            )
            file_paths = [entry["path"] for entry in first.manifest["files"]]
            self.assertEqual(file_paths, ["assets/app.js", "index.html"])
            self.assertEqual(len(file_paths), len(set(file_paths)))
            self.assertEqual(
                {entry["pack"] for entry in first.manifest["files"]},
                {entry["name"] for entry in first.manifest["packs"]},
            )

    def test_release_packs_split_multi_file_groups_below_maximum(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact_dir = root / "dist"
            artifact_dir.mkdir()
            for index in range(8):
                payload = bytes((index * 31 + offset * 17) % 251 for offset in range(512))
                (artifact_dir / f"file-{index}.txt").write_bytes(payload)

            bundle = build_release_packs(artifact_dir, root / "packs", target_bytes=400, max_bytes=1024)

            self.assertGreater(len(bundle.pack_paths), 1)
            for pack in bundle.manifest["packs"]:
                self.assertLessEqual(pack["compressed_size"], 1024)
                self.assertFalse(pack["oversized_single_file"])

    def test_release_packs_reject_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact_dir = root / "dist"
            artifact_dir.mkdir()
            outside = root / "outside.txt"
            outside.write_text("secret")
            (artifact_dir / "linked.txt").symlink_to(outside)

            with self.assertRaisesRegex(ValueError, "symbolic link"):
                build_release_packs(artifact_dir, root / "packs")

    def test_pack_protocol_retries_only_failed_pack_before_commit(self) -> None:
        class Response:
            def __init__(self, body: dict[str, object]) -> None:
                self.body = json.dumps(body).encode()

            def __enter__(self):
                return self

            def __exit__(self, *_args) -> None:
                return None

            def read(self) -> bytes:
                return self.body

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pack = root / "pack-0001-deadbeef.tar.gz"
            pack.write_bytes(b"pack-content")
            bundle = ReleaseBundle(
                manifest={
                    "format_version": 1,
                    "file_count": 1,
                    "total_uncompressed_bytes": 4,
                    "packs": [
                        {
                            "name": pack.name,
                            "compressed_size": pack.stat().st_size,
                            "sha256": "deadbeef",
                            "file_count": 1,
                            "oversized_single_file": False,
                        }
                    ],
                    "files": [],
                },
                pack_paths=[pack],
            )
            requests = []
            pack_attempts = 0

            def fake_urlopen(request, timeout):
                nonlocal pack_attempts
                requests.append((request, timeout))
                if request.full_url == "https://static.example/api/releases":
                    return Response(
                        {
                            "release_id": "release-1",
                            "uploads": [
                                {
                                    "name": pack.name,
                                    "url": "https://cos.example/staging/pack-1",
                                    "headers": {"X-Signed-Pack": "pack-1"},
                                }
                            ],
                        }
                    )
                if request.full_url == "https://cos.example/staging/pack-1":
                    pack_attempts += 1
                    if pack_attempts == 1:
                        raise urllib.error.URLError("temporary upload failure")
                    self.assertEqual(request.get_method(), "PUT")
                    self.assertEqual(request.get_header("X-signed-pack"), "pack-1")
                    self.assertEqual(request.data.read(), b"pack-content")
                    return Response({})
                if request.full_url == "https://static.example/api/releases/release-1/commit":
                    return Response({"status": "published", "preview_url": ["https://demo.example"]})
                self.fail(f"unexpected request: {request.full_url}")

            result = publish_release_packs(
                api_url="https://static.example/api/upload",
                headers={"Authorization": "Bearer test"},
                bundle=bundle,
                timeout_seconds=30,
                pack_upload_attempts=3,
                progress=False,
                urlopen=fake_urlopen,
                sleep=lambda _seconds: None,
            )

            self.assertEqual(result["status"], "published")
            self.assertEqual(pack_attempts, 2)
            self.assertEqual(
                [(request.full_url, request.get_method()) for request, _ in requests],
                [
                    ("https://static.example/api/releases", "POST"),
                    ("https://cos.example/staging/pack-1", "PUT"),
                    ("https://cos.example/staging/pack-1", "PUT"),
                    ("https://static.example/api/releases/release-1/commit", "POST"),
                ],
            )

    def test_pack_protocol_short_circuits_already_published_release(self) -> None:
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args) -> None:
                return None

            def read(self) -> bytes:
                return json.dumps({"release_id": "release-1", "status": "published"}).encode()

        with tempfile.TemporaryDirectory() as tmp:
            pack = Path(tmp) / "pack-0001-deadbeef.tar.gz"
            pack.write_bytes(b"unused")
            bundle = ReleaseBundle(manifest={"packs": []}, pack_paths=[pack])
            requests = []

            def fake_urlopen(request, timeout):
                requests.append((request, timeout))
                return Response()

            result = publish_release_packs(
                api_url="https://static.example/api/upload",
                headers={"Authorization": "Bearer test"},
                bundle=bundle,
                timeout_seconds=30,
                progress=False,
                urlopen=fake_urlopen,
            )

            self.assertEqual(result["status"], "published")
            self.assertEqual(len(requests), 1)

    def test_upload_pack_mode_builds_and_publishes_release_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact_dir = root / "dist"
            artifact_dir.mkdir()
            (artifact_dir / "index.html").write_text("home")
            args = Namespace(
                token="test-token",
                preview_name="demo",
                source_branch="frontsandbox/demo",
                variant="cn",
                sha="abc123",
                artifact_dir=str(artifact_dir),
                archive_file="",
                upload_mode="packs",
                api_url="https://static.example/api/upload",
                repository="wisp/mono2",
                timeout_seconds=30,
                no_progress=True,
                pack_target_bytes=1024,
                pack_max_bytes=2048,
                pack_upload_attempts=3,
            )

            with patch("support.staticpages_preview.publish_release_packs") as publish, patch(
                "support.staticpages_preview._upload_multipart",
                side_effect=AssertionError("pack mode must not use multipart upload"),
            ):
                publish.return_value = {"status": "published"}
                with redirect_stdout(StringIO()):
                    self.assertEqual(upload(args), 0)

            publish.assert_called_once()
            bundle = publish.call_args.kwargs["bundle"]
            self.assertEqual(bundle.manifest["file_count"], 1)
            self.assertEqual(len(bundle.pack_paths), 1)

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
