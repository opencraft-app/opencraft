#!/usr/bin/env python3
import importlib.util
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


JOIN = load("join_admission", ROOT / "assemble-admission-receipt.py")
IMAGES = load("join_images", ROOT / "image-seed" / "image_contract.py")
PRODUCT = JOIN.load_product_contract()
DIGEST = "sha256:" + "a" * 64
RUNTIME_DIGEST = "sha256:" + "b" * 64
REGISTRY = "registry.tencentcloudcr.com"


class AdmissionReceiptTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.paths = {name: root / (name + ".json") for name in (
            "management_images", "images", "upstream_images", "image_seed", "product_lock",
            "terraform_inventory", "management_platform", "management_git", "management_desired",
            "handoff", "publication", "platform", "registration",
            "tls", "qualification_audit", "qualification_control", "initial_qualification",
            "argo", "qualification_chain", "adoption", "route", "activation", "workers_api_images", "workers_api_product", "workers_api_render",
            "workers_api_install", "placement",
        )}
        upstream = IMAGES.validate_upstream(IMAGES.load(ROOT / "image-seed" / "upstream-images.lock.json"))
        self.paths["upstream_images"].write_text(json.dumps(upstream, sort_keys=True) + "\n")
        seed = {
            "schemaVersion": 1, "result": "passed", "registry": REGISTRY,
            "namespace": "actor-fleet", "platform": "linux/amd64",
            "sourceLockDigest": IMAGES.digest(upstream),
            "images": [
                {
                    "repository": item["repository"], "source": item["source"],
                    "destination": f'{REGISTRY}/actor-fleet/{item["repository"]}@{DIGEST}',
                    "destinationDigest": DIGEST,
                }
                for item in upstream["images"]
            ],
        }
        self.paths["image_seed"].write_text(json.dumps(seed, sort_keys=True) + "\n")
        refs = {
            repository: f"{REGISTRY}/actor-fleet/{repository}@" + (
                RUNTIME_DIGEST if repository == "rivet-runtime" else DIGEST
            )
            for repository in PRODUCT.PRODUCT_REPOSITORIES
        }
        self.product_receipts = []
        product_items = []
        for repository in sorted(PRODUCT.PRODUCT_REPOSITORIES):
            receipt = PRODUCT.make_receipt(
                repository, refs[repository], "c" * 40, DIGEST,
                [
                    {"repository": dependency, "ref": refs[dependency]}
                    for dependency in PRODUCT.DEPENDENCIES[repository]
                ],
            )
            path = root / f"product-{repository}.json"
            path.write_text(json.dumps(receipt, sort_keys=True) + "\n")
            self.product_receipts.append(path)
            product_items.append({
                "repository": repository, "ref": refs[repository],
                "sourceRevision": "c" * 40, "sourceManifestDigest": DIGEST,
                "buildReceiptDigest": JOIN.file_digest(path),
            })
        product_lock = {
            "schemaVersion": 1, "registry": REGISTRY, "namespace": "actor-fleet",
            "images": product_items,
        }
        self.paths["product_lock"].write_text(json.dumps(product_lock, sort_keys=True) + "\n")
        self.inventory = IMAGES.assemble(upstream, seed, product_lock)
        self.paths["images"].write_text(json.dumps(self.inventory) + "\n")
        self.paths["management_images"].write_text(json.dumps(self.inventory) + "\n")
        self.paths["workers_api_images"].write_text(json.dumps(self.inventory) + "\n")
        fleet_binding = {
            "poolName": "pool-a", "poolUid": "pool-uid", "claimName": "claim-a",
            "claimUid": "claim-uid", "scaleOutEpoch": 1, "className": "standard",
            "profileDigest": DIGEST, "datacenterName": "dc-a",
        }
        terraform_inventory = {
            "schemaVersion": 1, "cellId": "actor-bj-k02", "fleet": fleet_binding,
            "management": {"managementId": "actor-bj-c01", "clusterId": "cls-management"},
            "kubernetes": {"clusterId": "cls-test", "privateEndpoint": "https://10.0.0.1"},
            "registry": {"host": REGISTRY, "namespace": "actor-fleet"},
        }
        self.paths["terraform_inventory"].write_text(json.dumps(terraform_inventory) + "\n")
        management_platform = {
            "schema": "actor-create-first-management-platform/v1", "verdict": "passed",
            "managementId": "actor-bj-c01",
            "cluster": {"id": "cls-management", "uid": "management-cluster-uid"},
            "imageInventoryDigest": self.inventory["inventoryDigest"],
        }
        self.paths["management_platform"].write_text(json.dumps(management_platform) + "\n")
        management_repository_url = (
            "http://actor-git.actor-git-system.svc.cluster.local:3000/"
            "release-publisher/fleet-desired.git"
        )
        management_git = {
            "schema": "actor-create-first-management-git/v1", "verdict": "passed",
            "managementId": "actor-bj-c01", "cluster": management_platform["cluster"],
            "managementPlatformReceiptDigest": JOIN.file_digest(self.paths["management_platform"]),
            "imageInventoryDigest": self.inventory["inventoryDigest"],
            "image": refs["git-service"],
            "repository": {"id": "42", "url": management_repository_url, "private": True,
                           "defaultBranch": "main", "publisherAccess": "owner", "argocdAccess": "read-only"},
        }
        self.paths["management_git"].write_text(json.dumps(management_git) + "\n")
        management_desired = {
            "schema": "actor-management-desired-state/v1", "verdict": "passed",
            "managementPlatformReceiptDigest": JOIN.file_digest(self.paths["management_platform"]),
            "managementGitReceiptDigest": JOIN.file_digest(self.paths["management_git"]),
            "managementClusterUid": "management-cluster-uid",
            "repository": {"url": management_repository_url, "pathPrefix": "cells"},
            "resources": {
                "appProject": {"name": "actor-cell-bootstrap", "uid": "project-uid"},
                "runtimeAppProject": {"name": "actor-cell-runtime", "uid": "runtime-project-uid"},
                "applicationSet": {"name": "actor-cells", "uid": "appset-uid"},
            },
        }
        self.paths["management_desired"].write_text(json.dumps(management_desired) + "\n")
        handoff = {
            "schemaVersion": 2, "cellId": "actor-bj-k02",
            "terraformInventoryDigest": IMAGES.digest(terraform_inventory),
            "fleetBinding": fleet_binding, "profileDigest": DIGEST,
            "imageInventoryDigest": self.inventory["inventoryDigest"],
            "files": {
                name: DIGEST for name in (
                    "inventory.json", "image-inventory.json", "cell.json", "kustomization.yaml",
                )
            },
        }
        self.terraform_digest = handoff["terraformInventoryDigest"]
        self.paths["handoff"].write_text(json.dumps(handoff) + "\n")
        handoff_digest = JOIN.file_digest(self.paths["handoff"])
        repository = {
            "url": management_repository_url, "branch": "main",
            "path": "cells/actor-bj-k02",
        }
        publication = {
            "schema": "actor-cell-desired-state-publication/v1", "verdict": "passed",
            "cellId": "actor-bj-k02", "terraformInventoryDigest": handoff["terraformInventoryDigest"],
            "handoffReceiptDigest": handoff_digest, "imageInventoryDigest": self.inventory["inventoryDigest"],
            "profileDigest": DIGEST, "gitRevision": "c" * 40, "repository": repository,
            "files": {**handoff["files"], "handoff-receipt.json": handoff_digest},
        }
        self.paths["publication"].write_text(json.dumps(publication) + "\n")
        controller_image = next(
            item["ref"] for item in self.inventory["images"]
            if item["repository"] == "actor-fleet-controller"
        )
        platform = {
            "schema": "actor-create-first-cell-platform/v1", "verdict": "passed",
            "cellId": "actor-bj-k02", "cluster": {"id": "cls-test", "uid": "cluster-uid"},
            "imageInventoryDigest": self.inventory["inventoryDigest"],
            "inputs": {
                "pullCredentialReceiptSha256": "1" * 64,
                "storageCredentialReceiptSha256": "2" * 64,
                "fdbTlsReceiptSha256": "3" * 64,
                "regionalProfileReceiptSha256": "4" * 64,
            },
            "profile": {"name": "profile-a", "uid": "profile-uid", "digest": DIGEST,
                        "className": "standard", "classUid": "class-uid"},
            "workloads": {"fdbOperatorUid": "fdb-uid",
                          "fdbOperatorImages": ["fdb.invalid/operator@sha256:" + "5" * 64],
                          "cellControllerUid": "controller-uid",
                          "cellControllerImage": controller_image},
        }
        self.paths["platform"].write_text(json.dumps(platform) + "\n")
        registration = {
            "schemaVersion": 3, "registrationScope": "production", "cellId": "actor-bj-k02", "clusterId": "cls-test",
            "server": "https://10.0.0.1", "terraformInventoryDigest": handoff["terraformInventoryDigest"],
            "handoffReceiptDigest": handoff_digest,
            "publicationReceiptDigest": JOIN.file_digest(self.paths["publication"]),
            "platformReceiptDigest": JOIN.file_digest(self.paths["platform"]), "platformClusterUid": "cluster-uid",
            "imageInventoryDigest": self.inventory["inventoryDigest"], "gitRevision": "c" * 40,
            "publicationRepository": repository, "caDigest": DIGEST,
            "argoClusterSecret": {"name": "actor-cell-actor-bj-k02", "uid": "secret-uid", "resourceVersion": "1"},
            "permissions": {
                "machineSetDelete": False, "rivetCellDelete": False, "secretRead": False,
                "fdbWorkloadCreate": False, "statelessSecretRead": False,
                "statelessWorkloadDelete": False,
            },
        }
        self.paths["registration"].write_text(json.dumps(registration) + "\n")
        tls = {
            "schema": "actor-fdb-tls-bootstrap/v1", "verdict": "passed",
            "cellId": "actor-bj-k02",
            "namespace": {"name": "actor-fdb-cell-system", "uid": "fdb-namespace-uid"},
            "secrets": [
                {"purpose": purpose, "name": name, "uid": "uid-" + purpose,
                 "certificateSha256": "1" * 64, "caBundleSha256": "2" * 64}
                for purpose, name in (
                    ("operator", "fdb-operator-tls"),
                    ("cell", "actor-bj-k02-fdb-tls"),
                    ("backup", "actor-bj-k02-backup-tls"),
                )
            ],
        }
        self.paths["tls"].write_text(json.dumps(tls) + "\n")
        audit = {
            "schemaVersion": "actor-fdb-autonomy-audit-v1", "verdict": "passed",
            "cell": "actor-bj-k02", "namespace": "actor-fdb-cell-system",
            "failures": [], "warnings": [], "sourceIdentity": {"revision": "c" * 40},
            "evidence": {"qualification_mode": "initial-cell",
                         "current_release_binding": {"runtime_digest": RUNTIME_DIGEST},
                         "receipts": [
                {"name": "bottomless", "passed": True, "path": "/protected/bottomless.json"},
                {"name": "engine_ha", "passed": True, "path": "/protected/engine-ha.json"},
                {"name": "dr", "passed": True, "path": "/protected/physical-restore.json"},
            ]},
        }
        self.paths["qualification_audit"].write_text(json.dumps(audit, sort_keys=True) + "\n")
        audit_sha = hashlib.sha256(self.paths["qualification_audit"].read_bytes()).hexdigest()
        control = {
            "schemaVersion": "actor-fdb-autonomy-control-v1", "control": "allow", "verdict": "passed",
            "cell": audit["cell"], "namespace": audit["namespace"],
            "failures": [], "warnings": [], "sourceIdentity": audit["sourceIdentity"],
            "source_receipt": "/protected/qualification-audit.json", "source_receipt_sha256": audit_sha,
        }
        self.paths["qualification_control"].write_text(json.dumps(control, sort_keys=True) + "\n")
        control_sha = hashlib.sha256(self.paths["qualification_control"].read_bytes()).hexdigest()
        argo = {
            "schema": "actor-cell-argo-convergence/v1", "verdict": "passed",
            "argo": {
                "project": "actor-cell-bootstrap", "registrationScope": "production",
                "applicationSet": {"name": "actor-cells", "uid": "appset-uid"},
                "clusterSecret": {"name": "actor-cell-actor-bj-k02", "uid": "secret-uid"},
                "application": {"name": "actor-cell-actor-bj-k02", "uid": "application-uid", "sync": "Synced", "health": "Healthy"},
            },
            "cell": {"id": "actor-bj-k02", "uid": "spoke-uid", "profileDigest": DIGEST},
            "fleetBinding": fleet_binding,
            "terraformInventoryDigest": handoff["terraformInventoryDigest"],
            "handoffReceiptDigest": handoff_digest,
            "publicationReceiptDigest": JOIN.file_digest(self.paths["publication"]),
            "registrationReceiptDigest": JOIN.file_digest(self.paths["registration"]),
            "platformReceiptDigest": JOIN.file_digest(self.paths["platform"]),
            "platformClusterUid": "cluster-uid",
            "gitRevision": "c" * 40,
            "imageInventoryDigest": self.inventory["inventoryDigest"],
            "publicationRepository": repository,
        }
        self.paths["argo"].write_text(json.dumps(argo) + "\n")
        initial_qualification = {
            "schema": "actor-cell-initial-qualification/v2", "verdict": "passed",
            "cell": audit["cell"], "namespace": audit["namespace"],
            "sourceIdentity": audit["sourceIdentity"], "operator_activation_required": True,
            "argo": {"receipt": "/protected/argo.json", "sha256": JOIN.file_digest(self.paths["argo"]).removeprefix("sha256:"), "cell_uid": "spoke-uid"},
            "qualification": {
                "bottomless": {"receipt": "/protected/bottomless.json", "sha256": "a" * 64},
                "engine_ha": {"receipt": "/protected/engine-ha.json", "sha256": "a" * 64},
                "audit": {"receipt": "/protected/audit.json", "sha256": JOIN.file_digest(self.paths["qualification_audit"]).removeprefix("sha256:")},
                "control": {"receipt": "/protected/control.json", "sha256": JOIN.file_digest(self.paths["qualification_control"]).removeprefix("sha256:")},
            },
        }
        self.paths["initial_qualification"].write_text(json.dumps(initial_qualification) + "\n")
        qualification_chain = JOIN.assemble(
            self.paths, self.product_receipts, qualification_only=True,
        )
        self.paths["qualification_chain"].write_text(
            json.dumps(qualification_chain, indent=2, sort_keys=True) + "\n"
        )
        route = {
            "schema": "actor-cell-route-publication/v2", "verdict": "passed",
            "convergenceReceiptDigest": JOIN.file_digest(self.paths["argo"]),
            "pool": {"name": "pool-a", "uid": "pool-uid"},
            "cell": {"name": "logical-a", "uid": "spoke-uid"}, "datacenter": "dc-a",
            "routeConfigMap": {"name": "actor-cell-route-logical-a", "uid": "route-uid", "resourceVersion": "7"},
        }
        activation = {
            "schema": "actor-cell-qualification-activation/v1", "verdict": "passed",
            "cell": "actor-bj-k02", "desired_state": "Ready", "ready_for_placement": True,
            "cell_identity": {"uid": "spoke-uid", "generation": 3, "observed_generation": 3, "profile_digest": DIGEST},
            "control_receipt_sha256": control_sha,
            "qualification": {
                "receipt_ref": "kubernetes://actor-fdb-cell-system/configmaps/evidence?sha256=" + control_sha,
                "receipt_digest": "sha256:" + control_sha,
                "release_digest": RUNTIME_DIGEST,
            },
        }
        activation["activation_plan"] = {
            "schema": "actor-cell-qualification-activation-plan/v1",
            "cell": activation["cell"],
            "control_receipt_sha256": activation["control_receipt_sha256"],
            "source_receipt_sha256": audit_sha,
            "qualification": {**activation["qualification"], "ready": True},
        }
        operation_id = "0" * 32
        first_worker = f"first-agent-{operation_id[:16]}"
        first_object_id = hashlib.sha256(f"{first_worker}\0{operation_id}".encode()).hexdigest()
        record = {
            "schema": "rivet-worker-object/v2", "state": "active", "namespace": "default",
            "worker": first_worker, "class_name": "QualificationAgent", "object_id": first_object_id, "actor_id": "actor-1",
            "placement": {"pool_name": "pool-a", "pool_uid": "pool-uid", "cell_name": "logical-a",
                          "cell_uid": "spoke-uid", "datacenter": "dc-a", "snapshot_digest": DIGEST},
        }
        placement = {
            "schema": "actor-first-placement/v1", "verdict": "passed",
            "operation_id": operation_id, "logical_actor_id": "actor-1",
            "version_id": "version-1", "deployment_id": "deployment-1",
            "cell_identity": {"name": "actor-bj-k02", "cell_id": "actor-bj-k02",
                "uid": "spoke-uid", "generation": 3, "observed_generation": 3,
                "desired_state": "Ready", "phase": "Ready", "ready_for_placement": True},
            "first_placement": {"object_id": first_object_id,
                "object_ref": {"object": "object", "id": first_object_id, "worker": first_worker, "class_name": "QualificationAgent"},
                "registry_record": record, "route_configmap_uid": "route-uid",
                "functional_probe": {"status": 200, "response_bytes": 9,
                    "response_sha256": "sha256:" + hashlib.sha256(b"qualified").hexdigest()}},
        }
        self.paths["activation"].write_text(json.dumps(activation) + "\n")
        adoption = {
            "schema": "actor-cell-claim-adoption/v2", "verdict": "passed",
            "cell": {"name": "actor-bj-k02", "uid": "spoke-uid"},
            "pool": {"name": "pool-a", "uid": "pool-uid"},
            "claim": {"name": "claim-a", "uid": "claim-uid"},
            "evidence": {
                "convergence": JOIN.file_digest(self.paths["argo"]),
                "qualification": JOIN.file_digest(self.paths["qualification_chain"]),
                "activation": JOIN.file_digest(self.paths["activation"]),
            },
        }
        self.paths["adoption"].write_text(json.dumps(adoption) + "\n")
        route.update({
            "qualificationChainReceiptDigest": JOIN.file_digest(self.paths["qualification_chain"]),
            "activationReceiptDigest": JOIN.file_digest(self.paths["activation"]),
            "adoptionReceiptDigest": JOIN.file_digest(self.paths["adoption"]),
        })
        self.paths["route"].write_text(json.dumps(route) + "\n")
        self.paths["placement"].write_text(json.dumps(placement) + "\n")
        workers_product = next(
            json.loads(path.read_text()) for path in self.product_receipts if path.name == "product-workers-api.json"
        )
        self.paths["workers_api_product"].write_text(json.dumps(workers_product, sort_keys=True) + "\n")
        public_cells = [
            {
                "cell": "logical-a", "cellUid": "spoke-uid", "datacenter": "dc-a",
                "endpoint": "http://10.0.0.2:6420", "serviceUid": "engine-service-a",
                "digest": DIGEST, "routeDigest": JOIN.file_digest(self.paths["route"]),
                "routeConfigMapUid": "route-uid",
            },
            {
                "cell": "logical-b", "cellUid": "spoke-b-uid", "datacenter": "dc-b",
                "endpoint": "http://10.0.1.2:6420", "serviceUid": "engine-service-b",
                "digest": DIGEST, "routeDigest": DIGEST, "routeConfigMapUid": "route-b-uid",
            },
        ]
        workers_render = {
            "schema": "actor-workers-api-render/v1", "verdict": "passed",
            "imageInventory": {
                "digest": self.inventory["inventoryDigest"],
                "fileSha256": JOIN.file_digest(self.paths["workers_api_images"]),
            },
            "workersApiImage": workers_product["ref"],
            "workersApiProductReceipt": {
                "path": "/protected/product-workers-api.json",
                "sha256": JOIN.file_digest(self.paths["workers_api_product"]),
            },
            "pool": route["pool"], "cells": public_cells, "manifestSha256": DIGEST,
        }
        self.paths["workers_api_render"].write_text(json.dumps(workers_render) + "\n")
        workers_install = {
            "schema": "actor-workers-api-installation/v1", "verdict": "passed",
            "renderReceipt": {
                "path": "/protected/workers-api-render.json",
                "sha256": JOIN.file_digest(self.paths["workers_api_render"]),
            },
            "topology": {"pool": route["pool"], "cells": public_cells, "workersApiImage": workers_product["ref"]},
            "deployment": {
                "deploymentUid": "workers-deployment-uid", "generation": 1,
                "podUids": ["pod-a", "pod-b", "pod-c", "pod-d", "pod-e"],
            },
            "credentialSecret": {"name": "workers-api-internal-token", "uid": "token-secret-uid", "resourceVersion": "1", "cellScopedTokens": True},
            "serviceReady": True,
        }
        self.paths["workers_api_install"].write_text(json.dumps(workers_install) + "\n")

    def tearDown(self):
        self.temporary.cleanup()

    def test_complete_chain(self):
        result = JOIN.assemble(self.paths, self.product_receipts)
        self.assertEqual(result["schema"], "actor-cell-admission-chain/v6")
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["cell"]["datacenter"], "dc-a")
        self.assertEqual(result["construction"]["terraform_inventory_digest"], self.terraform_digest)
        self.assertEqual(result["construction"]["argo_applicationset_uid"], "appset-uid")
        self.assertEqual(
            result["construction"]["management_desired_state_receipt_digest"],
            JOIN.file_digest(self.paths["management_desired"]),
        )
        self.assertEqual(result["qualification"]["control_receipt_digest"], JOIN.file_digest(self.paths["qualification_control"]))
        self.assertEqual(result["qualification"]["audit_receipt_digest"], JOIN.file_digest(self.paths["qualification_audit"]))
        self.assertEqual(
            result["qualification"]["pre_activation_chain_receipt_digest"],
            JOIN.file_digest(self.paths["qualification_chain"]),
        )
        self.assertEqual(result["management_image_inventory_digest"], self.inventory["inventoryDigest"])
        self.assertEqual(result["cell_image_inventory_digest"], self.inventory["inventoryDigest"])
        self.assertEqual(result["workers_api_image_inventory_digest"], self.inventory["inventoryDigest"])
        self.assertEqual(
            set(result["source_receipts"]),
            set(self.paths) - {"upstream_images", "image_seed", "product_lock"},
        )

    def test_management_and_cell_image_generations_may_roll_independently(self):
        management_inventory = json.loads(json.dumps(self.inventory))
        controller = next(
            item for item in management_inventory["images"]
            if item["repository"] == "actor-fleet-controller"
        )
        controller["ref"] = f"{REGISTRY}/actor-fleet/actor-fleet-controller@sha256:" + "d" * 64
        controller["provenance"]["buildReceiptDigest"] = "sha256:" + "e" * 64
        unsigned = dict(management_inventory)
        unsigned.pop("inventoryDigest")
        management_inventory["inventoryDigest"] = IMAGES.digest(unsigned)
        self.paths["management_images"].write_text(json.dumps(management_inventory) + "\n")

        platform = json.loads(self.paths["management_platform"].read_text())
        platform["imageInventoryDigest"] = management_inventory["inventoryDigest"]
        self.paths["management_platform"].write_text(json.dumps(platform) + "\n")
        management_git = json.loads(self.paths["management_git"].read_text())
        management_git["imageInventoryDigest"] = management_inventory["inventoryDigest"]
        management_git["managementPlatformReceiptDigest"] = JOIN.file_digest(self.paths["management_platform"])
        self.paths["management_git"].write_text(json.dumps(management_git) + "\n")
        desired = json.loads(self.paths["management_desired"].read_text())
        desired["managementPlatformReceiptDigest"] = JOIN.file_digest(self.paths["management_platform"])
        desired["managementGitReceiptDigest"] = JOIN.file_digest(self.paths["management_git"])
        self.paths["management_desired"].write_text(json.dumps(desired) + "\n")
        qualification_chain = JOIN.assemble(
            self.paths, self.product_receipts, qualification_only=True,
        )
        self.paths["qualification_chain"].write_text(
            json.dumps(qualification_chain, indent=2, sort_keys=True) + "\n"
        )
        self.refresh_route_dependents()

        result = JOIN.assemble(self.paths, self.product_receipts)
        self.assertEqual(result["management_image_inventory_digest"], management_inventory["inventoryDigest"])
        self.assertEqual(result["cell_image_inventory_digest"], self.inventory["inventoryDigest"])

    def test_preflight_validates_human_activation_without_placement(self):
        paths = {name: path for name, path in self.paths.items() if name != "placement"}
        result = JOIN.assemble(paths, self.product_receipts, preflight_only=True)
        self.assertEqual(
            (result["schema"], result["verdict"]),
            ("actor-cell-admission-preflight/v1", "passed"),
        )
        self.assertEqual(result["cell"], {"id": "actor-bj-k02", "uid": "spoke-uid"})

        activation = json.loads(self.paths["activation"].read_text())
        activation["ready_for_placement"] = False
        self.paths["activation"].write_text(json.dumps(activation) + "\n")
        self.refresh_activation_dependents()
        with self.assertRaisesRegex(ValueError, "did not open the Cell"):
            JOIN.assemble(paths, self.product_receipts, preflight_only=True)

    def test_qualification_chain_stops_before_operator_activation(self):
        admission_only = {
            "route", "activation", "workers_api_images", "workers_api_product", "workers_api_render",
            "workers_api_install", "placement",
        }
        paths = {
            name: path for name, path in self.paths.items()
            if name not in admission_only
        }
        result = JOIN.assemble(paths, self.product_receipts, qualification_only=True)
        self.assertEqual(
            (result["schema"], result["verdict"]),
            ("actor-cell-qualification-chain/v1", "passed"),
        )
        self.assertEqual(result["cell"]["spoke_uid"], "spoke-uid")
        self.assertEqual(result["qualification"]["release_digest"], RUNTIME_DIGEST)
        self.assertFalse(result["placement_opened"])
        self.assertTrue(result["operator_activation_required"])
        self.assertNotIn("route", result["source_receipts"])
        self.assertNotIn("activation", result["source_receipts"])

    def test_qualification_entrypoint_resumes_exact_receipt(self):
        output = Path(self.temporary.name) / "qualification-chain.json"
        environment = dict(os.environ)
        environment.update({
            "PYTHON": "python3",
            "ACTOR_MANAGEMENT_IMAGE_INVENTORY": str(self.paths["management_images"]),
            "ACTOR_IMAGE_INVENTORY": str(self.paths["images"]),
            "ACTOR_TERRAFORM_INVENTORY": str(self.paths["terraform_inventory"]),
            "ACTOR_MANAGEMENT_PLATFORM_RECEIPT": str(self.paths["management_platform"]),
            "ACTOR_MANAGEMENT_GIT_RECEIPT": str(self.paths["management_git"]),
            "ACTOR_MANAGEMENT_DESIRED_RECEIPT": str(self.paths["management_desired"]),
            "ACTOR_HANDOFF_RECEIPT": str(self.paths["handoff"]),
            "ACTOR_PUBLICATION_RECEIPT": str(self.paths["publication"]),
            "ACTOR_CELL_PLATFORM_RECEIPT": str(self.paths["platform"]),
            "ACTOR_REGISTRATION_RECEIPT": str(self.paths["registration"]),
            "ACTOR_FDB_TLS_RECEIPT": str(self.paths["tls"]),
            "ACTOR_QUALIFICATION_AUDIT_RECEIPT": str(self.paths["qualification_audit"]),
            "ACTOR_QUALIFICATION_CONTROL_RECEIPT": str(self.paths["qualification_control"]),
            "ACTOR_INITIAL_QUALIFICATION_RECEIPT": str(self.paths["initial_qualification"]),
            "ACTOR_ARGO_CONVERGENCE_RECEIPT": str(self.paths["argo"]),
            "ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT": str(output),
        })
        command = [str(ROOT / "complete-cell-qualification.sh")]
        first = subprocess.run(command, env=environment, check=True, capture_output=True, text=True)
        original = output.read_bytes()
        second = subprocess.run(command, env=environment, check=True, capture_output=True, text=True)
        self.assertEqual(output.read_bytes(), original)
        self.assertIn("placement_opened=false", first.stdout)
        self.assertIn("placement_opened=false", second.stdout)

    def test_qualification_chain_rejects_runtime_outside_inventory(self):
        audit = json.loads(self.paths["qualification_audit"].read_text())
        audit["evidence"]["current_release_binding"]["runtime_digest"] = "sha256:" + "e" * 64
        self.paths["qualification_audit"].write_text(json.dumps(audit, sort_keys=True) + "\n")
        control = json.loads(self.paths["qualification_control"].read_text())
        control["source_receipt_sha256"] = hashlib.sha256(
            self.paths["qualification_audit"].read_bytes()
        ).hexdigest()
        self.paths["qualification_control"].write_text(json.dumps(control, sort_keys=True) + "\n")
        initial = json.loads(self.paths["initial_qualification"].read_text())
        initial["qualification"]["audit"]["sha256"] = JOIN.file_digest(
            self.paths["qualification_audit"]
        ).removeprefix("sha256:")
        initial["qualification"]["control"]["sha256"] = JOIN.file_digest(
            self.paths["qualification_control"]
        ).removeprefix("sha256:")
        self.paths["initial_qualification"].write_text(json.dumps(initial) + "\n")
        paths = {
            name: path for name, path in self.paths.items()
            if name not in {
                "route", "activation", "workers_api_images", "workers_api_product", "workers_api_render",
                "workers_api_install", "placement",
            }
        }
        with self.assertRaisesRegex(ValueError, "initial qualification runtime"):
            JOIN.assemble(paths, self.product_receipts, qualification_only=True)

    def test_final_chain_rejects_another_pre_activation_chain(self):
        chain = json.loads(self.paths["qualification_chain"].read_text())
        chain["placement_opened"] = True
        self.paths["qualification_chain"].write_text(json.dumps(chain) + "\n")
        with self.assertRaisesRegex(ValueError, "pre-activation qualification chain differs"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_public_api_route_or_credential_drift(self):
        original = self.paths["workers_api_render"].read_text()
        rendered = json.loads(original)
        rendered["cells"][0]["routeDigest"] = DIGEST
        self.paths["workers_api_render"].write_text(json.dumps(rendered) + "\n")
        with self.assertRaisesRegex(ValueError, "exact route receipt"):
            JOIN.assemble(self.paths, self.product_receipts)

        self.paths["workers_api_render"].write_text(original)
        installed = json.loads(self.paths["workers_api_install"].read_text())
        installed["credentialSecret"]["cellScopedTokens"] = False
        self.paths["workers_api_install"].write_text(json.dumps(installed) + "\n")
        with self.assertRaisesRegex(ValueError, "Cell-scoped credentials"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_workers_api_installation_requires_three_distinct_replicas(self):
        installed = json.loads(self.paths["workers_api_install"].read_text())
        installed["deployment"]["podUids"] = ["pod-a", "pod-b"]
        self.paths["workers_api_install"].write_text(json.dumps(installed) + "\n")
        with self.assertRaisesRegex(ValueError, "three-replica HA floor"):
            JOIN.assemble(self.paths, self.product_receipts)

        installed["deployment"]["podUids"] = ["pod-a", "pod-b", "pod-b"]
        self.paths["workers_api_install"].write_text(json.dumps(installed) + "\n")
        with self.assertRaisesRegex(ValueError, "three-replica HA floor"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_registration_cannot_bind_another_platform_receipt(self):
        registration = json.loads(self.paths["registration"].read_text())
        registration["platformReceiptDigest"] = "sha256:" + "f" * 64
        self.paths["registration"].write_text(json.dumps(registration) + "\n")
        with self.assertRaisesRegex(ValueError, "exact Cell platform receipt"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_management_desired_state_cannot_bind_another_git_receipt(self):
        desired = json.loads(self.paths["management_desired"].read_text())
        desired["managementGitReceiptDigest"] = "sha256:" + "f" * 64
        self.paths["management_desired"].write_text(json.dumps(desired) + "\n")
        with self.assertRaisesRegex(ValueError, "exact management Git receipt"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_argo_cannot_converge_from_another_applicationset(self):
        argo = json.loads(self.paths["argo"].read_text())
        argo["argo"]["applicationSet"]["uid"] = "other-appset-uid"
        self.paths["argo"].write_text(json.dumps(argo) + "\n")
        with self.assertRaisesRegex(ValueError, "management ApplicationSet UID"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_tls_for_another_cell(self):
        value = json.loads(self.paths["tls"].read_text())
        value["cellId"] = "actor-bj-k03"
        self.paths["tls"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "TLS Cell ID"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_control_without_exact_audit(self):
        value = json.loads(self.paths["qualification_audit"].read_text())
        value["sourceIdentity"] = {"revision": "d" * 40}
        self.paths["qualification_audit"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "source identity differs|exact audit receipt"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_initial_qualification_with_another_component_receipt(self):
        value = json.loads(self.paths["initial_qualification"].read_text())
        value["qualification"]["bottomless"]["receipt"] = "/protected/other.json"
        self.paths["initial_qualification"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "bottomless receipt differs"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_non_initial_or_duplicated_qualification_audit(self):
        value = json.loads(self.paths["qualification_audit"].read_text())
        value["evidence"]["qualification_mode"] = "autoscaling-cell"
        self.paths["qualification_audit"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "did not use initial-cell"):
            JOIN.assemble(self.paths, self.product_receipts)

        value["evidence"]["qualification_mode"] = "initial-cell"
        value["evidence"]["receipts"].append(dict(value["evidence"]["receipts"][0]))
        self.paths["qualification_audit"].write_text(json.dumps(value) + "\n")
        control = json.loads(self.paths["qualification_control"].read_text())
        control["source_receipt_sha256"] = hashlib.sha256(
            self.paths["qualification_audit"].read_bytes()
        ).hexdigest()
        self.paths["qualification_control"].write_text(json.dumps(control) + "\n")
        initial = json.loads(self.paths["initial_qualification"].read_text())
        initial["qualification"]["audit"]["sha256"] = JOIN.file_digest(
            self.paths["qualification_audit"]
        ).removeprefix("sha256:")
        initial["qualification"]["control"]["sha256"] = JOIN.file_digest(
            self.paths["qualification_control"]
        ).removeprefix("sha256:")
        self.paths["initial_qualification"].write_text(json.dumps(initial) + "\n")
        with self.assertRaisesRegex(ValueError, "duplicated or malformed"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_activation_without_exact_control(self):
        value = json.loads(self.paths["qualification_control"].read_text())
        value["policy_version"] = "tampered"
        self.paths["qualification_control"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "exact control"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_symlinked_evidence(self):
        original = self.paths["qualification_control"]
        target = original.with_name("qualification-control-target.json")
        original.rename(target)
        original.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "regular file"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_placement_cell_drift(self):
        value = json.loads(self.paths["placement"].read_text())
        value["first_placement"]["registry_record"]["placement"]["cell_uid"] = "replacement"
        self.paths["placement"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "Cell UID"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_runtime_outside_inventory(self):
        value = json.loads(self.paths["activation"].read_text())
        value["qualification"]["release_digest"] = "sha256:" + "e" * 64
        value["activation_plan"]["qualification"] = {**value["qualification"], "ready": True}
        self.paths["activation"].write_text(json.dumps(value) + "\n")
        self.refresh_activation_dependents()
        with self.assertRaisesRegex(ValueError, "image inventory"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_another_handoff_image_inventory(self):
        value = json.loads(self.paths["argo"].read_text())
        value["imageInventoryDigest"] = "sha256:" + "f" * 64
        self.paths["argo"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "exact Argo convergence"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_activation_with_another_control_receipt(self):
        value = json.loads(self.paths["activation"].read_text())
        value["qualification"]["receipt_digest"] = "sha256:" + "f" * 64
        value["activation_plan"]["qualification"] = {**value["qualification"], "ready": True}
        self.paths["activation"].write_text(json.dumps(value) + "\n")
        self.refresh_activation_dependents()
        with self.assertRaisesRegex(ValueError, "exact control receipt"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_activation_plan_drift(self):
        value = json.loads(self.paths["activation"].read_text())
        value["activation_plan"]["control_receipt_sha256"] = "f" * 64
        self.paths["activation"].write_text(json.dumps(value) + "\n")
        self.refresh_activation_dependents()
        with self.assertRaisesRegex(ValueError, "another control receipt"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_activation_plan_that_did_not_admit_qualification(self):
        value = json.loads(self.paths["activation"].read_text())
        value["activation_plan"]["qualification"]["ready"] = False
        self.paths["activation"].write_text(json.dumps(value) + "\n")
        self.refresh_activation_dependents()
        with self.assertRaisesRegex(ValueError, "published activation"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_public_api_product_without_pull_verification(self):
        path = self.paths["workers_api_product"]
        value = json.loads(path.read_text())
        value["registryPullVerified"] = False
        path.write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "pull verification"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_registration_not_bound_to_publication(self):
        value = json.loads(self.paths["registration"].read_text())
        value["publicationReceiptDigest"] = DIGEST
        self.paths["registration"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "exact publication receipt"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_non_production_registration_chain(self):
        value = json.loads(self.paths["registration"].read_text())
        value["registrationScope"] = "applicationset-e2e"
        self.paths["registration"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "not production-scoped"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_non_production_convergence_chain(self):
        value = json.loads(self.paths["argo"].read_text())
        value["argo"]["registrationScope"] = "applicationset-e2e"
        self.paths["argo"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "not production-scoped"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_terraform_inventory_not_bound_to_handoff(self):
        value = json.loads(self.paths["terraform_inventory"].read_text())
        value["kubernetes"]["clusterId"] = "cls-replacement"
        self.paths["terraform_inventory"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "exact Terraform inventory"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_registration_for_another_cluster_or_endpoint(self):
        value = json.loads(self.paths["registration"].read_text())
        value["clusterId"] = "cls-replacement"
        self.paths["registration"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "cluster ID differs"):
            JOIN.assemble(self.paths, self.product_receipts)

        self.refresh_registration_and_argo_dependents(value, cluster_id="cls-test")
        value = json.loads(self.paths["registration"].read_text())
        value["server"] = "https://10.0.0.2"
        self.paths["registration"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "endpoint differs"):
            JOIN.assemble(self.paths, self.product_receipts)

    def refresh_registration_and_argo_dependents(self, value, cluster_id):
        value["clusterId"] = cluster_id
        self.paths["registration"].write_text(json.dumps(value) + "\n")
        argo = json.loads(self.paths["argo"].read_text())
        argo["registrationReceiptDigest"] = JOIN.file_digest(self.paths["registration"])
        self.paths["argo"].write_text(json.dumps(argo) + "\n")
        initial = json.loads(self.paths["initial_qualification"].read_text())
        initial["argo"]["sha256"] = JOIN.file_digest(self.paths["argo"]).removeprefix("sha256:")
        self.paths["initial_qualification"].write_text(json.dumps(initial) + "\n")
        route = json.loads(self.paths["route"].read_text())
        route["convergenceReceiptDigest"] = JOIN.file_digest(self.paths["argo"])
        self.paths["route"].write_text(json.dumps(route) + "\n")

    def refresh_route_dependents(self):
        adoption = json.loads(self.paths["adoption"].read_text())
        adoption["evidence"]["qualification"] = JOIN.file_digest(self.paths["qualification_chain"])
        self.paths["adoption"].write_text(json.dumps(adoption) + "\n")
        route = json.loads(self.paths["route"].read_text())
        route["qualificationChainReceiptDigest"] = JOIN.file_digest(self.paths["qualification_chain"])
        route["adoptionReceiptDigest"] = JOIN.file_digest(self.paths["adoption"])
        self.paths["route"].write_text(json.dumps(route) + "\n")
        rendered = json.loads(self.paths["workers_api_render"].read_text())
        matching = next(item for item in rendered["cells"] if item["cell"] == route["cell"]["name"])
        matching["routeDigest"] = JOIN.file_digest(self.paths["route"])
        self.paths["workers_api_render"].write_text(json.dumps(rendered) + "\n")
        installed = json.loads(self.paths["workers_api_install"].read_text())
        installed["renderReceipt"]["sha256"] = JOIN.file_digest(self.paths["workers_api_render"])
        installed["topology"]["cells"] = rendered["cells"]
        self.paths["workers_api_install"].write_text(json.dumps(installed) + "\n")

    def refresh_activation_dependents(self):
        adoption = json.loads(self.paths["adoption"].read_text())
        adoption["evidence"]["activation"] = JOIN.file_digest(self.paths["activation"])
        self.paths["adoption"].write_text(json.dumps(adoption) + "\n")
        route = json.loads(self.paths["route"].read_text())
        route["activationReceiptDigest"] = JOIN.file_digest(self.paths["activation"])
        route["adoptionReceiptDigest"] = JOIN.file_digest(self.paths["adoption"])
        self.paths["route"].write_text(json.dumps(route) + "\n")
        self.refresh_route_dependents()

    def test_rejects_argo_convergence_for_replaced_cluster_secret(self):
        value = json.loads(self.paths["argo"].read_text())
        value["argo"]["clusterSecret"]["uid"] = "replacement"
        self.paths["argo"].write_text(json.dumps(value) + "\n")
        initial = json.loads(self.paths["initial_qualification"].read_text())
        initial["argo"]["sha256"] = JOIN.file_digest(self.paths["argo"]).removeprefix("sha256:")
        self.paths["initial_qualification"].write_text(json.dumps(initial) + "\n")
        route = json.loads(self.paths["route"].read_text())
        route["convergenceReceiptDigest"] = JOIN.file_digest(self.paths["argo"])
        self.paths["route"].write_text(json.dumps(route) + "\n")
        with self.assertRaisesRegex(ValueError, "another cluster Secret"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_invalid_first_placement_operation(self):
        value = json.loads(self.paths["placement"].read_text())
        value["operation_id"] = "not-an-operation"
        self.paths["placement"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "operation ID"):
            JOIN.assemble(self.paths, self.product_receipts)

    def test_rejects_first_placement_after_cell_closed(self):
        value = json.loads(self.paths["placement"].read_text())
        value["cell_identity"]["ready_for_placement"] = False
        self.paths["placement"].write_text(json.dumps(value) + "\n")
        with self.assertRaisesRegex(ValueError, "was not admitted"):
            JOIN.assemble(self.paths, self.product_receipts)


if __name__ == "__main__":
    unittest.main()
