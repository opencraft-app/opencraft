#!/usr/bin/env python3
"""Validate a C/Cell destroy plan against one passing rebuild audit."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
from typing import Any


AUDIT_SCHEMA = "actor-pre-destroy-audit/v2"
RECEIPT_SCHEMA = "actor-terraform-destroy-plan/v1"
SCOPES = {
    "management": {
        "state": "management",
        "cluster": "tencentcloud_kubernetes_cluster.management",
        "vpc": "tencentcloud_vpc.management",
    },
    "actor-bj-a01": {
        "state": "actor-bj-a01",
        "cluster": "tencentcloud_kubernetes_cluster.cell",
        "vpc": "tencentcloud_vpc.cell",
    },
    "actor-bj-b01": {
        "state": "actor-bj-b01",
        "cluster": "tencentcloud_kubernetes_cluster.cell",
        "vpc": "tencentcloud_vpc.cell",
    },
}
FORBIDDEN_TYPES = {
    "tencentcloud_ccn",
    "tencentcloud_tcr_instance",
    "tencentcloud_tcr_namespace",
    "tencentcloud_tcr_repository",
}


def load(path: pathlib.Path, label: str) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_file(path: pathlib.Path, label: str) -> pathlib.Path:
    if path.is_symlink():
        raise ValueError(f"{label} must be a regular non-symlink file")
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise ValueError(f"{label} must be a regular non-symlink file")
    return resolved


def git(repo: pathlib.Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, text=True,
        stdout=subprocess.PIPE,
    ).stdout.strip()


def validate_authority(
    audit_path: pathlib.Path,
    inventory_path: pathlib.Path,
    repo: pathlib.Path,
    scope: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    if scope not in SCOPES:
        raise ValueError("scope must be management, actor-bj-a01, or actor-bj-b01")
    audit_path = require_file(audit_path, "audit")
    inventory_path = require_file(inventory_path, "image inventory")
    audit = load(audit_path, "audit")
    if audit.get("schema") != AUDIT_SCHEMA or audit.get("verdict") != "passed":
        raise ValueError("destroy authority is not a passing pre-destroy audit")
    if audit.get("failures") != []:
        raise ValueError("passing pre-destroy audit contains failures")
    recovery = audit.get("recoveryBucket", {})
    if (
        recovery.get("retentionClass") != "bootstrap-seed-do-not-destroy"
        or recovery.get("terraformPreventDestroy") is not True
        or recovery.get("versioning") != "Enabled"
    ):
        raise ValueError("recovery/state bucket is not protected")
    repo = repo.resolve(strict=True)
    if git(repo, "status", "--porcelain=v1", "--untracked-files=all", "--", "."):
        raise ValueError("working tree contains unarchived changes")
    source = audit.get("source", {})
    repository_root = pathlib.Path(git(repo, "rev-parse", "--show-toplevel")).resolve(strict=True)
    project_path_value = repo.relative_to(repository_root).as_posix()
    project_path = "." if project_path_value == "." else project_path_value
    revision = git(repository_root, "rev-parse", "HEAD")
    repository_tree = git(repository_root, "rev-parse", "HEAD^{tree}")
    project_tree = (
        repository_tree
        if project_path == "."
        else git(repository_root, "rev-parse", f"HEAD:{project_path}")
    )
    if revision != source.get("revision"):
        raise ValueError("audit source revision differs from current HEAD")
    if source.get("repositoryTree") != repository_tree:
        raise ValueError("audit repository tree differs from current HEAD")
    if source.get("projectPath") != project_path or source.get("projectTree") != project_tree:
        raise ValueError("audit project tree differs from current HEAD")
    inventory = load(inventory_path, "image inventory")
    audited_inventory = audit.get("imageInventory", {})
    if sha256(inventory_path) != audited_inventory.get("sha256"):
        raise ValueError("image inventory bytes differ from the audited inventory")
    if inventory.get("inventoryDigest") != audited_inventory.get("inventoryDigest"):
        raise ValueError("image inventory digest differs from the audited inventory")
    if len(inventory.get("images", [])) != 28:
        raise ValueError("image inventory is not the complete 28-image generation")
    state_name = SCOPES[scope]["state"]
    state = audit.get("terraformStates", {}).get(state_name)
    if not isinstance(state, dict):
        raise ValueError("audit does not contain the requested Terraform state")
    return audit, inventory, state


def resource_id(state: dict[str, Any], address: str) -> str:
    # `terraform state pull` returns Terraform's raw state representation, not
    # the public `terraform show -json` values tree used by plan JSON.
    for resource in state.get("resources", []):
        prefix = f"{resource['module']}." if resource.get("module") else ""
        candidate = f"{prefix}{resource.get('type')}.{resource.get('name')}"
        if candidate != address:
            continue
        instances = resource.get("instances", [])
        if len(instances) != 1:
            raise ValueError(f"current state has ambiguous identity for {address}")
        identity = instances[0].get("attributes", {}).get("id")
        if isinstance(identity, str) and identity:
            return identity
    raise ValueError(f"current state is missing exact identity for {address}")


def validate_plan(
    audit_path: pathlib.Path,
    inventory_path: pathlib.Path,
    repo: pathlib.Path,
    scope: str,
    state_path: pathlib.Path,
    plan_path: pathlib.Path,
    plan_json_path: pathlib.Path,
) -> dict[str, Any]:
    audit, inventory, audited_state = validate_authority(
        audit_path, inventory_path, repo, scope
    )
    state_path = require_file(state_path, "current Terraform state")
    plan_path = require_file(plan_path, "Terraform plan")
    plan_json_path = require_file(plan_json_path, "Terraform plan JSON")
    current_state = load(state_path, "current Terraform state")
    plan = load(plan_json_path, "Terraform plan JSON")
    if current_state.get("lineage") != audited_state.get("lineage"):
        raise ValueError("current Terraform state lineage differs from the audit")
    serial = current_state.get("serial")
    if not isinstance(serial, int) or serial < audited_state.get("serial", -1):
        raise ValueError("current Terraform state predates the audit")
    if plan.get("terraform_version") != audit.get("terraform", {}).get("version"):
        raise ValueError("destroy plan used a different Terraform version")
    variables = plan.get("variables", {})
    if variables.get("deletion_protection", {}).get("value") is not False:
        raise ValueError("destroy plan did not explicitly disable deletion protection")
    state_bucket = audit["recoveryBucket"]["name"]
    if variables.get("terraform_state_bucket", {}).get("value") != state_bucket:
        raise ValueError("destroy plan targets a different Terraform state bucket")
    if scope == "management":
        if variables.get("management_id", {}).get("value") != "actor-bj-c01":
            raise ValueError("management destroy plan targets an unexpected identity")
    elif variables.get("cell_id", {}).get("value") != scope:
        raise ValueError("Cell destroy plan targets an unexpected identity")

    app_id_match = re.search(r"-([0-9]{10})$", state_bucket)
    if app_id_match is None:
        raise ValueError("state bucket does not carry the Tencent AppId suffix")
    app_id = app_id_match.group(1)
    if scope == "management":
        allowed_buckets = {
            f"actor-bootstrap-relay-bj-c01-nv1-{app_id}",
            f"actor-fdb-backup-prod-bj-c01-nv1-{app_id}",
            f"actor-worker-code-prod-bj-c01-nv1-{app_id}",
            f"actor-qualification-evidence-prod-bj-c01-nv1-{app_id}",
        }
    else:
        suffix = scope.removeprefix("actor-")
        allowed_buckets = {
            f"actor-fdb-backup-prod-{suffix}-nv1-{app_id}",
            f"actor-worker-code-prod-{suffix}-nv1-{app_id}",
            f"actor-depot-cold-prod-{suffix}-nv1-{app_id}",
            f"actor-qualification-evidence-prod-{suffix}-nv1-{app_id}",
            f"actor-build-relay-prod-{suffix}-nv1-{app_id}",
        }

    expected = SCOPES[scope]
    cluster_id = resource_id(current_state, expected["cluster"])
    vpc_id = resource_id(current_state, expected["vpc"])
    audited_identities = audited_state.get("identities", {})
    if cluster_id != audited_identities.get("cluster") or vpc_id != audited_identities.get("vpc"):
        raise ValueError("live state identities differ from the pre-destroy audit")

    deletes: list[dict[str, str]] = []
    seen: dict[str, dict[str, Any]] = {}
    for change in plan.get("resource_changes", []):
        actions = change.get("change", {}).get("actions")
        if actions == ["no-op"] or actions == ["read"]:
            continue
        if actions != ["delete"]:
            raise ValueError(
                f"destroy plan contains a non-delete action: {change.get('address')}={actions}"
            )
        address = str(change.get("address", ""))
        resource_type = str(change.get("type", ""))
        if resource_type in FORBIDDEN_TYPES or "tke_oidc_config" in address:
            raise ValueError(f"destroy plan crosses the retained foundation boundary: {address}")
        before = change.get("change", {}).get("before", {})
        if before.get("bucket") == state_bucket:
            raise ValueError("destroy plan includes the protected state/recovery bucket")
        if resource_type == "tencentcloud_cos_bucket" and before.get("bucket") not in allowed_buckets:
            raise ValueError(f"destroy plan includes a bucket outside the exact scope: {address}")
        seen[address] = change
        deletes.append({"address": address, "type": resource_type})
    if not deletes:
        raise ValueError("destroy plan contains no managed-resource deletions")
    for address, identity in ((expected["cluster"], cluster_id), (expected["vpc"], vpc_id)):
        change = seen.get(address)
        if change is None or change.get("change", {}).get("before", {}).get("id") != identity:
            raise ValueError(f"destroy plan does not delete audited identity {address}")

    deletes.sort(key=lambda item: item["address"])
    return {
        "schema": RECEIPT_SCHEMA,
        "verdict": "passed",
        "scope": scope,
        "auditSha256": sha256(audit_path),
        "sourceRevision": audit["source"]["revision"],
        "imageInventoryDigest": inventory["inventoryDigest"],
        "state": {
            "bucket": state_bucket,
            "lineage": current_state["lineage"],
            "serial": serial,
            "sha256": sha256(state_path),
        },
        "identities": {"cluster": cluster_id, "vpc": vpc_id},
        "retained": {
            "stateBucket": state_bucket,
            "ccn": audit["terraformStates"]["foundation"]["identities"]["ccn"],
            "registry": audit["terraformStates"]["foundation"]["identities"]["registry"],
        },
        "planSha256": sha256(plan_path),
        "planJsonSha256": sha256(plan_json_path),
        "deleteCount": len(deletes),
        "deletes": deletes,
    }


def write_new(path: pathlib.Path, value: dict[str, Any]) -> None:
    if not path.is_absolute() or path.exists():
        raise ValueError("output receipt must be a new absolute path")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    path.chmod(0o600)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit", required=True, type=pathlib.Path)
    parser.add_argument("--image-inventory", required=True, type=pathlib.Path)
    parser.add_argument("--repo", required=True, type=pathlib.Path)
    parser.add_argument("--scope", required=True)
    parser.add_argument("--state", required=True, type=pathlib.Path)
    parser.add_argument("--plan", required=True, type=pathlib.Path)
    parser.add_argument("--plan-json", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    receipt = validate_plan(
        args.audit, args.image_inventory, args.repo, args.scope,
        args.state, args.plan, args.plan_json,
    )
    write_new(args.output, receipt)
    print(json.dumps({
        "verdict": "passed", "scope": receipt["scope"],
        "deleteCount": receipt["deleteCount"], "output": str(args.output),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
