from __future__ import annotations

import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]


class ReferralGuardWorkflowTests(unittest.TestCase):
    def test_manifest_uses_ci_owned_referral_guard(self) -> None:
        manifest = (REPO_ROOT / ".ci/guards.manifest").read_text()
        self.assertIn("command: .ci/checks/referral_guard.sh", manifest)

    def test_referral_guard_bootstraps_pinned_tools(self) -> None:
        guard = (REPO_ROOT / ".ci/checks/referral_guard.sh").read_text()
        self.assertIn("source .ci/init.sh", guard)
        self.assertIn("ci_ensure_go", guard)
        self.assertIn("ci_ensure_kustomize", guard)
        self.assertIn("go test ./...", guard)
        self.assertIn("go vet ./...", guard)


if __name__ == "__main__":
    unittest.main()
