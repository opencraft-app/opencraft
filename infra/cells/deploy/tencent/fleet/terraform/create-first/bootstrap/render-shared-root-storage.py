#!/usr/bin/env python3
"""Render the explicitly selected root-account storage bootstrap handoff."""

import argparse
import json
import os
import re
import stat
import sys
from pathlib import Path


def render(inventory, sensitive, access_key, secret_key):
    if not isinstance(inventory, dict) or not isinstance(sensitive, dict):
        raise ValueError("inventory and Terraform sensitive output must be objects")
    if inventory.get("schemaVersion") != 1 or not re.fullmatch(r"actor-[a-z]{2}-[a-z][0-9]{2}", inventory.get("cellId", "")):
        raise ValueError("Cell inventory identity is invalid")
    if set(sensitive) != {"kubeconfig", "storageCredentialMode", "storageCredentials"}:
        raise ValueError("Terraform sensitive output schema is invalid")
    if sensitive["storageCredentialMode"] != "shared-root":
        raise ValueError("root injection requires explicit shared-root mode")
    if sensitive["storageCredentials"] != {}:
        raise ValueError("root injection requires the unmodified empty Terraform credential output")
    if not isinstance(sensitive["kubeconfig"], str) or not sensitive["kubeconfig"]:
        raise ValueError("Terraform kubeconfig is absent")
    if not all(isinstance(value, str) and len(value) >= 16 for value in (access_key, secret_key)):
        raise ValueError("root credentials must be supplied through the protected environment")
    identities, storage = inventory.get("identity"), inventory.get("storage")
    if not isinstance(identities, dict) or not isinstance(storage, dict):
        raise ValueError("inventory storage and identity must be objects")
    credentials = {}
    for role, identity_key in (("cold", "coldStorageUser"), ("backup", "backupStorageUser")):
        if identities.get(identity_key) != "root-account-shared":
            raise ValueError("inventory does not authorize shared root identity")
        bucket = storage.get(role)
        if not isinstance(bucket, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket):
            raise ValueError("inventory storage bucket is invalid")
        credentials[role] = {"userName": "root-account-shared", "bucket": bucket,
                             "accessKeyId": access_key, "secretAccessKey": secret_key}
    if credentials["cold"]["bucket"] == credentials["backup"]["bucket"]:
        raise ValueError("cold and backup buckets must be distinct")
    return dict(sensitive, storageCredentials=credentials)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--sensitive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        for path in (args.inventory, args.sensitive):
            if not path.is_absolute() or path.is_symlink() or not path.is_file():
                raise ValueError("bootstrap inputs must be absolute regular non-symlink files")
        if stat.S_IMODE(args.sensitive.stat().st_mode) & 0o077:
            raise ValueError("Terraform sensitive output must not be group/world accessible")
        output = args.output
        if not output.is_absolute() or output.is_symlink() or not output.parent.is_dir():
            raise ValueError("output must have an existing absolute real parent")
        if output.parent.is_symlink() or stat.S_IMODE(output.parent.stat().st_mode) & 0o077:
            raise ValueError("output parent must be a protected real directory")
        payload = render(json.loads(args.inventory.read_text()), json.loads(args.sensitive.read_text()),
                         os.environ.get("TENCENTCLOUD_SECRET_ID"), os.environ.get("TENCENTCLOUD_SECRET_KEY"))
        encoded = (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode()
        descriptor = os.open(str(output), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
    except (OSError, TypeError, ValueError) as error:
        print("shared-root handoff rejected: " + str(error), file=sys.stderr)
        return 2
    print("shared-root storage handoff rendered; output is protected and contains credentials")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
