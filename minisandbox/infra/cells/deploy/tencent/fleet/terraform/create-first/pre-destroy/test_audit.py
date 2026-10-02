#!/usr/bin/env python3
import hashlib
import importlib.util
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent
AUDIT = ROOT / "audit.py"
IMAGE_SEED = ROOT.parents[2] / "gitops/image-seed"


class PreDestroyAuditTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.git_root = self.root / "repo"
        self.git_root.mkdir()
        self.repo = self.git_root / "minisandbox"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", self.git_root], check=True)
        subprocess.run(["git", "-C", self.git_root, "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", self.git_root, "config", "user.name", "test"], check=True)
        (self.git_root / "sibling.txt").write_text("not part of minisandbox\n")
        (self.repo / "source.txt").write_text("reviewed\n")
        fixture_image_seed = (
            self.repo / "infra/cells/deploy/tencent/fleet/gitops/image-seed"
        )
        fixture_image_seed.mkdir(parents=True)
        for name in ("image-lock.py", "image_contract.py"):
            shutil.copyfile(IMAGE_SEED / name, fixture_image_seed / name)
        bootstrap = self.repo / "infra/cells/deploy/tencent/fleet/terraform/create-first/bootstrap-state"
        bootstrap.mkdir(parents=True)
        (bootstrap / "main.tf").write_text(
            'resource "tencentcloud_cos_bucket" "state" {\n'
            "  lifecycle {\n"
            "    prevent_destroy = true\n"
            "  }\n"
            "}\n"
        )
        subprocess.run(["git", "-C", self.git_root, "add", "."], check=True)
        subprocess.run(["git", "-C", self.git_root, "commit", "-qm", "fixture"], check=True)
        self.revision = subprocess.run(
            ["git", "-C", self.git_root, "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.repository_tree = subprocess.run(
            ["git", "-C", self.git_root, "rev-parse", "HEAD^{tree}"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.tree = subprocess.run(
            ["git", "-C", self.git_root, "rev-parse", "HEAD:minisandbox"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.bundle = self.root / "source.tar.gz"
        self.bundle.write_bytes(b"deterministic source bundle")
        self.bundle_sha = hashlib.sha256(self.bundle.read_bytes()).hexdigest()
        self.receipt = self.root / "source.receipt.json"
        self.receipt.write_text(
            json.dumps(
                {
                    "schema": "actor-reviewed-source-bundle/v2",
                    "verdict": "passed",
                    "source": {
                        "revision": self.revision,
                        "repositoryTree": self.repository_tree,
                        "projectPath": "minisandbox",
                        "projectTree": self.tree,
                    },
                    "bundle": {"sha256": self.bundle_sha},
                }
            )
        )
        self.archive = self.root / "terraform.zip"
        self.archive.write_bytes(b"terraform archive")
        archive_sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.lock = self.root / "terraform.lock.json"
        self.lock.write_text(
            json.dumps(
                {
                    "schema": "actor-bootstrap-tool/v1",
                    "version": "1.9.8",
                    "platform": "linux_amd64",
                    "archive": {"sha256": archive_sha},
                }
            )
        )
        spec = importlib.util.spec_from_file_location(
            "pre_destroy_image_contract", IMAGE_SEED / "image_contract.py"
        )
        contract = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(contract)
        self.image_contract = contract
        registry = "tcr-test.tencentcloudcr.com"
        digest = "sha256:" + "a" * 64
        images = []
        for repository in sorted(contract.ALL_REPOSITORIES):
            if repository in contract.UPSTREAM_REPOSITORIES:
                provenance = {
                    "kind": "mirror",
                    "source": f"docker.io/test/{repository}@{digest}",
                }
            else:
                provenance = {
                    "kind": "build",
                    "sourceRevision": "b" * 40,
                    "sourceManifestDigest": digest,
                    "buildReceiptDigest": digest,
                }
            images.append(
                {
                    "repository": repository,
                    "ref": f"{registry}/actor-fleet/{repository}@{digest}",
                    "provenance": provenance,
                }
            )
        inventory = {
            "schemaVersion": 1,
            "registry": registry,
            "namespace": "actor-fleet",
            "platform": "linux/amd64",
            "sourceLockDigest": digest,
            "seedReceiptDigest": digest,
            "images": images,
        }
        inventory["inventoryDigest"] = contract.digest(inventory)
        self.image_inventory = self.root / "all-images.lock.json"
        self.image_inventory.write_text(json.dumps(inventory))
        self.image_sha = hashlib.sha256(self.image_inventory.read_bytes()).hexdigest()
        self.image_digest = inventory["inventoryDigest"]
        self.states = {}
        for index, name in enumerate(
            ("foundation", "management", "operations-network", "actor-bj-a01", "actor-bj-b01"), start=1
        ):
            path = self.root / f"{name}.json"
            path.write_text(json.dumps(self.state_fixture(name, index)))
            self.states[name] = path

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def state_fixture(name: str, index: int) -> dict:
        resources = []
        required = {
            "foundation": [
                ("tencentcloud_ccn", "fleet", "ccn-test"),
                ("tencentcloud_tcr_instance", "fleet", "tcr-test"),
                ("tencentcloud_tcr_namespace", "fleet", "namespace-test"),
                ("tencentcloud_tcr_repository", "fleet", "repository-test"),
            ],
            "management": [
                ("tencentcloud_cos_bucket", "bootstrap_relay", "bucket-relay"),
                ("tencentcloud_cos_bucket", "code_plane", "bucket-code"),
                ("tencentcloud_instance", "bootstrap", "ins-management"),
                ("tencentcloud_instance", "ha_worker", "ins-ha"),
                ("tencentcloud_kubernetes_cluster", "management", f"cls-{index}"),
                ("tencentcloud_vpc", "management", f"vpc-{index}"),
            ],
            "operations-network": [
                ("tencentcloud_ccn_attachment_v2", "operations", "ccn-test#VPC#ap-beijing#vpc-operations"),
                ("tencentcloud_ccn_route_table", "operations", "ccnrtb-operations"),
                ("tencentcloud_ccn_route_table_broadcast_policies", "default_isolation", "ccn-test#ccnrtb-default"),
                ("tencentcloud_ccn_route_table_input_policies", "operations", "ccn-test#ccnrtb-operations"),
            ],
            "actor-bj-a01": [
                ("tencentcloud_cos_bucket", "storage", "bucket-a"),
                ("tencentcloud_instance", "bootstrap", "ins-a"),
                ("tencentcloud_kubernetes_cluster", "cell", f"cls-{index}"),
                ("tencentcloud_vpc", "cell", f"vpc-{index}"),
            ],
            "actor-bj-b01": [
                ("tencentcloud_cos_bucket", "storage", "bucket-b"),
                ("tencentcloud_instance", "bootstrap", "ins-b"),
                ("tencentcloud_kubernetes_cluster", "cell", f"cls-{index}"),
                ("tencentcloud_vpc", "cell", f"vpc-{index}"),
            ],
        }
        for resource_type, resource_name, identity in required[name]:
            attributes = {"id": identity}
            if name == "foundation" and resource_type == "tencentcloud_tcr_instance":
                attributes["public_domain"] = "tcr-test.tencentcloudcr.com"
            if name == "operations-network" and resource_type == "tencentcloud_ccn_attachment_v2":
                attributes.update({"ccn_id": "ccn-test", "instance_id": "vpc-operations"})
            resources.append(
                {
                    "mode": "managed",
                    "type": resource_type,
                    "name": resource_name,
                    "instances": [{"attributes": attributes}],
                }
            )
        return {
            "version": 4,
            "terraform_version": "1.9.8",
            "serial": index,
            "lineage": f"0000000{index}-0000-4000-8000-00000000000{index}",
            "resources": resources,
        }

    def command(self, output: pathlib.Path) -> list[str]:
        bucket = "actor-terraform-state-test-1234567890"
        command = [
            "python3",
            str(AUDIT),
            "--repo",
            str(self.repo),
            "--source-bundle",
            str(self.bundle),
            "--source-receipt",
            str(self.receipt),
            "--source-remote-uri",
            f"cos://{bucket}/recovery/v1/source/{self.revision}/{self.bundle_sha}/source.tar.gz",
            "--terraform-lock",
            str(self.lock),
            "--terraform-archive",
            str(self.archive),
            "--terraform-remote-uri",
            f"cos://{bucket}/recovery/v1/tools/terraform/1.9.8/linux_amd64/terraform.zip",
            "--image-inventory",
            str(self.image_inventory),
            "--image-remote-uri",
            f"cos://{bucket}/recovery/v1/images/{self.image_digest}/{self.image_sha}/all-images.lock.json",
            "--state-bucket",
            bucket,
            "--bucket-versioning",
            "Enabled",
            "--output",
            str(output),
        ]
        for name, path in self.states.items():
            command.extend(("--state", f"{name}={path}"))
        return command

    def test_complete_seed_passes(self) -> None:
        output = self.root / "passed.json"
        result = subprocess.run(self.command(output), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(json.loads(output.read_text())["verdict"], "passed")

    def test_dirty_tree_blocks_destroy(self) -> None:
        (self.repo / "unarchived.txt").write_text("not in bundle\n")
        output = self.root / "blocked.json"
        result = subprocess.run(self.command(output), capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        document = json.loads(output.read_text())
        self.assertEqual(document["verdict"], "blocked")
        self.assertIn("working tree contains unarchived changes", document["failures"])

    def test_inventory_for_a_different_foundation_registry_blocks_destroy(self) -> None:
        inventory = json.loads(self.image_inventory.read_text())
        old_registry = inventory["registry"]
        inventory["registry"] = "other-test.tencentcloudcr.com"
        for image in inventory["images"]:
            image["ref"] = image["ref"].replace(
                old_registry, inventory["registry"], 1
            )
        inventory.pop("inventoryDigest")
        inventory["inventoryDigest"] = self.image_contract.digest(inventory)
        self.image_inventory.write_text(json.dumps(inventory))
        self.image_sha = hashlib.sha256(self.image_inventory.read_bytes()).hexdigest()
        self.image_digest = inventory["inventoryDigest"]

        output = self.root / "wrong-registry.json"
        result = subprocess.run(self.command(output), capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "image inventory registry differs from the foundation TCR",
            json.loads(output.read_text())["failures"],
        )

    def test_operations_network_on_a_different_ccn_blocks_destroy(self) -> None:
        state = json.loads(self.states["operations-network"].read_text())
        attachment = next(
            resource
            for resource in state["resources"]
            if resource["type"] == "tencentcloud_ccn_attachment_v2"
        )
        attachment["instances"][0]["attributes"]["ccn_id"] = "ccn-wrong"
        self.states["operations-network"].write_text(json.dumps(state))

        output = self.root / "wrong-operations-ccn.json"
        result = subprocess.run(self.command(output), capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "operations network is attached to a different CCN than foundation",
            json.loads(output.read_text())["failures"],
        )


if __name__ == "__main__":
    unittest.main()
