#!/usr/bin/env python3

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
CREATE_FIRST = ROOT.parents[1] / "terraform" / "create-first"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


HANDOFF = load("verify_handoff", ROOT / "verify-handoff.py")
RENDER = load("render_management", ROOT / "render-management.py")
MERGE = load("merge_resource_inclusions", ROOT / "merge-resource-inclusions.py")
CELL = load("render_cell_assets_for_registration", CREATE_FIRST / "render-cell-assets.py")
FIXTURE = load("cell_registration_fixture", ROOT / "local-registration-e2e.py")


def inventory():
    return {
        "schemaVersion": 1,
        "cellId": "actor-bj-k02",
        "environment": "prod",
        "region": "ap-beijing",
        "availabilityMode": "production-multi-zone",
        "fleet": {
            "poolName": "actor-beijing-kubernetes",
            "poolUid": "pool-uid-test",
            "claimName": "actor-bj-k02-claim",
            "claimUid": "claim-uid-test",
            "className": "rivet-fdb-cos-kubernetes-v1",
            "datacenterName": "default",
            "scaleOutEpoch": 1,
            "profileDigest": "sha256:" + "a" * 64,
        },
        "network": {
            "ccnId": "ccn-test0001",
            "ccnAttachmentId": "ccn-test0001#VPC#ap-beijing#vpc-test0001",
            "vpcId": "vpc-test0001",
            "vpcCidr": "10.3.0.0/16",
            "nodeSecurityGroup": "sg-test0001",
            "apiSecurityGroup": "sg-test0002",
            "podCidr": "10.203.0.0/16",
            "serviceCidr": "172.23.0.0/16",
            "subnets": {
                "z1": {"id": "subnet-test0001", "zone": "ap-beijing-5", "cidr": "10.3.1.0/24"},
                "z2": {"id": "subnet-test0002", "zone": "ap-beijing-6", "cidr": "10.3.2.0/24"},
                "z3": {"id": "subnet-test0003", "zone": "ap-beijing-7", "cidr": "10.3.3.0/24"},
            },
        },
        "management": {
            "managementId": "actor-bj-c01",
            "clusterId": "cls-management1",
            "vpcId": "vpc-management1",
            "vpcCidr": "10.160.0.0/16",
        },
        "kubernetes": {
            "clusterId": "cls-test0001",
            "clusterName": "actor-bj-k02",
            "clusterVersion": "1.30.0",
            "privateEndpoint": "https://10.3.0.10",
            "bootstrapInstanceId": "ins-test0001",
            "operatorKeyId": "skey-test0001",
            "statelessNodePoolId": "np-test0001",
        },
        "registry": {
            "id": "tcr-test0001",
            "host": "example.tencentcloudcr.com",
            "namespace": "actor-fleet",
            "accessIp": "10.3.0.11",
        },
        "storage": {
            "cold": "cold-bucket",
            "backup": "backup-bucket",
            "code": "code-bucket",
            "relay": "relay-bucket",
            "evidence": "evidence-bucket",
        },
        "identity": {
            "runtimeScaleDownRole": "runtime-role",
            "releaseHookRole": "release-role",
            "coldStorageUser": "actor-bj-k02-cold-storage",
            "backupStorageUser": "actor-bj-k02-backup-storage",
        },
    }


def cell_spec():
    return {
        "schemaVersion": 1,
        "cellId": "actor-bj-k02",
        "className": "rivet-fdb-cos-kubernetes-v1",
        "poolName": "actor-beijing-kubernetes",
        "profileDigest": "sha256:" + "a" * 64,
        "machinePools": {
            "control": {"instanceTypes": ["C1"], "replicas": 3, "minReplicas": 3, "maxReplicas": 3},
            "fdb": {"instanceTypes": ["F1"], "replicas": 9, "minReplicas": 9, "maxReplicas": 30},
            "runtime": {
                "instanceTypes": ["R1"],
                "replicas": 3,
                "minReplicas": 3,
                "maxReplicas": 301,
                "repairSurge": 1,
            },
            "stateless": {
                "instanceTypes": ["R1"],
                "replicas": 3,
                "minReplicas": 3,
                "maxReplicas": 300,
            },
        },
    }


