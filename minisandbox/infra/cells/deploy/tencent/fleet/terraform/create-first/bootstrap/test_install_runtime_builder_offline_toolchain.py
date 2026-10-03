"""Actual archive/file tests. These do not establish cloud attachment/build admission."""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("offline_toolchain", ROOT / "install-runtime-builder-offline-toolchain.py")
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "tools.tar.gz"
        self.target = self.root / "cache/tools"

    def archive_file(self, members):
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, kind, contents in members:
                member = tarfile.TarInfo(name)
                member.mode = 0o755
                if kind == "file":
                    member.size = len(contents)
                    archive.addfile(member, io.BytesIO(contents))
                else:
                    member.type = tarfile.SYMTYPE if kind == "link" else tarfile.LNKTYPE
                    member.linkname = contents
                    archive.addfile(member)
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def install(self, digest):
        TOOL.install_archive(self.archive, self.target, digest, {"bin", "lib"})

    def test_real_files_links_repeat_and_no_partial_tree(self):
        digest = self.archive_file([("bin/compiler", "file", b"compiler"),
                                    ("lib/shared", "file", b"library"),
                                    ("bin/alias", "link", "compiler")])
        self.install(digest)
        self.assertEqual((self.target / "bin/alias").read_bytes(), b"compiler")
        inode = self.target.stat().st_ino
        self.install(digest)
        self.assertEqual(self.target.stat().st_ino, inode)
        self.assertEqual((self.target / ".archive-sha256").read_text(), digest + "\n")
        self.assertFalse(list(self.target.parent.glob(".offline-toolchain-*")))

    def test_checksum_rejection_has_no_destination(self):
        digest = self.archive_file([("bin/compiler", "file", b"compiler")])
        self.archive.write_bytes(self.archive.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.install(digest)
        self.assertFalse(self.target.exists())

    def test_duplicate_escape_link_parent_and_hardlink_fail_closed(self):
        fixtures = [
            [("../escape", "file", b"bad")],
            [("bin/file", "file", b"one"), ("bin/file", "file", b"two")],
            [("bin/link", "link", "../../escape")],
            [("bin/link", "link", "/escape")],
            [("bin/link", "link", "../lib"), ("bin/link/file", "file", b"bad")],
            [("bin/file", "hardlink", "lib/shared")],
        ]
        for fixture in fixtures:
            with self.subTest(fixture=fixture):
                with self.assertRaises(ValueError):
                    self.install(self.archive_file(fixture))
                self.assertFalse(self.target.exists())

    def test_existing_corrupt_files_are_not_repaired_or_accepted_by_marker(self):
        digest = self.archive_file([("bin/compiler", "file", b"compiler")])
        self.install(digest)
        (self.target / "bin/compiler").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "bytes changed"):
            self.install(digest)
        self.assertEqual((self.target / "bin/compiler").read_bytes(), b"corrupt")

    def test_unrelated_existing_tree_is_preserved(self):
        digest = self.archive_file([("bin/compiler", "file", b"compiler")])
        self.target.mkdir(parents=True)
        self.target.parent.chmod(0o700)
        (self.target / "user-file").write_bytes(b"user")
        with self.assertRaises(ValueError):
            self.install(digest)
        self.assertEqual((self.target / "user-file").read_bytes(), b"user")

    def test_writable_symlink_or_multilink_archive_rejected(self):
        digest = self.archive_file([("bin/compiler", "file", b"compiler")])
        self.archive.chmod(0o666)
        with self.assertRaises(ValueError): self.install(digest)
        self.archive.chmod(0o600)
        other = self.archive.with_name("other")
        os.link(self.archive, other)
        with self.assertRaises(ValueError): self.install(digest)
        other.unlink()
        self.archive.rename(other)
        self.archive.symlink_to(other)
        with self.assertRaises(ValueError): self.install(digest)


if __name__ == "__main__":
    unittest.main()
