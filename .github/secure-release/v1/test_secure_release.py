#!/usr/bin/env python3
"""Observable-behavior tests for secure-release kit v1.

Definition:
  Exercise the public CLI in isolated Git repositories; no registry,
  credentials, or live repository is touched.

Parameters:
  Standard unittest parameters are supported.

Outputs:
  unittest results on stdout/stderr and a nonzero exit on failure.

Examples:
  python3 test_secure_release.py
  python3 -m unittest -v test_secure_release.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("secure_release.py")


class SecureReleaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="secure-release-test-")
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Release Test")
        self.git("config", "user.email", "release@example.invalid")
        (self.repo / "tracked.txt").write_text("release\n", encoding="utf-8")
        self.git("add", "tracked.txt")
        self.git("commit", "-qm", "initial")
        self.git("branch", "-M", "main")
        self.git("-c", "tag.gpgSign=false", "tag", "v1.2.3")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.check_output(("git", *args), cwd=self.repo, text=True).strip()

    def cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (sys.executable, str(SCRIPT), *args),
            cwd=self.repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_manifest_detects_changed_and_extra_artifacts(self) -> None:
        release = self.repo / "release"
        release.mkdir()
        artifact = release / "package.tgz"
        artifact.write_bytes(b"exact bytes")
        manifest = release / "manifest.json"
        created = self.cli(
            "manifest-create",
            "--tag",
            "v1.2.3",
            "--version",
            "1.2.3",
            "--artifact",
            str(artifact),
            "--output",
            str(manifest),
        )
        self.assertEqual(created.returncode, 0, created.stderr)
        verified = self.cli(
            "manifest-verify", "--manifest", str(manifest), "--directory", str(release)
        )
        self.assertEqual(verified.returncode, 0, verified.stderr)
        artifact.write_bytes(b"changed")
        changed = self.cli(
            "manifest-verify", "--manifest", str(manifest), "--directory", str(release)
        )
        self.assertNotEqual(changed.returncode, 0)
        artifact.write_bytes(b"exact bytes")
        (release / ".unexpected").write_text("no\n", encoding="utf-8")
        extra = self.cli(
            "manifest-verify", "--manifest", str(manifest), "--directory", str(release)
        )
        self.assertNotEqual(extra.returncode, 0)
        self.assertIn("artifact set mismatch", extra.stderr)

    def test_prerelease_manifest_is_explicit_and_bound_to_its_candidate(self) -> None:
        artifact = self.repo / "OpenCraft-1.2.3-beta.4-universal.dmg"
        artifact.write_bytes(b"release candidate")
        manifest = self.repo / "manifest.json"
        create = (
            "manifest-create", "--tag", "v1.2.3-beta.4", "--version", "1.2.3-beta.4",
            "--artifact", str(artifact), "--output", str(manifest),
        )
        self.assertNotEqual(self.cli(*create).returncode, 0)
        created = self.cli(*create, "--prerelease")
        self.assertEqual(created.returncode, 0, created.stderr)
        candidate = self.repo / "candidate"
        candidate.mkdir()
        artifact.rename(candidate / artifact.name)
        manifest = manifest.rename(candidate / manifest.name)
        verify = ("manifest-verify", "--manifest", str(manifest), "--directory", str(candidate))
        self.assertNotEqual(self.cli(*verify).returncode, 0)
        verified = self.cli(*verify, "--prerelease", "--tag", "v1.2.3-beta.4")
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertNotEqual(self.cli(*verify, "--prerelease", "--tag", "v1.2.3-beta.5").returncode, 0)

    def test_changelog_extracts_only_exact_tag_section(self) -> None:
        changelog = self.repo / "CHANGELOG.md"
        changelog.write_text(
            "# Changelog\n\n## v1.2.3\n\n- Current.\n\n## v1.2.2\n\n- Previous.\n",
            encoding="utf-8",
        )
        notes = self.repo / "release" / "notes.md"
        result = self.cli(
            "changelog", "--tag", "v1.2.3", "--changelog", str(changelog), "--notes", str(notes)
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(notes.read_text(encoding="utf-8"), "## v1.2.3\n\n- Current.\n")
        missing = self.cli(
            "changelog", "--tag", "v1.2.4", "--changelog", str(changelog), "--notes", str(notes)
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("no exact section", missing.stderr)

    def test_only_release_commands_are_offered(self) -> None:
        result = self.cli("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        for removed in ("npm-", "oidc", "source"):
            self.assertNotIn(removed, result.stdout)


if __name__ == "__main__":
    unittest.main()
