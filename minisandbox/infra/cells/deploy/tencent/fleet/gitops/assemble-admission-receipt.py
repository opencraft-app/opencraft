#!/usr/bin/env python3
"""Join immutable image, TLS, Argo, admission, route and placement evidence."""

from __future__ import annotations

import argparse
import functools
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
GIT_REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
MAX_RECEIPT_BYTES = 32 * 1024 * 1024


@functools.lru_cache(maxsize=1)
def load_image_contract():
    path = ROOT / "image-seed" / "image_contract.py"
    spec = importlib.util.spec_from_file_location("admission_image_contract", path)
    if spec is None or spec.loader is None:
        raise ValueError("image inventory validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@functools.lru_cache(maxsize=1)
def load_product_contract():
    path = ROOT / "image-seed" / "product-lock.py"
    spec = importlib.util.spec_from_file_location("admission_product_contract", path)
    if spec is None or spec.loader is None:
        raise ValueError("product image receipt validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(path.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


@functools.lru_cache(maxsize=1)
def load_platform_contract():
    path = ROOT / "cell-registration" / "verify-platform.py"
    spec = importlib.util.spec_from_file_location("admission_platform_contract", path)
    if spec is None or spec.loader is None:
        raise ValueError("Cell platform receipt validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_regular(path: Path, name: str) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ValueError(f"unable to open {name} as a regular file: {error.strerror}") from error
    with os.fdopen(descriptor, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"{name} must be a regular file")
        if metadata.st_size > MAX_RECEIPT_BYTES:
            raise ValueError(f"{name} exceeds the receipt size limit")
        payload = stream.read(MAX_RECEIPT_BYTES + 1)
    if len(payload) > MAX_RECEIPT_BYTES:
        raise ValueError(f"{name} exceeds the receipt size limit")
    return payload


def load_exact(path: Path, name: str) -> tuple[dict[str, Any], str]:
    payload = read_regular(path, name)
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return value, "sha256:" + hashlib.sha256(payload).hexdigest()


def file_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(read_regular(path, str(path))).hexdigest()


def nested(value: dict[str, Any], *path: str) -> Any:
    current: Any = value
    for name in path:
        if not isinstance(current, dict) or name not in current:
            raise ValueError("missing evidence field: " + ".".join(path))
        current = current[name]
    return current


def require_equal(left: Any, right: Any, message: str) -> None:
    if left != right:
        raise ValueError(message)


def require_digest(value: Any, name: str) -> str:
    if not isinstance(value, str) or not DIGEST.fullmatch(value):
        raise ValueError(f"{name} is not a sha256 digest")
    return value


def embedded_sha256(value: Any, name: str) -> str:
    if not isinstance(value, str) or not HEX_SHA256.fullmatch(value):
        raise ValueError(f"{name} is not a raw SHA-256 value")
    return "sha256:" + value


def assemble(
    paths: dict[str, Path], product_receipt_paths: list[Path] | None = None, *,
    preflight_only: bool = False, qualification_only: bool = False,
) -> dict[str, Any]:
    if preflight_only and qualification_only:
        raise ValueError("qualification-only and admission preflight modes are mutually exclusive")
    names = {
        "management_images": "management image inventory",
        "images": "image inventory",
        "terraform_inventory": "Terraform Cell inventory",
        "management_platform": "management platform receipt",
        "management_git": "management Git receipt",
        "management_desired": "management desired-state receipt",
        "handoff": "Terraform-to-Git handoff receipt",
        "publication": "desired-state publication receipt",
        "platform": "Cell platform receipt",
        "registration": "Argo Cell registration receipt",
        "tls": "FDB TLS bootstrap receipt",
        "qualification_audit": "qualification audit receipt",
        "qualification_control": "qualification control receipt",
        "initial_qualification": "initial Cell qualification receipt",
        "argo": "Argo convergence receipt",
    }
    qualification_input_names = tuple(names)
    if not qualification_only:
        names.update({
            "qualification_chain": "pre-activation Cell qualification chain",
            "adoption": "central Claim adoption receipt",
            "route": "Cell route receipt",
            "activation": "qualification activation receipt",
            "workers_api_images": "Workers API image inventory",
            "workers_api_product": "Workers API product receipt",
            "workers_api_render": "Workers API render receipt",
            "workers_api_install": "Workers API installation receipt",
        })
    if not preflight_only and not qualification_only:
        names["placement"] = "first placement receipt"
    loaded = {key: load_exact(paths[key], name) for key, name in names.items()}
    documents = {key: item[0] for key, item in loaded.items()}
    digests = {key: item[1] for key, item in loaded.items()}
    images = documents["images"]
    management_images = documents["management_images"]
    image_contract = load_image_contract()
    product_contract = load_product_contract()
    image_contract.validate_inventory(images)
    image_contract.validate_inventory(management_images)
    tls = documents["tls"]
    qualification_audit = documents["qualification_audit"]
    qualification_control = documents["qualification_control"]
    initial_qualification = documents["initial_qualification"]
    argo = documents["argo"]
    route = documents.get("route")
    activation = documents.get("activation")
    workers_api_product = documents.get("workers_api_product")
    workers_api_images = documents.get("workers_api_images")
    workers_api_render = documents.get("workers_api_render")
    workers_api_install = documents.get("workers_api_install")
    qualification_chain = documents.get("qualification_chain")
    adoption = documents.get("adoption")
    placement = documents.get("placement")
    terraform_inventory = documents["terraform_inventory"]
    management_platform = documents["management_platform"]
    management_git = documents["management_git"]
    management_desired = documents["management_desired"]
    handoff = documents["handoff"]
    publication = documents["publication"]
    platform = documents["platform"]
    registration = documents["registration"]

    management = nested(terraform_inventory, "management")
    require_equal(
        (management_platform.get("schema"), management_platform.get("verdict")),
        ("actor-create-first-management-platform/v1", "passed"),
        "management platform receipt did not pass",
    )
    management_cluster = nested(management_platform, "cluster")
    require_equal(
        (management_platform.get("managementId"), management_cluster.get("id")),
        (management.get("managementId"), management.get("clusterId")),
        "management platform differs from Cell Terraform management identity",
    )
    if not isinstance(management_cluster.get("uid"), str) or not management_cluster["uid"]:
        raise ValueError("management platform cluster UID is invalid")
    require_equal(
        management_platform.get("imageInventoryDigest"), management_images.get("inventoryDigest"),
        "management platform uses another image inventory",
    )
    require_equal(
        (management_git.get("schema"), management_git.get("verdict")),
        ("actor-create-first-management-git/v1", "passed"),
        "management Git receipt did not pass",
    )
    require_equal(
        (management_git.get("managementId"), management_git.get("cluster")),
        (management.get("managementId"), management_cluster),
        "management Git differs from management platform identity",
    )
    require_equal(
        management_git.get("managementPlatformReceiptDigest"), digests["management_platform"],
        "management Git does not bind the exact management platform receipt",
    )
    require_equal(
        management_git.get("imageInventoryDigest"), management_images.get("inventoryDigest"),
        "management Git uses another image inventory",
    )
    require_equal(
        management_git.get("image"), image_contract.resolve(management_images, "git-service")["ref"],
        "management Git image differs from the complete image inventory",
    )
    management_repository = nested(management_git, "repository")
    if (
        management_repository.get("private") is not True
        or management_repository.get("defaultBranch") != "main"
        or management_repository.get("argocdAccess") != "read-only"
        or not isinstance(management_repository.get("url"), str)
        or not management_repository["url"]
    ):
        raise ValueError("management Git repository contract is invalid")
    require_equal(
        (management_desired.get("schema"), management_desired.get("verdict")),
        ("actor-management-desired-state/v1", "passed"),
        "management desired-state receipt did not pass",
    )
    require_equal(
        management_desired.get("managementPlatformReceiptDigest"), digests["management_platform"],
        "management desired state does not bind the exact management platform receipt",
    )
    require_equal(
        management_desired.get("managementGitReceiptDigest"), digests["management_git"],
        "management desired state does not bind the exact management Git receipt",
    )
    require_equal(
        management_desired.get("managementClusterUid"), management_cluster["uid"],
        "management desired state uses another cluster UID",
    )
    desired_repository = nested(management_desired, "repository")
    require_equal(
        desired_repository,
        {"url": management_repository["url"], "pathPrefix": "cells"},
        "management desired-state repository differs from management Git",
    )
    desired_resources = nested(management_desired, "resources")
    require_equal(
        nested(desired_resources, "appProject", "name"), "actor-cell-bootstrap",
        "management desired state uses another AppProject",
    )
    require_equal(
        nested(desired_resources, "applicationSet", "name"), "actor-cells",
        "management desired state uses another ApplicationSet",
    )
    require_equal(
        nested(desired_resources, "runtimeAppProject", "name"), "actor-cell-runtime",
        "management desired state uses another runtime AppProject",
    )
    if any(
        not isinstance(nested(desired_resources, name, "uid"), str)
        or not nested(desired_resources, name, "uid")
        for name in ("appProject", "runtimeAppProject", "applicationSet")
    ):
        raise ValueError("management desired-state resource UID is invalid")

    require_equal((tls.get("schema"), tls.get("verdict")), ("actor-fdb-tls-bootstrap/v1", "passed"), "FDB TLS bootstrap receipt did not pass")
    require_equal(
        (qualification_audit.get("schemaVersion"), qualification_audit.get("verdict")),
        ("actor-fdb-autonomy-audit-v1", "passed"),
        "qualification audit receipt did not pass",
    )
    require_equal(
        (qualification_control.get("schemaVersion"), qualification_control.get("control"), qualification_control.get("verdict")),
        ("actor-fdb-autonomy-control-v1", "allow", "passed"),
        "qualification control receipt did not allow admission",
    )
    for name, evidence in (("audit", qualification_audit), ("control", qualification_control)):
        if evidence.get("failures") != [] or evidence.get("warnings") != []:
            raise ValueError(f"qualification {name} contains failures or warnings")
    require_equal(
        (initial_qualification.get("schema"), initial_qualification.get("verdict")),
        ("actor-cell-initial-qualification/v2", "passed"),
        "initial Cell qualification receipt did not pass",
    )
    if initial_qualification.get("operator_activation_required") is not True:
        raise ValueError("initial qualification crossed or obscured the operator activation boundary")
    require_equal((argo.get("schema"), argo.get("verdict")), ("actor-cell-argo-convergence/v1", "passed"), "Argo convergence receipt did not pass")
    require_equal(
        nested(argo, "argo", "project"), "actor-cell-bootstrap",
        "Argo convergence project is not the production Cell project",
    )
    require_equal(
        nested(argo, "argo", "registrationScope"), "production",
        "Argo convergence is not production-scoped",
    )
    application_set = nested(argo, "argo", "applicationSet")
    require_equal(
        application_set.get("name"), "actor-cells",
        "Argo convergence used another ApplicationSet",
    )
    if not isinstance(application_set.get("uid"), str) or not application_set["uid"]:
        raise ValueError("Argo convergence ApplicationSet UID is invalid")
    require_equal(
        application_set["uid"], nested(desired_resources, "applicationSet", "uid"),
        "Argo convergence used another management ApplicationSet UID",
    )
    if not qualification_only:
        assert route is not None and activation is not None
        require_equal((route.get("schema"), route.get("verdict")), ("actor-cell-route-publication/v2", "passed"), "Cell route receipt did not pass")
        require_equal((activation.get("schema"), activation.get("verdict")), ("actor-cell-qualification-activation/v1", "passed"), "qualification activation receipt did not pass")
    if placement is not None:
        require_equal((placement.get("schema"), placement.get("verdict")), ("actor-first-placement/v1", "passed"), "first placement receipt did not pass")
    if terraform_inventory.get("schemaVersion") != 1 or handoff.get("schemaVersion") != 2:
        raise ValueError("Terraform inventory or handoff schema is invalid")
    require_equal(handoff.get("cellId"), terraform_inventory.get("cellId"), "handoff Cell differs from Terraform inventory")
    terraform_source_digest = image_contract.digest(terraform_inventory)
    require_equal(handoff.get("terraformInventoryDigest"), terraform_source_digest, "handoff does not bind the exact Terraform inventory")
    require_equal(handoff.get("fleetBinding"), terraform_inventory.get("fleet"), "handoff Fleet binding differs from Terraform")
    require_equal(handoff.get("profileDigest"), nested(terraform_inventory, "fleet", "profileDigest"), "handoff profile differs from Terraform")
    require_equal(handoff.get("imageInventoryDigest"), images.get("inventoryDigest"), "handoff uses another complete image inventory")
    handoff_files = handoff.get("files")
    required_handoff_files = {"inventory.json", "image-inventory.json", "cell.json", "kustomization.yaml"}
    if not isinstance(handoff_files, dict) or not required_handoff_files.issubset(handoff_files):
        raise ValueError("handoff desired-state file inventory is incomplete")
    if any(not isinstance(value, str) or not DIGEST.fullmatch(value) for value in handoff_files.values()):
        raise ValueError("handoff desired-state file digest is invalid")

    require_equal(
        (publication.get("schema"), publication.get("verdict")),
        ("actor-cell-desired-state-publication/v1", "passed"),
        "desired-state publication receipt did not pass",
    )
    for name in (
        "cellId", "terraformInventoryDigest", "imageInventoryDigest", "profileDigest",
    ):
        require_equal(publication.get(name), handoff.get(name), f"publication {name} differs from handoff")
    require_equal(publication.get("handoffReceiptDigest"), digests["handoff"], "publication does not bind the exact handoff receipt")
    expected_publication_files = dict(handoff_files)
    expected_publication_files["handoff-receipt.json"] = digests["handoff"]
    require_equal(publication.get("files"), expected_publication_files, "publication file inventory differs from handoff")
    require_equal(
        publication.get("repository"),
        {
            "url": management_repository["url"],
            "branch": "main",
            "path": f'cells/{handoff.get("cellId")}',
        },
        "Cell publication repository differs from management desired state",
    )

    platform_evidence = load_platform_contract().validate_receipt(
        platform,
        digests["platform"],
        {
            "cellId": handoff.get("cellId"),
            "clusterId": nested(terraform_inventory, "kubernetes", "clusterId"),
            "imageInventoryDigest": handoff.get("imageInventoryDigest"),
            "profileDigest": handoff.get("profileDigest"),
            "fleetBinding": handoff.get("fleetBinding"),
        },
    )

    if registration.get("schemaVersion") != 3:
        raise ValueError("Argo registration receipt schema is invalid")
    require_equal(
        registration.get("registrationScope"), "production",
        "Argo registration receipt is not production-scoped",
    )
    require_equal(registration.get("permissions"), {
        "machineSetDelete": False, "rivetCellDelete": False, "secretRead": False,
        "fdbWorkloadCreate": False, "statelessSecretRead": False,
        "statelessWorkloadDelete": False,
    }, "Argo registration did not prove negative permissions")
    registration_bindings = {
        "cellId": handoff.get("cellId"),
        "terraformInventoryDigest": handoff.get("terraformInventoryDigest"),
        "handoffReceiptDigest": digests["handoff"],
        "imageInventoryDigest": handoff.get("imageInventoryDigest"),
        "gitRevision": publication.get("gitRevision"),
    }
    for name, expected in registration_bindings.items():
        require_equal(registration.get(name), expected, f"registration {name} differs from published handoff")
    require_equal(registration.get("publicationReceiptDigest"), digests["publication"], "registration does not bind exact publication receipt")
    require_equal(registration.get("platformReceiptDigest"), digests["platform"], "registration does not bind exact Cell platform receipt")
    require_equal(registration.get("platformClusterUid"), platform_evidence["clusterUid"], "registration Cell platform cluster UID differs")
    require_equal(registration.get("publicationRepository"), publication.get("repository"), "registration repository differs from publication")
    terraform_kubernetes = nested(terraform_inventory, "kubernetes")
    require_equal(
        registration.get("clusterId"), terraform_kubernetes.get("clusterId"),
        "Argo registration cluster ID differs from Terraform",
    )
    require_equal(
        registration.get("server"), terraform_kubernetes.get("privateEndpoint"),
        "Argo registration endpoint differs from Terraform",
    )
    require_digest(registration.get("caDigest"), "Argo registration CA digest")
    registered_secret = registration.get("argoClusterSecret")
    if not isinstance(registered_secret, dict) or set(registered_secret) != {
        "name", "uid", "resourceVersion",
    }:
        raise ValueError("Argo registration cluster Secret identity is invalid")
    require_equal(
        registered_secret.get("name"), f'actor-cell-{handoff.get("cellId")}',
        "Argo registration cluster Secret name differs from Cell",
    )
    if any(not isinstance(registered_secret.get(name), str) or not registered_secret[name] for name in ("uid", "resourceVersion")):
        raise ValueError("Argo registration cluster Secret UID or resourceVersion is invalid")
    require_equal(tls.get("cellId"), nested(argo, "cell", "id"), "FDB TLS Cell ID differs from Argo")
    require_equal(qualification_audit.get("cell"), nested(argo, "cell", "id"), "qualification audit Cell differs from Argo")
    require_equal(qualification_control.get("cell"), nested(argo, "cell", "id"), "qualification control Cell differs from Argo")
    require_equal(qualification_audit.get("namespace"), "actor-fdb-cell-system", "qualification audit namespace is invalid")
    require_equal(qualification_control.get("namespace"), qualification_audit.get("namespace"), "qualification control namespace differs from audit")
    require_equal(qualification_control.get("sourceIdentity"), qualification_audit.get("sourceIdentity"), "qualification control source identity differs from audit")
    require_equal(initial_qualification.get("sourceIdentity"), qualification_audit.get("sourceIdentity"), "initial qualification source identity differs from audit")
    require_equal(
        nested(qualification_audit, "evidence", "qualification_mode"),
        "initial-cell",
        "admission audit did not use initial-cell qualification mode",
    )
    audit_sha = digests["qualification_audit"]
    require_equal(
        qualification_control.get("source_receipt_sha256"), audit_sha.removeprefix("sha256:"),
        "qualification control does not bind the exact audit receipt",
    )
    require_equal(initial_qualification.get("cell"), qualification_audit.get("cell"), "initial qualification Cell differs from audit")
    require_equal(initial_qualification.get("namespace"), qualification_audit.get("namespace"), "initial qualification namespace differs from audit")
    require_equal(
        embedded_sha256(nested(initial_qualification, "argo", "sha256"), "initial qualification Argo digest"),
        digests["argo"], "initial qualification does not bind exact Argo convergence",
    )
    require_equal(nested(initial_qualification, "argo", "cell_uid"), nested(argo, "cell", "uid"), "initial qualification Argo Cell UID differs")
    require_equal(
        embedded_sha256(nested(initial_qualification, "qualification", "audit", "sha256"), "initial qualification audit digest"),
        audit_sha, "initial qualification does not bind exact audit",
    )
    require_equal(
        embedded_sha256(nested(initial_qualification, "qualification", "control", "sha256"), "initial qualification control digest"),
        digests["qualification_control"], "initial qualification does not bind exact control",
    )
    audit_receipts = nested(qualification_audit, "evidence", "receipts")
    if not isinstance(audit_receipts, list) or any(not isinstance(item, dict) for item in audit_receipts):
        raise ValueError("qualification audit receipt inventory is malformed")
    audit_names = [item.get("name") for item in audit_receipts]
    if any(not isinstance(name, str) for name in audit_names) or len(audit_names) != len(set(audit_names)):
        raise ValueError("qualification audit receipt inventory is duplicated or malformed")
    audit_evidence = {item["name"]: item for item in audit_receipts}
    for aggregate_name, audit_name in (
        ("bottomless", "bottomless"),
        ("engine_ha", "engine_ha"),
    ):
        aggregate = nested(initial_qualification, "qualification", aggregate_name)
        evidence = audit_evidence.get(audit_name, {})
        embedded_sha256(aggregate.get("sha256"), f"initial qualification {aggregate_name} digest")
        require_equal(evidence.get("passed"), True, f"initial qualification audit did not pass {audit_name}")
        require_equal(aggregate.get("receipt"), evidence.get("path"), f"initial qualification {aggregate_name} receipt differs from audited evidence")
    tls_namespace = nested(tls, "namespace")
    if tls_namespace.get("name") != "actor-fdb-cell-system" or not tls_namespace.get("uid"):
        raise ValueError("FDB TLS namespace identity is invalid")
    tls_secrets = tls.get("secrets")
    expected_tls_names = {
        "operator": "fdb-operator-tls",
        "cell": f'{tls["cellId"]}-fdb-tls',
        "backup": f'{tls["cellId"]}-backup-tls',
    }
    if not isinstance(tls_secrets, list) or len(tls_secrets) != len(expected_tls_names):
        raise ValueError("FDB TLS Secret inventory is incomplete")
    observed_tls_names: dict[str, str] = {}
    for secret in tls_secrets:
        if not isinstance(secret, dict) or set(secret) != {
            "purpose", "name", "uid", "certificateSha256", "caBundleSha256",
        }:
            raise ValueError("FDB TLS Secret identity is invalid")
        if not isinstance(secret["uid"], str) or not secret["uid"]:
            raise ValueError("FDB TLS Secret UID is invalid")
        for field in ("certificateSha256", "caBundleSha256"):
            if not isinstance(secret[field], str) or not HEX_SHA256.fullmatch(secret[field]):
                raise ValueError("FDB TLS public-material digest is invalid")
        observed_tls_names[secret["purpose"]] = secret["name"]
    require_equal(observed_tls_names, expected_tls_names, "FDB TLS Secret inventory differs from Cell identity")
    terraform_digest = require_digest(
        argo.get("terraformInventoryDigest"), "Terraform inventory digest",
    )
    handoff_digest = require_digest(
        argo.get("handoffReceiptDigest"), "Terraform-to-Git handoff receipt digest",
    )
    registration_digest = require_digest(
        argo.get("registrationReceiptDigest"), "Argo registration receipt digest",
    )
    publication_digest = require_digest(
        argo.get("publicationReceiptDigest"), "desired-state publication receipt digest",
    )
    git_revision = argo.get("gitRevision")
    if not isinstance(git_revision, str) or not GIT_REVISION.fullmatch(git_revision):
        raise ValueError("Argo Git revision is not immutable")
    require_equal(git_revision, publication.get("gitRevision"), "Argo Git revision differs from publication")
    require_equal(nested(argo, "cell", "id"), handoff.get("cellId"), "Argo Cell ID differs from handoff")
    require_equal(nested(argo, "cell", "profileDigest"), handoff.get("profileDigest"), "Argo profile differs from handoff")
    require_equal(argo.get("fleetBinding"), handoff.get("fleetBinding"), "Argo Fleet binding differs from handoff")
    require_digest(argo.get("imageInventoryDigest"), "Argo image inventory digest")
    require_equal(terraform_digest, terraform_source_digest, "Argo does not bind the exact Terraform inventory")
    require_equal(handoff_digest, digests["handoff"], "Argo does not bind the exact handoff receipt")
    require_equal(publication_digest, digests["publication"], "Argo does not bind the exact publication receipt")
    require_equal(registration_digest, digests["registration"], "Argo does not bind the exact registration receipt")
    require_equal(argo.get("platformReceiptDigest"), digests["platform"], "Argo does not bind the exact Cell platform receipt")
    require_equal(argo.get("platformClusterUid"), platform_evidence["clusterUid"], "Argo Cell platform cluster UID differs")
    require_equal(argo.get("publicationRepository"), publication.get("repository"), "Argo repository differs from publication")
    require_equal(
        nested(argo, "argo", "clusterSecret"),
        {"name": registered_secret["name"], "uid": registered_secret["uid"]},
        "Argo convergence observed another cluster Secret identity",
    )
    argo_application = nested(argo, "argo", "application")
    if (
        argo_application.get("name") != f'actor-cell-{handoff.get("cellId")}'
        or not isinstance(argo_application.get("uid"), str)
        or not argo_application["uid"]
        or argo_application.get("sync") != "Synced"
        or argo_application.get("health") != "Healthy"
    ):
        raise ValueError("Argo convergence does not identify a Synced and Healthy Application")
    require_equal(
        argo.get("imageInventoryDigest"), images["inventoryDigest"],
        "Terraform/Argo handoff used another complete image inventory",
    )

    argo_digest = digests["argo"]
    runtime_ref = next(item["ref"] for item in images["images"] if item["repository"] == "rivet-runtime")
    runtime_digest = "sha256:" + runtime_ref.rsplit("@sha256:", 1)[1]
    audited_runtime_digest = nested(qualification_audit, "evidence", "current_release_binding", "runtime_digest")
    require_equal(
        audited_runtime_digest, runtime_digest,
        "initial qualification runtime is outside the complete image inventory",
    )
    qualification_result = {
            "schema": "actor-cell-qualification-chain/v1",
            "verdict": "passed",
            "cell": {
                "id": nested(argo, "cell", "id"),
                "spoke_uid": nested(argo, "cell", "uid"),
                "cluster_uid": platform_evidence["clusterUid"],
            },
            "pool": {
                "name": nested(argo, "fleetBinding", "poolName"),
                "uid": nested(argo, "fleetBinding", "poolUid"),
            },
            "construction": {
                "management_platform_receipt_digest": digests["management_platform"],
                "management_git_receipt_digest": digests["management_git"],
                "management_desired_state_receipt_digest": digests["management_desired"],
                "management_cluster_uid": management_cluster["uid"],
                "terraform_inventory_digest": terraform_digest,
                "handoff_receipt_digest": handoff_digest,
                "publication_receipt_digest": publication_digest,
                "argo_registration_receipt_digest": registration_digest,
                "cell_platform_receipt_digest": digests["platform"],
                "git_revision": git_revision,
                "argo_applicationset_uid": application_set["uid"],
                "argo_convergence_receipt_digest": argo_digest,
                "fdb_tls_receipt_digest": digests["tls"],
            },
            "qualification": {
                "audit_receipt_digest": audit_sha,
                "control_receipt_digest": digests["qualification_control"],
                "initial_qualification_receipt_digest": digests["initial_qualification"],
                "release_digest": runtime_digest,
            },
            "management_image_inventory_digest": management_images["inventoryDigest"],
            "cell_image_inventory_digest": images["inventoryDigest"],
            "placement_opened": False,
            "operator_activation_required": True,
            "source_receipts": {
                name: digests[name] for name in sorted(qualification_input_names)
            },
    }
    if qualification_only:
        return qualification_result
    assert qualification_chain is not None
    require_equal(
        qualification_chain, qualification_result,
        "pre-activation qualification chain differs from the exact construction and qualification inputs",
    )
    assert route is not None and activation is not None and adoption is not None
    require_equal(
        (adoption.get("schema"), adoption.get("verdict")),
        ("actor-cell-claim-adoption/v2", "passed"),
        "central Claim adoption receipt did not pass",
    )
    require_equal(nested(adoption, "cell", "name"), nested(argo, "cell", "id"), "Claim adoption Cell ID differs")
    require_equal(nested(adoption, "cell", "uid"), nested(argo, "cell", "uid"), "Claim adoption Cell UID differs")
    require_equal(nested(adoption, "pool", "name"), nested(argo, "fleetBinding", "poolName"), "Claim adoption Pool name differs")
    require_equal(nested(adoption, "pool", "uid"), nested(argo, "fleetBinding", "poolUid"), "Claim adoption Pool UID differs")
    require_equal(nested(adoption, "claim", "name"), nested(argo, "fleetBinding", "claimName"), "Claim adoption Claim name differs")
    require_equal(nested(adoption, "claim", "uid"), nested(argo, "fleetBinding", "claimUid"), "Claim adoption Claim UID differs")
    require_equal(nested(adoption, "evidence", "convergence"), argo_digest, "Claim adoption does not bind exact convergence")
    require_equal(
        nested(adoption, "evidence", "qualification"), digests["qualification_chain"],
        "Claim adoption does not bind exact qualification chain",
    )
    require_equal(nested(adoption, "evidence", "activation"), digests["activation"], "Claim adoption does not bind exact activation")
    assert workers_api_product is not None and workers_api_render is not None and workers_api_install is not None
    assert workers_api_images is not None
    image_contract.validate_inventory(workers_api_images)
    require_equal(route.get("convergenceReceiptDigest"), argo_digest, "route does not bind the exact Argo convergence receipt")
    require_equal(route.get("qualificationChainReceiptDigest"), digests["qualification_chain"], "route does not bind the exact qualification chain")
    require_equal(route.get("activationReceiptDigest"), digests["activation"], "route does not bind the exact activation receipt")
    require_equal(route.get("adoptionReceiptDigest"), digests["adoption"], "route does not bind the exact Claim adoption receipt")
    binding = nested(argo, "fleetBinding")
    require_equal(nested(route, "pool", "name"), binding.get("poolName"), "route Pool name differs from Terraform/Argo")
    require_equal(nested(route, "pool", "uid"), binding.get("poolUid"), "route Pool UID differs from Terraform/Argo")
    require_equal(route.get("datacenter"), binding.get("datacenterName"), "route datacenter differs from Terraform/Argo")
    require_equal(nested(route, "cell", "uid"), nested(argo, "cell", "uid"), "route spoke Cell UID differs from Argo")

    product_contract.validate_receipt(workers_api_product)
    require_equal(workers_api_product.get("repository"), "workers-api", "public API product receipt describes another component")
    public_dependencies = {item["repository"]: item["ref"] for item in workers_api_product["dependencies"]}
    require_equal(
        public_dependencies,
        {
            name: image_contract.resolve(images, name)["ref"]
            for name in ("base-distroless", "base-golang")
        },
        "public Workers API foundations differ from the admitted image generation",
    )
    require_equal(
        workers_api_product["ref"], image_contract.resolve(workers_api_images, "workers-api")["ref"],
        "Workers API product differs from its image inventory",
    )
    require_equal(
        (workers_api_render.get("schema"), workers_api_render.get("verdict")),
        ("actor-workers-api-render/v1", "passed"),
        "Workers API render receipt did not pass",
    )
    require_equal(
        nested(workers_api_render, "imageInventory", "digest"), workers_api_images["inventoryDigest"],
        "Workers API render used another Workers API image inventory",
    )
    require_equal(
        nested(workers_api_render, "imageInventory", "fileSha256"), digests["workers_api_images"],
        "Workers API render does not bind the exact Workers API image inventory file",
    )
    require_equal(
        nested(workers_api_render, "workersApiProductReceipt", "sha256"), digests["workers_api_product"],
        "Workers API render does not bind the exact product receipt",
    )
    require_equal(
        workers_api_render.get("workersApiImage"), workers_api_product["ref"],
        "Workers API render uses another product image",
    )
    require_equal(
        nested(workers_api_render, "pool"), nested(route, "pool"),
        "Workers API render Pool differs from the Cell route",
    )
    rendered_cells = workers_api_render.get("cells")
    if not isinstance(rendered_cells, list) or len(rendered_cells) != 2:
        raise ValueError("Workers API render does not contain exactly two Cells")
    matching_cells = [
        item for item in rendered_cells if isinstance(item, dict)
        and item.get("cell") == nested(route, "cell", "name")
    ]
    if len(matching_cells) != 1:
        raise ValueError("Workers API render does not contain the routed Cell exactly once")
    public_cell = matching_cells[0]
    require_equal(public_cell.get("cellUid"), nested(route, "cell", "uid"), "Workers API endpoint Cell UID differs from route")
    require_equal(public_cell.get("datacenter"), route.get("datacenter"), "Workers API endpoint datacenter differs from route")
    require_equal(public_cell.get("routeDigest"), digests["route"], "Workers API render does not bind the exact route receipt")
    require_equal(
        (workers_api_install.get("schema"), workers_api_install.get("verdict"), workers_api_install.get("serviceReady")),
        ("actor-workers-api-installation/v1", "passed", True),
        "Workers API installation did not pass",
    )
    require_equal(
        nested(workers_api_install, "renderReceipt", "sha256"), digests["workers_api_render"],
        "Workers API installation does not bind the exact render receipt",
    )
    require_equal(
        nested(workers_api_install, "topology"),
        {"pool": workers_api_render["pool"], "cells": rendered_cells, "workersApiImage": workers_api_product["ref"]},
        "Workers API installed topology differs from its render receipt",
    )
    require_equal(
        nested(workers_api_install, "credentialSecret", "cellScopedTokens"), True,
        "Workers API installation did not use Cell-scoped credentials",
    )
    installed_pods = nested(workers_api_install, "deployment", "podUids")
    if (
        not isinstance(installed_pods, list)
        or len(installed_pods) < 3
        or len(set(installed_pods)) != len(installed_pods)
    ):
        raise ValueError("Workers API installation does not preserve its distinct three-replica HA floor")

    identity = nested(activation, "cell_identity")
    require_equal(activation.get("cell"), nested(argo, "cell", "id"), "activation Cell ID differs from Argo")
    require_equal(identity.get("uid"), nested(argo, "cell", "uid"), "activation Cell UID differs from Argo")
    require_equal(identity.get("generation"), identity.get("observed_generation"), "activation status did not observe its exact generation")
    require_equal(identity.get("profile_digest"), nested(argo, "cell", "profileDigest"), "activation profile differs from Argo")
    if not activation.get("ready_for_placement") or activation.get("desired_state") != "Ready":
        raise ValueError("qualification activation did not open the Cell")
    control_sha = activation.get("control_receipt_sha256")
    if not isinstance(control_sha, str) or not HEX_SHA256.fullmatch(control_sha):
        raise ValueError("qualification activation control digest is invalid")
    require_equal(
        "sha256:" + control_sha, digests["qualification_control"],
        "qualification activation does not bind the supplied control receipt",
    )
    qualification = nested(activation, "qualification")
    require_equal(
        qualification.get("receipt_digest"), "sha256:" + control_sha,
        "qualification activation does not bind its exact control receipt",
    )
    receipt_ref = qualification.get("receipt_ref")
    if not isinstance(receipt_ref, str) or not receipt_ref.endswith("?sha256=" + control_sha):
        raise ValueError("qualification activation cache reference is not content addressed")
    activation_plan = nested(activation, "activation_plan")
    require_equal(
        activation_plan.get("schema"), "actor-cell-qualification-activation-plan/v1",
        "qualification activation plan schema mismatch",
    )
    require_equal(activation_plan.get("cell"), activation.get("cell"), "activation plan Cell differs")
    require_equal(
        activation_plan.get("control_receipt_sha256"), control_sha,
        "activation plan uses another control receipt",
    )
    require_equal(
        activation_plan.get("source_receipt_sha256"), audit_sha.removeprefix("sha256:"),
        "activation plan uses another qualification audit receipt",
    )
    # The plan records the admission decision (ready=true), while the immutable
    # publication projects only the content-addressed qualification identity.
    # Compare the exact producer contract instead of requiring two deliberately
    # different representations to be byte-for-byte equal.
    planned_qualification = dict(qualification)
    planned_qualification["ready"] = True
    require_equal(
        nested(activation_plan, "qualification"), planned_qualification,
        "activation plan qualification differs from the published activation",
    )

    require_equal(nested(activation, "qualification", "release_digest"), runtime_digest, "qualified runtime is outside the complete image inventory")

    if preflight_only:
        return {
            "schema": "actor-cell-admission-preflight/v1",
            "verdict": "passed",
            "cell": {"id": nested(argo, "cell", "id"), "uid": nested(argo, "cell", "uid")},
            "activation_receipt_digest": digests["activation"],
            "image_inventory_digest": images["inventoryDigest"],
            "workers_api_installation_receipt_digest": digests["workers_api_install"],
        }
    if placement is None:
        raise ValueError("first placement receipt is required")

    first = nested(placement, "first_placement")
    record = nested(first, "registry_record")
    decision = nested(record, "placement")
    object_ref = nested(first, "object_ref")
    if record.get("schema") != "rivet-worker-object/v2" or record.get("state") != "active":
        raise ValueError("first placement is not an active FDB object record")
    for public_name, registry_name in (("id", "object_id"), ("worker", "worker"), ("class_name", "class_name")):
        require_equal(object_ref.get(public_name), record.get(registry_name), "public ObjectRef differs from Registry FDB identity")
    require_equal(first.get("object_id"), record.get("object_id"), "first-placement object ID differs")
    require_equal(placement.get("logical_actor_id"), record.get("actor_id"), "first-placement Actor ID differs from Registry FDB")
    if not record.get("actor_id"):
        raise ValueError("first-placement Registry record has no Actor ID")
    require_equal(decision.get("pool_name"), nested(route, "pool", "name"), "FDB placement Pool name differs from route")
    require_equal(decision.get("pool_uid"), nested(route, "pool", "uid"), "FDB placement Pool UID differs from route")
    require_equal(decision.get("cell_name"), nested(route, "cell", "name"), "FDB placement Cell name differs from route")
    require_equal(decision.get("cell_uid"), nested(route, "cell", "uid"), "FDB placement Cell UID differs from route")
    require_equal(decision.get("datacenter"), route.get("datacenter"), "FDB placement datacenter differs from route")
    require_equal(first.get("route_configmap_uid"), nested(route, "routeConfigMap", "uid"), "first placement observed another route ConfigMap")
    if not DIGEST.fullmatch(str(decision.get("snapshot_digest", ""))):
        raise ValueError("FDB placement snapshot digest is invalid")
    operation_id = placement.get("operation_id")
    if not isinstance(operation_id, str) or not re.fullmatch(r"[0-9a-f]{32}", operation_id):
        raise ValueError("first-placement operation ID is invalid")
    expected_worker = f"first-agent-{operation_id[:16]}"
    expected_object_id = hashlib.sha256(f"{expected_worker}\0{operation_id}".encode()).hexdigest()
    require_equal(record.get("worker"), expected_worker, "first-placement Worker differs from operation identity")
    require_equal(record.get("class_name"), "QualificationAgent", "first-placement class differs from qualification contract")
    require_equal(record.get("object_id"), expected_object_id, "first-placement Object differs from operation identity")
    if not isinstance(placement.get("version_id"), str) or not placement["version_id"]:
        raise ValueError("first-placement Version identity is invalid")
    if not isinstance(placement.get("deployment_id"), str) or not placement["deployment_id"]:
        raise ValueError("first-placement Deployment identity is invalid")
    require_equal(record.get("namespace"), "default", "first-placement Registry namespace is invalid")
    placement_cell = nested(placement, "cell_identity")
    require_equal(placement_cell.get("cell_id"), nested(argo, "cell", "id"), "first-placement live Cell ID differs from Argo")
    require_equal(placement_cell.get("uid"), nested(argo, "cell", "uid"), "first-placement live Cell UID differs from Argo")
    require_equal(
        placement_cell.get("generation"), placement_cell.get("observed_generation"),
        "first-placement live Cell generation is not observed",
    )
    if (
        placement_cell.get("desired_state") != "Ready"
        or placement_cell.get("phase") != "Ready"
        or placement_cell.get("ready_for_placement") is not True
    ):
        raise ValueError("first-placement live Cell was not admitted")
    functional_probe = nested(first, "functional_probe")
    require_equal(functional_probe.get("status"), 200, "first-placement functional probe did not return HTTP 200")
    require_equal(functional_probe.get("response_bytes"), len(b"qualified"), "first-placement functional probe response length differs")
    require_equal(
        functional_probe.get("response_sha256"),
        "sha256:" + hashlib.sha256(b"qualified").hexdigest(),
        "first-placement functional probe returned unexpected content",
    )

    return {
        "schema": "actor-cell-admission-chain/v6",
        "verdict": "passed",
        "cell": {
            "id": nested(argo, "cell", "id"),
            "spoke_uid": nested(argo, "cell", "uid"),
            "logical_name": nested(route, "cell", "name"),
            "datacenter": route["datacenter"],
        },
        "pool": route["pool"],
        "construction": {
            "management_platform_receipt_digest": digests["management_platform"],
            "management_git_receipt_digest": digests["management_git"],
            "management_desired_state_receipt_digest": digests["management_desired"],
            "management_cluster_uid": management_cluster["uid"],
            "terraform_inventory_digest": terraform_digest,
            "handoff_receipt_digest": handoff_digest,
            "publication_receipt_digest": publication_digest,
            "argo_registration_receipt_digest": registration_digest,
            "cell_platform_receipt_digest": digests["platform"],
            "cell_platform_cluster_uid": platform_evidence["clusterUid"],
            "git_revision": git_revision,
            "argo_applicationset_uid": application_set["uid"],
            "argo_convergence_receipt_digest": argo_digest,
            "fdb_tls_receipt_digest": digests["tls"],
        },
        "qualification": {
            "pre_activation_chain_receipt_digest": digests["qualification_chain"],
            "control_receipt_digest": "sha256:" + control_sha,
            "audit_receipt_digest": audit_sha,
            "initial_qualification_receipt_digest": digests["initial_qualification"],
            "release_digest": qualification["release_digest"],
            "activation_receipt_digest": digests["activation"],
        },
        "first_object": {
            "id": record["object_id"], "worker": record["worker"],
            "class_name": record["class_name"], "actor_id": record["actor_id"],
            "placement_snapshot_digest": decision["snapshot_digest"],
            "operation_id": operation_id,
            "version_id": placement["version_id"],
            "deployment_id": placement["deployment_id"],
            "functional_probe": functional_probe,
        },
        "management_image_inventory_digest": management_images["inventoryDigest"],
        "cell_image_inventory_digest": images["inventoryDigest"],
        "workers_api_image_inventory_digest": workers_api_images["inventoryDigest"],
        "public_api": {
            "image": workers_api_product["ref"],
            "product_receipt_digest": digests["workers_api_product"],
            "render_receipt_digest": digests["workers_api_render"],
            "installation_receipt_digest": digests["workers_api_install"],
            "cell_scoped_credentials": True,
        },
        "source_receipts": dict(sorted(digests.items())),
    }


def publish_new(path: Path, value: dict[str, Any]) -> None:
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
    common_input_names = (
        "management_images", "images",
        "terraform_inventory", "management_platform", "management_git", "management_desired",
        "handoff", "publication", "platform", "registration",
        "tls", "qualification_audit", "qualification_control", "initial_qualification",
        "argo",
    )
    admission_input_names = (
        "qualification_chain", "adoption", "route", "activation", "workers_api_images", "workers_api_product", "workers_api_render",
        "workers_api_install",
    )
    for name in common_input_names + admission_input_names:
        parser.add_argument("--" + name.replace("_", "-"), type=Path)
    parser.add_argument("--placement", type=Path)
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--qualification-only", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    for name in common_input_names:
        if getattr(args, name) is None:
            parser.error("--" + name.replace("_", "-") + " is required")
    modes = int(args.preflight_only) + int(args.qualification_only) + int(args.placement is not None)
    if modes != 1:
        parser.error("use exactly one of --qualification-only, --preflight-only, or --placement")
    if not args.qualification_only:
        for name in admission_input_names:
            if getattr(args, name) is None:
                parser.error("--" + name.replace("_", "-") + " is required")
    elif any(getattr(args, name) is not None for name in admission_input_names):
        parser.error("admission-only inputs are forbidden with --qualification-only")
    paths = {name: getattr(args, name) for name in common_input_names}
    if not args.qualification_only:
        paths.update({name: getattr(args, name) for name in admission_input_names})
    if args.placement is not None:
        paths["placement"] = args.placement
    if not args.output.is_absolute() or args.output.exists():
        parser.error("--output must be a new absolute path")
    result = assemble(
        paths, preflight_only=args.preflight_only, qualification_only=args.qualification_only,
    )
    publish_new(args.output, result)
    print(json.dumps({"admissionChain": "passed", "output": str(args.output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
