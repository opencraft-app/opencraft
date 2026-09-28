from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]


class CloudAPIGuangzhouRouteTest(unittest.TestCase):
    def test_beijing_prerelease_ctl_accepts_guangzhou_region(self) -> None:
        manifest = yaml.safe_load(
            (
                REPO_ROOT
                / "argocd/services/ctl/beijing-sandbox/kustomization.yaml"
            ).read_text(encoding="utf-8")
        )

        cloudapi_regions = []
        for patch in manifest.get("patches", []):
            if patch.get("target", {}).get("name") != "ctl-api":
                continue
            operations = yaml.safe_load(patch.get("patch", "")) or []
            for operation in operations:
                value = operation.get("value", {})
                if value.get("name") == "CTL_CLOUDAPI_ALLOWED_REGIONS":
                    cloudapi_regions.extend(
                        region.strip()
                        for region in value.get("value", "").split(",")
                        if region.strip()
                    )

        self.assertIn("ap-guangzhou", cloudapi_regions)


if __name__ == "__main__":
    unittest.main()
