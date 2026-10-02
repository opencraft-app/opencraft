#!/usr/bin/env python3
"""Verify management Git receipt identity and optional live Kubernetes state."""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DIGEST = re.compile(r"^[0-9a-f]{64}$")
SHA = re.compile(r"^sha256:[0-9a-f]{64}$")
REPOSITORY_URL = (
    "http://actor-git.actor-git-system.svc.cluster.local:3000/"
    "release-publisher/fleet-desired.git"
)


def image_contract():
    path = ROOT.parents[2] / "gitops" / "image-seed" / "image_contract.py"
    spec = importlib.util.spec_from_file_location("verify_management_git_images", path)
    if spec is None or spec.loader is None:
        raise ValueError("image inventory validator is unavailable")
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


def metadata(value: Any, name: str) -> dict[str, Any]:
    return mapping(mapping(value, name).get("metadata"), f"{name} metadata")


def validate_receipt(
    receipt: Any,
    receipt_digest: str,
    platform: Any,
    plan: Any,
    images: Any,
) -> dict[str, Any]:
    value = mapping(receipt, "management Git receipt")
    platform_value = mapping(platform, "verified management platform")
    plan_value = mapping(plan, "management Git input plan")
    inventory = image_contract().validate_inventory(mapping(images, "image inventory"))
    expected_image = image_contract().resolve(inventory, "git-service")["ref"]
    if value.get("schema") != "actor-create-first-management-git/v1" or value.get("verdict") != "passed":
        raise ValueError("management Git receipt is not passed evidence")
    cluster = mapping(value.get("cluster"), "management Git cluster")
    if (
        value.get("managementId") != plan_value.get("managementId")
        or cluster != {"id": plan_value.get("clusterId"), "uid": plan_value.get("clusterUid")}
        or value.get("managementPlatformReceiptDigest") != platform_value.get("platformReceiptDigest")
        or value.get("imageInventoryDigest") != inventory["inventoryDigest"]
        or value.get("image") != expected_image
    ):
        raise ValueError("management Git receipt differs from platform/Terraform/image identity")
    if (
        platform_value.get("managementId") != plan_value.get("managementId")
        or platform_value.get("clusterId") != plan_value.get("clusterId")
        or platform_value.get("clusterUid") != plan_value.get("clusterUid")
        or platform_value.get("imageInventoryDigest") != inventory["inventoryDigest"]
    ):
        raise ValueError("verified management platform differs from Terraform/image identity")
    repository = mapping(value.get("repository"), "management Git repository")
    if repository != {
        "id": repository.get("id"),
        "url": REPOSITORY_URL,
        "private": True,
        "defaultBranch": "main",
        "publisherAccess": "owner",
        "argocdAccess": "read-only",
    } or not isinstance(repository.get("id"), str) or not repository["id"].isdigit():
        raise ValueError("management Git repository contract differs")
    resources = mapping(value.get("resources"), "management Git resources")
    expected_resources = {
        "namespace": ("actor-git-system", plan_value.get("actorGitNamespaceUid")),
        "statefulSet": ("actor-git", None),
        "pvc": ("actor-git-data", None),
        "credentialSecret": ("actor-git-bootstrap-credentials", None),
        "argocdRepositorySecret": ("actor-fleet-desired-repository", None),
    }
    if set(resources) != set(expected_resources):
        raise ValueError("management Git resource inventory differs")
    for key, (name, expected_uid) in expected_resources.items():
        record = mapping(resources[key], f"management Git {key}")
        allowed = {"name", "uid", "pullSecretUid"} if key == "namespace" else {"name", "uid"}
        if set(record) != allowed or record.get("name") != name:
            raise ValueError(f"management Git {key} identity differs")
        text(record.get("uid"), f"management Git {key} UID")
        if expected_uid is not None and record["uid"] != expected_uid:
            raise ValueError("management Git namespace UID differs from pull bootstrap evidence")
        if key == "namespace" and record.get("pullSecretUid") != plan_value.get("actorGitPullSecretUid"):
            raise ValueError("management Git pull Secret UID differs from pull bootstrap evidence")
    render = mapping(value.get("render"), "management Git render")
    if set(render) != {"sourceSha256", "manifestSha256", "receiptSha256"}:
        raise ValueError("management Git render inventory differs")
    if any(not isinstance(raw, str) or not DIGEST.fullmatch(raw) for raw in render.values()):
        raise ValueError("management Git render digest is invalid")
    return {
        "schemaVersion": 1,
        "managementId": value["managementId"],
        "clusterId": cluster["id"],
        "clusterUid": cluster["uid"],
        "imageInventoryDigest": value["imageInventoryDigest"],
        "managementPlatformReceiptDigest": value["managementPlatformReceiptDigest"],
        "managementGitReceiptDigest": receipt_digest,
        "image": value["image"],
        "repository": repository,
        "resources": resources,
    }


def decode(secret: dict[str, Any], name: str) -> bytes:
    try:
        return base64.b64decode(mapping(secret.get("data"), "Secret data")[name], validate=True)
    except (KeyError, ValueError) as error:
        raise ValueError(f"Secret data {name} is invalid") from error


