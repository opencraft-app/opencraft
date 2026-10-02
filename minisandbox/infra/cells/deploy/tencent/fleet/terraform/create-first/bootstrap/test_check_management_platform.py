#!/usr/bin/env python3

import unittest
from pathlib import Path


SCRIPT = (Path(__file__).resolve().parent / "check-management-platform.sh").read_text()


class CheckManagementPlatformTests(unittest.TestCase):
    def test_is_read_only_and_revalidates_live_uids(self):
        self.assertIn("verify-management-platform.py", SCRIPT)
        self.assertIn("--receipt-only", SCRIPT)
        self.assertIn("--kube-system", SCRIPT)
        for mutation in (" apply ", " create ", " delete ", " patch "):
            self.assertNotIn(mutation, SCRIPT)


if __name__ == "__main__":
    unittest.main()
