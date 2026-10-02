#!/usr/bin/env python3
"""Strict image-source, mirror-receipt, and complete-inventory contracts."""

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, Set


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
IMAGE = re.compile(r"^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$")
REPOSITORY = re.compile(r"^[a-z0-9][a-z0-9._-]+$")
REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")

UPSTREAM_REPOSITORIES = frozenset({
    "argocd", "argocd-dex", "argocd-haproxy", "argocd-redis",
    "fdb-kubernetes-monitor", "fdb-kubernetes-operator", "nats",
    "observability-busybox", "observability-grafana", "observability-k8s-sidecar",
    "observability-kube-state-metrics", "observability-kubectl", "observability-prometheus",
    "observability-prometheus-adapter", "observability-prometheus-config-reloader",
    "observability-prometheus-operator", "observability-webhook-certgen",
})
PRODUCT_REPOSITORIES = frozenset({
    "actor-fleet-controller", "actor-loadgen", "base-distroless", "base-golang",
    "base-tencentcloud-cli", "git-service", "release-hook", "rivet-runtime",
    "runtime-base", "worker-registry", "workers-api",
})
ALL_REPOSITORIES = UPSTREAM_REPOSITORIES | PRODUCT_REPOSITORIES


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical(value)).hexdigest()


def exact_keys(value: dict, expected: Set[str], name: str) -> None:
    if set(value) != expected:
        raise ValueError(f"{name} schema differs: expected={sorted(expected)} actual={sorted(value)}")