def require_annotations(value: dict[str, Any], expected: dict[str, str], name: str) -> None:
    annotations = metadata(value, name).get("annotations")
    if not isinstance(annotations, dict) or any(annotations.get(key) != item for key, item in expected.items()):
        raise ValueError(f"live {name} annotations differ from receipt identity")


def validate_live(
    verified: dict[str, Any],
    namespace: Any,
    pull_secret: Any,
    statefulset: Any,
    pvc: Any,
    credential_secret: Any,
    repository_secret: Any,
    repository: Any,
) -> None:
    resources = verified["resources"]
    values = {
        "namespace": mapping(namespace, "live namespace"),
        "statefulSet": mapping(statefulset, "live StatefulSet"),
        "pvc": mapping(pvc, "live PVC"),
        "credentialSecret": mapping(credential_secret, "live credential Secret"),
        "argocdRepositorySecret": mapping(repository_secret, "live Argo repository Secret"),
    }
    for key, value in values.items():
        if metadata(value, key).get("uid") != resources[key]["uid"]:
            raise ValueError(f"live {key} UID differs from management Git receipt")
    if metadata(mapping(pull_secret, "live pull Secret"), "pull Secret").get("uid") != resources["namespace"]["pullSecretUid"]:
        raise ValueError("live management Git pull Secret UID differs from receipt")
    expected_annotations = {
        "fleet.actor.dev/management-id": verified["managementId"],
        "fleet.actor.dev/management-cluster-uid": verified["clusterUid"],
        "fleet.actor.dev/management-platform-receipt-digest": verified["managementPlatformReceiptDigest"],
        "fleet.actor.dev/image-inventory-digest": verified["imageInventoryDigest"],
    }
    require_annotations(values["statefulSet"], expected_annotations, "StatefulSet")
    spec = mapping(values["statefulSet"].get("spec"), "StatefulSet spec")
    status = mapping(values["statefulSet"].get("status"), "StatefulSet status")
    containers = mapping(mapping(spec.get("template"), "pod template").get("spec"), "pod spec").get("containers")
    if (
        not isinstance(containers, list) or len(containers) != 1
        or containers[0].get("name") != "gitea" or containers[0].get("image") != verified["image"]
        or spec.get("replicas") != 1 or status.get("readyReplicas") != 1
        or status.get("currentRevision") != status.get("updateRevision")
    ):
        raise ValueError("live management Git StatefulSet is not converged on the locked image")
    if mapping(values["pvc"].get("status"), "PVC status").get("phase") != "Bound":
        raise ValueError("live management Git PVC is not Bound")
    credential = values["credentialSecret"]
    require_annotations(credential, expected_annotations, "credential Secret")
    if credential.get("immutable") is not True or set(mapping(credential.get("data"), "credential Secret data")) != {
        "publisher-username", "publisher-password", "reader-username", "reader-password"
    }:
        raise ValueError("live management Git credential Secret contract differs")
    if decode(credential, "publisher-username") != b"release-publisher" or decode(credential, "reader-username") != b"argocd-reader":
        raise ValueError("live management Git credential usernames differ")
    if len(decode(credential, "publisher-password")) != 64 or len(decode(credential, "reader-password")) != 64:
        raise ValueError("live management Git credential password shape differs")
    repo_secret = values["argocdRepositorySecret"]
    if repo_secret.get("immutable") is not True:
        raise ValueError("live Argo repository Secret is mutable")
    if metadata(repo_secret, "Argo repository Secret").get("labels", {}).get("argocd.argoproj.io/secret-type") != "repository":
        raise ValueError("live Argo repository Secret label differs")
    if (
        decode(repo_secret, "type") != b"git"
        or decode(repo_secret, "url").decode() != REPOSITORY_URL
        or decode(repo_secret, "username") != b"argocd-reader"
        or decode(repo_secret, "password") != decode(credential, "reader-password")
    ):
        raise ValueError("live Argo repository credential differs from management Git authority")
    repository_value = mapping(repository, "live management Git repository")
    if (
        str(repository_value.get("id")) != verified["repository"]["id"]
        or repository_value.get("private") is not True
        or repository_value.get("default_branch") != "main"
        or mapping(repository_value.get("permissions"), "repository permissions").get("pull") is not True
        or repository_value["permissions"].get("push") is not False
    ):
        raise ValueError("live read-only repository view differs from receipt")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--platform", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--namespace", type=Path)
    parser.add_argument("--pull-secret", type=Path)
    parser.add_argument("--statefulset", type=Path)
    parser.add_argument("--pvc", type=Path)
    parser.add_argument("--credential-secret", type=Path)
    parser.add_argument("--repository-secret", type=Path)
    parser.add_argument("--repository", type=Path)
    parser.add_argument("--receipt-only", action="store_true")
    args = parser.parse_args()
    try:
        verified = validate_receipt(
            json.loads(args.receipt.read_text()), file_digest(args.receipt),
            json.loads(args.platform.read_text()), json.loads(args.plan.read_text()),
            json.loads(args.images.read_text()),
        )
        if not args.receipt_only:
            paths = (
                args.namespace, args.pull_secret, args.statefulset, args.pvc,
                args.credential_secret, args.repository_secret, args.repository,
            )
            if any(path is None for path in paths):
                raise ValueError("complete live management Git inputs are required")
            validate_live(verified, *(json.loads(path.read_text()) for path in paths if path is not None))
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(verified, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
