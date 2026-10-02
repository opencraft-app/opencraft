#!/usr/bin/env python3
"""Exercise generic C-to-Cell registration against the local three-k3s mesh."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
CREATE_FIRST = ROOT.parents[1] / "terraform" / "create-first"


def load_renderer():
    spec = importlib.util.spec_from_file_location("cell_renderer_e2e", CREATE_FIRST / "render-cell-assets.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_image_contract():
    path = ROOT.parent / "image-seed" / "image_contract.py"
    spec = importlib.util.spec_from_file_location("local_registration_images", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def load_publisher():
    path = ROOT / "publish-desired-state.py"
    spec = importlib.util.spec_from_file_location("local_registration_publisher", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def local_image_inventory(registry: str = "local.tencentcloudcr.com") -> dict:
    contract = load_image_contract()
    checksum = "sha256:" + "d" * 64
    images = []
    for repository in sorted(contract.ALL_REPOSITORIES):
        provenance = {"kind": "mirror", "source": f"example.invalid/{repository}@{checksum}"}
        if repository in contract.PRODUCT_REPOSITORIES:
            provenance = {
                "kind": "build", "sourceRevision": "e" * 40,
                "sourceManifestDigest": checksum, "buildReceiptDigest": checksum,
            }
        images.append({
            "repository": repository,
            "ref": f"{registry}/actor-fleet/{repository}@{checksum}",
            "provenance": provenance,
        })
    result = {
        "schemaVersion": 1, "registry": registry, "namespace": "actor-fleet",
        "platform": "linux/amd64", "sourceLockDigest": checksum,
        "seedReceiptDigest": checksum, "images": images,
    }
    result["inventoryDigest"] = contract.digest(result)
    return result


def run(*args: str, env=None, capture=False) -> str:
    result = subprocess.run(args, check=True, env=env, text=True, capture_output=capture)
    return result.stdout if capture else ""


def kubectl(kubeconfig: Path, *args: str, capture=False) -> str:
    return run("kubectl", "--kubeconfig", str(kubeconfig), *args, capture=capture)


def kubectl_exists(kubeconfig: Path, *args: str) -> bool:
    return subprocess.run(
        ("kubectl", "--kubeconfig", str(kubeconfig), *args),
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def write_platform_fixture(path: Path, kubeconfig: Path, inventory: dict, images: dict) -> None:
    """Write explicit test-only platform evidence for local registration E2Es."""
    cluster_uid = kubectl(
        kubeconfig, "get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}", capture=True,
    )
    controller = next(item for item in images["images"] if item["repository"] == "actor-fleet-controller")
    receipt = {
        "schema": "actor-create-first-cell-platform/v1",
        "verdict": "passed",
        "testFixture": True,
        "cellId": inventory["cellId"],
        "cluster": {"id": inventory["kubernetes"]["clusterId"], "uid": cluster_uid},
        "imageInventoryDigest": images["inventoryDigest"],
        "inputs": {
            "pullCredentialReceiptSha256": "1" * 64,
            "storageCredentialReceiptSha256": "2" * 64,
            "fdbTlsReceiptSha256": "3" * 64,
            "regionalProfileReceiptSha256": "4" * 64,
        },
        "profile": {
            "name": "local-registration-profile",
            "uid": "local-profile-fixture-uid",
            "digest": inventory["fleet"]["profileDigest"],
            "className": inventory["fleet"]["className"],
            "classUid": "local-class-fixture-uid",
        },
        "workloads": {
            "fdbOperatorUid": "local-fdb-operator-fixture-uid",
            "fdbOperatorImages": [
                "local.invalid/fdb-operator@sha256:" + "5" * 64,
                "local.invalid/fdb-monitor@sha256:" + "6" * 64,
            ],
            "cellControllerUid": "local-cell-controller-fixture-uid",
            "cellControllerImage": controller["ref"],
        },
    }
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")


def local_inventory(cell_id: str, server: str) -> dict:
    return {
        "schemaVersion": 1,
        "cellId": cell_id,
        "environment": "qual",
        "region": "ap-beijing",
        "availabilityMode": "production-multi-zone",
        "fleet": {
            "poolName": "local-runtime",
            "poolUid": "local-pool-uid",
            "claimName": cell_id + "-claim",
            "claimUid": "local-claim-uid",
            "className": "local-rivet-fdb-cos-v1",
            "datacenterName": "default",
            "scaleOutEpoch": 1,
            "profileDigest": "sha256:" + "a" * 64,
        },
        "network": {
            "ccnId": "ccn-local001",
            "ccnAttachmentId": "ccn-local001#VPC#ap-beijing#vpc-local001",
            "vpcId": "vpc-local001",
            "vpcCidr": "10.3.0.0/16",
            "nodeSecurityGroup": "sg-local001",
            "apiSecurityGroup": "sg-local002",
            "podCidr": "10.203.0.0/16",
            "serviceCidr": "172.23.0.0/16",
            "subnets": {
                "z1": {"id": "subnet-local001", "zone": "local-a", "cidr": "10.3.1.0/24"},
                "z2": {"id": "subnet-local002", "zone": "local-b", "cidr": "10.3.2.0/24"},
                "z3": {"id": "subnet-local003", "zone": "local-c", "cidr": "10.3.3.0/24"},
            },
        },
        "management": {
            "managementId": "actor-bj-c01",
            "clusterId": "cls-localhub",
            "vpcId": "vpc-localhub",
            "vpcCidr": "10.160.0.0/16",
        },
        "kubernetes": {
            "clusterId": "cls-local001",
            "clusterName": cell_id,
            "clusterVersion": "1.30.0",
            "privateEndpoint": server,
            "bootstrapInstanceId": "ins-local001",
            "operatorKeyId": "skey-local001",
            "statelessNodePoolId": "np-local001",
        },
        "registry": {
            "id": "tcr-local001",
            "host": "local.tencentcloudcr.com",
            "namespace": "actor-fleet",
            "accessIp": "10.3.0.11",
        },
        "storage": {
            "cold": "local-cold-bucket",
            "backup": "local-backup-bucket",
            "code": "local-code-bucket",
            "relay": "local-relay-bucket",
            "evidence": "local-evidence-bucket",
        },
        "identity": {
            "runtimeScaleDownRole": "local-runtime-role",
            "releaseHookRole": "local-release-role",
            "coldStorageUser": f"{cell_id}-cold-storage",
            "backupStorageUser": f"{cell_id}-backup-storage",
        },
    }


def local_cell_spec(cell_id: str, inventory: dict) -> dict:
    return {
        "schemaVersion": 1,
        "cellId": cell_id,
        "className": inventory["fleet"]["className"],
        "poolName": inventory["fleet"]["poolName"],
        "profileDigest": inventory["fleet"]["profileDigest"],
        "machinePools": {
            "control": {"instanceTypes": ["LOCAL"], "replicas": 3, "minReplicas": 3, "maxReplicas": 3},
            "fdb": {"instanceTypes": ["LOCAL"], "replicas": 9, "minReplicas": 9, "maxReplicas": 30},
            "runtime": {
                "instanceTypes": ["LOCAL"],
                "replicas": 3,
                "minReplicas": 3,
                "maxReplicas": 31,
                "repairSurge": 1,
            },
            "stateless": {
                "instanceTypes": ["LOCAL"],
                "replicas": 3,
                "minReplicas": 3,
                "maxReplicas": 30,
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub-kubeconfig", required=True, type=Path)
    parser.add_argument("--cell-kubeconfig", required=True, type=Path)
    parser.add_argument("--internal-server", required=True)
    parser.add_argument(
        "--tls-server-name",
        help="TLS identity for a container-network IP (for example k3d-rivet-runtime-a-serverlb)",
    )
    parser.add_argument("--cell-id", default="actor-bj-a01")
    parser.add_argument(
        "--receipt",
        type=Path,
        default=Path("/data/actor-qualification/receipts/local-argocd-cell-registration.json"),
    )
    args = parser.parse_args()
    if not args.receipt.is_absolute() or args.receipt.exists():
        parser.error("--receipt must be a new absolute path")
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    renderer = load_renderer()
    secret_name = "actor-cell-" + args.cell_id
    role_name = "actor-argocd-cell-" + args.cell_id

    with tempfile.TemporaryDirectory(prefix="argocd-cell-registration.", dir="/data/tmp") as temporary_name:
        temporary = Path(temporary_name)
        config = yaml.safe_load(args.cell_kubeconfig.read_text())
        current = config["current-context"]
        context = next(item for item in config["contexts"] if item["name"] == current)
        cluster_name = context["context"]["cluster"]
        cluster = next(item for item in config["clusters"] if item["name"] == cluster_name)
        cluster["cluster"]["server"] = args.internal_server
        if args.tls_server_name:
            cluster["cluster"]["tls-server-name"] = args.tls_server_name
        internal_kubeconfig = temporary / "cell.kubeconfig"
        internal_kubeconfig.write_text(yaml.safe_dump(config))
        internal_kubeconfig.chmod(0o600)

        inventory = local_inventory(args.cell_id, args.internal_server)
        cell_spec = local_cell_spec(args.cell_id, inventory)
        inventory = renderer.validate_inventory(inventory)
        cell_spec = renderer.validate_spec(cell_spec, inventory)
        desired = temporary / "desired"
        images = local_image_inventory()
        renderer.write_new_tree(desired, renderer.render(inventory, cell_spec, images))
        inventory_file = temporary / "inventory.json"
        inventory_file.write_text(json.dumps(inventory, sort_keys=True))
        platform_receipt = temporary / "platform.json"
        write_platform_fixture(platform_receipt, internal_kubeconfig, inventory, images)
        seed = temporary / "seed"
        remote = temporary / "desired.git"
        run("git", "init", "--quiet", "--initial-branch=main", str(seed))
        (seed / "README.md").write_text("# local registration desired state\n")
        run("git", "-C", str(seed), "add", "README.md")
        git_env = dict(os.environ, GIT_AUTHOR_NAME="test", GIT_AUTHOR_EMAIL="test@invalid", GIT_COMMITTER_NAME="test", GIT_COMMITTER_EMAIL="test@invalid")
        run("git", "-C", str(seed), "commit", "--quiet", "-m", "seed", env=git_env)
        run("git", "clone", "--quiet", "--bare", str(seed), str(remote))
        publication_receipt = temporary / "publication.json"
        publication = load_publisher().publish(
            inventory_file,
            desired / "handoff-receipt.json",
            desired,
            remote.as_uri(),
            "main",
            publication_receipt,
            allow_local_repository=True,
        )
        machine_set_crd = "machinesets.node.tke.cloud.tencent.com"
        installed_machine_set_crd = not kubectl_exists(args.cell_kubeconfig, "get", "crd", machine_set_crd)
        if installed_machine_set_crd:
            crd_file = temporary / "local-machineset-crd.yaml"
            crd_file.write_text(
                """apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: machinesets.node.tke.cloud.tencent.com
