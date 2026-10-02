#!/usr/bin/env python3
"""CAS-promote a rendered regional Profile/Class without replacing their identities."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Tuple

import yaml


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def spec_digest(profile: Dict[str, Any]) -> str:
    encoded = json.dumps(profile["spec"], sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def validate(profile_path: Path, receipt_path: Path) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    receipt = json.loads(receipt_path.read_text())
    if receipt.get("schema") != "actor-regional-profile-render/v1" or receipt.get("verdict") != "passed":
        raise ValueError("regional profile render receipt did not pass")
    documents = [item for item in yaml.safe_load_all(profile_path.read_text()) if item]
    profiles = [item for item in documents if item.get("kind") == "RivetCellProfile"]
    classes = [item for item in documents if item.get("kind") == "ShardClass"]
    if len(documents) != 2 or len(profiles) != 1 or len(classes) != 1:
        raise ValueError("rendered regional profile must contain exactly one Profile and Class")
    profile, shard_class = profiles[0], classes[0]
    digest = spec_digest(profile)
    inventory = receipt.get("imageInventoryDigest")
    if not isinstance(inventory, str) or not DIGEST.fullmatch(inventory):
        raise ValueError("regional profile image inventory digest is invalid")
    if receipt.get("profileName") != profile.get("metadata", {}).get("name"):
        raise ValueError("regional profile identity differs from receipt")
    if receipt.get("className") != shard_class.get("metadata", {}).get("name"):
        raise ValueError("regional ShardClass identity differs from receipt")
    if receipt.get("profileDigest") != digest:
        raise ValueError("regional profile spec digest differs from receipt")
    for resource in (profile, shard_class):
        if resource.get("metadata", {}).get("annotations", {}).get("fleet.actor.dev/image-inventory-digest") != inventory:
            raise ValueError("regional resource image inventory differs from receipt")
    if shard_class.get("spec", {}).get("profileRef") != {"name": receipt["profileName"], "digest": digest}:
        raise ValueError("regional ShardClass does not bind the rendered Profile")
    return documents, receipt


def validate_live(
    profile: Dict[str, Any], shard_class: Dict[str, Any], receipt: Dict[str, Any],
    expected_digest: str,
) -> Tuple[str, str]:
    if not DIGEST.fullmatch(expected_digest):
        raise ValueError("expected profile digest is invalid")
    if profile.get("metadata", {}).get("name") != receipt["profileName"]:
        raise ValueError("live regional Profile identity differs")
    if shard_class.get("metadata", {}).get("name") != receipt["className"]:
        raise ValueError("live regional ShardClass identity differs")
    if shard_class.get("spec", {}).get("profileRef") != {"name": receipt["profileName"], "digest": expected_digest}:
        raise ValueError("live regional profile revision moved since review")
    profile_uid = profile.get("metadata", {}).get("uid")
    class_uid = shard_class.get("metadata", {}).get("uid")
    if not profile_uid or not class_uid:
        raise ValueError("live regional resources lack Kubernetes identities")
    return profile_uid, class_uid


def run(*arguments: str) -> str:
    completed = subprocess.run(
        arguments, universal_newlines=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=True,
    )
    return completed.stdout


def write_new(path: Path, value: Dict[str, Any]) -> None:
    if not path.is_absolute() or path.exists() or not path.parent.is_dir():
        raise ValueError("profile promotion receipt must be a new absolute path with an existing parent")
    descriptor, staged_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    staged = Path(staged_name)
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
            staged.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True, type=Path)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--profile-receipt", required=True, type=Path)
    parser.add_argument("--expected-profile-digest", required=True)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    documents, rendered = validate(args.profile, args.profile_receipt)
    profile_name, class_name = rendered["profileName"], rendered["className"]
    base = ("kubectl", "--kubeconfig", str(args.kubeconfig))
    before_profile = json.loads(run(*base, "get", "rivetcellprofile", profile_name, "-o", "json"))
    before_class = json.loads(run(*base, "get", "shardclass", class_name, "-o", "json"))
    profile_uid, class_uid = validate_live(before_profile, before_class, rendered, args.expected_profile_digest)
    run(
        *base, "apply", "--server-side", "--force-conflicts",
        "--field-manager=actor-create-first-platform", "-f", str(args.profile),
    )
    after_profile = json.loads(run(*base, "get", "rivetcellprofile", profile_name, "-o", "json"))
    after_class = json.loads(run(*base, "get", "shardclass", class_name, "-o", "json"))
    if after_profile.get("metadata", {}).get("uid") != profile_uid or after_class.get("metadata", {}).get("uid") != class_uid:
        raise ValueError("regional resource identity changed during promotion")
    if spec_digest(after_profile) != rendered["profileDigest"]:
        raise ValueError("live regional Profile did not converge to rendered spec")
    if after_class.get("spec", {}).get("profileRef") != {
        "name": profile_name, "digest": rendered["profileDigest"],
    }:
        raise ValueError("live regional ShardClass did not converge to rendered Profile")
    for resource in (after_profile, after_class):
        if resource.get("metadata", {}).get("annotations", {}).get("fleet.actor.dev/image-inventory-digest") != rendered["imageInventoryDigest"]:
            raise ValueError("live regional resource did not converge to rendered image inventory")
    write_new(args.receipt, {
        "schema": "actor-regional-profile-promotion/v1",
        "verdict": "passed",
        "fromProfileDigest": args.expected_profile_digest,
        "toProfileDigest": rendered["profileDigest"],
        "imageInventoryDigest": rendered["imageInventoryDigest"],
        "profile": {"name": profile_name, "uid": profile_uid},
        "shardClass": {"name": class_name, "uid": class_uid},
    })
    print(json.dumps({"regionalProfilePromotion": "passed", "profileDigest": rendered["profileDigest"], "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
