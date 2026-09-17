from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]


class ReferralConfigRolloutTest(unittest.TestCase):
    def test_config_is_generated_with_a_hash_and_referenced_by_all_workloads(self) -> None:
        binary = shutil.which("kustomize")
        if not binary:
            self.skipTest("kustomize is required for source rendering")

        expected_campaigns = {
            "beijing-sandbox": "beijing-pilot-2026-09",
            "shprod": "shanghai-launch-2026-09",
            "sgprod": "singapore-launch-2026-09",
        }
        for env, expected_campaign in expected_campaigns.items():
            with self.subTest(env=env), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                shutil.copytree(REPO_ROOT / "referral/k8s", root / "referral/k8s")
                deploy_root = root / f"argocd/services/referral/{env}"
                shutil.copytree(REPO_ROOT / "argocd/services/referral/common", root / "argocd/services/referral/common")
                shutil.copytree(REPO_ROOT / f"argocd/services/referral/{env}", deploy_root)

                spec = yaml.safe_load((deploy_root / "kustomization.yaml").read_text())
                spec.pop("generators")
                spec["resources"].append("fixture-secret.yaml")
                (deploy_root / "kustomization.yaml").write_text(yaml.safe_dump(spec, sort_keys=False))
                (deploy_root / "fixture-secret.yaml").write_text(
                    "apiVersion: v1\nkind: Secret\nmetadata:\n"
                    "  name: referral-runtime-secrets\n  namespace: referral\n"
                )

                result = subprocess.run(
                    [binary, "build", str(deploy_root)],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                resources = [item for item in yaml.safe_load_all(result.stdout) if item]
                config = next(
                    item for item in resources
                    if item["kind"] == "ConfigMap"
                    and item["metadata"]["name"].startswith("referral-config-")
                )
                config_name = config["metadata"]["name"]

                self.assertRegex(config_name, r"^referral-config-[a-z0-9]+$")
                self.assertEqual(config["data"]["REFERRAL_ENABLED"], "true")
                self.assertEqual(config["data"]["REFERRAL_CAMPAIGN_ID"], expected_campaign)

                workloads = [item for item in resources if item["kind"] in {"Deployment", "Job"}]
                self.assertEqual(
                    {item["metadata"]["name"] for item in workloads},
                    {"referral", "referral-worker", "referral-campaign"},
                )
                for workload in workloads:
                    references = workload["spec"]["template"]["spec"]["containers"][0]["envFrom"]
                    self.assertIn({"configMapRef": {"name": config_name}}, references)


if __name__ == "__main__":
    unittest.main()
