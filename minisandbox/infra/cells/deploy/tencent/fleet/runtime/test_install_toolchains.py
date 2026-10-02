#!/usr/bin/env python3

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class ToolchainInstallTests(unittest.TestCase):
    def test_lock_has_exact_official_sources(self):
        value = json.loads((ROOT / "toolchains.lock.json").read_text())
        self.assertEqual((value["schemaVersion"], value["platform"]), (1, "linux/amd64"))
        self.assertEqual(value["zig"]["version"], "0.14.1")
        self.assertEqual(value["bazel"]["version"], "9.2.0")
        self.assertTrue(value["zig"]["url"].startswith("https://ziglang.org/download/0.14.1/"))
        self.assertTrue(value["bazel"]["url"].startswith("https://github.com/bazelbuild/bazel/releases/download/9.2.0/"))
        for name in (value["zig"]["archiveSha256"], value["zig"]["binarySha256"], value["bazel"]["binarySha256"]):
            self.assertEqual(len(name), 64)

    def test_installer_has_no_build_cache_or_unlocked_fallback(self):
        script = (ROOT / "install-toolchains.sh").read_text()
        self.assertNotIn("/data/build-cache", script)
        self.assertIn("sha256sum --check --status", script)
        self.assertIn("existing toolchain installation differs from the lock", script)
        self.assertIn("actor-runtime-toolchains/v1", script)

    def test_installer_accepts_only_a_complete_supplied_artifact_pair(self):
        script = (ROOT / "install-toolchains.sh").read_text()
        self.assertIn("RIVET_ZIG_ARCHIVE", script)
        self.assertIn("RIVET_BAZEL_BINARY", script)
        self.assertIn("supplied toolchain artifacts must be two absolute regular files", script)
        self.assertIn('cp -- "$zig_archive" "$download/zig.tar.xz"', script)
        self.assertIn('cp -- "$bazel_binary" "$download/bazel"', script)


if __name__ == "__main__":
    unittest.main()
