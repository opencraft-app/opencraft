#!/usr/bin/env python3
"""Add the Workers API discovery allowlist without dropping existing Argo policy."""

from __future__ import annotations

import argparse
import ipaddress
import json
import pathlib
import urllib.parse

import yaml


# v1 accidentally enabled Workers API discovery on every registered Cell.
# Remove only those byte-equivalent entries while retaining every unrelated
# inclusion. The replacement file scopes the same kinds to management C.
LEGACY_GLOBAL = [
    {"apiGroups": [""], "kinds": ["Namespace", "ServiceAccount", "ConfigMap", "Service"], "clusters": ["*"]},
    {"apiGroups": ["apps"], "kinds": ["Deployment"], "clusters": ["*"]},
    {"apiGroups": ["policy"], "kinds": ["PodDisruptionBudget"], "clusters": ["*"]},
    {
        "apiGroups": ["rbac.authorization.k8s.io"],
        "kinds": ["Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"],
        "clusters": ["*"],
    },
]
LEGACY_SERVICE_ALIAS = [
    {**item, "clusters": ["https://kubernetes.default.svc"]} for item in LEGACY_GLOBAL
]


def parse(value: str | None, source: str) -> list[dict]:
    if not value or not value.strip():
        return []
    result = yaml.safe_load(value)
    if not isinstance(result, list) or not all(isinstance(item, dict) for item in result):
        raise ValueError(f"{source} resource.inclusions must be a list of objects")
    return result


def canonical(value: dict) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def render(existing_path: pathlib.Path, required_path: pathlib.Path, management_cluster_url: str) -> dict:
    existing = json.loads(existing_path.read_text())
    required = yaml.safe_load(required_path.read_text())
    if (
        existing.get("kind") != "ConfigMap"
        or existing.get("metadata", {}).get("name") != "argocd-cm"
        or required.get("kind") != "ConfigMap"
        or required.get("metadata", {}).get("name") != "argocd-cm"
    ):
        raise ValueError("resource inclusion inputs must describe argocd-cm")
    parsed_url = urllib.parse.urlsplit(management_cluster_url)
    try:
        address = ipaddress.ip_address(parsed_url.hostname or "")
    except ValueError as error:
        raise ValueError("management cluster URL must use an IP address") from error
    if (
        parsed_url.scheme != "https" or parsed_url.port != 443 or parsed_url.path not in ("", "/")
        or parsed_url.query or parsed_url.fragment or not address.is_private
    ):
        raise ValueError("management cluster URL must be a private HTTPS origin on port 443")
    required_items = parse(required.get("data", {}).get("resource.inclusions"), "required")
    for item in required_items:
        item["clusters"] = [management_cluster_url if value == "__MANAGEMENT_CLUSTER_URL__" else value for value in item["clusters"]]
    merged: list[dict] = []
    seen: set[str] = set()
    legacy = {canonical(item) for item in LEGACY_GLOBAL + LEGACY_SERVICE_ALIAS}
    existing_items = [
        item for item in parse(existing.get("data", {}).get("resource.inclusions"), "existing")
        if canonical(item) not in legacy
    ]
    for item in existing_items + required_items:
        identity = canonical(item)
        if identity not in seen:
            merged.append(item)
            seen.add(identity)
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": "argocd-cm", "namespace": "argocd"},
        "data": {"resource.inclusions": yaml.safe_dump(merged, sort_keys=False)},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--existing", required=True, type=pathlib.Path)
    parser.add_argument("--required", required=True, type=pathlib.Path)
    parser.add_argument("--management-cluster-url", required=True)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output must be new")
    args.output.write_text(yaml.safe_dump(render(args.existing, args.required, args.management_cluster_url), sort_keys=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
