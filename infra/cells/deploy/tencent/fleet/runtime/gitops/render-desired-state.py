#!/usr/bin/env python3
"""Render one Cell's stateless execution plane for Argo adoption.

The first installation owns credential creation and proves the live cloud
endpoint.  This renderer turns that evidence into a credential-free desired
tree.  It never copies the stateless auth Secret, a kubeconfig, or a cloud
credential into Git.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import ipaddress
import json
import os
import re
import shutil
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
CELL = re.compile(r"^actor-[a-z0-9]+-[a-z][0-9]{2}$")


def sha(path: Path, prefix: bool = True) -> str:
    value = hashlib.sha256(path.read_bytes()).hexdigest()
    return ("sha256:" if prefix else "") + value


def load(path: Path, name: str) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"{name} must be a regular file")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{name} must contain one JSON object")
    return value


def require_receipt(value: dict[str, Any], schema: str, verdict: str, name: str) -> None:
    if (value.get("schema"), value.get("verdict")) != (schema, verdict):
        raise ValueError(f"{name} did not pass")


def image_contract():
    path = ROOT.parent / "gitops" / "image-seed" / "image_contract.py"
    spec = importlib.util.spec_from_file_location("stateless_gitops_image_contract", path)
    if spec is None or spec.loader is None:
        raise ValueError("image inventory validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def image_ref(inventory: dict[str, Any], repository: str) -> str:
    return image_contract().resolve(inventory, repository)["ref"]


def render_executor(
    source: Path,
    cell: str,
    runtime_image: str,
    runtime_digest: str,
    machine_set: str,
    registry_url: str,
    object_router_address: str,
) -> bytes:
    if not source.is_file() or source.is_symlink():
        raise ValueError("stateless executor source must be a regular file")
    replacements = {
        "__CELL_NAME__": cell,
        "__RUNTIME_IMAGE__": runtime_image,
        "__RUNTIME_DIGEST__": runtime_digest,
        "__STATELESS_MACHINE_SET__": machine_set,
        "__WORKER_REGISTRY_URL__": registry_url,
        "__OBJECT_ROUTER_ADDRESS__": object_router_address,
    }
    text = source.read_text()
    for old, new in replacements.items():
        text = text.replace(old, new)
    unresolved = sorted(set(re.findall(r"__[A-Z0-9_]+__", text)))
    if unresolved:
        raise ValueError("executor manifest has unresolved placeholders: " + ",".join(unresolved))
    documents = [item for item in yaml.safe_load_all(text) if item]
    if any(item.get("kind") == "Secret" for item in documents):
        raise ValueError("stateless Git desired state must not contain Secrets")
    identities = {(item.get("kind"), item.get("metadata", {}).get("name")) for item in documents}
    expected = {
        ("ServiceAccount", f"{cell}-stateless-executor"),
        ("Service", f"{cell}-stateless-executor"),
        ("PodDisruptionBudget", f"{cell}-stateless-executor"),
        ("Deployment", f"{cell}-stateless-executor"),
        ("HorizontalPodAutoscaler", f"{cell}-stateless-executor"),
    }
    if identities != expected:
        raise ValueError("stateless executor manifest resource inventory differs")
    return text.encode()


def private_endpoint(cell: str, endpoint: dict[str, Any]) -> bytes:
    network = endpoint.get("network", {})
    service = endpoint.get("service", {})
    service_config = endpoint.get("serviceConfig", {})
    parsed_endpoint = urllib.parse.urlsplit(str(endpoint.get("endpoint", "")))
    try:
        endpoint_address = ipaddress.ip_address(parsed_endpoint.hostname or "")
    except ValueError as error:
        raise ValueError("stateless endpoint must use a private IP address") from error
    if (
        parsed_endpoint.scheme != "http" or parsed_endpoint.port != 19084
        or parsed_endpoint.path not in {"", "/"} or parsed_endpoint.query or parsed_endpoint.fragment
        or not endpoint_address.is_private
    ):
        raise ValueError("stateless endpoint must be a private HTTP origin on port 19084")
    subnet = network.get("subnetId")
    security_group = network.get("securityGroupId")
    cidrs = network.get("hubSourceCidrs")
    if not isinstance(subnet, str) or not re.fullmatch(r"subnet-[A-Za-z0-9]+", subnet):
        raise ValueError("stateless endpoint subnet identity is invalid")
    if not isinstance(security_group, str) or not re.fullmatch(r"sg-[A-Za-z0-9]+", security_group):
        raise ValueError("stateless endpoint security-group identity is invalid")
    if not re.fullmatch(r"lb-[A-Za-z0-9]+", str(network.get("loadBalancerId", ""))):
        raise ValueError("stateless endpoint load-balancer identity is invalid")
    if not isinstance(cidrs, list) or not cidrs:
        raise ValueError("stateless endpoint source ranges are absent")
    normalized = []
    for raw in cidrs:
        network_value = ipaddress.ip_network(raw, strict=False)
        if network_value.version != 4 or not network_value.is_private:
            raise ValueError("stateless endpoint source range is not private IPv4")
        normalized.append(str(network_value))
    if normalized != sorted(set(normalized)):
        raise ValueError("stateless endpoint source ranges are not canonical")
    if (
        service.get("name") != f"{cell}-stateless-executor-private"
        or service.get("namespace") != "actor-stateless-system"
        or service.get("listenerPort") != 19084
        or service.get("targetPort") != "executor"
        or service.get("externalTrafficPolicy") != "Local"
        or service.get("scheduler") != "LEAST_CONN"
        or service.get("readyEndpointCount") != 3
        or not service.get("uid")
        or service_config.get("name") != f"{cell}-stateless-executor-private-config"
        or not service_config.get("uid")
    ):
        raise ValueError("stateless endpoint Service contract differs")
    config_name = service_config["name"]
    config = {
        "apiVersion": "cloud.tencent.com/v1alpha1",
        "kind": "TkeServiceConfig",
        "metadata": {
            "name": config_name,
            "namespace": service["namespace"],
            "labels": {
                "fleet.actor.dev/cell-name": cell,
                "fleet.actor.dev/component": "stateless-executor",
                "app.kubernetes.io/managed-by": "actor-stateless-endpoint",
            },
        },
        "spec": {"loadBalancer": {"l4Listeners": [{
            "protocol": "TCP", "port": 19084, "scheduler": "LEAST_CONN",
            "deregisterTargetRst": True,
        }]}},
    }
    value = {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {
            "name": service["name"],
            "namespace": service["namespace"],
            "labels": {
                "fleet.actor.dev/cell-name": cell,
                "fleet.actor.dev/component": "stateless-executor",
                "app.kubernetes.io/managed-by": "actor-stateless-endpoint",
                "service.cloud.tencent.com/loadbalance-type": "INTERNAL",
            },
            "annotations": {
                "argocd.argoproj.io/sync-options": "Prune=false",
                "service.kubernetes.io/qcloud-loadbalancer-internal-subnetid": subnet,
                "service.cloud.tencent.com/security-groups": security_group,
                "service.cloud.tencent.com/pass-to-target": "true",
                "service.cloud.tencent.com/tke-service-config": config_name,
                "service.cloud.tencent.com/loadbalance-retain": "true",
            },
        },
        "spec": {
            "type": "LoadBalancer",
            "externalTrafficPolicy": "Local",
            "loadBalancerSourceRanges": normalized,
            "selector": {
                "fleet.actor.dev/cell-name": cell,
                "fleet.actor.dev/component": "stateless-executor",
            },
            "ports": [{"name": "http", "port": 19084, "protocol": "TCP", "targetPort": "executor"}],
        },
    }
    return yaml.safe_dump_all([config, value], sort_keys=True).encode()


def render(
    source: Path,
    inventory_path: Path,
    image_inventory_path: Path,
    admission_path: Path,
    auth_path: Path,
    install_path: Path,
    endpoint_path: Path,
    registry_endpoint_path: Path,
    object_router_endpoint_path: Path,
) -> tuple[dict[str, bytes], dict[str, Any]]:
    inventory = load(inventory_path, "Cell inventory")
    images = image_contract().validate_inventory(load(image_inventory_path, "image inventory"))
    admission = load(admission_path, "stateless admission receipt")
    auth = load(auth_path, "stateless auth receipt")
    install = load(install_path, "stateless executor installation receipt")
    endpoint = load(endpoint_path, "stateless endpoint receipt")
    registry = load(registry_endpoint_path, "Worker Registry endpoint receipt")
    router = load(object_router_endpoint_path, "Object Router endpoint receipt")

    cell = inventory.get("cellId")
    if not isinstance(cell, str) or not CELL.fullmatch(cell):
        raise ValueError("Cell inventory identity is invalid")
    if images.get("inventoryDigest") != inventory.get("imageInventoryDigest", images.get("inventoryDigest")):
        # New Terraform inventories do not duplicate this release identity;
        # when the field exists, it must still agree exactly.
        raise ValueError("Cell and image inventory generations differ")
    require_receipt(admission, "actor-stateless-node-admission/v1", "passed", "stateless admission")
    require_receipt(auth, "actor-stateless-auth/v1", "passed", "stateless auth")
    require_receipt(install, "actor-stateless-executor-installation/v1", "passed", "stateless installation")
    require_receipt(endpoint, "actor-stateless-private-endpoint/v1", "passed", "stateless endpoint")
    require_receipt(registry, "actor-worker-registry-private-endpoint/v1", "installed", "Worker Registry endpoint")
    require_receipt(router, "actor-object-router-private-endpoint/v1", "passed", "Object Router endpoint")

    runtime_image = image_ref(images, "rivet-runtime")
    controller_image = image_ref(images, "actor-fleet-controller")
    runtime_digest = runtime_image.rsplit("@", 1)[1]
    machine_set = install.get("machineSet")
    capabilities = install.get("credential", {}).get("capabilities")
    if (
        install.get("cell") != cell
        or admission.get("cell") != cell
        or auth.get("cell", {}).get("name") != cell
        or endpoint.get("cell", {}).get("name") != cell
        or install.get("runtimeImage") != runtime_image
        or admission.get("runtimeImage") != runtime_image
        or admission.get("controllerImage") != controller_image
        or not isinstance(machine_set, str)
        or admission.get("machineSet", {}).get("name") != machine_set
        or not admission.get("machineSet", {}).get("uid")
        or capabilities != ["executor-token", "object-router-token", "workerd-token"]
    ):
        raise ValueError("stateless release identity differs across evidence")
    if install.get("nodeAdmissionReceiptSha256") != sha(admission_path):
        raise ValueError("stateless installation does not bind the admission receipt")
    if (
        install.get("credentialReceiptSha256") != sha(auth_path)
        or auth.get("credential", {}).get("uid") != install.get("credential", {}).get("uid")
        or auth.get("credential", {}).get("capabilities") != capabilities
    ):
        raise ValueError("stateless installation does not bind the auth receipt")
    if endpoint.get("deployment", {}).get("uid") != install.get("deployment", {}).get("uid"):
        raise ValueError("stateless endpoint does not bind the installed Deployment")
    if endpoint.get("service", {}).get("readyEndpointCount") != 3:
        raise ValueError("stateless endpoint does not prove three Ready backends")

    registry_url = install.get("registryUrl")
    parsed_registry = urllib.parse.urlsplit(str(registry_url))
    try:
        registry_address = ipaddress.ip_address(parsed_registry.hostname or "")
    except ValueError as error:
        raise ValueError("qualified Registry endpoint must use a private IP address") from error
    if (
        registry_url != registry.get("endpoint") or parsed_registry.scheme not in {"http", "https"}
        or parsed_registry.path not in {"", "/"} or parsed_registry.query or parsed_registry.fragment
        or not registry_address.is_private or not registry.get("service", {}).get("uid")
    ):
        raise ValueError("stateless installation does not bind the qualified Registry endpoint")
    object_router_address = install.get("objectRouterAddress")
    router_host, separator, router_port = str(object_router_address).rpartition(":")
    try:
        router_ip = ipaddress.ip_address(router_host)
    except ValueError as error:
        raise ValueError("qualified Object Router must use a private IP address") from error
    if (
        object_router_address != router.get("endpoint") or not separator or router_port != "19085"
        or not router_ip.is_private or not router.get("service", {}).get("uid")
    ):
        raise ValueError("stateless installation does not bind the qualified Object Router endpoint")

    executor = render_executor(
        source, cell, runtime_image, runtime_digest, machine_set,
        str(registry_url), str(object_router_address),
    )
    if install.get("manifestSha256") != "sha256:" + hashlib.sha256(executor).hexdigest():
        raise ValueError("installed stateless manifest differs from the reviewed source and inputs")
    endpoint_manifest = private_endpoint(cell, endpoint)
    kustomization = yaml.safe_dump({
        "apiVersion": "kustomize.config.k8s.io/v1beta1",
        "kind": "Kustomization",
        "resources": ["stateless-executor.yaml", "stateless-private-endpoint.yaml"],
    }, sort_keys=False).encode()
    evidence = {
        "schema": "actor-stateless-runtime-desired-evidence/v1",
        "cell": cell,
        "region": inventory.get("region"),
        "imageInventoryDigest": images["inventoryDigest"],
        "runtimeImage": runtime_image,
        "controllerImage": controller_image,
        "machineSet": {
            "name": machine_set,
            "uid": admission["machineSet"]["uid"],
        },
        "routing": {
            "workerRegistry": registry_url,
            "workerRegistryServiceUid": registry.get("service", {}).get("uid"),
            "objectRouter": object_router_address,
            "objectRouterServiceUid": router.get("service", {}).get("uid"),
        },
        "adoptionIdentity": {
            "deploymentUid": install["deployment"]["uid"],
            "clusterServiceUid": install["service"]["uid"],
            "privateServiceUid": endpoint["service"]["uid"],
            "privateServiceConfigUid": endpoint["serviceConfig"]["uid"],
            "credentialUid": install["credential"]["uid"],
        },
        "sourceReceipts": {
            "cellInventory": sha(inventory_path),
            "imageInventory": sha(image_inventory_path),
            "nodeAdmission": sha(admission_path),
            "statelessAuth": sha(auth_path),
            "executorInstallation": sha(install_path),
            "privateEndpoint": sha(endpoint_path),
            "workerRegistryEndpoint": sha(registry_endpoint_path),
            "objectRouterEndpoint": sha(object_router_endpoint_path),
        },
    }
    files = {
        "stateless-executor.yaml": executor,
        "stateless-private-endpoint.yaml": endpoint_manifest,
        "kustomization.yaml": kustomization,
        "evidence.json": (json.dumps(evidence, indent=2, sort_keys=True) + "\n").encode(),
    }
    receipt = {
        "schema": "actor-stateless-runtime-desired-render/v1",
        "verdict": "passed",
        "cell": cell,
        "files": {
            name: "sha256:" + hashlib.sha256(value).hexdigest()
            for name, value in sorted(files.items())
        },
        "sources": evidence,
    }
    return files, receipt


def write_new(path: Path, value: bytes) -> None:
    descriptor, staged_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    staged = Path(staged_name)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        try:
            staged.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ROOT / "stateless-executor.yaml")
    parser.add_argument("--cell-inventory", type=Path, required=True)
    parser.add_argument("--image-inventory", type=Path, required=True)
    parser.add_argument("--node-admission-receipt", type=Path, required=True)
    parser.add_argument("--stateless-auth-receipt", type=Path, required=True)
    parser.add_argument("--executor-installation-receipt", type=Path, required=True)
    parser.add_argument("--private-endpoint-receipt", type=Path, required=True)
    parser.add_argument("--worker-registry-endpoint-receipt", type=Path, required=True)
    parser.add_argument("--object-router-endpoint-receipt", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.output_dir.exists() or not args.output_dir.parent.is_dir():
            raise ValueError("output-dir must be new with an existing parent")
        if not args.receipt.is_absolute() or args.receipt.exists() or not args.receipt.parent.is_dir():
            raise ValueError("receipt must be a new absolute path with an existing parent")
        files, receipt = render(
            args.source, args.cell_inventory, args.image_inventory,
            args.node_admission_receipt, args.stateless_auth_receipt, args.executor_installation_receipt,
            args.private_endpoint_receipt, args.worker_registry_endpoint_receipt,
            args.object_router_endpoint_receipt,
        )
        staging = Path(tempfile.mkdtemp(prefix=f".{args.output_dir.name}.", dir=args.output_dir.parent))
        try:
            for name, value in files.items():
                (staging / name).write_bytes(value)
            os.rename(staging, args.output_dir)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
        write_new(args.receipt, (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(str(error), file=os.sys.stderr)
        return 2
    print(json.dumps({"verdict": "passed", "cell": receipt["cell"], "desiredState": str(args.output_dir)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
