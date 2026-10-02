#!/usr/bin/env python3

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
INSTALL = (ROOT / "install.sh").read_text()
RELEASE = (ROOT / "release-runtime.sh").read_text()
MANIFEST = (ROOT / "runtime.yaml").read_text()


class RuntimeStorageIdentityTests(unittest.TestCase):
    def test_release_requires_and_forwards_exact_cold_bucket(self):
        self.assertIn("RIVET_COLD_BUCKET must be the exact Terraform Cell cold bucket", RELEASE)
        self.assertIn('RIVET_COLD_BUCKET="$cold_bucket"', RELEASE)
        self.assertIn("__RIVET_COLD_BUCKET__", MANIFEST)
        self.assertIn('s|__RIVET_COLD_BUCKET__|$cold_bucket|g', INSTALL)

    def test_release_binds_cold_origin_and_signing_region_to_profile(self):
        self.assertIn("profile_cold_region=$(jq -er '.cold_region'", RELEASE)
        self.assertIn("profile_cold_endpoint=$(jq -er '.cold_endpoint'", RELEASE)
        self.assertIn('RIVET_COLD_ENDPOINT="$cold_endpoint"', RELEASE)
        self.assertIn('RIVET_COLD_REGION="$cold_region"', RELEASE)
        self.assertIn("__RIVET_COLD_ENDPOINT__", MANIFEST)
        self.assertIn("__RIVET_COLD_REGION__", MANIFEST)
        self.assertNotIn("cos.ap-beijing.myqcloud.com", MANIFEST)

    def test_runtime_only_consumes_bootstrap_owned_immutable_secret(self):
        for value in (
            'get secret "${cell_name}-runtime-cos"',
            ".immutable == true",
            'credential-scope"] == "cell-cold"',
            'storage-bucket"] == $bucket',
        ):
            self.assertIn(value, INSTALL)
        for forbidden in (
            "blob-credentials.json",
            "credential-scope=cloud-root",
            'create secret generic "${cell_name}-runtime-cos"',
        ):
            self.assertNotIn(forbidden, INSTALL)


if __name__ == "__main__":
    unittest.main()
