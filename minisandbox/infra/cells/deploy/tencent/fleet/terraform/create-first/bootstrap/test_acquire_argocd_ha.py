#!/usr/bin/env python3

import unittest
from pathlib import Path


SCRIPT = (Path(__file__).resolve().parent / "acquire-argocd-ha.sh").read_text()


class AcquireArgoSourceTests(unittest.TestCase):
    def test_uses_full_ha_install_and_fixed_digest(self):
        self.assertIn("manifests/ha/install.yaml", SCRIPT)
        self.assertIn("2ce4de1f93549619a72fa7aee124d92fe73aa28ad062f1c614e15b5576ca0466", SCRIPT)
        self.assertNotIn("namespace-install.yaml", SCRIPT)

    def test_never_replaces_an_existing_source(self):
        self.assertIn("existing Argo source differs", SCRIPT)
        self.assertIn('ln "$temporary" "$ACTOR_ARGOCD_HA_SOURCE"', SCRIPT)
        self.assertNotIn("mv -f", SCRIPT)


if __name__ == "__main__":
    unittest.main()
