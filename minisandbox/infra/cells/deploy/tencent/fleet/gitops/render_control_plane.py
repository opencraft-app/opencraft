#!/usr/bin/env python3
"""Render the q01 Fleet control plane as one immutable Argo desired state."""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import yaml


IMAGE = re.compile(r"^.+@sha256:[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
SHA = re.compile(r"^[0-9a-f]{64}$")
SHA_REF = re.compile(r"^sha256:[0-9a-f]{64}$")


def documents(path):
    return [item for item in yaml.safe_load_all(Path(path).read_text()) if item]


def spec_digest(profile):
    encoded = json.dumps(profile["spec"], sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def wave(document):
    kind = document.get("kind")
    if kind == "CustomResourceDefinition":
        return "-3"
    if kind in {"Namespace", "ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding", "Service"}:
        return "-2"
    if kind in {"RivetCellProfile", "ShardClass"}:
        return "-1"
    if kind == "RivetCell":
        return "0"
    if kind == "Deployment":
        return "1"
    raise ValueError(f"unowned control-plane resource kind: {kind}")


def render(args):
    if IMAGE.fullmatch(args.controller_image) is None:
        raise ValueError("controller image must be pinned by registry digest")
    if REVISION.fullmatch(args.source_revision) is None or SHA.fullmatch(args.source_manifest_sha256) is None:
        raise ValueError("controller source identity is invalid")
    if SHA_REF.fullmatch(args.image_inventory_digest) is None:
        raise ValueError("complete image inventory digest is invalid")
    # CRDs and controller RBAC form the bootstrap capability ceiling. Validate
    # their presence here but never let the child Application mutate them.
    crds = documents(args.crds)
    required_crds = {
        "rivetcellprofiles.fleet.actor.dev", "shardclasses.fleet.actor.dev",
        "rivetcells.fleet.actor.dev",
    }
    if not required_crds.issubset({item.get("metadata", {}).get("name") for item in crds}):
        raise ValueError("control bootstrap is missing a required Fleet CRD")
    controller = documents(args.controller)
    result = [item for item in controller if item.get("kind") in {"Deployment", "Service"}] + documents(args.cell)
    if any(item.get("kind") == "Secret" for item in result):
        raise ValueError("control desired state must not contain Secrets")

    profiles = [item for item in result if item.get("kind") == "RivetCellProfile"]
    classes = [item for item in result if item.get("kind") == "ShardClass"]
    cells = [item for item in result if item.get("kind") == "RivetCell"]
    deployments = [item for item in result if item.get("kind") == "Deployment"]
    services = [item for item in result if item.get("kind") == "Service"]
    if len(profiles) != 1 or len(classes) != 1 or len(cells) != 1 or len(deployments) != 1 or len(services) != 1:
        raise ValueError("q01 control desired state requires exactly one Profile, Class, Cell, Deployment and Service")
    profile, shard_class, cell, deployment = profiles[0], classes[0], cells[0], deployments[0]
    reference = shard_class["spec"]["profileRef"]
    if reference != {"name": profile["metadata"]["name"], "digest": spec_digest(profile)}:
        raise ValueError("ShardClass does not bind the exact rendered RivetCellProfile spec")
    if cell["metadata"]["name"] != args.cell_name or cell["spec"]["className"] != shard_class["metadata"]["name"]:
        raise ValueError("RivetCell identity or ShardClass binding is invalid")
    profile_digest = spec_digest(profile)
    profile.setdefault("metadata", {}).setdefault("annotations", {})[
        "fleet.actor.dev/image-inventory-digest"
    ] = args.image_inventory_digest
    cell_annotations = cell.setdefault("metadata", {}).setdefault("annotations", {})
    cell_annotations["fleet.actor.dev/profile-digest"] = profile_digest
    cell_annotations["fleet.actor.dev/image-inventory-digest"] = args.image_inventory_digest
    if deployment["metadata"]["name"] != "fdb-operator-actor-fleet-controller":
        raise ValueError("unexpected Fleet controller Deployment")
    containers = deployment["spec"]["template"]["spec"].get("containers", [])
    if len(containers) != 1 or containers[0].get("name") != "manager":
        raise ValueError("Fleet controller must have exactly one manager container")
    containers[0]["image"] = args.controller_image
    annotations = deployment["spec"]["template"].setdefault("metadata", {}).setdefault("annotations", {})
    annotations["fleet.actor.dev/source-commit"] = args.source_revision
    annotations["fleet.actor.dev/source-manifest-sha256"] = args.source_manifest_sha256

    identities = set()
    for item in result:
        metadata = item.setdefault("metadata", {})
        identity = (item.get("apiVersion"), item.get("kind"), metadata.get("namespace", ""), metadata.get("name"))
        if not all((identity[0], identity[1], identity[3])) or identity in identities:
            raise ValueError(f"invalid or duplicate resource identity: {identity}")
        identities.add(identity)
        item_annotations = metadata.setdefault("annotations", {})
        item_annotations["argocd.argoproj.io/sync-wave"] = wave(item)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--crds", required=True)
    parser.add_argument("--controller", required=True)
    parser.add_argument("--cell", required=True)
    parser.add_argument("--cell-name", default="actor-bj-q01")
    parser.add_argument("--controller-image", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-manifest-sha256", required=True)
    parser.add_argument("--image-inventory-digest", required=True)
    args = parser.parse_args()
    try:
        yaml.safe_dump_all(render(args), sys.stdout)
    except (KeyError, TypeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
