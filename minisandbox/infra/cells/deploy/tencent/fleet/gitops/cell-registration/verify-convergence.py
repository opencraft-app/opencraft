#!/usr/bin/env python3
"""Verify one live Argo-managed Cell and publish a credential-free receipt."""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
# The local ApplicationSet E2E uses the renderer defaults. Production
# convergence derives these identities from the digest-bound handoff files.
LOCAL_E2E_MACHINE_SETS = ("np-control0", "np-fdbpool0", "np-runtime0")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def load_handoff_module():
    path = ROOT / "verify-handoff.py"
    spec = importlib.util.spec_from_file_location("cell_convergence_handoff", path)
    if spec is None or spec.loader is None:
        raise ValueError("handoff verifier is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load(path: Path, name: str) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return value


def file_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def require_text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def nested(value: dict, *path: str) -> Any:
    current: Any = value
    for name in path:
        if not isinstance(current, dict) or name not in current:
            raise ValueError("missing live field: " + ".".join(path))
        current = current[name]
    return current


def decode_secret(value: dict, name: str) -> str:
    encoded = nested(value, "data", name)
    if not isinstance(encoded, str):
        raise ValueError(f"Argo cluster Secret data.{name} is invalid")
    try:
        return base64.b64decode(encoded, validate=True).decode()
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError(f"Argo cluster Secret data.{name} is invalid") from error


def verify(
    registration: dict,
    registration_digest: str,
    handoff: dict,
    secret: dict,
    application: dict,
    cell: dict,
    machine_sets: list[dict],
    application_set: dict,
    expected_project: str = "actor-cell-bootstrap",
    expected_application_set: str = "actor-cells",
    expected_registration_scope: str = "production",
) -> dict:
    if registration.get("schemaVersion") != 3:
        raise ValueError("registration receipt schema mismatch")
    if not isinstance(registration_digest, str) or not DIGEST.fullmatch(registration_digest):
        raise ValueError("registration receipt digest is invalid")
    if registration.get("permissions") != {
        "machineSetDelete": False, "rivetCellDelete": False, "secretRead": False,
        "fdbWorkloadCreate": False, "statelessSecretRead": False,
        "statelessWorkloadDelete": False,
    }:
        raise ValueError("registration receipt did not prove the negative permissions")
    cell_id = require_text(registration.get("cellId"), "registration cellId")
    registration_scope = require_text(
        registration.get("registrationScope"), "registration registrationScope"
    )
    if registration_scope != expected_registration_scope:
        raise ValueError("registration scope differs")
    revision = require_text(registration.get("gitRevision"), "registration gitRevision")
    platform_digest = require_text(
        registration.get("platformReceiptDigest"), "registration platformReceiptDigest"
    )
    if not DIGEST.fullmatch(platform_digest):
        raise ValueError("registration platform receipt digest is invalid")
    platform_cluster_uid = require_text(
        registration.get("platformClusterUid"), "registration platformClusterUid"
    )
    publication_repository = registration.get("publicationRepository")
    if not isinstance(publication_repository, dict) or set(publication_repository) != {"url", "branch", "path"}:
        raise ValueError("registration publication repository identity is invalid")
    if handoff.get("cellId") != cell_id:
        raise ValueError("registration and handoff Cell identity differ")
    for name in ("terraformInventoryDigest", "handoffReceiptDigest", "imageInventoryDigest"):
        if registration.get(name) != handoff.get(name):
            raise ValueError(f"registration and handoff {name} differ")

    expected_secret = registration.get("argoClusterSecret")
    if not isinstance(expected_secret, dict):
        raise ValueError("registration receipt has no Argo cluster Secret identity")
    secret_metadata = nested(secret, "metadata")
    if secret.get("type") != "Opaque":
        raise ValueError("live Argo cluster Secret type differs")
    if secret_metadata.get("name") != expected_secret.get("name") or secret_metadata.get("uid") != expected_secret.get("uid"):
        raise ValueError("live Argo cluster Secret identity differs from registration")
    labels = nested(secret_metadata, "labels")
    annotations = nested(secret_metadata, "annotations")
    if labels.get("fleet.actor.dev/cell-id") != cell_id:
        raise ValueError("live Argo cluster Secret Cell label differs")
    if labels.get("argocd.argoproj.io/secret-type") != "cluster" or labels.get("fleet.actor.dev/managed-cell") != "true" or labels.get("fleet.actor.dev/desired-state") != "published" or labels.get("fleet.actor.dev/registration-scope") != registration_scope:
        raise ValueError("live Argo cluster Secret is not an admitted ApplicationSet target")
    expected_annotations = {
        "fleet.actor.dev/cluster-id": registration.get("clusterId"),
        "fleet.actor.dev/git-revision": revision,
        "fleet.actor.dev/inventory-digest": handoff.get("terraformInventoryDigest"),
        "fleet.actor.dev/handoff-receipt-digest": handoff.get("handoffReceiptDigest"),
        "fleet.actor.dev/publication-receipt-digest": registration.get("publicationReceiptDigest"),
        "fleet.actor.dev/image-inventory-digest": handoff.get("imageInventoryDigest"),
        "fleet.actor.dev/platform-receipt-digest": platform_digest,
        "fleet.actor.dev/cluster-uid": platform_cluster_uid,
    }
    for name, expected in expected_annotations.items():
        if annotations.get(name) != expected:
            raise ValueError(f"live Argo cluster Secret annotation differs: {name}")
    server = require_text(registration.get("server"), "registration server")
    if decode_secret(secret, "server") != server:
        raise ValueError("live Argo cluster Secret server differs from registration")
    if decode_secret(secret, "namespaces") != "actor-fdb-cell-system,actor-stateless-system":
        raise ValueError("live Argo cluster Secret namespace allow-list differs")
    if decode_secret(secret, "clusterResources") != "true":
        raise ValueError("live Argo cluster Secret cluster-resource policy differs")

    appset_metadata = nested(application_set, "metadata")
    if appset_metadata.get("name") != expected_application_set or appset_metadata.get("namespace") != "argocd":
        raise ValueError("Argo ApplicationSet identity differs")
    appset_uid = require_text(appset_metadata.get("uid"), "ApplicationSet UID")
    expected_selector = {
        "fleet.actor.dev/managed-cell": "true",
        "fleet.actor.dev/desired-state": "published",
        "fleet.actor.dev/registration-scope": registration_scope,
    }
    if nested(
        application_set, "spec", "generators"
    ) != [{"clusters": {"selector": {"matchLabels": expected_selector}}}]:
        raise ValueError("Argo ApplicationSet selector differs")
    appset_template = nested(application_set, "spec", "template", "spec")
    if appset_template.get("project") != expected_project:
        raise ValueError("Argo ApplicationSet project differs")
    appset_source = nested(appset_template, "source")
    if appset_source.get("repoURL") != publication_repository.get("url"):
        raise ValueError("Argo ApplicationSet repository differs")
    if appset_source.get("targetRevision") != '{{index .metadata.annotations "fleet.actor.dev/git-revision"}}':
        raise ValueError("Argo ApplicationSet does not pin the registered Git revision")
    path_prefix = str(Path(publication_repository["path"]).parent)
    expected_path_template = path_prefix + '/{{index .metadata.labels "fleet.actor.dev/cell-id"}}'
    if appset_source.get("path") != expected_path_template:
        raise ValueError("Argo ApplicationSet path template differs")

    app_metadata = nested(application, "metadata")
    expected_app_name = "actor-cell-" + cell_id
    if app_metadata.get("name") != expected_app_name:
        raise ValueError("Argo Application name differs from the registered Cell")
    app_uid = require_text(app_metadata.get("uid"), "Application UID")
    owners = app_metadata.get("ownerReferences")
    expected_owner = {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "ApplicationSet",
        "name": expected_application_set,
        "uid": appset_uid,
        "controller": True,
        "blockOwnerDeletion": True,
    }
    if not isinstance(owners, list) or expected_owner not in owners:
        raise ValueError("Argo Application is not owned by the expected ApplicationSet UID")
    app_annotations = nested(app_metadata, "annotations")
    if app_annotations.get("fleet.actor.dev/inventory-digest") != handoff.get("terraformInventoryDigest"):
        raise ValueError("Argo Application inventory digest differs")
    if app_annotations.get("fleet.actor.dev/handoff-receipt-digest") != handoff.get("handoffReceiptDigest"):
        raise ValueError("Argo Application handoff digest differs")
    if app_annotations.get("fleet.actor.dev/publication-receipt-digest") != registration.get("publicationReceiptDigest"):
        raise ValueError("Argo Application publication digest differs")
    if app_annotations.get("fleet.actor.dev/image-inventory-digest") != handoff.get("imageInventoryDigest"):
        raise ValueError("Argo Application image inventory digest differs")
    if app_annotations.get("fleet.actor.dev/platform-receipt-digest") != platform_digest:
        raise ValueError("Argo Application platform receipt digest differs")
    if app_annotations.get("fleet.actor.dev/cluster-uid") != platform_cluster_uid:
        raise ValueError("Argo Application platform cluster UID differs")
    if nested(application, "spec", "project") != expected_project:
        raise ValueError("Argo Application project differs")
    if nested(application, "spec", "source", "targetRevision") != revision:
        raise ValueError("Argo Application target revision differs")
    source_path = nested(application, "spec", "source", "path")
    if source_path != publication_repository.get("path") or ".." in Path(source_path).parts or Path(source_path).name != cell_id:
        raise ValueError("Argo Application source path differs from the registered Cell")
    if nested(application, "spec", "source", "repoURL") != publication_repository.get("url"):
        raise ValueError("Argo Application repository differs from the published desired state")
    if nested(application, "spec", "destination", "server") != server:
        raise ValueError("Argo Application destination differs")
    if nested(application, "status", "sync", "status") != "Synced":
        raise ValueError("Argo Application is not Synced")
    if nested(application, "status", "health", "status") != "Healthy":
        raise ValueError("Argo Application is not Healthy")
    if nested(application, "status", "sync", "revision") != revision:
        raise ValueError("Argo Application did not sync the exact immutable revision")

    cell_metadata = nested(cell, "metadata")
    cell_uid = require_text(cell_metadata.get("uid"), "RivetCell UID")
    if cell_metadata.get("name") != cell_id or nested(cell, "spec", "cellId") != cell_id:
        raise ValueError("live RivetCell identity differs")
    if nested(cell_metadata, "annotations").get("fleet.actor.dev/profile-digest") != handoff.get("profileDigest"):
        raise ValueError("live RivetCell profile digest differs")
    if nested(cell_metadata, "annotations").get("fleet.actor.dev/image-inventory-digest") != handoff.get("imageInventoryDigest"):
        raise ValueError("live RivetCell image inventory digest differs")
    stateless_node_pool_id = require_text(
        handoff.get("statelessNodePoolId"), "handoff statelessNodePoolId"
    )
    if not re.fullmatch(r"np-[a-z0-9]{8}", stateless_node_pool_id):
        raise ValueError("Terraform stateless Native NodePool ID is invalid")
    if nested(cell_metadata, "annotations").get("fleet.actor.dev/stateless-node-pool-id") != stateless_node_pool_id:
        raise ValueError("live RivetCell stateless Native NodePool identity differs")
    managed_machine_sets = handoff.get("machineSets")
    if (
        not isinstance(managed_machine_sets, list)
        or len(managed_machine_sets) != 3
        or any(not isinstance(name, str) or not name.startswith("np-") for name in managed_machine_sets)
        or len(set(managed_machine_sets)) != len(managed_machine_sets)
    ):
        raise ValueError("handoff fixed MachineSet inventory is invalid")
    expected_machine_sets = set(managed_machine_sets) | {stateless_node_pool_id}

    actual_machine_sets: dict[str, str] = {}
    for item in machine_sets:
        metadata = nested(item, "metadata")
        name = require_text(metadata.get("name"), "MachineSet name")
        if name not in expected_machine_sets or name in actual_machine_sets:
            raise ValueError("live MachineSet inventory is unknown or duplicated")
        if nested(item, "spec", "template", "spec", "metadata", "labels").get("fleet.actor.dev/cell") != cell_id:
            raise ValueError(f"MachineSet {name} is not owned by the registered Cell")
        actual_machine_sets[name] = require_text(metadata.get("uid"), f"MachineSet {name} UID")
    if set(actual_machine_sets) != expected_machine_sets:
        raise ValueError("live Cell does not contain the exact MachineSet inventory")

    return {
        "schema": "actor-cell-argo-convergence/v1",
        "verdict": "passed",
        "cell": {
            "id": cell_id,
            "uid": cell_uid,
            "generation": nested(cell_metadata, "generation"),
            "profileDigest": handoff["profileDigest"],
        },
        "fleetBinding": handoff["fleetBinding"],
        "terraformInventoryDigest": handoff["terraformInventoryDigest"],
        "handoffReceiptDigest": handoff["handoffReceiptDigest"],
        "publicationReceiptDigest": registration["publicationReceiptDigest"],
        "imageInventoryDigest": handoff["imageInventoryDigest"],
        "registrationReceiptDigest": registration_digest,
        "platformReceiptDigest": platform_digest,
        "platformClusterUid": platform_cluster_uid,
        "gitRevision": revision,
        "publicationRepository": publication_repository,
        "argo": {
            "project": expected_project,
            "registrationScope": registration_scope,
            "applicationSet": {"name": expected_application_set, "uid": appset_uid},
            "clusterSecret": {"name": secret_metadata["name"], "uid": secret_metadata["uid"]},
            "application": {"name": expected_app_name, "uid": app_uid, "sync": "Synced", "health": "Healthy"},
        },
        "machineSets": actual_machine_sets,
    }


def kubectl(kubeconfig: Path, *arguments: str) -> dict:
    result = subprocess.run(
        ("kubectl", "--kubeconfig", str(kubeconfig), *arguments, "-o", "json"),
        check=True,
        capture_output=True,
        text=True,
    )
    value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError("kubectl did not return a JSON object")
    return value


def publish_new(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub-kubeconfig", required=True, type=Path)
    parser.add_argument("--cell-kubeconfig", required=True, type=Path)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--handoff-receipt", required=True, type=Path)
    parser.add_argument("--desired-root", required=True, type=Path)
    parser.add_argument("--registration-receipt", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--timeout-seconds", type=int, default=600)
    args = parser.parse_args()
    if not args.receipt.is_absolute() or args.receipt.exists():
        parser.error("--receipt must be a new absolute path")
    if args.timeout_seconds < 1 or args.timeout_seconds > 3600:
        parser.error("--timeout-seconds must be in [1, 3600]")
    for path in (args.hub_kubeconfig, args.cell_kubeconfig, args.inventory, args.handoff_receipt, args.registration_receipt):
        if not path.is_file():
            parser.error(f"required input is not a regular file: {path}")

    handoff = load_handoff_module().verify(args.inventory, args.handoff_receipt, args.desired_root)
    registration = load(args.registration_receipt, "registration receipt")
    cell_id = require_text(registration.get("cellId"), "registration cellId")
    secret_name = require_text(registration.get("argoClusterSecret", {}).get("name"), "Argo cluster Secret name")
    app_name = "actor-cell-" + cell_id
    deadline = time.monotonic() + args.timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            secret = kubectl(args.hub_kubeconfig, "-n", "argocd", "get", "secret", secret_name)
            application_set = kubectl(args.hub_kubeconfig, "-n", "argocd", "get", "applicationset", "actor-cells")
            application = kubectl(args.hub_kubeconfig, "-n", "argocd", "get", "application", app_name)
            cell = kubectl(args.cell_kubeconfig, "-n", "actor-fdb-cell-system", "get", "rivetcell", cell_id)
            machine_set_list = kubectl(args.cell_kubeconfig, "get", "machinesets")
            machine_sets = machine_set_list.get("items")
            if not isinstance(machine_sets, list):
                raise ValueError("live MachineSet list is invalid")
            receipt = verify(
                registration,
                file_digest(args.registration_receipt),
                handoff,
                secret,
                application,
                cell,
                machine_sets,
                application_set,
            )
            publish_new(args.receipt, receipt)
            print(json.dumps({"argoConvergence": "passed", "receipt": str(args.receipt)}, sort_keys=True))
            return 0
        except (subprocess.CalledProcessError, ValueError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(2)
    raise RuntimeError(f"Argo Cell convergence did not pass before timeout: {last_error}")


if __name__ == "__main__":
    raise SystemExit(main())
