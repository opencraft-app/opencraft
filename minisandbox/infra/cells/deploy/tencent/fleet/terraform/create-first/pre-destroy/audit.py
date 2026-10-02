#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
from typing import Any


REQUIRED_STATES = {
    "foundation": {
        "tencentcloud_ccn.fleet",
        "tencentcloud_tcr_instance.fleet",
        "tencentcloud_tcr_namespace.fleet",
        "tencentcloud_tcr_repository.fleet",
    },
    "management": {
        "tencentcloud_cos_bucket.bootstrap_relay",
        "tencentcloud_cos_bucket.code_plane",
        "tencentcloud_instance.bootstrap",
        "tencentcloud_instance.ha_worker",
        "tencentcloud_kubernetes_cluster.management",
        "tencentcloud_vpc.management",
    },
    "operations-network": {
        "tencentcloud_ccn_attachment_v2.operations",
        "tencentcloud_ccn_route_table.operations",
        "tencentcloud_ccn_route_table_broadcast_policies.default_isolation",
        "tencentcloud_ccn_route_table_input_policies.operations",
    },
    "actor-bj-a01": {
        "tencentcloud_cos_bucket.storage",
        "tencentcloud_instance.bootstrap",
        "tencentcloud_kubernetes_cluster.cell",
        "tencentcloud_vpc.cell",
    },
    "actor-bj-b01": {
        "tencentcloud_cos_bucket.storage",
        "tencentcloud_instance.bootstrap",
        "tencentcloud_kubernetes_cluster.cell",
        "tencentcloud_vpc.cell",
    },
}


def sha256(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def load_json(path: pathlib.Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"{label} is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def git(repo: pathlib.Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def resource_address(resource: dict[str, Any]) -> str:
    module = resource.get("module")
    prefix = f"{module}." if isinstance(module, str) and module else ""
    return f"{prefix}{resource.get('type')}.{resource.get('name')}"


def first_id(state: dict[str, Any], address: str) -> str:
    return first_attributes(state, address)["id"]


def first_attributes(state: dict[str, Any], address: str) -> dict[str, Any]:
    for resource in state.get("resources", []):
        if resource_address(resource) != address:
            continue
        for instance in resource.get("instances", []):
            attributes = instance.get("attributes", {})
            identity = attributes.get("id")
            if isinstance(identity, str) and identity:
                return attributes
    raise ValueError(f"state has no materialized identity for {address}")


def inspect_state(name: str, path: pathlib.Path) -> dict[str, Any]:
    state = load_json(path, f"{name} state")
    if state.get("version") != 4:
        raise ValueError(f"{name} state is not Terraform state v4")
    serial = state.get("serial")
    lineage = state.get("lineage")
    if not isinstance(serial, int) or serial < 1:
        raise ValueError(f"{name} state has invalid serial")
    if not isinstance(lineage, str) or not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f-]{27,}", lineage
    ):
        raise ValueError(f"{name} state has invalid lineage")
    resources = state.get("resources")
    if not isinstance(resources, list) or not resources:
        raise ValueError(f"{name} state has no resources")
    addresses = {resource_address(resource) for resource in resources}
    missing = sorted(REQUIRED_STATES[name] - addresses)
    if missing:
        raise ValueError(f"{name} state is missing resources: {', '.join(missing)}")

    if name == "foundation":
        registry = first_attributes(state, "tencentcloud_tcr_instance.fleet")
        registry_host = registry.get("public_domain")
        if not isinstance(registry_host, str) or not registry_host.endswith(
            ".tencentcloudcr.com"
        ):
            raise ValueError("foundation state has no materialized TCR public domain")
        identities = {
            "ccn": first_id(state, "tencentcloud_ccn.fleet"),
            "registry": registry["id"],
            "registryHost": registry_host,
        }
    elif name == "management":
        identities = {
            "cluster": first_id(state, "tencentcloud_kubernetes_cluster.management"),
            "vpc": first_id(state, "tencentcloud_vpc.management"),
        }
    elif name == "operations-network":
        attachment = first_attributes(state, "tencentcloud_ccn_attachment_v2.operations")
        identities = {
            "ccn": attachment["ccn_id"],
            "vpc": attachment["instance_id"],
            "routeTable": first_id(state, "tencentcloud_ccn_route_table.operations"),
        }
    else:
        identities = {
            "cluster": first_id(state, "tencentcloud_kubernetes_cluster.cell"),
            "vpc": first_id(state, "tencentcloud_vpc.cell"),
        }
    return {
        "sha256": sha256(path),
        "serial": serial,
        "lineage": lineage,
        "terraformVersion": state.get("terraform_version"),
        "resourceBlocks": len(resources),
        "identities": identities,
    }


