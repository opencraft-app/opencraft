from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


RUNTIME_DIR = Path(__file__).resolve().parents[2]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops.pin_only_promote_diff import staged_velagw_diff_is_pin_only


class PinOnlyPromoteDiffTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.repo = Path(self.tempdir.name)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.name", "test"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.email", "test@example.com"], check=True)
        self.overlay = self.repo / "argocd/services/velagw/sgprod"
        self.overlay.mkdir(parents=True)
        self.env_file = self.overlay / "velagw-platform.env"
        self.env_file.write_text("VELAGW_IMAGE=old\nVELAGW_DEPLOYED_AT=old-time\nUNCHANGED=value\n")
        (self.overlay / "kustomization.yaml").write_text("resources: []\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "baseline"], check=True)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def stage(self, path: Path) -> None:
        subprocess.run(["git", "-C", str(self.repo), "add", str(path.relative_to(self.repo))], check=True)

    def test_accepts_image_and_deployed_at_changes(self) -> None:
        self.env_file.write_text("VELAGW_IMAGE=new\nVELAGW_DEPLOYED_AT=new-time\nUNCHANGED=value\n")
        self.stage(self.env_file)

        self.assertEqual(staged_velagw_diff_is_pin_only(self.repo, "sgprod"), (True, "pin-only"))

    def test_rejects_other_platform_keys(self) -> None:
        self.env_file.write_text("VELAGW_IMAGE=new\nVELAGW_DEPLOYED_AT=new-time\n")
        self.stage(self.env_file)

        pin_only, reason = staged_velagw_diff_is_pin_only(self.repo, "sgprod")
        self.assertFalse(pin_only)
        self.assertIn("UNCHANGED", reason)

    def test_rejects_other_overlay_files(self) -> None:
        kustomization = self.overlay / "kustomization.yaml"
        kustomization.write_text("resources: [changed]\n")
        self.stage(kustomization)

        pin_only, reason = staged_velagw_diff_is_pin_only(self.repo, "sgprod")
        self.assertFalse(pin_only)
        self.assertIn("kustomization.yaml", reason)