class CellRegistrationTests(unittest.TestCase):
    def render_handoff(self, directory: Path):
        inv = CELL.validate_inventory(inventory())
        spec = CELL.validate_spec(cell_spec(), inv)
        root = directory / "desired"
        CELL.write_new_tree(
            root,
            CELL.render(inv, spec, FIXTURE.local_image_inventory("example.tencentcloudcr.com")),
        )
        supplied = directory / "inventory.json"
        supplied.write_text(json.dumps(inv))
        return inv, supplied, root / "handoff-receipt.json", root

    def test_handoff_verifier_accepts_exact_rendering(self):
        with tempfile.TemporaryDirectory() as value:
            inv, supplied, receipt, desired = self.render_handoff(Path(value))
            result = HANDOFF.verify(supplied, receipt, desired)
            self.assertEqual(result["cellId"], inv["cellId"])
            self.assertEqual(result["fleetBinding"], inv["fleet"])
            self.assertEqual(
                result["imageInventoryDigest"],
                FIXTURE.local_image_inventory("example.tencentcloudcr.com")["inventoryDigest"],
            )
            self.assertEqual(
                set(result["machineSets"]),
                {"np-control0", "np-fdbpool0", "np-runtime0"},
            )

    def test_handoff_verifier_rejects_changed_payload(self):
        with tempfile.TemporaryDirectory() as value:
            _, supplied, receipt, desired = self.render_handoff(Path(value))
            (desired / "cell.json").write_text("{}\n")
            with self.assertRaisesRegex(ValueError, "missing or changed"):
                HANDOFF.verify(supplied, receipt, desired)

    def test_renderer_rejects_inventory_without_management_binding(self):
        candidate = inventory()
        del candidate["management"]
        with self.assertRaisesRegex(ValueError, "missing=management"):
            CELL.validate_inventory(candidate)

    def test_management_render_is_fail_closed(self):
        documents = RENDER.resources(
            "ssh://git@example.invalid/fleet.git", "cells", "sha256:" + "1" * 64,
            "sha256:" + "2" * 64, "cluster-uid",
        )
        project, runtime_project, appset = documents
        self.assertEqual(project["spec"]["clusterResourceWhitelist"], [
            {"group": "node.tke.cloud.tencent.com", "kind": "MachineSet"}
        ])
        self.assertEqual(project["spec"]["destinations"], [
            {"server": "*", "namespace": "actor-fdb-cell-system"},
        ])
        self.assertEqual(project["spec"]["namespaceResourceWhitelist"], [
            {"group": "fleet.actor.dev", "kind": "RivetCell"},
        ])
        self.assertEqual(runtime_project["metadata"]["name"], "actor-cell-runtime")
        self.assertEqual(runtime_project["spec"]["clusterResourceWhitelist"], [])
        self.assertEqual(runtime_project["spec"]["destinations"], [
            {"server": "*", "namespace": "actor-stateless-system"},
        ])
        self.assertEqual(runtime_project["spec"]["namespaceResourceWhitelist"], [
            {"group": "", "kind": "ServiceAccount"},
            {"group": "", "kind": "Service"},
            {"group": "apps", "kind": "Deployment"},
            {"group": "policy", "kind": "PodDisruptionBudget"},
            {"group": "autoscaling", "kind": "HorizontalPodAutoscaler"},
            {"group": "cloud.tencent.com", "kind": "TkeServiceConfig"},
        ])
        template = appset["spec"]["template"]["spec"]
        self.assertEqual(
            appset["spec"]["generators"][0]["clusters"]["selector"]["matchLabels"],
            {
                "fleet.actor.dev/managed-cell": "true",
                "fleet.actor.dev/desired-state": "published",
                "fleet.actor.dev/registration-scope": "production",
            },
        )
        self.assertTrue(appset["spec"]["syncPolicy"]["preserveResourcesOnDeletion"])
        self.assertFalse(template["syncPolicy"]["automated"]["prune"])
        self.assertIn("ServerSideApply=false", template["syncPolicy"]["syncOptions"])
        self.assertNotIn("ServerSideApply=true", template["syncPolicy"]["syncOptions"])
        machine_ignore = template["ignoreDifferences"][0]
        self.assertEqual(machine_ignore["group"], "node.tke.cloud.tencent.com")
        self.assertIn("/spec/machineUpdateStrategy", machine_ignore["jsonPointers"])
        self.assertIn(
            "/spec/template/spec/providerSpec/value/systemDisk/DiskPartition",
            machine_ignore["jsonPointers"],
        )
        self.assertEqual(
            machine_ignore["jqPathExpressions"],
            [".spec.template.spec.taints | select(. == [])"],
        )
        self.assertIn(
            {"group": "node.tke.cloud.tencent.com", "kind": "MachineSet",
             "name": "np-fdbpool0", "jsonPointers": ["/spec/scaling/minReplicas"]},
            template["ignoreDifferences"],
        )
        self.assertEqual(template["source"]["targetRevision"],
                         '{{index .metadata.annotations "fleet.actor.dev/git-revision"}}')
        self.assertEqual(
            appset["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/image-inventory-digest"],
            '{{index .metadata.annotations "fleet.actor.dev/image-inventory-digest"}}',
        )
        self.assertEqual(
            appset["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/profile-digest"],
            '{{index .metadata.annotations "fleet.actor.dev/profile-digest"}}',
        )
        self.assertEqual(
            appset["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/publication-receipt-digest"],
            '{{index .metadata.annotations "fleet.actor.dev/publication-receipt-digest"}}',
        )
        self.assertEqual(
            appset["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/platform-receipt-digest"],
            '{{index .metadata.annotations "fleet.actor.dev/platform-receipt-digest"}}',
        )
        self.assertIn({"group": "fleet.actor.dev", "kind": "RivetCell", "jsonPointers": ["/spec/desiredState", "/status"]},
                      template["ignoreDifferences"])
        for document in documents:
            self.assertEqual(
                document["metadata"]["annotations"]["fleet.actor.dev/management-cluster-uid"],
                "cluster-uid",
            )

    def test_management_cli_emits_a_real_yaml_document_stream(self):
        with tempfile.TemporaryDirectory() as value:
            output = Path(value) / "management.yaml"
            self.assertEqual(RENDER.main.__module__, "render_management")
            documents = RENDER.resources(
                "git://repo.example.invalid/fleet.git", "cells", "sha256:" + "1" * 64,
                "sha256:" + "2" * 64, "cluster-uid",
            )
            output.write_text(yaml.safe_dump_all(documents, explicit_start=True, sort_keys=True))
            parsed = list(yaml.safe_load_all(output.read_text()))
            self.assertEqual(
                [item["kind"] for item in parsed],
                ["AppProject", "AppProject", "ApplicationSet"],
            )
            self.assertTrue(output.read_text().startswith("---\n"))

    def test_management_render_rejects_embedded_password(self):
        with self.assertRaisesRegex(ValueError, "password"):
            RENDER.validate_repo_url("https://user:secret@example.invalid/fleet.git")

    def test_management_render_accepts_only_cluster_local_plain_http(self):
        self.assertEqual(
            RENDER.validate_repo_url(
                "http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git"
            ),
            "http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git",
        )
        with self.assertRaisesRegex(ValueError, "cluster-local HTTP"):
            RENDER.validate_repo_url("http://git.example.invalid/fleet.git")

    def test_spoke_rbac_has_no_delete_or_secret_read(self):
        documents = list(yaml.safe_load_all((ROOT / "spoke-rbac.yaml").read_text()))
        rules = [rule for document in documents for rule in document.get("rules", [])]
        self.assertTrue(rules)
        self.assertNotIn("delete", {verb for rule in rules for verb in rule["verbs"]})
        self.assertNotIn("secrets", {resource for rule in rules for resource in rule["resources"]})
        roles = {document["metadata"]["namespace"]: document for document in documents if document["kind"] == "Role"}
        self.assertEqual(set(roles), {"actor-fdb-cell-system", "actor-stateless-system"})
        fdb_resources = {resource for rule in roles["actor-fdb-cell-system"]["rules"] for resource in rule["resources"]}
        stateless_resources = {resource for rule in roles["actor-stateless-system"]["rules"] for resource in rule["resources"]}
        self.assertEqual(fdb_resources, {"rivetcells"})
        self.assertIn("deployments", stateless_resources)
        self.assertIn("rivetcells", stateless_resources)
        stateless_rivetcell_rule = next(
            rule for rule in roles["actor-stateless-system"]["rules"]
            if "rivetcells" in rule["resources"]
        )
        self.assertEqual(set(stateless_rivetcell_rule["verbs"]), {"get", "list", "watch"})

    def test_registration_crd_fences_identity_but_allows_evidence_rotation(self):
        documents = list(yaml.safe_load_all((ROOT.parents[1] / "crds.yaml").read_text()))
        registration = next(
            item for item in documents
            if item.get("kind") == "CustomResourceDefinition"
            and item["metadata"]["name"] == "rivetcellregistrations.fleet.actor.dev"
        )
        rules = registration["spec"]["versions"][0]["schema"]["openAPIV3Schema"]["properties"]["spec"]["x-kubernetes-validations"]
        self.assertEqual(len(rules), 1)
        rule = rules[0]["rule"]
        for field in (
            "provider", "claimRef", "poolRef", "spokeClusterRef", "spokeCellRef",
            "credentialSecretRef", "datacenterName",
        ):
            self.assertIn(f"self.{field} == oldSelf.{field}", rule)
        self.assertNotIn("self.evidence == oldSelf.evidence", rule)
        self.assertNotIn("self.registeredAt == oldSelf.registeredAt", rule)

    def test_registration_derives_revision_from_publication(self):
        script = (ROOT / "register-cell.sh").read_text()
        self.assertNotIn(": \"${CELL_GIT_REVISION", script)
        self.assertIn("git_revision=$(jq -er '.gitRevision'", script)
        self.assertIn('--publication-receipt "$CELL_PUBLICATION_RECEIPT"', script)
        self.assertIn(': "${CELL_PLATFORM_RECEIPT:', script)
        self.assertIn('--platform-receipt "$CELL_PLATFORM_RECEIPT"', script)
        self.assertLess(script.index('verify-platform.py'), script.index('create namespace actor-fdb-cell-system'))
        self.assertIn('ACTOR_ARGOCD_REGISTRATION_SCOPE=${ACTOR_ARGOCD_REGISTRATION_SCOPE:-production}', script)
        self.assertIn('ACTOR_ARGOCD_UPDATE_REGISTRATION=${ACTOR_ARGOCD_UPDATE_REGISTRATION:-false}', script)
        self.assertIn('ACTOR_ARGOCD_EXPECTED_REVISION', script)
        self.assertIn('existing Argo registration revision differs from the reviewed update CAS', script)
        self.assertIn('apply_args+=(--force-conflicts)', script)
        self.assertIn('namespaces:"actor-fdb-cell-system,actor-stateless-system"', script)
        self.assertIn('-n actor-fdb-cell-system auth can-i create deployments.apps) == no', script)
        self.assertIn('-n actor-stateless-system auth can-i patch deployments.apps) == yes', script)
        self.assertIn('-n actor-stateless-system auth can-i list rivetcells.fleet.actor.dev) == yes', script)
        self.assertIn('-n actor-stateless-system auth can-i patch rivetcells.fleet.actor.dev) == no', script)
        self.assertIn('-n actor-stateless-system auth can-i get secrets) == no', script)

    def test_management_desired_state_requires_live_platform_floor(self):
        script = (ROOT / "install-management.sh").read_text()
        self.assertIn('python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}', script)
        self.assertNotIn('python3 "$script_dir/', script)
        self.assertIn("ACTOR_MANAGEMENT_PLATFORM_RECEIPT", script)
        self.assertIn("ACTOR_MANAGEMENT_GIT_RECEIPT", script)
        self.assertIn("ACTOR_MANAGEMENT_DESIRED_RECEIPT", script)
        self.assertLess(
            script.index("check-management-git.sh"),
            script.index("get configmap argocd-cm"),
        )
        self.assertIn("actor-management-desired-state/v1", script)

    def test_management_publisher_is_generic_and_git_receipt_gated(self):
        script = (ROOT / "publish-management-desired-state.sh").read_text()
        self.assertIn("check-management-git.sh", script)
        self.assertIn("publish-desired-state.py", script)
        self.assertIn("ACTOR_MANAGEMENT_GIT_CREDENTIAL", script)
        self.assertNotIn("actor-bj-q01", script)
        self.assertIn("--allow-local-repository", script)

    def test_argocd_includes_only_required_cell_kinds(self):
        document = yaml.safe_load((ROOT / "resource-inclusions.yaml").read_text())
        inclusions = yaml.safe_load(document["data"]["resource.inclusions"])
        kinds = {(tuple(item["apiGroups"]), tuple(item["kinds"])) for item in inclusions}
        self.assertEqual(kinds, {
            (("node.tke.cloud.tencent.com",), ("MachineSet",)),
            (("fleet.actor.dev",), ("RivetCell",)),
            (("",), ("ServiceAccount", "Service")),
            (("apps",), ("Deployment",)),
            (("policy",), ("PodDisruptionBudget",)),
            (("autoscaling",), ("HorizontalPodAutoscaler",)),
            (("cloud.tencent.com",), ("TkeServiceConfig",)),
        })
        self.assertTrue(all(item["clusters"] == ["*"] for item in inclusions))

    def test_resource_inclusion_merge_preserves_existing_and_is_idempotent(self):
        existing = [{"apiGroups": [""], "kinds": ["ConfigMap"], "clusters": ["https://a"]}]
        required = [
            {"apiGroups": ["node.tke.cloud.tencent.com"], "kinds": ["MachineSet"], "clusters": ["*"]},
            {"apiGroups": ["fleet.actor.dev"], "kinds": ["RivetCell"], "clusters": ["*"]},
        ]
        once = MERGE.merge(existing, required)
        twice = MERGE.merge(once, required)
        self.assertEqual(once, existing + required)
        self.assertEqual(twice, once)

    def test_resource_inclusion_parser_rejects_non_list(self):
        with self.assertRaisesRegex(ValueError, "YAML list"):
            MERGE.parse_inclusions("apiGroups: []", "test")

    def test_local_appset_e2e_seeds_an_immutable_k3s_sandbox_image(self):
        e2e = (ROOT / "local-applicationset-e2e.py").read_text()
        local_mesh = ROOT.parents[3] / "local" / "mesh"
        seeder = (local_mesh / "seed-k3s-sandbox-image.sh").read_text()
        versions = (local_mesh / "versions.env").read_text()
        self.assertIn("SANDBOX_IMAGE_SEEDER", e2e)
        self.assertIn("run(str(SANDBOX_IMAGE_SEEDER), args.hub_cluster)", e2e)
        self.assertIn('docker pull "$K3S_SANDBOX_IMAGE_SOURCE"', seeder)
        self.assertIn('k3d image import "$K3S_SANDBOX_IMAGE"', seeder)
        self.assertRegex(
            versions,
            r"K3S_SANDBOX_IMAGE_SOURCE=.*@sha256:[0-9a-f]{64}",
        )


if __name__ == "__main__":
    unittest.main()
