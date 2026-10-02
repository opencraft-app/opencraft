#!/usr/bin/env python3
"""Render the bootstrap-owned Argo project and pinned Workers API Application."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import tempfile
import urllib.parse
from typing import Any

import yaml


REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
APPLICATION = "actor-management-workers-api"
PROJECT = "actor-management-workloads"
ROUTE_NAME = re.compile(r"^actor-cell-(?:serving-)?route-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
CREDENTIAL_NAME = re.compile(r"^workers-api-internal-token-[0-9a-f]{12}$")


def sha256(path: pathlib.Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def validate_repository(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.password or parsed.query or parsed.fragment or not parsed.hostname or not parsed.path:
        raise ValueError("publication repository URL is unsafe")
    internal_http = parsed.scheme == "http" and parsed.hostname.endswith(".svc.cluster.local")
    if parsed.scheme == "https" and not parsed.username:
        return value
    if parsed.scheme == "ssh":
        return value
    if internal_http and not parsed.username:
        return value
    raise ValueError("publication repository must be credential-free HTTPS/SSH or cluster-local HTTP")


def render(publication_path: pathlib.Path, desired_render_path: pathlib.Path) -> list[dict[str, Any]]:
    publication = json.loads(publication_path.read_text())
    desired_render = json.loads(desired_render_path.read_text())
    if (publication.get("schema"), publication.get("verdict")) != (
        "actor-management-workers-api-desired-publication/v1", "passed",
    ):
        raise ValueError("Workers API desired-state publication did not pass")
    if (desired_render.get("schema"), desired_render.get("verdict")) != (
        "actor-management-workers-api-desired-render/v1", "passed",
    ):
        raise ValueError("Workers API desired-state rendering did not pass")
    if publication.get("renderReceiptSha256") != sha256(desired_render_path):
        raise ValueError("publication does not bind the exact desired-state rendering")
    if publication.get("files") != desired_render.get("files"):
        raise ValueError("publication file inventory differs from desired-state rendering")
    repository = publication.get("repository", {})
    repo_url = validate_repository(repository.get("url", ""))
    revision = publication.get("gitRevision", "")
    if (
        not REVISION.fullmatch(revision)
        or repository.get("branch") != "main"
        or repository.get("path") != "management/workers-api"
    ):
        raise ValueError("publication repository identity is invalid")
    evidence = {
        "fleet.actor.dev/publication-receipt-digest": sha256(publication_path),
        "fleet.actor.dev/desired-render-receipt-digest": sha256(desired_render_path),
        "fleet.actor.dev/git-revision": revision,
    }
    sources = desired_render.get("sources", {})
    phase = sources.get("phase")
    if phase not in {"object-router-bootstrap", "serving"}:
        raise ValueError("desired rendering has an invalid release phase")
    routes = sources.get("externalRouteConfigMaps", [])
    credential_name = sources.get("externalCredentialName", "")
    expected_route_count = 2 if phase == "object-router-bootstrap" else 4
    if (
        not isinstance(routes, list)
        or len(routes) != expected_route_count
        or routes != sorted(set(routes))
        or not all(isinstance(name, str) and ROUTE_NAME.fullmatch(name) for name in routes)
        or not CREDENTIAL_NAME.fullmatch(credential_name)
    ):
        raise ValueError("desired rendering has no exact external route and credential inventory")
    project = {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "AppProject",
        "metadata": {"name": PROJECT, "namespace": "argocd", "annotations": evidence},
        "spec": {
            "description": "Credential-free management workloads admitted by product qualification.",
            "sourceRepos": [repo_url],
            "destinations": [{"server": "https://kubernetes.default.svc", "namespace": "workers-api-system"}],
            "clusterResourceWhitelist": [
                {"group": "", "kind": "Namespace"},
                {"group": "rbac.authorization.k8s.io", "kind": "ClusterRole"},
                {"group": "rbac.authorization.k8s.io", "kind": "ClusterRoleBinding"},
            ],
            "namespaceResourceWhitelist": [
                {"group": "", "kind": "ServiceAccount"},
                {"group": "", "kind": "ConfigMap"},
                {"group": "", "kind": "Service"},
                {"group": "apps", "kind": "Deployment"},
                {"group": "autoscaling", "kind": "HorizontalPodAutoscaler"},
                {"group": "policy", "kind": "PodDisruptionBudget"},
                {"group": "rbac.authorization.k8s.io", "kind": "Role"},
                {"group": "rbac.authorization.k8s.io", "kind": "RoleBinding"},
            ],
            "orphanedResources": {
                "warn": True,
                "ignore": [
                    {"group": "", "kind": "Secret", "name": "actor-fleet-tcr"},
                    {"group": "", "kind": "Secret", "name": "workers-api-internal-token"},
                    {"group": "", "kind": "Secret", "name": credential_name},
                    *({"group": "", "kind": "ConfigMap", "name": name} for name in routes),
                ],
            },
        },
    }
    allocated_service_fields = [
        "/spec/clusterIP", "/spec/clusterIPs", "/spec/ipFamilies", "/spec/ipFamilyPolicy",
        "/spec/healthCheckNodePort", "/status",
    ]
    application = {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "Application",
        "metadata": {
            "name": APPLICATION,
            "namespace": "argocd",
            "annotations": evidence,
        },
        "spec": {
            "project": PROJECT,
            "source": {"repoURL": repo_url, "targetRevision": revision, "path": repository["path"]},
            "destination": {"server": "https://kubernetes.default.svc", "namespace": "workers-api-system"},
            "syncPolicy": {
                "automated": {"enabled": True, "prune": True, "selfHeal": True},
                "retry": {"limit": 5, "backoff": {"duration": "5s", "factor": 2, "maxDuration": "1m"}},
                "syncOptions": [
                    "CreateNamespace=false", "FailOnSharedResource=true", "RespectIgnoreDifferences=true",
                    "PruneLast=true", "ServerSideApply=false",
                ],
            },
            "ignoreDifferences": [
                {
                    "group": "apps", "kind": "Deployment", "name": "workers-api", "namespace": "workers-api-system",
                    "jsonPointers": ["/spec/replicas"],
                },
                {
                    "group": "", "kind": "Service", "name": "workers-api", "namespace": "workers-api-system",
                    "jsonPointers": allocated_service_fields,
                    "jqPathExpressions": [".spec.ports[]?.nodePort"],
                },
                {
                    "group": "", "kind": "Service", "name": "workers-object-router", "namespace": "workers-api-system",
                    "jsonPointers": allocated_service_fields,
                    "jqPathExpressions": [".spec.ports[]?.nodePort"],
                },
                {
                    "group": "", "kind": "Service", "name": "workers-api-private", "namespace": "workers-api-system",
                    "jsonPointers": allocated_service_fields,
                    "jqPathExpressions": [
                        ".spec.ports[]?.nodePort",
                        '.metadata.annotations."service.kubernetes.io/loadbalance-id"',
                        '.metadata.annotations."service.kubernetes.io/loadbalancer-current-protection"',
                        '.metadata.annotations."service.kubernetes.io/qcloud-loadbalancer-client-token"',
                        '.metadata.annotations."service.kubernetes.io/qcloud-loadbalancer-sync-begin-time"',
                        '.metadata.annotations."service.kubernetes.io/qcloud-loadbalancer-sync-end-time"',
                    ],
                },
                {
                    "group": "", "kind": "Service", "name": "workers-object-router-private", "namespace": "workers-api-system",
                    "jsonPointers": allocated_service_fields,
                    "jqPathExpressions": [
                        ".spec.ports[]?.nodePort",
                        '.metadata.annotations."service.kubernetes.io/loadbalance-id"',
                        '.metadata.annotations."service.kubernetes.io/loadbalancer-current-protection"',
                        '.metadata.annotations."service.kubernetes.io/qcloud-loadbalancer-client-token"',
                        '.metadata.annotations."service.kubernetes.io/qcloud-loadbalancer-sync-begin-time"',
                        '.metadata.annotations."service.kubernetes.io/qcloud-loadbalancer-sync-end-time"',
                    ],
                },
            ],
            "revisionHistoryLimit": 20,
        },
    }
    return [project, application]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--publication-receipt", required=True, type=pathlib.Path)
    parser.add_argument("--desired-render-receipt", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if any(not path.is_file() or path.is_symlink() for path in (args.publication_receipt, args.desired_render_receipt)):
        parser.error("application inputs must be regular non-symlink files")
    if not args.output.is_absolute() or args.output.exists() or not args.output.parent.is_dir():
        parser.error("output must be a new absolute path with an existing parent")
    documents = render(args.publication_receipt, args.desired_render_receipt)
    encoded = yaml.safe_dump_all(documents, explicit_start=True, sort_keys=True)
    descriptor, staged = tempfile.mkstemp(prefix=f".{args.output.name}.", dir=args.output.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(encoded); stream.flush(); os.fsync(stream.fileno())
        os.link(staged, args.output)
    finally:
        pathlib.Path(staged).unlink(missing_ok=True)
    print(json.dumps({"application": APPLICATION, "output": str(args.output), "revision": documents[1]["spec"]["source"]["targetRevision"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
