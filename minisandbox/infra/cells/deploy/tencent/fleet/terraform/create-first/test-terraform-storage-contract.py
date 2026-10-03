#!/usr/bin/env python3

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MAIN = (ROOT / "cell" / "main.tf").read_text()
OUTPUTS = (ROOT / "cell" / "outputs.tf").read_text()
MANAGEMENT = (ROOT / "management" / "main.tf").read_text()
MANAGEMENT_OUTPUTS = (ROOT / "management" / "outputs.tf").read_text()
FOUNDATION = (ROOT / "foundation" / "main.tf").read_text()


class TerraformStorageIdentityContractTests(unittest.TestCase):
    def test_explicit_tcr_destroy_removes_its_backing_bucket(self):
        block = re.search(
            r'resource "tencentcloud_tcr_instance" "fleet" \{(.*?)\n\}',
            FOUNDATION,
            re.S,
        )
        self.assertIsNotNone(block)
        self.assertIn("deletion_protection   = var.deletion_protection", block.group(1))
        self.assertIn("delete_bucket         = true", block.group(1))

    def test_management_bootstrap_relay_is_private_ephemeral_cos(self):
        block = re.search(
            r'resource "tencentcloud_cos_bucket" "bootstrap_relay" \{(.*?)\n\}',
            MANAGEMENT,
            re.S,
        )
        self.assertIsNotNone(block)
        relay = block.group(1)
        self.assertIn('acl                  = "private"', relay)
        self.assertIn('encryption_algorithm = "AES256"', relay)
        self.assertIn('filter_prefix = "relay/"', relay)
        self.assertIn("days = 1", relay)
        self.assertIn('output "bootstrap_relay_bucket"', MANAGEMENT_OUTPUTS)

    def test_management_owns_regional_code_plane_storage(self):
        self.assertIn('resource "tencentcloud_cos_bucket" "code_plane"', MANAGEMENT)
        self.assertIn('actor-fdb-backup-prod-${local.management_suffix}-nv1-${var.account_app_id}', MANAGEMENT)
        self.assertIn('actor-worker-code-prod-${local.management_suffix}-nv1-${var.account_app_id}', MANAGEMENT)
        self.assertIn('actor-qualification-evidence-prod-${local.management_suffix}-nv1-${var.account_app_id}', MANAGEMENT)
        self.assertIn('versioning = "never-enabled"', MANAGEMENT)
        self.assertRegex(MANAGEMENT, r'codePlaneBackupBucket\s*=\s*tencentcloud_cos_bucket\.code_plane\["backup"\]\.bucket')
        self.assertRegex(MANAGEMENT, r'qualificationEvidenceBucket\s*=\s*tencentcloud_cos_bucket\.code_plane\["evidence"\]\.bucket')
        self.assertRegex(MANAGEMENT, r'workerCodeBucket\s*=\s*tencentcloud_cos_bucket\.code_plane\["code"\]\.bucket')
        self.assertIn('output "code_plane_buckets"', MANAGEMENT_OUTPUTS)

    def test_runtime_builder_is_not_a_control_worker(self):
        block = re.search(
            r'resource "tencentcloud_instance" "runtime_builder" \{(.*?)\n\}', MANAGEMENT, re.S,
        )
        self.assertIsNotNone(block)
        self.assertIn("var.runtime_builder_instance_type", block.group(1))
        self.assertIn("allocate_public_ip         = false", block.group(1))
        self.assertIn("tencentcloud_security_group.runtime_builder.id", block.group(1))
        attachments = re.findall(
            r'resource "tencentcloud_kubernetes_cluster_attachment" "[^"]+" \{(.*?)\n\}',
            MANAGEMENT, re.S,
        )
        self.assertEqual(len(attachments), 2)
        for attachment in attachments:
            self.assertNotIn("runtime_builder", attachment)
        control_nodes = re.search(r'initialWorkerInstanceIds = concat\((.*?)\n      \)', MANAGEMENT, re.S)
        self.assertIsNotNone(control_nodes)
        self.assertNotIn("runtime_builder", control_nodes.group(1))

    def test_build_disk_has_exact_identity_without_formatting_existing_disks(self):
        self.assertIn('resource "tencentcloud_cbs_storage" "runtime_builder"', MANAGEMENT)
        self.assertIn('resource "tencentcloud_cbs_storage_attachment" "runtime_builder"', MANAGEMENT)
        self.assertIn("storage_id  = tencentcloud_cbs_storage.runtime_builder.id", MANAGEMENT)
        self.assertIn("instance_id = tencentcloud_instance.runtime_builder.id", MANAGEMENT)
        self.assertIn("force_delete      = false", MANAGEMENT)
        self.assertRegex(MANAGEMENT, r"dataDiskId\s*=\s*tencentcloud_cbs_storage.runtime_builder.id")
        self.assertRegex(MANAGEMENT, r"storageBootstrapRequired\s*=\s*true")
        self.assertRegex(MANAGEMENT, r"operationsInstanceId\s*=\s*tencentcloud_instance.bootstrap.id")
        self.assertIn('output "runtime_builder_inventory"', MANAGEMENT_OUTPUTS)
        for forbidden in ("local-exec", "remote-exec", "mkfs", "/dev/vdb"):
            self.assertNotIn(forbidden, MANAGEMENT)

    def test_builder_security_group_has_no_ingress_authority(self):
        rules = re.findall(r'resource "tencentcloud_security_group_rule" "[^"]+" \{(.*?)\n\}', MANAGEMENT, re.S)
        builder_rules = [rule for rule in rules if "tencentcloud_security_group.runtime_builder.id" in rule]
        self.assertEqual(len(builder_rules), 1)
        self.assertIn('type              = "egress"', builder_rules[0])

    def test_build_inventory_is_not_part_of_strict_platform_inventory(self):
        self.assertIn('value       = local.runtime_builder_inventory', MANAGEMENT_OUTPUTS)
        platform = MANAGEMENT.split('management_inventory = {', 1)[1].split('runtime_builder_inventory = {', 1)[0]
        self.assertNotIn('runtimeBuilder', platform)
        self.assertNotIn('tencentcloud_instance.runtime_builder', platform)
        self.assertIn('schema                   = "actor-runtime-builder-inventory/v1"', MANAGEMENT)

    def test_cold_and_backup_are_independent_api_only_users(self):
        self.assertIn('var.storage_identity_mode == "dedicated-users"', MAIN)
        self.assertIn('name          = "${var.cell_id}-${each.key}-storage"', MAIN)
        self.assertIn("console_login = false", MAIN)
        self.assertIn("use_api       = true", MAIN)
        self.assertIn("force_delete  = true", MAIN)
        self.assertIn('tencentcloud_cam_user.data_plane_storage["cold"].name', MAIN)
        self.assertIn('tencentcloud_cam_user.data_plane_storage["backup"].name', MAIN)
        self.assertIn(') : "root-account-shared"', MAIN)

    def test_policy_is_exact_bucket_data_plane_not_account_wide(self):
        block = re.search(
            r'resource "tencentcloud_cam_policy" "data_plane_storage" \{(.*?)\n\}', MAIN, re.S,
        )
        self.assertIsNotNone(block)
        policy = block.group(1)
        self.assertNotIn('resource = ["*"]', policy)
        self.assertIn('qcs::cos:${var.region}:uid/${var.account_app_id}:${each.value.bucket}', policy)
        self.assertIn('qcs::cos:${var.region}:uid/${var.account_app_id}:${each.value.bucket}/*', policy)
        for action in (
            "GetBucket", "GetObject", "PutObject", "DeleteObject",
            "InitiateMultipartUpload", "UploadPart", "CompleteMultipartUpload", "AbortMultipartUpload",
        ):
            self.assertIn(f'"name/cos:{action}"', MAIN)
        # These Cell buckets are created with versioning NeverEnabled. Tencent
        # CAM has no GetObjectVersion action; object reads use GetObject.
        self.assertNotIn('"name/cos:GetObjectVersion"', MAIN)

    def test_only_sensitive_output_contains_key_material(self):
        self.assertIn("storageCredentials", OUTPUTS)
        self.assertIn("accessKeyId     = identity.secret_id", OUTPUTS)
        self.assertIn("secretAccessKey = identity.secret_key", OUTPUTS)
        self.assertIn("sensitive   = true", OUTPUTS)
        public_inventory = MAIN.split("cell_inventory = {", 1)[1]
        self.assertNotIn("secret_id", public_inventory)
        self.assertNotIn("secret_key", public_inventory)


if __name__ == "__main__":
    unittest.main()
