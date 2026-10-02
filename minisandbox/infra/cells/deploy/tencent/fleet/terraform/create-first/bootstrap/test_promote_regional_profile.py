#!/usr/bin/env python3

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("promote_regional_profile", ROOT / "promote-regional-profile.py")
PROMOTE = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(PROMOTE)


class RegionalProfilePromotionTests(unittest.TestCase):
    def fixture(self, root):
        profile = {
            "apiVersion": "fleet.actor.dev/v1alpha1", "kind": "RivetCellProfile",
            "metadata": {"name": "profile", "annotations": {"fleet.actor.dev/image-inventory-digest": "sha256:" + "1" * 64}},
            "spec": {"driverABI": "v1", "capacity": {"limit": 7}},
        }
        digest = PROMOTE.spec_digest(profile)
        shard_class = {
            "apiVersion": "fleet.actor.dev/v1alpha1", "kind": "ShardClass",
            "metadata": {"name": "class", "annotations": {"fleet.actor.dev/image-inventory-digest": "sha256:" + "1" * 64}},
            "spec": {"profileRef": {"name": "profile", "digest": digest}},
        }
        profile_path, receipt_path = root / "profile.yaml", root / "receipt.json"
        profile_path.write_text(yaml.safe_dump_all([profile, shard_class]))
        receipt_path.write_text(json.dumps({
            "schema": "actor-regional-profile-render/v1", "verdict": "passed",
            "profileName": "profile", "className": "class", "profileDigest": digest,
            "imageInventoryDigest": "sha256:" + "1" * 64,
        }))
        return profile, shard_class, digest, profile_path, receipt_path

    def test_validates_exact_rendered_contract_and_live_cas(self):
        with tempfile.TemporaryDirectory() as value:
            profile, shard_class, digest, profile_path, receipt_path = self.fixture(Path(value))
            _, receipt = PROMOTE.validate(profile_path, receipt_path)
            live_profile = {"metadata": {"name": "profile", "uid": "p-uid"}, "spec": profile["spec"]}
            live_class = {"metadata": {"name": "class", "uid": "c-uid"}, "spec": shard_class["spec"]}
            self.assertEqual(PROMOTE.validate_live(live_profile, live_class, receipt, digest), ("p-uid", "c-uid"))

    def test_rejects_stale_live_digest(self):
        with tempfile.TemporaryDirectory() as value:
            profile, shard_class, digest, profile_path, receipt_path = self.fixture(Path(value))
            _, receipt = PROMOTE.validate(profile_path, receipt_path)
            live_profile = {"metadata": {"name": "profile", "uid": "p-uid"}, "spec": profile["spec"]}
            live_class = {"metadata": {"name": "class", "uid": "c-uid"}, "spec": shard_class["spec"]}
            with self.assertRaisesRegex(ValueError, "moved since review"):
                PROMOTE.validate_live(live_profile, live_class, receipt, "sha256:" + "9" * 64)

    def test_bootstrap_tool_avoids_post_python36_syntax(self):
        source = (ROOT / "promote-regional-profile.py").read_text()
        self.assertNotIn("from __future__ import annotations", source)
        self.assertNotIn("capture_output=", source)
        self.assertNotRegex(source, r"\b(?:dict|list|tuple|set)\[")


if __name__ == "__main__":
    unittest.main()