def parse_state_argument(value: str) -> tuple[str, pathlib.Path]:
    name, separator, path = value.partition("=")
    if not separator or name not in REQUIRED_STATES or not path:
        raise argparse.ArgumentTypeError("state must be NAME=/absolute/path")
    candidate = pathlib.Path(path)
    if not candidate.is_absolute():
        raise argparse.ArgumentTypeError("state path must be absolute")
    return name, candidate


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=pathlib.Path)
    parser.add_argument("--source-bundle", required=True, type=pathlib.Path)
    parser.add_argument("--source-receipt", required=True, type=pathlib.Path)
    parser.add_argument("--source-remote-uri", required=True)
    parser.add_argument("--terraform-lock", required=True, type=pathlib.Path)
    parser.add_argument("--terraform-archive", required=True, type=pathlib.Path)
    parser.add_argument("--terraform-remote-uri", required=True)
    parser.add_argument("--image-inventory", required=True, type=pathlib.Path)
    parser.add_argument("--image-remote-uri", required=True)
    parser.add_argument("--state-bucket", required=True)
    parser.add_argument("--state", action="append", type=parse_state_argument, default=[])
    parser.add_argument("--bucket-versioning", required=True, choices=("Enabled",))
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()

    failures: list[str] = []
    details: dict[str, Any] = {}
    try:
        repo = args.repo.resolve(strict=True)
        repository_root = pathlib.Path(git(repo, "rev-parse", "--show-toplevel")).resolve(strict=True)
        project_path_value = repo.relative_to(repository_root).as_posix()
        project_path = "." if project_path_value == "." else project_path_value
        head = git(repository_root, "rev-parse", "HEAD")
        repository_tree = git(repository_root, "rev-parse", "HEAD^{tree}")
        project_tree = (
            repository_tree
            if project_path == "."
            else git(repository_root, "rev-parse", f"HEAD:{project_path}")
        )
        dirty = git(repo, "status", "--porcelain=v1", "--untracked-files=all", "--", ".").splitlines()
        if dirty:
            failures.append("working tree contains unarchived changes")
        source_identity = {
            "revision": head,
            "repositoryTree": repository_tree,
            "projectPath": project_path,
            "projectTree": project_tree,
        }
        details["source"] = {**source_identity, "dirtyPaths": dirty}

        create_first = repo / "infra/cells/deploy/tencent/fleet/terraform/create-first"
        bootstrap_state = (create_first / "bootstrap-state/main.tf").read_text()
        if "prevent_destroy = true" not in bootstrap_state:
            failures.append("Terraform state bucket lost prevent_destroy")
        forbidden_cache_refs = []
        forbidden_cache_root = "/data/" + "build-cache"
        for suffix in ("*.sh", "*.py"):
            for path in create_first.rglob(suffix):
                if forbidden_cache_root in path.read_text(errors="replace"):
                    forbidden_cache_refs.append(str(path.relative_to(repo)))
        if forbidden_cache_refs:
            failures.append(
                f"create-first executable source depends on {forbidden_cache_root}: "
                + ", ".join(sorted(forbidden_cache_refs))
            )

        source_receipt = load_json(args.source_receipt, "source receipt")
        if (
            source_receipt.get("schema") != "actor-reviewed-source-bundle/v2"
            or source_receipt.get("verdict") != "passed"
            or source_receipt.get("source") != source_identity
        ):
            failures.append("source receipt does not bind the current Git commit and project tree")
        expected_bundle_sha = source_receipt.get("bundle", {}).get("sha256")
        actual_bundle_sha = sha256(args.source_bundle)
        if expected_bundle_sha != actual_bundle_sha:
            failures.append("source bundle hash differs from its receipt")
        if not args.source_remote_uri.startswith(
            f"cos://{args.state_bucket}/recovery/v1/source/{head}/{actual_bundle_sha}/"
        ):
            failures.append("source bundle is not under its content-addressed recovery key")
        details["source"].update(
            {
                "bundleSha256": actual_bundle_sha,
                "receiptSha256": sha256(args.source_receipt),
                "remoteUri": args.source_remote_uri,
            }
        )
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        failures.append(f"source verification failed: {error}")

    try:
        lock = load_json(args.terraform_lock, "Terraform lock")
        if lock.get("schema") != "actor-bootstrap-tool/v1":
            raise ValueError("Terraform lock schema is invalid")
        archive_sha = sha256(args.terraform_archive)
        if lock.get("archive", {}).get("sha256") != archive_sha:
            raise ValueError("Terraform archive differs from lock")
        if not args.terraform_remote_uri.startswith(
            f"cos://{args.state_bucket}/recovery/v1/tools/terraform/"
        ):
            raise ValueError("Terraform archive is outside the recovery tool prefix")
        details["terraform"] = {
            "version": lock.get("version"),
            "platform": lock.get("platform"),
            "lockSha256": sha256(args.terraform_lock),
            "archiveSha256": archive_sha,
            "remoteUri": args.terraform_remote_uri,
        }
    except (OSError, ValueError) as error:
        failures.append(f"Terraform recovery verification failed: {error}")

    try:
        image_lock = (
            args.repo
            / "infra/cells/deploy/tencent/fleet/gitops/image-seed/image-lock.py"
        )
        validation = subprocess.run(
            [
                "python3",
                str(image_lock),
                "validate-inventory",
                "--lock",
                str(args.image_inventory),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        validated = json.loads(validation.stdout)
        inventory = load_json(args.image_inventory, "image inventory")
        inventory_sha = sha256(args.image_inventory)
        inventory_digest = validated.get("inventoryDigest")
        expected_prefix = (
            f"cos://{args.state_bucket}/recovery/v1/images/"
            f"{inventory_digest}/{inventory_sha}/"
        )
        if not args.image_remote_uri.startswith(expected_prefix):
            raise ValueError("image inventory is outside its content-addressed recovery key")
        details["imageInventory"] = {
            "registry": inventory.get("registry"),
            "images": validated.get("images"),
            "inventoryDigest": inventory_digest,
            "sha256": inventory_sha,
            "remoteUri": args.image_remote_uri,
        }
    except (
        OSError,
        ValueError,
        json.JSONDecodeError,
        subprocess.CalledProcessError,
    ) as error:
        failures.append(f"image recovery verification failed: {error}")

    supplied_states = dict(args.state)
    missing_states = sorted(set(REQUIRED_STATES) - set(supplied_states))
    extra_states = sorted(set(supplied_states) - set(REQUIRED_STATES))
    if missing_states or extra_states or len(args.state) != len(supplied_states):
        failures.append(
            f"state set differs from required roots; missing={missing_states} extra={extra_states}"
        )
    state_details: dict[str, Any] = {}
    for name in sorted(REQUIRED_STATES):
        if name not in supplied_states:
            continue
        try:
            state_details[name] = inspect_state(name, supplied_states[name])
        except (OSError, ValueError) as error:
            failures.append(f"{name} state verification failed: {error}")
    details["terraformStates"] = state_details

    cluster_ids = [
        value["identities"]["cluster"]
        for name, value in state_details.items()
        if name in {"management", "actor-bj-a01", "actor-bj-b01"}
    ]
    vpc_ids = [
        value["identities"]["vpc"]
        for name, value in state_details.items()
        if name in {"management", "operations-network", "actor-bj-a01", "actor-bj-b01"}
    ]
    if len(cluster_ids) != len(set(cluster_ids)):
        failures.append("management and Cell state reuse a TKE cluster identity")
    if len(vpc_ids) != len(set(vpc_ids)):
        failures.append("management and Cell state reuse a VPC identity")
    foundation = state_details.get("foundation", {})
    operations = state_details.get("operations-network", {})
    if operations and operations.get("identities", {}).get("ccn") != foundation.get("identities", {}).get("ccn"):
        failures.append("operations network is attached to a different CCN than foundation")
    inventory_registry = details.get("imageInventory", {}).get("registry")
    if inventory_registry and inventory_registry != foundation.get("identities", {}).get(
        "registryHost"
    ):
        failures.append("image inventory registry differs from the foundation TCR")

    details["recoveryBucket"] = {
        "name": args.state_bucket,
        "versioning": args.bucket_versioning,
        "terraformPreventDestroy": not any(
            failure == "Terraform state bucket lost prevent_destroy" for failure in failures
        ),
        "retentionClass": "bootstrap-seed-do-not-destroy",
    }
    document = {
        "schema": "actor-pre-destroy-audit/v2",
        "verdict": "passed" if not failures else "blocked",
        "failures": failures,
        **details,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"verdict": document["verdict"], "failures": failures}))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
