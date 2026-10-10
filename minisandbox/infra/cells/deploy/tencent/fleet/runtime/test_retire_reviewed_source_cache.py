"""Bound source-cache deletion to recoverable immutable inputs and unused paths."""

import hashlib
import importlib.util
import io
import importlib.util
import marshal
from pathlib import Path
import tarfile
import tempfile
import struct
import unittest
from unittest.mock import patch


PATH = Path(__file__).with_name("retire-reviewed-source-cache.py")
SPEC = importlib.util.spec_from_file_location("retire_reviewed_source_cache", PATH)
CACHE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CACHE)
REVISION = "1" * 40


class SourceCacheRetirementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.incoming, self.deploy = root / "incoming", root / "deploy"
        self.incoming.mkdir()
        self.deploy.mkdir()
        self.payload = b"source fixture\n"
        self.manifest = (hashlib.sha256(self.payload).hexdigest() + "  payload.txt\n").encode()
        self.manifest_sha = hashlib.sha256(self.manifest).hexdigest()
        self.target = self.deploy / ("q01-src-" + REVISION + "-" + self.manifest_sha)
        self.target.mkdir()
        (self.target / "payload.txt").write_bytes(self.payload)
        metadata = self.target / ".actor-source"
        metadata.mkdir()
        (metadata / "SOURCE_REVISION").write_text(REVISION + "\n")
        (metadata / "RELEASE_SHA256SUMS").write_bytes(self.manifest)
        (metadata / "FILE_COUNT").write_text("1\n")
        self.recovery = self.incoming / ("reviewed-source-" + REVISION + "-" + self.manifest_sha)
        self.recovery.mkdir()
        self.bundle = self.recovery / "source.tar.gz"
        self.receipt = self.recovery / "source.receipt.json"
        self.receipt.write_text("{}\n")
        self.make_bundle()
        self.row = {"revision": REVISION, "manifest": self.manifest_sha,
                    "target": str(self.target), "receiptSha256": CACHE.digest(self.receipt),
                    "bundleSha256": CACHE.digest(self.bundle)}
        for name, value in (("INCOMING", self.incoming), ("DEPLOY", self.deploy)):
            patcher = patch.object(CACHE, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(CACHE, "legacy_device", return_value=root.stat().st_dev)
        patcher.start()
        self.addCleanup(patcher.stop)
        original_command = CACHE.command

        def verified_command(args, **kwargs):
            if args[0] == CACHE.sys.executable:
                return REVISION + "\t" + self.manifest_sha
            return original_command(args, **kwargs)

        patcher = patch.object(CACHE, "command", side_effect=verified_command)
        patcher.start()
        self.addCleanup(patcher.stop)

    def make_bundle(self, revision=REVISION):
        with tarfile.open(self.bundle, "w:gz") as archive:
            for name, payload in ((".actor-source/SOURCE_REVISION", (revision + "\n").encode()),
                                  (".actor-source/RELEASE_SHA256SUMS", self.manifest),
                                  (".actor-source/FILE_COUNT", b"1\n"),
                                  ("payload.txt", self.payload)):
                info = tarfile.TarInfo(name)
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))

    def test_exact_recoverable_cache_is_only_validated_not_deleted(self):
        identity = CACHE.verify_candidate(self.row, set())
        self.assertEqual(identity["inode"], self.target.stat().st_ino)
        self.assertTrue(self.target.exists())
        self.assertTrue(self.bundle.exists())

    def test_protected_or_malformed_targets_never_resolve_to_deletion(self):
        for revision in list(CACHE.PROTECTED) + ["../", "1" * 39, "1" * 41, None]:
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                CACHE.target_for(revision, self.manifest_sha)
        row = dict(self.row, target=str(self.deploy))
        with self.assertRaises(ValueError):
            CACHE.verify_candidate(row, set())

    def test_active_reference_prevents_cache_retirement(self):
        with self.assertRaises(ValueError):
            CACHE.verify_candidate(self.row, {self.target.name})

    def test_modified_or_additional_files_are_not_disposable_source(self):
        (self.target / "payload.txt").write_bytes(b"local change\n")
        with self.assertRaises(ValueError):
            CACHE.verify_candidate(self.row, set())
        (self.target / "payload.txt").write_bytes(self.payload)
        (self.target / "application-state").write_bytes(b"do not remove")
        with self.assertRaises(ValueError):
            CACHE.verify_candidate(self.row, set())

    def test_recovery_bundle_must_match_both_bytes_and_source_identity(self):
        self.make_bundle("2" * 40)
        with self.assertRaises(ValueError):
            CACHE.verify_candidate(self.row, set())
        row = dict(self.row, bundleSha256=CACHE.digest(self.bundle))
        with self.assertRaises(ValueError):
            CACHE.verify_candidate(row, set())
        self.receipt.write_text('{"changed":true}\n')
        with self.assertRaises(ValueError):
            CACHE.verify_candidate(row, set())

    def test_added_metadata_or_symlink_is_not_disposable_source(self):
        added = self.target / ".actor-source" / "application.db"
        added.write_bytes(b"not a cache")
        with self.assertRaises(ValueError):
            CACHE.verify_candidate(self.row, set())
        added.unlink()
        (self.target / "unmanifested-link").symlink_to("payload.txt")
        with self.assertRaises(ValueError):
            CACHE.verify_candidate(self.row, set())

    def test_source_root_or_recovery_symlink_is_rejected(self):
        self.receipt.unlink()
        alternate = self.recovery / "alternate.json"
        alternate.write_text("{}\n")
        self.receipt.symlink_to(alternate)
        with self.assertRaises(ValueError):
            CACHE.verify_candidate(self.row, set())
        self.receipt.unlink()
        self.receipt.write_text("{}\n")
        original = self.target.with_name("original")
        self.target.rename(original)
        self.target.symlink_to(original, target_is_directory=True)
        with self.assertRaises(ValueError):
            CACHE.verify_candidate(self.row, set())

    def test_generated_bytecode_must_be_provably_regenerable_not_just_named_pyc(self):
        source = self.target / "module.py"
        source.write_bytes(b"answer = 42\n")
        cache = self.target / "__pycache__/module.cpython-311.pyc"
        cache.parent.mkdir()
        code = compile(source.read_bytes(), str(source), "exec", dont_inherit=True)
        header = importlib.util.MAGIC_NUMBER + struct.pack("<I", 0) + struct.pack(
            "<II", int(source.stat().st_mtime) & 0xffffffff, source.stat().st_size)
        cache.write_bytes(header + marshal.dumps(code))
        expected = {"module.py"}
        self.assertTrue(CACHE.generated_bytecode(self.target, str(cache.relative_to(self.target)), expected))
        self.assertFalse(CACHE.generated_bytecode(self.target, str(cache.relative_to(self.target)), set()))
        cache.write_bytes(header + marshal.dumps(code) + b"unrelated application state")
        self.assertFalse(CACHE.generated_bytecode(self.target, str(cache.relative_to(self.target)), expected))
        cache.write_bytes(header + marshal.dumps(compile(b"answer = 43\n", str(source), "exec")))
        self.assertFalse(CACHE.generated_bytecode(self.target, str(cache.relative_to(self.target)), expected))
        cache.write_bytes(header + marshal.dumps(code))
        source.write_bytes(b"answer = 99\n")
        self.assertFalse(CACHE.generated_bytecode(self.target, str(cache.relative_to(self.target)), expected))

    def test_bytecode_filename_normalization_stays_inside_exact_source_root(self):
        source = self.target / "module.py"
        source.write_bytes(b"answer = 42\n")
        cache = self.target / "__pycache__/module.cpython-311.pyc"
        cache.parent.mkdir()
        header = importlib.util.MAGIC_NUMBER + struct.pack("<I", 0) + struct.pack(
            "<II", int(source.stat().st_mtime) & 0xffffffff, source.stat().st_size)
        for filename, expected in (
            ("/var/lib/actor-build/deploy/q01-full-staging.ABC123/subdirectory/../module.py", True),
            ("/var/lib/actor-build/deploy/q01-full-staging.ABC123/../module.py", False)):
            cache.write_bytes(header + marshal.dumps(compile(source.read_bytes(), filename, "exec", dont_inherit=True)))
            self.assertEqual(CACHE.generated_bytecode(self.target, str(cache.relative_to(self.target)), {"module.py"}), expected)


if __name__ == "__main__":
    unittest.main()