def load(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def validate_upstream(value: dict) -> dict:
    exact_keys(value, {"schemaVersion", "platform", "images"}, "upstream lock")
    if value["schemaVersion"] != 1 or value["platform"] != "linux/amd64":
        raise ValueError("upstream lock requires schemaVersion=1 and platform=linux/amd64")
    if not isinstance(value["images"], list):
        raise ValueError("upstream lock images must be a list")
    images = []
    components = set()  # type: Set[str]
    repositories = set()  # type: Set[str]
    for index, raw in enumerate(value["images"]):
        if not isinstance(raw, dict):
            raise ValueError(f"upstream image {index} must be an object")
        exact_keys(raw, {"component", "repository", "source"}, f"upstream image {index}")
        component, repository, source = raw["component"], raw["repository"], raw["source"]
        if not isinstance(component, str) or not REPOSITORY.fullmatch(component):
            raise ValueError(f"upstream image {index} has an invalid component")
        if not isinstance(repository, str) or not REPOSITORY.fullmatch(repository):
            raise ValueError(f"upstream image {index} has an invalid repository")
        if not isinstance(source, str) or not IMAGE.fullmatch(source):
            raise ValueError(f"upstream image {index} is not pinned by registry digest")
        if source.split("@", 1)[0].endswith(":latest"):
            raise ValueError(f"upstream image {index} uses a mutable latest alias")
        if component in components or repository in repositories:
            raise ValueError("upstream components and repositories must be unique")
        components.add(component)
        repositories.add(repository)
        images.append({"component": component, "repository": repository, "source": source})
    if repositories != UPSTREAM_REPOSITORIES:
        raise ValueError(
            f"upstream repository inventory mismatch: missing={sorted(UPSTREAM_REPOSITORIES - repositories)} "
            f"unknown={sorted(repositories - UPSTREAM_REPOSITORIES)}"
        )
    return {"schemaVersion": 1, "platform": "linux/amd64", "images": sorted(images, key=lambda item: item["repository"])}


def validate_seed(value: dict, upstream: dict) -> dict:
    exact_keys(
        value,
        {"schemaVersion", "result", "registry", "namespace", "platform", "sourceLockDigest", "images"},
        "seed receipt",
    )
    if value["schemaVersion"] != 1 or value["result"] != "passed":
        raise ValueError("seed receipt is not a passing schemaVersion=1 receipt")
    if value["platform"] != upstream["platform"] or value["namespace"] != "actor-fleet":
        raise ValueError("seed receipt platform or namespace mismatch")
    registry = value["registry"]
    if not isinstance(registry, str) or not re.fullmatch(
        r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.tencentcloudcr\.com", registry
    ):
        raise ValueError("seed receipt registry is not a Tencent TCR host")
    if value["sourceLockDigest"] != digest(upstream):
        raise ValueError("seed receipt does not bind the canonical upstream lock")
    expected = {item["repository"]: item for item in upstream["images"]}
    actual = {}  # type: Dict[str, dict]
    if not isinstance(value["images"], list):
        raise ValueError("seed receipt images must be a list")
    for index, raw in enumerate(value["images"]):
        if not isinstance(raw, dict):
            raise ValueError(f"seed image {index} must be an object")
        exact_keys(raw, {"repository", "source", "destination", "destinationDigest"}, f"seed image {index}")
        repository = raw["repository"]
        if repository not in expected or repository in actual:
            raise ValueError("seed receipt has an unknown or duplicate repository")
        if raw["source"] != expected[repository]["source"]:
            raise ValueError("seed receipt source differs from the reviewed lock")
        if not DIGEST.fullmatch(raw["destinationDigest"]):
            raise ValueError("seed destination digest is invalid")
        destination = f"{registry}/actor-fleet/{repository}@{raw['destinationDigest']}"
        if raw["destination"] != destination:
            raise ValueError("seed destination reference does not match registry digest")
        actual[repository] = dict(raw)
    if set(actual) != set(expected):
        raise ValueError("seed receipt does not cover every upstream image")
    return value


def validate_product(value: dict, registry: str, namespace: str) -> Dict[str, dict]:
    exact_keys(value, {"schemaVersion", "registry", "namespace", "images"}, "product lock")
    if value["schemaVersion"] != 1 or value["registry"] != registry or value["namespace"] != namespace:
        raise ValueError("product lock target differs from the seed target")
    actual = {}  # type: Dict[str, dict]
    if not isinstance(value["images"], list):
        raise ValueError("product lock images must be a list")
    keys = {"repository", "ref", "sourceRevision", "sourceManifestDigest", "buildReceiptDigest"}
    for index, raw in enumerate(value["images"]):
        if not isinstance(raw, dict):
            raise ValueError(f"product image {index} must be an object")
        exact_keys(raw, keys, f"product image {index}")
        repository = raw["repository"]
        if repository not in PRODUCT_REPOSITORIES or repository in actual:
            raise ValueError("product lock has an unknown or duplicate repository")
        if not IMAGE.fullmatch(raw["ref"]):
            raise ValueError("product image is not pinned by registry digest")
        prefix = f"{registry}/{namespace}/{repository}@"
        if not raw["ref"].startswith(prefix):
            raise ValueError("product image is outside its exact TCR repository")
        if not REVISION.fullmatch(raw["sourceRevision"]):
            raise ValueError("product source revision is not immutable")
        for name in ("sourceManifestDigest", "buildReceiptDigest"):
            if not DIGEST.fullmatch(raw[name]):
                raise ValueError(f"product {name} is invalid")
        actual[repository] = dict(raw)
    if set(actual) != PRODUCT_REPOSITORIES:
        raise ValueError("product lock does not cover every internally built repository")
    return actual


def assemble(upstream: dict, seed: dict, product: dict) -> dict:
    upstream = validate_upstream(upstream)
    validate_seed(seed, upstream)
    products = validate_product(product, seed["registry"], seed["namespace"])
    images = []
    for item in seed["images"]:
        images.append({
            "repository": item["repository"],
            "ref": item["destination"],
            "provenance": {"kind": "mirror", "source": item["source"]},
        })
    for repository, item in products.items():
        images.append({
            "repository": repository,
            "ref": item["ref"],
            "provenance": {
                "kind": "build",
                "sourceRevision": item["sourceRevision"],
                "sourceManifestDigest": item["sourceManifestDigest"],
                "buildReceiptDigest": item["buildReceiptDigest"],
            },
        })
    if {item["repository"] for item in images} != ALL_REPOSITORIES:
        raise ValueError("assembled inventory is incomplete")
    result = {
        "schemaVersion": 1,
        "registry": seed["registry"],
        "namespace": seed["namespace"],
        "platform": seed["platform"],
        "sourceLockDigest": seed["sourceLockDigest"],
        "seedReceiptDigest": digest(seed),
        "images": sorted(images, key=lambda item: item["repository"]),
    }
    result["inventoryDigest"] = digest(result)
    return validate_inventory(result)


def validate_inventory(value: dict) -> dict:
    """Validate a standalone final inventory and its self-authenticating digest."""
    exact_keys(
        value,
        {
            "schemaVersion", "registry", "namespace", "platform", "sourceLockDigest",
            "seedReceiptDigest", "images", "inventoryDigest",
        },
        "image inventory",
    )
    if value["schemaVersion"] != 1 or value["namespace"] != "actor-fleet":
        raise ValueError("image inventory requires schemaVersion=1 and namespace=actor-fleet")
    if value["platform"] != "linux/amd64":
        raise ValueError("image inventory platform must be linux/amd64")
    registry = value["registry"]
    if not isinstance(registry, str) or not re.fullmatch(
        r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.tencentcloudcr\.com", registry
    ):
        raise ValueError("image inventory registry is not a Tencent TCR host")
    for name in ("sourceLockDigest", "seedReceiptDigest", "inventoryDigest"):
        if not isinstance(value[name], str) or not DIGEST.fullmatch(value[name]):
            raise ValueError(f"image inventory {name} is invalid")
    unsigned = dict(value)
    actual_digest = unsigned.pop("inventoryDigest")
    if digest(unsigned) != actual_digest:
        raise ValueError("image inventory digest mismatch")
    if not isinstance(value["images"], list):
        raise ValueError("image inventory images must be a list")
    repositories = set()  # type: Set[str]
    for index, raw in enumerate(value["images"]):
        if not isinstance(raw, dict):
            raise ValueError(f"image inventory item {index} must be an object")
        exact_keys(raw, {"repository", "ref", "provenance"}, f"image inventory item {index}")
        repository = raw["repository"]
        if repository not in ALL_REPOSITORIES or repository in repositories:
            raise ValueError("image inventory has an unknown or duplicate repository")
        expected_prefix = f"{registry}/actor-fleet/{repository}@"
        if not isinstance(raw["ref"], str) or not IMAGE.fullmatch(raw["ref"]):
            raise ValueError("image inventory reference is not digest pinned")
        if not raw["ref"].startswith(expected_prefix):
            raise ValueError("image inventory reference is outside its exact TCR repository")
        provenance = raw["provenance"]
        if not isinstance(provenance, dict):
            raise ValueError("image inventory provenance must be an object")
        if repository in UPSTREAM_REPOSITORIES:
            exact_keys(provenance, {"kind", "source"}, "mirror provenance")
            if provenance["kind"] != "mirror" or not isinstance(provenance["source"], str):
                raise ValueError("upstream image inventory provenance is invalid")
            if not IMAGE.fullmatch(provenance["source"]):
                raise ValueError("upstream image inventory source is not digest pinned")
        else:
            exact_keys(
                provenance,
                {"kind", "sourceRevision", "sourceManifestDigest", "buildReceiptDigest"},
                "build provenance",
            )
            if provenance["kind"] != "build" or not REVISION.fullmatch(provenance["sourceRevision"]):
                raise ValueError("product image inventory provenance is invalid")
            for name in ("sourceManifestDigest", "buildReceiptDigest"):
                if not DIGEST.fullmatch(provenance[name]):
                    raise ValueError(f"product image inventory {name} is invalid")
        repositories.add(repository)
    if repositories != ALL_REPOSITORIES:
        raise ValueError("image inventory does not cover every required repository")
    if [item["repository"] for item in value["images"]] != sorted(repositories):
        raise ValueError("image inventory must use canonical repository order")
    return value


def resolve(value: dict, repository: str) -> dict:
    """Return one exact entry from a validated complete inventory."""
    inventory = validate_inventory(value)
    if repository not in ALL_REPOSITORIES:
        raise ValueError(f"unknown image repository: {repository}")
    for item in inventory["images"]:
        if item["repository"] == repository:
            return item
    # validate_inventory already proves completeness. Keep an explicit failure
    # here so callers never accidentally treat an absent result as an empty ref.
    raise ValueError(f"image repository is absent from inventory: {repository}")
