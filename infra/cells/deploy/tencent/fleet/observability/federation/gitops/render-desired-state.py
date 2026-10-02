#!/usr/bin/env python3
"""Render the installed, pinned Hub release into a credential-free Argo tree."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import tempfile
from typing import Any

import yaml


SCHEMA = "actor-mesh-observability-desired-render/v1"
CHART_VERSION = "87.21.0"
CHART_SHA256 = "05eae98df0ff6c21877a26a4400780e4bbff248bc3b88694ef8d08b273ed6815"
ADAPTER_CHART_VERSION = "5.3.0"
ADAPTER_CHART_SHA256 = "aa6752b6207ed788522714c3ef7f67f27d423eb4d9512fecb52dc641b6434f31"
NAMESPACE = "mesh-observability"
ALLOWED_CLUSTER_KINDS = {
    ("", "Namespace"),
    ("admissionregistration.k8s.io", "MutatingWebhookConfiguration"),
    ("admissionregistration.k8s.io", "ValidatingWebhookConfiguration"),
    ("apiregistration.k8s.io", "APIService"),
    ("rbac.authorization.k8s.io", "ClusterRole"),
    ("rbac.authorization.k8s.io", "ClusterRoleBinding"),
    ("storage.k8s.io", "StorageClass"),
}
ALLOWED_NAMESPACE_KINDS = {
    ("", "ConfigMap"),
    ("", "Service"),
    ("", "ServiceAccount"),
    ("apps", "Deployment"),
    ("apps", "StatefulSet"),
    ("rbac.authorization.k8s.io", "RoleBinding"),
    ("monitoring.coreos.com", "Prometheus"),
    ("monitoring.coreos.com", "PrometheusRule"),
    ("monitoring.coreos.com", "ServiceMonitor"),
}
EXTERNAL_SECRETS = {
    "actor-fleet-tcr",
    "actor-mesh-observability-admission",
    "actor-mesh-observability-grafana-admin",
    "actor-mesh-observability-prometheus-scrape-confg",
}


def group(document: dict[str, Any]) -> str:
    api_version = document.get("apiVersion", "")
    return api_version.split("/", 1)[0] if "/" in api_version else ""


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def load_documents(paths: list[pathlib.Path]) -> list[dict[str, Any]]:
    documents: list[dict[str, Any]] = []
    for path in paths:
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"manifest input is not a regular file: {path}")
        for item in yaml.safe_load_all(path.read_text()):
            if item is not None:
                if not isinstance(item, dict):
                    raise ValueError(f"manifest contains a non-object document: {path}")
                documents.append(item)
    return documents


def render(
    paths: list[pathlib.Path],
    output: pathlib.Path,
    receipt: pathlib.Path,
    prior_render_receipt: pathlib.Path | None = None,
) -> dict[str, Any]:
    if output.exists() or not output.parent.is_dir() or not output.is_absolute():
        raise ValueError("output must be a new absolute directory")
    if receipt.exists() or not receipt.parent.is_dir() or not receipt.is_absolute():
        raise ValueError("receipt must be a new absolute path")
    if not paths:
        raise ValueError("at least one manifest input is required")
    prior_receipt_digest = None
    inherited_exclusions: set[str] = set()
    if prior_render_receipt is not None:
        if not prior_render_receipt.is_file() or prior_render_receipt.is_symlink():
            raise ValueError("prior render receipt is not a regular file")
        prior = json.loads(prior_render_receipt.read_text())
        base_digest = digest(paths[0].read_bytes())
        inherited_exclusions = set(prior.get("excludedSecrets", []))
        if (
            prior.get("schema") != SCHEMA
            or prior.get("verdict") != "passed"
            or prior.get("hubManifestSha256") != base_digest
            or prior.get("files", {}).get("hub.yaml") != base_digest
            or not inherited_exclusions.issubset(EXTERNAL_SECRETS)
        ):
            raise ValueError("prior desired manifest is not bound by its render receipt")
        prior_receipt_digest = digest(prior_render_receipt.read_bytes())
    documents = load_documents(paths)
    selected: list[dict[str, Any]] = []
    excluded_secrets = set(inherited_exclusions)
    identities: set[tuple[str, str, str, str]] = set()
    for item in documents:
        metadata = item.get("metadata", {})
        kind, api_group, name = item.get("kind", ""), group(item), metadata.get("name", "")
        namespace = metadata.get("namespace", "")
        if kind == "Secret":
            if namespace != NAMESPACE or name not in EXTERNAL_SECRETS:
                raise ValueError(f"unexpected Secret in Hub release: {namespace}/{name}")
            excluded_secrets.add(name)
            continue
        if kind in {"Job", "Pod"}:
            # Helm admission/CRD hooks are bootstrap operations, not steady desired state.
            continue
        identity = (api_group, kind, namespace, name)
        if not name or identity in identities:
            raise ValueError(f"invalid or duplicate resource identity: {identity}")
        identities.add(identity)
        if namespace:
            special = namespace == "kube-system" and api_group == "rbac.authorization.k8s.io" and kind == "RoleBinding" and name == "prometheus-adapter-auth-reader"
            if (namespace != NAMESPACE and not special) or (api_group, kind) not in ALLOWED_NAMESPACE_KINDS:
                raise ValueError(f"unexpected namespaced Hub resource: {identity}")
        elif (api_group, kind) not in ALLOWED_CLUSTER_KINDS:
            raise ValueError(f"unexpected cluster Hub resource: {identity}")
        annotations = metadata.get("annotations") or {}
        metadata["annotations"] = annotations
        annotations.pop("meta.helm.sh/release-name", None)
        annotations.pop("meta.helm.sh/release-namespace", None)
        labels = metadata.get("labels") or {}
        metadata["labels"] = labels
        labels.pop("app.kubernetes.io/managed-by", None)
        selected.append(item)
    # The Grafana credential and image-pull credential are deliberately not
    # rendered by Helm. The scrape config is rendered from values and must be
    # observed and excluded here so it cannot silently enter desired Git.
    required_external = {"actor-mesh-observability-prometheus-scrape-confg"}
    if not required_external.issubset(excluded_secrets):
        raise ValueError("installed release is missing required externally owned Secrets")
    selected.sort(key=lambda item: (
        group(item), item.get("kind", ""), item.get("metadata", {}).get("namespace", ""),
        item.get("metadata", {}).get("name", ""),
    ))
    encoded = yaml.safe_dump_all(selected, explicit_start=True, sort_keys=True).encode()
    evidence = {
        "schema": SCHEMA,
        "verdict": "passed",
        "chart": {"name": "kube-prometheus-stack", "version": CHART_VERSION, "sha256": CHART_SHA256},
        "adapterChart": {"name": "prometheus-adapter", "version": ADAPTER_CHART_VERSION, "sha256": ADAPTER_CHART_SHA256},
        "resourceCount": len(selected),
        "excludedSecrets": sorted(excluded_secrets),
        "priorRenderReceiptSha256": prior_receipt_digest,
        "hubManifestSha256": digest(encoded),
    }
    output.mkdir(mode=0o755)
    (output / "hub.yaml").write_bytes(encoded)
    (output / "kustomization.yaml").write_text(
        "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n- hub.yaml\n"
    )
    inventory = {
        path.name: digest(path.read_bytes())
        for path in sorted(output.iterdir()) if path.is_file()
    }
    evidence["files"] = inventory
    (output / "evidence.json").write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    final = dict(evidence)
    final["files"] = {
        path.name: digest(path.read_bytes())
        for path in sorted(output.iterdir()) if path.is_file()
    }
    descriptor, staged = tempfile.mkstemp(prefix=f".{receipt.name}.", dir=receipt.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(final, stream, indent=2, sort_keys=True)
            stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
        os.link(staged, receipt)
    finally:
        pathlib.Path(staged).unlink(missing_ok=True)
    return final


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, action="append", type=pathlib.Path)
    parser.add_argument("--prior-render-receipt", type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    args = parser.parse_args()
    result = render(args.manifest, args.output, args.receipt, args.prior_render_receipt)
    print(json.dumps({"observabilityDesiredRender": "passed", "resources": result["resourceCount"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
