"""Real-process relay tests. Device observations are protocol doubles, not CBS evidence."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


PROTOCOL = r'''#!/usr/bin/env python3
import os
from pathlib import Path
import shutil
import subprocess
import sys
name = Path(sys.argv[0]).name
args = sys.argv[1:]
trace = Path(os.environ["TRACE"])
with trace.open("a") as stream:
    stream.write(name + "\n")
mode = os.environ.get("MODE", "ok")
if name == "coscli":
    if args == ["--version"]: print("coscli version v1.0.9")
    elif args[0] == "signurl": print("https://protocol.invalid/artifact")
    else: assert args[0] == "stat"
elif name == "curl":
    if args[-1].startswith("http://metadata."):
        print("ins-wrong" if mode == "instance" else "ins-test")
    else:
        shutil.copyfile(os.environ["ARTIFACT"], args[args.index("--output") + 1])
        if mode == "lost": Path(os.environ["LOST"]).touch()
elif name == "findmnt":
    if args[-1] == "UUID":
        print("wrong" if mode == "uuid" or Path(os.environ["LOST"]).exists()
              else "dd34c927-dfee-4826-8b45-d5cbb4d47c5e")
    else: print("/dev/wrong" if mode == "disk" else "/dev/test-disk")
elif name == "readlink":
    if args[-1].startswith("/dev/disk/by-id/"): print("/dev/test-disk")
    elif args[0] == "-m" and mode == "escape": print("/outside/build")
    else: sys.exit(subprocess.call(["/usr/bin/readlink", *args]))
elif name == "stat" and args[:2] == ["-c", "%d"]:
    print("1" if args[-1] == "/" or mode == "root" else "2")
elif name == "stat":
    sys.exit(subprocess.call(["/usr/bin/stat", *args]))
else: raise AssertionError(name)
'''


class RelayTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="relay-process-", dir="/data/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.build = self.root / "build"
        self.build.mkdir()
        scripts = self.root / "fleet/qualification/actor-bj-q01"
        scripts.mkdir(parents=True)
        tat = self.root / "fleet/tat"
        tat.mkdir()
        self.script = scripts / "relay-upload-to-builder.sh"
        original = Path(__file__).with_name("relay-upload-to-builder.sh").read_text()
        # Substitute only the destination allowlist for isolated real files.
        # Production mount, metadata and native device checks are unchanged.
        original = original.replace("/data/actor-build", str(self.build))
        self.script.write_text(original)
        runner = tat / "tat-run.sh"
        runner.write_text('#!/usr/bin/env bash\nset -eu\necho tat >>"$TRACE"\nbash -s\n')
        runner.chmod(0o755)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("coscli", "curl", "findmnt", "readlink", "stat"):
            path = self.bin / name
            path.write_text(PROTOCOL)
            path.chmod(0o755)
        self.artifact = self.root / "artifact"
        self.artifact.write_bytes(b"bounded immutable artifact\n")
        self.trace = self.root / "trace"
        self.destination = self.build / "source/sha/kubectl"
        self.env = dict(os.environ, PATH=str(self.bin) + ":" + os.environ["PATH"],
                        COSCLI=str(self.bin / "coscli"), TRACE=str(self.trace),
                        ARTIFACT=str(self.artifact), LOST=str(self.root / "lost"),
                        TAT_INSTANCE_ID="ins-test", TENCENTCLOUD_SECRET_ID="protocol-only-id",
                        TENCENTCLOUD_SECRET_KEY="protocol-only-key",
                        RELAY_BUILDER_FILESYSTEM_UUID="dd34c927-dfee-4826-8b45-d5cbb4d47c5e",
                        RELAY_BUILDER_DISK_ID="disk-test")

    def run_relay(self, mode="ok", **extra):
        return subprocess.run(["bash", str(self.script), str(self.artifact), str(self.destination)],
                              env=dict(self.env, MODE=mode, **extra), capture_output=True,
                              text=True, timeout=15)

    def test_guarded_transfer_checks_storage_twice_and_publishes_exact_bytes(self):
        result = self.run_relay()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.destination.read_bytes(), self.artifact.read_bytes())
        self.assertEqual(self.trace.read_text().splitlines().count("findmnt"), 4)
        self.assertFalse(Path(str(self.destination) + ".cos-part").exists())

    def test_bad_identity_mount_or_escape_rejects_before_download(self):
        for mode in ("instance", "uuid", "disk", "root", "escape"):
            with self.subTest(mode=mode):
                self.trace.unlink(missing_ok=True)
                result = self.run_relay(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.destination.exists())
                self.assertLessEqual(self.trace.read_text().splitlines().count("curl"), 1)

    def test_mount_loss_after_download_does_not_publish(self):
        result = self.run_relay("lost")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.destination.exists())
        self.assertFalse(Path(str(self.destination) + ".cos-part").exists())

    def test_existing_partial_symlink_is_not_followed_or_deleted(self):
        self.destination.parent.mkdir(parents=True)
        partial = Path(str(self.destination) + ".cos-part")
        partial.symlink_to(self.artifact)
        result = self.run_relay()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(partial.is_symlink())
        self.assertEqual(self.artifact.read_bytes(), b"bounded immutable artifact\n")

    def test_incomplete_guard_is_rejected_before_external_calls(self):
        result = self.run_relay(RELAY_BUILDER_DISK_ID="")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("tat", self.trace.read_text().splitlines())
        self.assertNotIn("curl", self.trace.read_text().splitlines())

    def test_legacy_operations_transfer_does_not_assert_builder_mount(self):
        result = self.run_relay(RELAY_BUILDER_DISK_ID="", RELAY_BUILDER_FILESYSTEM_UUID="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.destination.read_bytes(), self.artifact.read_bytes())
        self.assertNotIn("findmnt", self.trace.read_text().splitlines())


if __name__ == "__main__":
    unittest.main()