spec:
  group: node.tke.cloud.tencent.com
  names:
    kind: MachineSet
    listKind: MachineSetList
    plural: machinesets
    singular: machineset
  scope: Cluster
  versions:
  - name: v1alpha1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
        x-kubernetes-preserve-unknown-fields: true
"""
            )
            kubectl(args.cell_kubeconfig, "apply", "-f", str(crd_file))
        env = dict(
            os.environ,
            HUB_KUBECONFIG=str(args.hub_kubeconfig),
            CELL_KUBECONFIG=str(internal_kubeconfig),
            CELL_INVENTORY=str(inventory_file),
            CELL_HANDOFF_RECEIPT=str(desired / "handoff-receipt.json"),
            CELL_PUBLICATION_RECEIPT=str(publication_receipt),
            CELL_PLATFORM_RECEIPT=str(platform_receipt),
            CELL_DESIRED_ROOT=str(desired),
            CELL_REGISTRATION_RECEIPT=str(args.receipt),
            ACTOR_ARGOCD_REGISTRATION_SCOPE="registration-e2e",
            ACTOR_CELL_PLATFORM_TEST_FIXTURE="true",
        )
        try:
            run(str(ROOT / "register-cell.sh"), env=env)
            secret = json.loads(kubectl(args.hub_kubeconfig, "-n", "argocd", "get", "secret", secret_name, "-o", "json", capture=True))
            assert secret["metadata"]["labels"]["fleet.actor.dev/desired-state"] == "published"
            receipt = json.loads(args.receipt.read_text())
            assert receipt["argoClusterSecret"]["uid"] == secret["metadata"]["uid"]
            assert receipt["permissions"] == {
                "machineSetDelete": False,
                "rivetCellDelete": False,
                "secretRead": False,
                "fdbWorkloadCreate": False,
                "statelessSecretRead": False,
                "statelessWorkloadDelete": False,
            }
        finally:
            kubectl(args.hub_kubeconfig, "-n", "argocd", "delete", "secret", secret_name, "--ignore-not-found=true")
            kubectl(args.cell_kubeconfig, "delete", "clusterrolebinding", role_name, "--ignore-not-found=true")
            kubectl(args.cell_kubeconfig, "delete", "clusterrole", role_name, "--ignore-not-found=true")
            kubectl(args.cell_kubeconfig, "-n", "actor-fdb-cell-system", "delete", "rolebinding", "actor-argocd-cell", "--ignore-not-found=true")
            kubectl(args.cell_kubeconfig, "-n", "actor-fdb-cell-system", "delete", "role", "actor-argocd-cell", "--ignore-not-found=true")
            kubectl(args.cell_kubeconfig, "-n", "actor-stateless-system", "delete", "rolebinding", "actor-argocd-stateless-runtime", "--ignore-not-found=true")
            kubectl(args.cell_kubeconfig, "-n", "actor-stateless-system", "delete", "role", "actor-argocd-stateless-runtime", "--ignore-not-found=true")
            kubectl(args.cell_kubeconfig, "-n", "actor-fdb-cell-system", "delete", "secret", "actor-argocd-cell-token", "--ignore-not-found=true")
            kubectl(args.cell_kubeconfig, "-n", "actor-fdb-cell-system", "delete", "serviceaccount", "actor-argocd-cell", "--ignore-not-found=true")
            if installed_machine_set_crd:
                kubectl(args.cell_kubeconfig, "delete", "crd", machine_set_crd, "--ignore-not-found=true")
    print(json.dumps({"cellRegistrationE2E": "passed", "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
