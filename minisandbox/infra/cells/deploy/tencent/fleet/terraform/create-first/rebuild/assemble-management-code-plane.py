#!/usr/bin/env python3
"""Assemble the immutable regional Code Plane rebuild receipt chain."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parent
FLEET = ROOT.parents[2]
BOOTSTRAP_MANIFESTS = {
    "fdb-cluster.yaml",
    "fdb-backup.yaml",
    "worker-registry.yaml",
    "worker-registry-private.yaml",
}
GIT_MANIFESTS = BOOTSTRAP_MANIFESTS | {"evidence.json", "kustomization.yaml"}
REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")


def digest(path: Path, prefix: bool = True) -> str:
    value = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"sha256:{value}" if prefix else value


def load(path: Path, label: str) -> dict[str, Any]:
    if not path.is_absolute() or not path.is_file() or path.is_symlink():
        raise ValueError(f"{label} must be an absolute regular non-symlink file")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain one object")
    return value


def passed(value: dict[str, Any], schema: str, label: str) -> None:
    if value.get("schema") != schema or value.get("verdict") != "passed":
        raise ValueError(f"{label} is not passed evidence")


def inventory(root: Path, expected: set[str], label: str) -> dict[str, str]:
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        raise ValueError(f"{label} must be an absolute real directory")
    observed: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not path.is_file():
            if not path.is_dir():
                raise ValueError(f"{label} contains a symlink or special file")
            continue
        name = path.relative_to(root).as_posix()
        observed[name] = digest(path)
    if set(observed) != expected:
        raise ValueError(f"{label} file inventory differs")
    return observed


def application_renderer():
    path = FLEET / "code-plane/gitops/render-application.py"
    spec = importlib.util.spec_from_file_location("actor_code_plane_application", path)
    if spec is None or spec.loader is None:
        raise ValueError("Code Plane Application renderer is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assemble(args: argparse.Namespace) -> dict[str, Any]:
    load(args.inventory, "Terraform inventory")
    images = load(args.images, "Code Plane image inventory")
    management_images = load(args.management_bootstrap_images, "management bootstrap image inventory")
    management_git = load(args.management_git_receipt, "management Git receipt")
    rendered = load(args.render_receipt, "Code Plane render receipt")
    installed = load(args.install_receipt, "Code Plane install receipt")
    desired = load(args.desired_render_receipt, "Code Plane Git render receipt")
    publication = load(args.publication_receipt, "Code Plane publication receipt")
    convergence = load(args.convergence_receipt, "Code Plane convergence receipt")

    passed(management_git, "actor-create-first-management-git/v1", "management Git receipt")
    passed(rendered, "actor-regional-code-plane-render/v1", "Code Plane render receipt")
    passed(installed, "actor-regional-code-plane-install/v1", "Code Plane install receipt")
    passed(desired, "actor-regional-code-plane-desired-render/v1", "Code Plane Git render receipt")
    passed(publication, "actor-regional-code-plane-desired-publication/v1", "Code Plane publication receipt")
    passed(convergence, "actor-regional-code-plane-argocd-convergence/v1", "Code Plane convergence receipt")

    management_id = rendered.get("managementId")
    cluster_id = rendered.get("clusterId")
    image_digest = rendered.get("imageInventoryDigest")
    if not isinstance(management_id, str) or not isinstance(cluster_id, str) or not isinstance(image_digest, str):
        raise ValueError("rendered management identity is incomplete")
    if (
        installed.get("managementId") != management_id
        or installed.get("cluster", {}).get("id") != cluster_id
        or installed.get("cluster", {}).get("uid") != management_git.get("cluster", {}).get("uid")
        or installed.get("imageInventoryDigest") != image_digest
        or management_git.get("managementId") != management_id
        or management_git.get("cluster", {}).get("id") != cluster_id
        or images.get("inventoryDigest") != image_digest
    ):
        raise ValueError("Code Plane stages differ from Terraform/image identity")
    management_image_digest = management_images.get("inventoryDigest")
    if management_git.get("imageInventoryDigest") != management_image_digest:
        raise ValueError("management Git differs from its bootstrap image identity")

    inputs = installed.get("inputs", {})
    expected_inputs = {
        "terraformInventorySha256": digest(args.inventory, False),
        "imageInventorySha256": digest(args.images, False),
        "renderReceiptSha256": digest(args.render_receipt, False),
    }
    if inputs != expected_inputs:
        raise ValueError("installation does not bind the exact rebuild inputs")

    bootstrap_files = inventory(args.bootstrap_desired, BOOTSTRAP_MANIFESTS, "bootstrap desired state")
    expected_bootstrap = {name: f"sha256:{value}" for name, value in rendered.get("files", {}).items()}
    if bootstrap_files != expected_bootstrap:
        raise ValueError("bootstrap desired state differs from render receipt")

    git_files = inventory(args.git_desired, GIT_MANIFESTS, "Git desired state")
    if git_files != desired.get("files") or publication.get("files") != git_files:
        raise ValueError("published desired state differs from its rendering")
    sources = desired.get("sources", {})
    if (
        sources.get("renderReceiptSha256") != digest(args.render_receipt)
        or sources.get("installReceiptSha256") != digest(args.install_receipt)
        or publication.get("renderReceiptSha256") != digest(args.desired_render_receipt)
    ):
        raise ValueError("Git desired state does not bind the bootstrap receipts")

    revision = publication.get("gitRevision")
    repository = publication.get("repository", {})
    management_repository = management_git.get("repository", {})
    if (
        not isinstance(revision, str)
        or not REVISION.fullmatch(revision)
        or repository.get("url") != management_repository.get("url")
        or repository.get("branch") != "main"
        or repository.get("path") != "management/code-plane"
    ):
        raise ValueError("Code Plane publication differs from management Git authority")

    expected_documents = application_renderer().render(args.publication_receipt, args.desired_render_receipt)
    if not args.application.is_absolute() or not args.application.is_file() or args.application.is_symlink():
        raise ValueError("Argo Application must be an absolute regular non-symlink file")
    application_documents = [item for item in yaml.safe_load_all(args.application.read_text()) if item]
    if application_documents != expected_documents:
        raise ValueError("Argo Application differs from the receipt-bound rendering")

    source_receipts = convergence.get("sourceReceipts", {})
    if (
        convergence.get("gitRevision") != revision
        or source_receipts.get("publicationSha256") != digest(args.publication_receipt, False)
        or source_receipts.get("desiredRenderSha256") != digest(args.desired_render_receipt, False)
    ):
        raise ValueError("Argo convergence does not bind the published revision")
    gates = convergence.get("gates")
    expected_gates = {
        "synced": True,
        "identityPreserved": True,
        "secretsExternallyOwned": True,
        "pruneDisabled": True,
        "selfHeal": True,
    }
    if gates != expected_gates:
        raise ValueError("Argo convergence gates are incomplete")
    if installed.get("foundationDB", {}).get("backup", {}).get("restorable") is not True:
        raise ValueError("Code Plane backup is not physically restorable")

    identity = convergence.get("adoptedIdentity", {})
    endpoint = urllib.parse.urlsplit(installed.get("registry", {}).get("endpoint", ""))
    if endpoint.scheme != "http" or not endpoint.hostname or endpoint.port != 8080:
        raise ValueError("installed Registry endpoint is invalid")
    expected_identity = {
        "fdbClusterUid": installed.get("foundationDB", {}).get("uid"),
        "fdbBackupUid": installed.get("foundationDB", {}).get("backup", {}).get("uid"),
        "registryDeploymentUid": installed.get("registry", {}).get("deploymentUid"),
        "registryPrivateServiceUid": installed.get("registry", {}).get("privateServiceUid"),
    }
    if any(identity.get(name) != value or not isinstance(value, str) or not value for name, value in expected_identity.items()):
        raise ValueError("Argo adoption changed Code Plane identity")
    if identity.get("endpointIp") != endpoint.hostname or identity.get("secrets") != installed.get("externalSecrets"):
        raise ValueError("Argo adoption changed endpoint or external Secret identity")

    cluster_uid = installed.get("cluster", {}).get("uid")
    application_uid = convergence.get("applicationUid")
    if not isinstance(cluster_uid, str) or not cluster_uid or not isinstance(application_uid, str) or not application_uid:
        raise ValueError("installed management cluster UID is missing")
    return {
        "schema": "actor-create-first-management-code-plane-chain/v1",
        "verdict": "passed",
        "managementId": management_id,
        "cluster": {"id": cluster_id, "uid": cluster_uid},
        "imageInventoryDigest": image_digest,
        "managementBootstrapImageInventoryDigest": management_image_digest,
        "inputs": {
            "terraformInventorySha256": digest(args.inventory),
            "codePlaneImageInventorySha256": digest(args.images),
            "managementBootstrapImageInventorySha256": digest(args.management_bootstrap_images),
            "managementGitReceiptSha256": digest(args.management_git_receipt),
        },
        "receipts": {
            "render": digest(args.render_receipt),
            "install": digest(args.install_receipt),
            "desiredRender": digest(args.desired_render_receipt),
            "publication": digest(args.publication_receipt),
            "convergence": digest(args.convergence_receipt),
        },
        "artifacts": {
            "bootstrapDesired": bootstrap_files,
            "gitDesired": git_files,
            "applicationSha256": digest(args.application),
        },
        "repository": {"url": repository["url"], "path": repository["path"], "gitRevision": revision},
        "identity": {
            **expected_identity,
            "registryEndpoint": installed["registry"]["endpoint"],
            "externalSecretUids": installed["externalSecrets"],
            "applicationUid": application_uid,
        },
        "gates": {**expected_gates, "physicallyRestorableBackup": True},
    }


def publish(path: Path, value: dict[str, Any]) -> None:
    if not path.is_absolute() or path.exists() or not path.parent.is_dir():
        raise ValueError("output must be a new absolute path with an existing parent")
    descriptor, staged = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        try:
            os.unlink(staged)
        except FileNotFoundError:
            pass


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--inventory", type=Path, required=True)
    result.add_argument("--images", type=Path, required=True)
    result.add_argument("--management-bootstrap-images", type=Path, required=True)
    result.add_argument("--management-git-receipt", type=Path, required=True)
    result.add_argument("--bootstrap-desired", type=Path, required=True)
    result.add_argument("--render-receipt", type=Path, required=True)
    result.add_argument("--install-receipt", type=Path, required=True)
    result.add_argument("--git-desired", type=Path, required=True)
    result.add_argument("--desired-render-receipt", type=Path, required=True)
    result.add_argument("--publication-receipt", type=Path, required=True)
    result.add_argument("--application", type=Path, required=True)
    result.add_argument("--convergence-receipt", type=Path, required=True)
    output = result.add_mutually_exclusive_group(required=True)
    output.add_argument("--output", type=Path)
    output.add_argument("--verify-receipt", type=Path)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        value = assemble(args)
        if args.output:
            publish(args.output, value)
        else:
            existing = load(args.verify_receipt, "management Code Plane chain receipt")
            if existing != value:
                raise ValueError("existing management Code Plane chain receipt differs")
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError, yaml.YAMLError) as error:
        print(str(error), file=os.sys.stderr)
        return 2
    print(json.dumps({"managementCodePlaneChain": "passed", "gitRevision": value["repository"]["gitRevision"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
