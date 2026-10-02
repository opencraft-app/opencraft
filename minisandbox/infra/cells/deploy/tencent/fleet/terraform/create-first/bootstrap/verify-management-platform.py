#!/usr/bin/env python3
"""Verify management-platform receipt identity and optional live Argo resources."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DIGEST = re.compile(r"^[0-9a-f]{64}$")
EXPECTED_CRDS = {
    "applications.argoproj.io", "applicationsets.argoproj.io", "appprojects.argoproj.io",
}
EXPECTED_WORKLOADS = {
    ("Deployment", "argocd-applicationset-controller"),
    ("Deployment", "argocd-dex-server"),
    ("Deployment", "argocd-notifications-controller"),
    ("Deployment", "argocd-redis-ha-haproxy"),
    ("Deployment", "argocd-repo-server"),
    ("Deployment", "argocd-server"),
    ("StatefulSet", "argocd-application-controller"),
    ("StatefulSet", "argocd-redis-ha-server"),
}


def live_contract():
    path = ROOT / "verify-management-platform-live.py"
    spec = importlib.util.spec_from_file_location("management_platform_live_contract", path)
    if spec is None or spec.loader is None:
        raise ValueError("management platform live validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def file_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def validate_receipt(receipt: Any, receipt_digest: str, plan: Any) -> dict[str, Any]:
    value = mapping(receipt, "management platform receipt")
    expected = mapping(plan, "management platform input plan")
    if value.get("schema") != "actor-create-first-management-platform/v1" or value.get("verdict") != "passed":
        raise ValueError("management platform receipt is not passed evidence")
    cluster = mapping(value.get("cluster"), "management platform cluster")
    namespace = mapping(value.get("namespace"), "management platform namespace")
    inputs = mapping(value.get("inputs"), "management platform inputs")
    if (
        value.get("managementId") != expected.get("managementId")
        or cluster != {"id": expected.get("clusterId"), "uid": expected.get("clusterUid")}
        or value.get("imageInventoryDigest") != expected.get("imageInventoryDigest")
        or inputs.get("pullCredentialReceiptSha256") != expected.get("pullCredentialReceiptSha256")
        or namespace != {
            "name": "argocd", "uid": expected.get("argocdNamespaceUid"),
            "pullSecretUid": expected.get("argocdPullSecretUid"),
        }
    ):
        raise ValueError("management platform receipt differs from Terraform/pull identity")
    if set(inputs) != {"pullCredentialReceiptSha256", "argocdSourceSha256", "argocdRenderReceiptSha256"}:
        raise ValueError("management platform input receipt inventory differs")
    if any(not isinstance(item, str) or not DIGEST.fullmatch(item) for item in inputs.values()):
        raise ValueError("management platform input digest is invalid")
    argocd = mapping(value.get("argocd"), "management platform Argo inventory")
    crds = argocd.get("crds")
    workloads = argocd.get("workloads")
    if not isinstance(crds, list) or not isinstance(workloads, list):
        raise ValueError("management platform Argo inventory is missing")
    crd_records = {item.get("name"): item for item in crds if isinstance(item, dict)}
    workload_records = {
        (item.get("kind"), item.get("name")): item for item in workloads if isinstance(item, dict)
    }
    if len(crd_records) != len(crds) or set(crd_records) != EXPECTED_CRDS:
        raise ValueError("management platform CRD inventory differs")
    if len(workload_records) != len(workloads) or set(workload_records) != EXPECTED_WORKLOADS:
        raise ValueError("management platform workload inventory differs")
    for name, record in crd_records.items():
        text(record.get("uid"), f"management platform CRD {name} UID")
    for key, record in workload_records.items():
        text(record.get("uid"), f"management platform {key[0]}/{key[1]} UID")
        images = record.get("images")
        if (
            not isinstance(images, list) or not images
            or images != sorted(images)
            or any(not isinstance(image, str) or "@sha256:" not in image for image in images)
        ):
            raise ValueError(f"management platform {key[0]}/{key[1]} image inventory is invalid")
    return {
        "schemaVersion": 1,
        "managementId": value["managementId"],
        "clusterId": cluster["id"],
        "clusterUid": cluster["uid"],
        "imageInventoryDigest": value["imageInventoryDigest"],
        "platformReceiptDigest": receipt_digest,
        "namespace": namespace,
        "crds": [crd_records[name] for name in sorted(crd_records)],
        "workloads": [workload_records[key] for key in sorted(workload_records)],
    }


def validate_live(verified: dict[str, Any], kube_system: Any, namespace: Any, pull_secret: Any, resources: list[Any]) -> None:
    contract = live_contract()
    if mapping(mapping(kube_system, "kube-system Namespace").get("metadata"), "kube-system metadata").get("uid") != verified["clusterUid"]:
        raise ValueError("live management cluster UID differs from platform receipt")
    if mapping(mapping(namespace, "Argo Namespace").get("metadata"), "Argo Namespace metadata").get("uid") != verified["namespace"]["uid"]:
        raise ValueError("live Argo Namespace UID differs from platform receipt")
    if mapping(mapping(pull_secret, "Argo pull Secret").get("metadata"), "Argo pull Secret metadata").get("uid") != verified["namespace"]["pullSecretUid"]:
        raise ValueError("live Argo pull Secret UID differs from platform receipt")
    actual = {contract.identity(mapping(item, "live Argo resource")): item for item in resources}
    receipt_workloads = {(item["kind"], item["name"]): item for item in verified["workloads"]}
    receipt_crds = {item["name"]: item for item in verified["crds"]}
    expected = set(EXPECTED_WORKLOADS) | {("CustomResourceDefinition", name) for name in EXPECTED_CRDS}
    if len(actual) != len(resources) or set(actual) != expected:
        raise ValueError("live Argo inventory differs from platform receipt")
    for key in EXPECTED_WORKLOADS:
        item = actual[key]
        metadata = mapping(item.get("metadata"), "live Argo workload metadata")
        record = receipt_workloads[key]
        if metadata.get("uid") != record["uid"] or contract.images(item) != record["images"]:
            raise ValueError(f"live {key[0]}/{key[1]} identity differs from platform receipt")
        annotations = mapping(mapping(mapping(item.get("spec"), "live workload spec").get("template"), "live pod template").get("metadata"), "live pod metadata").get("annotations", {})
        if not isinstance(annotations, dict) or annotations.get("fleet.actor.dev/image-inventory-digest") != verified["imageInventoryDigest"]:
            raise ValueError(f"live {key[0]}/{key[1]} image inventory differs")
        contract.ready(item)
    for name in EXPECTED_CRDS:
        item = actual[("CustomResourceDefinition", name)]
        if mapping(item.get("metadata"), "live CRD metadata").get("uid") != receipt_crds[name]["uid"]:
            raise ValueError(f"live CRD/{name} identity differs from platform receipt")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform-receipt", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--kube-system", type=Path)
    parser.add_argument("--namespace", type=Path)
    parser.add_argument("--pull-secret", type=Path)
    parser.add_argument("--live", type=Path, action="append")
    parser.add_argument("--receipt-only", action="store_true")
    args = parser.parse_args()
    try:
        verified = validate_receipt(
            json.loads(args.platform_receipt.read_text()), file_digest(args.platform_receipt),
            json.loads(args.plan.read_text()),
        )
        if not args.receipt_only:
            if None in (args.kube_system, args.namespace, args.pull_secret) or not args.live:
                raise ValueError("complete live management platform inputs are required")
            validate_live(
                verified, json.loads(args.kube_system.read_text()), json.loads(args.namespace.read_text()),
                json.loads(args.pull_secret.read_text()), [json.loads(path.read_text()) for path in args.live],
            )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(verified, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
