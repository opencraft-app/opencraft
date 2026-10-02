#!/usr/bin/env python3
"""Join one Cell's public Terraform inventory to its protected storage keys."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parent


def load_inputs_validator():
    path = ROOT / "validate-inputs.py"
    spec = importlib.util.spec_from_file_location("storage_bootstrap_inputs", path)
    if spec is None or spec.loader is None:
        raise ValueError("create-first input validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mapping(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def exact_keys(value: dict[str, Any], name: str, expected: set[str]) -> None:
    actual = set(value)
    if actual != expected:
        raise ValueError(
            f"{name} schema mismatch: missing={sorted(expected - actual)} "
            f"unknown={sorted(actual - expected)}"
        )


def required_text(value: Any, name: str, minimum: int = 1) -> str:
    if not isinstance(value, str) or len(value) < minimum:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def validate(
    terraform: Any,
    images: Any,
    sensitive: Any,
    kubeconfig: str,
    pull_receipt: Any,
) -> dict[str, Any]:
    public = load_inputs_validator().validate(terraform, images, "cell")
    inventory = mapping(terraform, "Terraform inventory")
    protected = mapping(sensitive, "sensitive bootstrap")
    exact_keys(
        protected,
        "sensitive bootstrap",
        {"kubeconfig", "storageCredentialMode", "storageCredentials"},
    )
    credential_mode = required_text(
        protected["storageCredentialMode"], "storage credential mode"
    )
    if credential_mode not in {"dedicated-users", "shared-root"}:
        raise ValueError("storage credential mode is invalid")
    try:
        protected_kube = yaml.safe_load(required_text(protected["kubeconfig"], "sensitive kubeconfig"))
        supplied_kube = yaml.safe_load(required_text(kubeconfig, "Cell kubeconfig"))
    except yaml.YAMLError as error:
        raise ValueError("Cell kubeconfig is not valid YAML") from error
    if protected_kube != supplied_kube:
        raise ValueError("Cell kubeconfig differs from Terraform sensitive bootstrap")

    pull = mapping(pull_receipt, "pull credential receipt")
    if pull.get("schema") != "actor-create-first-pull-bootstrap/v1" or pull.get("verdict") != "passed":
        raise ValueError("pull credential receipt is not passed v1 evidence")
    if pull.get("role") != "cell" or pull.get("identity") != public["identity"]:
        raise ValueError("pull credential receipt is not for this Cell")
    cluster = mapping(pull.get("cluster"), "pull receipt cluster")
    if (
        cluster.get("id") != public["clusterId"]
        or cluster.get("vpcId") != public["vpcId"]
        or pull.get("imageInventoryDigest") != public["imageInventoryDigest"]
    ):
        raise ValueError("pull credential receipt differs from Terraform/image inventory")
    namespace_records = pull.get("namespaces")
    if not isinstance(namespace_records, list):
        raise ValueError("pull credential receipt namespaces must be an array")
    matches = [item for item in namespace_records if isinstance(item, dict) and item.get("name") == "actor-fdb-cell-system"]
    if len(matches) != 1 or not all(
        isinstance(matches[0].get(key), str) and matches[0][key]
        for key in ("namespaceUid", "secretUid")
    ):
        raise ValueError("pull credential receipt lacks the exact FDB namespace identity")

    identities = mapping(inventory.get("identity"), "inventory.identity")
    buckets = mapping(inventory.get("storage"), "inventory.storage")
    credentials = mapping(protected.get("storageCredentials"), "storage credentials")
    exact_keys(credentials, "storage credentials", {"cold", "backup"})
    result_credentials: dict[str, dict[str, str]] = {}
    for role, identity_key in (("cold", "coldStorageUser"), ("backup", "backupStorageUser")):
        value = mapping(credentials[role], f"storage credential {role}")
        exact_keys(value, f"storage credential {role}", {"userName", "bucket", "accessKeyId", "secretAccessKey"})
        user_name = required_text(value["userName"], f"{role} storage user")
        bucket = required_text(value["bucket"], f"{role} storage bucket")
        if user_name != identities.get(identity_key) or bucket != buckets.get(role):
            raise ValueError(f"{role} storage credential differs from Terraform inventory")
        result_credentials[role] = {
            "userName": user_name,
            "bucket": bucket,
            "accessKeyId": required_text(value["accessKeyId"], f"{role} access key", 16),
            "secretAccessKey": required_text(value["secretAccessKey"], f"{role} secret key", 16),
        }
    shared_access_key = (
        result_credentials["cold"]["accessKeyId"]
        == result_credentials["backup"]["accessKeyId"]
    )
    if credential_mode == "dedicated-users" and shared_access_key:
        raise ValueError("cold and backup storage must use different identities")
    if credential_mode == "shared-root" and (
        not shared_access_key
        or identities.get("coldStorageUser") != "root-account-shared"
        or identities.get("backupStorageUser") != "root-account-shared"
    ):
        raise ValueError("shared-root mode requires one root-account-shared identity")

    return {
        "schemaVersion": 1,
        "cellId": public["identity"],
        "region": public["region"],
        "clusterId": public["clusterId"],
        "clusterUid": cluster["uid"],
        "namespace": {
            "name": "actor-fdb-cell-system",
            "uid": matches[0]["namespaceUid"],
            "pullSecretUid": matches[0]["secretUid"],
        },
        "imageInventoryDigest": public["imageInventoryDigest"],
        "storageCredentialMode": credential_mode,
        "credentials": result_credentials,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--sensitive", type=Path, required=True)
    parser.add_argument("--kubeconfig", type=Path, required=True)
    parser.add_argument("--pull-receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = validate(
            json.loads(args.inventory.read_text()),
            json.loads(args.images.read_text()),
            json.loads(args.sensitive.read_text()),
            args.kubeconfig.read_text(),
            json.loads(args.pull_receipt.read_text()),
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
