"""Guest adapter rejection tests: no privileged installation is performed."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "scripts/e2b/install-guest-nfs.py"
spec = importlib.util.spec_from_file_location("guest_nfs", SOURCE)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class GuestNfsValidation(unittest.TestCase):
    def rejected(self, *, name=None, kind=None, sha=None, size=None,
                 manifest_kernel=None, pinned_sha=None, payload=b"module"):
        kernel = "6.12.0-test"
        prefix = "usr/lib/modules/" + kernel + "/"
        module = prefix + "kernel/fs/nfs/nfs.ko"
        with tempfile.TemporaryDirectory(prefix="hands-nfs-test-") as root:
            root = Path(root)
            archive = root / "modules.tar"
            with tarfile.open(archive, "w") as tar:
                item = tarfile.TarInfo(name or module)
                item.size = len(payload)
                if kind is not None:
                    item.type = kind
                    item.linkname = "/outside"
                    item.size = 0
                tar.addfile(item, io.BytesIO(payload) if kind is None else None)
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({
                "kernel": manifest_kernel or kernel,
                "archiveSha256": digest,
                "modules": [{"path": module, "bytes": len(payload) if size is None else size,
                             "sha256": sha or hashlib.sha256(payload).hexdigest()}],
            }))
            # Every rejection must precede ALL privileged writes and commands.
            with patch.object(adapter.os, "geteuid", return_value=0), \
                 patch.object(adapter.os, "uname", return_value=types.SimpleNamespace(release=kernel)), \
                 patch.object(Path, "mkdir") as mkdir, \
                 patch.object(Path, "write_bytes") as write, \
                 patch.object(Path, "write_text") as write_text, \
                 patch.object(adapter.subprocess, "run") as run:
                with self.assertRaises((AssertionError, KeyError)):
                    adapter.install(str(archive), str(manifest), pinned_sha or digest, kernel)
                mkdir.assert_not_called()
                write.assert_not_called()
                write_text.assert_not_called()
                run.assert_not_called()

    def test_archive_pin(self):
        self.rejected(pinned_sha="f" * 64)

    def test_wrong_kernel(self):
        self.rejected(manifest_kernel="different-kernel")

    def test_absolute_path(self):
        self.rejected(name="/etc/passwd")

    def test_traversal(self):
        self.rejected(name="usr/lib/modules/6.12.0-test/../../etc/passwd")

    def test_link(self):
        self.rejected(kind=tarfile.SYMTYPE)

    def test_hardlink(self):
        self.rejected(kind=tarfile.LNKTYPE)

    def test_unlisted_file(self):
        self.rejected(name="usr/lib/modules/6.12.0-test/kernel/unlisted.ko")

    def test_module_size(self):
        self.rejected(size=999)

    def test_module_hash(self):
        self.rejected(sha="e" * 64)

    def test_optimized_python_cannot_skip_validation(self):
        result = subprocess.run(
            [sys.executable, "-I", "-O", str(SOURCE), "unused", "unused", "a" * 64, "test"],
            capture_output=True, text=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("assertions enabled", result.stderr)


if __name__ == "__main__":
    unittest.main()
