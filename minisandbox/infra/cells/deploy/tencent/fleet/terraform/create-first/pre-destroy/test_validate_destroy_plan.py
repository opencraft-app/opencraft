#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest


HERE = pathlib.Path(__file__).parent
SPEC = importlib.util.spec_from_file_location(
    "validate_destroy_plan", HERE / "validate-destroy-plan.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DestroyPlanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.git_root = self.root / "repo"
        self.git_root.mkdir()
        self.repo = self.git_root / "minisandbox"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.git_root)], check=True)
        subprocess.run(["git", "-C", str(self.git_root), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(self.git_root), "config", "user.name", "test"], check=True)
        (self.git_root / "sibling").write_text("outside project\n")
        (self.repo / "tracked").write_text("reviewed\n")
        subprocess.run(["git", "-C", str(self.git_root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.git_root), "commit", "-qm", "fixture"], check=True)
        revision = self.git("rev-parse", "HEAD")
        repository_tree = self.git("rev-parse", "HEAD^{tree}")
        tree = self.git("rev-parse", "HEAD:minisandbox")

        self.inventory = self.root / "images.json"
        self.write(self.inventory, {
            "inventoryDigest": "sha256:" + "a" * 64,
            "images": [{"repository": f"image-{index}"} for index in range(28)],
        })
        self.audit = self.root / "audit.json"
        self.write(self.audit, {
            "schema": MODULE.AUDIT_SCHEMA,
            "verdict": "passed",
            "failures": [],
            "source": {
                "revision": revision,
                "repositoryTree": repository_tree,
                "projectPath": "minisandbox",
                "projectTree": tree,
            },
            "imageInventory": {
                "sha256": MODULE.sha256(self.inventory),
                "inventoryDigest": "sha256:" + "a" * 64,
            },
            "recoveryBucket": {
                "name": "actor-terraform-state-beijing-1234567890",
                "retentionClass": "bootstrap-seed-do-not-destroy",
                "terraformPreventDestroy": True,
                "versioning": "Enabled",
            },
            "terraform": {"version": "1.9.8"},
            "terraformStates": {
                "foundation": {"identities": {"ccn": "ccn-abcdefgh", "registry": "tcr-abcdefgh"}},
                "management": {
                    "lineage": "management-lineage", "serial": 4,
                    "identities": {"cluster": "cls-abcdefgh", "vpc": "vpc-abcdefgh"},
                },
                "actor-bj-a01": {
                    "lineage": "cell-lineage", "serial": 7,
                    "identities": {"cluster": "cls-12345678", "vpc": "vpc-12345678"},
                },
                "actor-bj-b01": {
                    "lineage": "other-lineage", "serial": 2,
                    "identities": {"cluster": "cls-87654321", "vpc": "vpc-87654321"},
                },
            },
        })
        self.state = self.root / "state.json"
        self.write(self.state, {
            "lineage": "cell-lineage",
            "serial": 8,
            "resources": [
                {
                    "mode": "managed", "type": "tencentcloud_kubernetes_cluster", "name": "cell",
                    "instances": [{"attributes": {"id": "cls-12345678"}}],
                },
                {
                    "mode": "managed", "type": "tencentcloud_vpc", "name": "cell",
                    "instances": [{"attributes": {"id": "vpc-12345678"}}],
                },
            ],
        })
        self.plan_binary = self.root / "destroy.tfplan"
        self.plan_binary.write_bytes(b"opaque reviewed plan")
        self.plan_json = self.root / "destroy.tfplan.json"
        self.plan = {
            "terraform_version": "1.9.8",
            "variables": {
                "deletion_protection": {"value": False},
                "terraform_state_bucket": {"value": "actor-terraform-state-beijing-1234567890"},
                "cell_id": {"value": "actor-bj-a01"},
            },
            "resource_changes": [
                self.change("tencentcloud_kubernetes_cluster.cell", "tencentcloud_kubernetes_cluster", {"id": "cls-12345678"}),
                self.change("tencentcloud_vpc.cell", "tencentcloud_vpc", {"id": "vpc-12345678"}),
                self.change(
                    "tencentcloud_cos_bucket.storage[\"cold\"]", "tencentcloud_cos_bucket",
                    {"bucket": "actor-depot-cold-prod-bj-a01-nv1-1234567890"},
                ),
            ],
        }
        self.write(self.plan_json, self.plan)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(self.repo), *args], check=True, text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()

    @staticmethod
    def write(path: pathlib.Path, value: object) -> None:
        path.write_text(json.dumps(value, sort_keys=True) + "\n")

    @staticmethod
    def change(address: str, resource_type: str, before: dict[str, object]) -> dict[str, object]:
        return {
            "address": address,
            "type": resource_type,
            "change": {"actions": ["delete"], "before": before},
        }

    def validate(self) -> dict[str, object]:
        return MODULE.validate_plan(
            self.audit, self.inventory, self.repo, "actor-bj-a01",
            self.state, self.plan_binary, self.plan_json,
        )

    def rewrite_plan(self) -> None:
        self.write(self.plan_json, self.plan)

    def test_accepts_exact_cell_plan_and_retains_foundation(self) -> None:
        receipt = self.validate()
        self.assertEqual(receipt["verdict"], "passed")
        self.assertEqual(receipt["deleteCount"], 3)
        self.assertEqual(receipt["retained"]["registry"], "tcr-abcdefgh")
        self.assertEqual(receipt["identities"]["cluster"], "cls-12345678")

    def test_rejects_foundation_resource(self) -> None:
        self.plan["resource_changes"].append(
            self.change("tencentcloud_tcr_instance.regional", "tencentcloud_tcr_instance", {"id": "tcr-abcdefgh"})
        )
        self.rewrite_plan()
        with self.assertRaisesRegex(ValueError, "retained foundation"):
            self.validate()

    def test_rejects_shared_oidc_attachment(self) -> None:
        self.plan["resource_changes"].append(
            self.change(
                "tencentcloud_cam_role_policy_attachment_by_name.tke_oidc_config",
                "tencentcloud_cam_role_policy_attachment_by_name", {"id": "shared"},
            )
        )
        self.rewrite_plan()
        with self.assertRaisesRegex(ValueError, "retained foundation"):
            self.validate()

    def test_rejects_state_bucket(self) -> None:
        self.plan["resource_changes"].append(
            self.change("tencentcloud_cos_bucket.state", "tencentcloud_cos_bucket", {
                "bucket": "actor-terraform-state-beijing-1234567890"
            })
        )
        self.rewrite_plan()
        with self.assertRaisesRegex(ValueError, "protected state"):
            self.validate()

    def test_rejects_other_scope_bucket(self) -> None:
        self.plan["resource_changes"][2]["change"]["before"]["bucket"] = (
            "actor-depot-cold-prod-bj-b01-nv1-1234567890"
        )
        self.rewrite_plan()
        with self.assertRaisesRegex(ValueError, "outside the exact scope"):
            self.validate()

    def test_rejects_non_delete_action(self) -> None:
        self.plan["resource_changes"][2]["change"]["actions"] = ["update"]
        self.rewrite_plan()
        with self.assertRaisesRegex(ValueError, "non-delete action"):
            self.validate()

    def test_rejects_different_live_identity(self) -> None:
        state = json.loads(self.state.read_text())
        state["resources"][0]["instances"][0]["attributes"]["id"] = "cls-deadbeef"
        self.write(self.state, state)
        with self.assertRaisesRegex(ValueError, "identities differ"):
            self.validate()

    def test_rejects_dirty_source_tree(self) -> None:
        (self.repo / "dirty").write_text("not archived\n")
        with self.assertRaisesRegex(ValueError, "unarchived"):
            self.validate()


if __name__ == "__main__":
    unittest.main()
