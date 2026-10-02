import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("install-helm.sh")
SHA = "ee88b3c851ae6466a3de507f7be73fe94d54cbf2987cbaa3d1a3832ea331f2cd"


class HelmArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        binaries = self.root / "bin"
        binaries.mkdir()
        self.archive = self.root / "helm.tar.gz"
        self.archive.write_bytes(b"fixture")
        mocks = {
            "sha256sum": 'printf "%s  %s\\n" "$MOCK_SHA" "$1"',
            "curl": 'printf "%s\\n" "$@" >"$MOCK_ROOT/curl.args"\n'
            'while (($#)); do if [[ $1 == --output ]]; then cp "$MOCK_ROOT/helm.tar.gz" "$2"; break; fi; shift; done',
            "tar": 'touch "$MOCK_ROOT/extracted"\n'
            'while (($#)); do if [[ $1 == -C ]]; then target=$2; break; fi; shift; done\n'
            'mkdir -p "$target/linux-amd64"\n'
            'printf "#!/bin/sh\\nprintf helm-fixture\\\\n\\n" >"$target/linux-amd64/helm"',
            "install": 'touch "$MOCK_ROOT/installed"\n'
            'cp -- "${@: -2:1}" "${@: -1}"\nchmod 0755 "${@: -1}"',
        }
        for name, body in mocks.items():
            path = binaries / name
            path.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body + "\n")
            path.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{binaries}:{os.environ['PATH']}",
            "MOCK_ROOT": str(self.root),
            "MOCK_SHA": SHA,
            "ACTOR_HELM_ARCHIVE": str(self.archive),
            "HELM_INSTALL_PATH": str(self.root / "helm"),
            "TMPDIR": str(self.root),
        }

    def run_installer(self):
        return subprocess.run(["bash", str(SCRIPT)], env=self.env, capture_output=True, text=True)

    def test_local_archive_does_not_download(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "installed").exists())
        self.assertFalse((self.root / "curl.args").exists())

    def test_digest_mismatch_never_extracts_or_installs(self):
        self.env["MOCK_SHA"] = "0" * 64
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256 mismatch", result.stderr)
        self.assertFalse((self.root / "extracted").exists())
        self.assertFalse((self.root / "installed").exists())

    def test_local_missing_archive_never_falls_back(self):
        self.env["ACTOR_HELM_ARCHIVE"] = str(self.root / "missing")
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertFalse((self.root / "curl.args").exists())

    def test_symlink_is_rejected(self):
        link = self.root / "link"
        link.symlink_to(self.archive)
        self.env["ACTOR_HELM_ARCHIVE"] = str(link)
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertFalse((self.root / "extracted").exists())

    def test_relative_path_is_rejected(self):
        self.env["ACTOR_HELM_ARCHIVE"] = "helm.tar.gz"
        self.assertNotEqual(self.run_installer().returncode, 0)

    def test_public_download_is_https_and_time_bounded(self):
        self.env.pop("ACTOR_HELM_ARCHIVE")
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        args = (self.root / "curl.args").read_text().splitlines()
        for flag, value in [("--proto", "=https"), ("--proto-redir", "=https"),
                            ("--connect-timeout", "10"), ("--max-time", "120")]:
            self.assertEqual(args[args.index(flag) + 1], value)
        self.assertIn("https://get.helm.sh/helm-v3.17.3-linux-amd64.tar.gz", args)

    def test_public_digest_mismatch_is_rejected(self):
        self.env.pop("ACTOR_HELM_ARCHIVE")
        self.env["MOCK_SHA"] = "f" * 64
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertFalse((self.root / "extracted").exists())


if __name__ == "__main__":
    unittest.main()
