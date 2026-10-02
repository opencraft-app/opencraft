#!/usr/bin/env python3
"""Verify the immutable Cell platform floor before Argo registration."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
RAW_DIGEST = re.compile(r"^[0-9a-f]{64}$")


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


def spec_digest(spec: Any) -> str:
    encoded = json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def validate_receipt(
    receipt: Any,
    receipt_digest: str,
    publication: Any,
    *,
    allow_test_fixture: bool = False,
) -> dict[str, Any]:
    platform = mapping(receipt, "Cell platform receipt")
    published = mapping(publication, "publication verification")
    if platform.get("schema") != "actor-create-first-cell-platform/v1" or platform.get("verdict") != "passed":
        raise ValueError("Cell platform receipt is not passed platform evidence")
    if not DIGEST.fullmatch(receipt_digest):
        raise ValueError("Cell platform receipt digest is invalid")
    fixture = platform.get("testFixture", False)
    if not isinstance(fixture, bool) or (fixture and not allow_test_fixture):
        raise ValueError("test-only Cell platform evidence is forbidden")
    if platform.get("cellId") != published.get("cellId"):
        raise ValueError("Cell platform and publication Cell identity differ")
    cluster = mapping(platform.get("cluster"), "Cell platform cluster")
    if cluster.get("id") != published.get("clusterId"):
        raise ValueError("Cell platform and publication cluster identity differ")
    cluster_uid = text(cluster.get("uid"), "Cell platform cluster UID")
    if platform.get("imageInventoryDigest") != published.get("imageInventoryDigest"):
        raise ValueError("Cell platform and publication image inventory differ")

    fleet = mapping(published.get("fleetBinding"), "publication Fleet binding")
    profile = mapping(platform.get("profile"), "Cell platform profile")
    expected_profile = published.get("profileDigest")
    if not isinstance(expected_profile, str) or not DIGEST.fullmatch(expected_profile):
        raise ValueError("publication profile digest is invalid")
    if profile.get("digest") != expected_profile or profile.get("className") != fleet.get("className"):
        raise ValueError("Cell platform Profile/Class differs from publication")
    profile_identity = {
        "name": text(profile.get("name"), "Cell platform Profile name"),
        "uid": text(profile.get("uid"), "Cell platform Profile UID"),
        "digest": expected_profile,
        "className": text(profile.get("className"), "Cell platform Class name"),
        "classUid": text(profile.get("classUid"), "Cell platform Class UID"),
    }

    workloads = mapping(platform.get("workloads"), "Cell platform workloads")
    fdb_images = workloads.get("fdbOperatorImages")
    if (
        not isinstance(fdb_images, list) or not fdb_images
        or any(not isinstance(image, str) or "@sha256:" not in image for image in fdb_images)
        or fdb_images != sorted(set(fdb_images))
    ):
        raise ValueError("Cell platform FDB Operator images are not a unique digest-pinned inventory")
    workload_identity = {
        "fdbOperatorUid": text(workloads.get("fdbOperatorUid"), "FDB Operator UID"),
        "fdbOperatorImages": fdb_images,
        "cellControllerUid": text(workloads.get("cellControllerUid"), "Cell controller UID"),
        "cellControllerImage": text(workloads.get("cellControllerImage"), "Cell controller image"),
    }
    if "@sha256:" not in workload_identity["cellControllerImage"]:
        raise ValueError("Cell controller image is not digest pinned")
    inputs = mapping(platform.get("inputs"), "Cell platform input receipts")
    expected_inputs = {
        "pullCredentialReceiptSha256",
        "storageCredentialReceiptSha256",
        "fdbTlsReceiptSha256",
        "regionalProfileReceiptSha256",
    }
    if set(inputs) != expected_inputs or any(not isinstance(inputs[name], str) or not RAW_DIGEST.fullmatch(inputs[name]) for name in expected_inputs):
        raise ValueError("Cell platform input receipt inventory is invalid")
    return {
        "schemaVersion": 1,
        "cellId": published["cellId"],
        "clusterId": published["clusterId"],
        "clusterUid": cluster_uid,
        "imageInventoryDigest": published["imageInventoryDigest"],
        "platformReceiptDigest": receipt_digest,
        "profile": profile_identity,
        "workloads": workload_identity,
        "testFixture": fixture,
    }


def deployment_ready(value: dict[str, Any], name: str) -> None:
    metadata = mapping(value.get("metadata"), f"live {name} metadata")
    spec = mapping(value.get("spec"), f"live {name} spec")
    status = mapping(value.get("status"), f"live {name} status")
    generation = metadata.get("generation")
    replicas = spec.get("replicas", 1)
    if not isinstance(generation, int) or not isinstance(replicas, int) or replicas < 1:
        raise ValueError(f"live {name} has an invalid desired replica state")
    if (
        status.get("observedGeneration") != generation
        or status.get("updatedReplicas", 0) != replicas
        or status.get("availableReplicas", 0) != replicas
    ):
        raise ValueError(f"live {name} is not fully available")


def validate_live(
    verified: dict[str, Any],
    kube_system: Any,
    fdb_operator: Any,
    cell_controller: Any,
    profile: Any,
    shard_class: Any,
) -> None:
    namespace = mapping(kube_system, "live kube-system Namespace")
    if mapping(namespace.get("metadata"), "live kube-system metadata").get("uid") != verified["clusterUid"]:
        raise ValueError("live cluster UID differs from Cell platform receipt")

    fdb = mapping(fdb_operator, "live FDB Operator")
    controller = mapping(cell_controller, "live Cell controller")
    if mapping(fdb.get("metadata"), "live FDB Operator metadata").get("uid") != verified["workloads"]["fdbOperatorUid"]:
        raise ValueError("live FDB Operator UID differs from Cell platform receipt")
    if mapping(controller.get("metadata"), "live Cell controller metadata").get("uid") != verified["workloads"]["cellControllerUid"]:
        raise ValueError("live Cell controller UID differs from Cell platform receipt")
    deployment_ready(fdb, "FDB Operator")
    deployment_ready(controller, "Cell controller")
    fdb_annotations = mapping(
        mapping(mapping(fdb["spec"], "live FDB Operator spec").get("template"), "live FDB Operator template")
        .get("metadata"), "live FDB Operator pod metadata",
    ).get("annotations", {})
    if not isinstance(fdb_annotations, dict) or fdb_annotations.get("fleet.actor.dev/image-inventory-digest") != verified["imageInventoryDigest"]:
        raise ValueError("live FDB Operator image inventory differs from Cell platform receipt")
    fdb_template = mapping(mapping(fdb["spec"], "live FDB Operator spec").get("template"), "live FDB Operator template")
    fdb_pod_spec = mapping(fdb_template.get("spec"), "live FDB Operator pod spec")
    fdb_live_images = sorted(
        container.get("image")
        for collection in (fdb_pod_spec.get("initContainers", []), fdb_pod_spec.get("containers", []))
        for container in collection if isinstance(container, dict) and isinstance(container.get("image"), str)
    )
    if fdb_live_images != verified["workloads"]["fdbOperatorImages"]:
        raise ValueError("live FDB Operator images differ from Cell platform receipt")
    controller_template = mapping(mapping(controller["spec"], "live Cell controller spec").get("template"), "live Cell controller template")
    controller_annotations = mapping(controller_template.get("metadata"), "live Cell controller pod metadata").get("annotations", {})
    containers = mapping(controller_template.get("spec"), "live Cell controller pod spec").get("containers")
    if (
        not isinstance(controller_annotations, dict)
        or controller_annotations.get("fleet.actor.dev/image-inventory-digest") != verified["imageInventoryDigest"]
        or not isinstance(containers, list) or len(containers) != 1
        or not isinstance(containers[0], dict)
        or containers[0].get("image") != verified["workloads"]["cellControllerImage"]
    ):
        raise ValueError("live Cell controller image identity differs from Cell platform receipt")

    live_profile = mapping(profile, "live RivetCellProfile")
    profile_metadata = mapping(live_profile.get("metadata"), "live RivetCellProfile metadata")
    if profile_metadata.get("name") != verified["profile"]["name"] or profile_metadata.get("uid") != verified["profile"]["uid"]:
        raise ValueError("live RivetCellProfile identity differs from Cell platform receipt")
    if spec_digest(live_profile.get("spec")) != verified["profile"]["digest"]:
        raise ValueError("live RivetCellProfile spec differs from Cell platform receipt")
    live_class = mapping(shard_class, "live ShardClass")
    class_metadata = mapping(live_class.get("metadata"), "live ShardClass metadata")
    if class_metadata.get("name") != verified["profile"]["className"] or class_metadata.get("uid") != verified["profile"]["classUid"]:
        raise ValueError("live ShardClass identity differs from Cell platform receipt")
    if mapping(live_class.get("spec"), "live ShardClass spec").get("profileRef") != {
        "name": verified["profile"]["name"], "digest": verified["profile"]["digest"],
    }:
        raise ValueError("live ShardClass binding differs from Cell platform receipt")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform-receipt", type=Path, required=True)
    parser.add_argument("--publication-verification", type=Path, required=True)
    parser.add_argument("--kube-system", type=Path)
    parser.add_argument("--fdb-operator", type=Path)
    parser.add_argument("--cell-controller", type=Path)
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--shard-class", type=Path)
    parser.add_argument("--allow-test-fixture", action="store_true")
    parser.add_argument("--receipt-only", action="store_true")
    args = parser.parse_args()
    live_paths = (args.kube_system, args.fdb_operator, args.cell_controller, args.profile, args.shard_class)
    if any(path is None for path in live_paths) != all(path is None for path in live_paths):
        parser.error("live platform inputs must be supplied together")
    try:
        receipt = json.loads(args.platform_receipt.read_text())
        publication = json.loads(args.publication_verification.read_text())
        verified = validate_receipt(
            receipt, file_digest(args.platform_receipt), publication,
            allow_test_fixture=args.allow_test_fixture,
        )
        if all(path is not None for path in live_paths):
            validate_live(verified, *(json.loads(path.read_text()) for path in live_paths))
        elif not verified["testFixture"] and not args.receipt_only:
            raise ValueError("live Cell platform evidence is required")
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(verified, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
