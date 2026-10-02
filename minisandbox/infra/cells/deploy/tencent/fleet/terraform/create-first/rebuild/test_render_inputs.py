#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest

import yaml


ROOT = pathlib.Path(__file__).resolve().parent
INTENT_PATH = ROOT / "fleet-intent.json"
NETWORK_PATH = ROOT.parents[2] / "network/ccn-plan.yaml"
SPEC = importlib.util.spec_from_file_location("render_rebuild_inputs", ROOT / "render-inputs.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class RenderRebuildInputsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.intent = json.loads(INTENT_PATH.read_text())
        self.binding = {
            "poolName": "actor-beijing-kubernetes",
            "poolUid": "new-pool-uid",
            "claimName": "new-cell-claim",
            "claimUid": "new-claim-uid",
            "className": "rivet-fdb-cos-kubernetes-v1",
            "scaleOutEpoch": 0,
            "profileDigest": "sha256:" + "a" * 64,
        }

    def test_intent_matches_reviewed_network_plan(self) -> None:
        plan = yaml.safe_load(NETWORK_PATH.read_text())
        self.assertEqual(self.intent["regionalVpcAggregate"], plan["regionalVpcAggregate"])
        self.assertEqual(self.intent["reservedCidrs"], plan["reservedCidrs"])
        expected = {
            "hub": self.intent["management"]["network"],
            "runtime-a": self.intent["cells"]["actor-bj-a01"]["network"],
            "runtime-b": self.intent["cells"]["actor-bj-b01"]["network"],
        }
        for name, actual in expected.items():
            source = plan["clusters"][name]
            self.assertEqual(actual["vpcCidr"], source["vpcCidr"])
            self.assertEqual(actual["podCidr"], source["podCidr"])
            self.assertEqual(actual["serviceCidr"], source["serviceCidr"])
            self.assertEqual(
                {item["availabilityZone"]: item["cidr"] for item in actual["subnets"].values()},
                source["subnets"],
            )

    def test_renders_management_without_cloud_ids(self) -> None:
        rendered = MODULE.render_management(self.intent)
        self.assertEqual(rendered["vpc_cidr"], "10.160.0.0/16")
        self.assertEqual(rendered["trusted_workers_api_cidrs"], ["9.134.163.40/32", "10.0.0.0/12"])
        encoded = json.dumps(rendered)
        for prefix in ("cls-", "vpc-", "subnet-", "ins-", "sg-"):
            self.assertNotIn(prefix, encoded)

    def test_renders_operations_network_by_stable_vpc_identity(self) -> None:
        rendered = MODULE.render_operations_network(self.intent)
        self.assertEqual(rendered["operations_vpc_name"], "lightclaw-bj8")
        self.assertEqual(rendered["operations_vpc_cidr"], "10.0.0.0/12")
        self.assertNotIn("operations_vpc_id", rendered)

    def test_cell_uses_fresh_binding_and_capacity_policy(self) -> None:
        rendered, spec = MODULE.render_cell(self.intent, "actor-bj-a01", self.binding)
        self.assertEqual(rendered["vpc_cidr"], "10.161.0.0/20")
        self.assertEqual(
            {item["cidr_block"] for item in rendered["subnets"].values()},
            {"10.161.0.0/22", "10.161.4.0/22", "10.161.8.0/22"},
        )
        self.assertEqual(rendered["fleet_binding"]["claim_uid"], "new-claim-uid")
        self.assertEqual(rendered["cluster_pod_cidr"], "10.201.0.0/16")
        self.assertEqual(rendered["stateless_node_pool"], {
            "instance_types": ["SA9.LARGE8", "SA9e.LARGE8", "SA5.LARGE8", "S9.LARGE8"],
            "replicas": 3,
            "min_replicas": 3,
            "max_replicas": 300,
        })
        self.assertEqual(
            spec["machinePools"]["control"]["instanceTypes"],
            ["SA9.4XLARGE32"],
        )
        self.assertEqual(spec["machinePools"]["runtime"]["maxReplicas"], 301)
        self.assertEqual(spec["profileDigest"], "sha256:" + "a" * 64)

    def test_old_or_wrong_binding_is_rejected(self) -> None:
        self.binding["poolName"] = "remembered-old-pool"
        with self.assertRaisesRegex(ValueError, "differs from fleet intent"):
            MODULE.render_cell(self.intent, "actor-bj-b01", self.binding)

    def test_cli_outputs_terraform_json(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            binding = root / "binding.json"
            binding.write_text(json.dumps(self.binding))
            output = root / "cell.tfvars.json"
            spec = root / "cell-spec.json"
            subprocess.run(
                [
                    "python3",
                    str(ROOT / "render-inputs.py"),
                    "--intent",
                    str(INTENT_PATH),
                    "--target",
                    "actor-bj-b01",
                    "--binding",
                    str(binding),
                    "--output",
                    str(output),
                    "--cell-spec-output",
                    str(spec),
                ],
                check=True,
            )
            self.assertEqual(json.loads(output.read_text())["cell_id"], "actor-bj-b01")
            self.assertEqual(json.loads(spec.read_text())["cellId"], "actor-bj-b01")


if __name__ == "__main__":
    unittest.main()
