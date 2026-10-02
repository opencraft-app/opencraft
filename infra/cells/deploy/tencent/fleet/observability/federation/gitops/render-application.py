#!/usr/bin/env python3
"""Render a least-privilege Argo project and pinned Hub observability Application."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import urllib.parse

import yaml


REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")


def validate_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "http" or not parsed.hostname.endswith(".svc.cluster.local") or parsed.username or parsed.password:
        raise ValueError("observability repository must be credential-free cluster-local HTTP")
    return value


def render(repository: str, revision: str) -> list[dict]:
    repository = validate_url(repository)
    if not REVISION.fullmatch(revision):
        raise ValueError("invalid immutable Git revision")
    project = {
        "apiVersion": "argoproj.io/v1alpha1", "kind": "AppProject",
        "metadata": {"name": "actor-management-observability", "namespace": "argocd"},
        "spec": {
            "description": "Least-privilege management-owned fleet observability",
            "sourceRepos": [repository],
            "destinations": [
                {"server": "https://kubernetes.default.svc", "namespace": "mesh-observability"},
                {"server": "https://kubernetes.default.svc", "namespace": "kube-system"},
                {"server": "https://kubernetes.default.svc", "namespace": ""},
            ],
            "clusterResourceWhitelist": [
                {"group": "", "kind": "Namespace"},
                {"group": "admissionregistration.k8s.io", "kind": "MutatingWebhookConfiguration"},
                {"group": "admissionregistration.k8s.io", "kind": "ValidatingWebhookConfiguration"},
                {"group": "apiregistration.k8s.io", "kind": "APIService"},
                {"group": "rbac.authorization.k8s.io", "kind": "ClusterRole"},
                {"group": "rbac.authorization.k8s.io", "kind": "ClusterRoleBinding"},
                {"group": "storage.k8s.io", "kind": "StorageClass"},
            ],
            "namespaceResourceWhitelist": [
                {"group": "", "kind": "ConfigMap"}, {"group": "", "kind": "Service"},
                {"group": "", "kind": "ServiceAccount"},
                {"group": "apps", "kind": "Deployment"}, {"group": "apps", "kind": "StatefulSet"},
                {"group": "rbac.authorization.k8s.io", "kind": "RoleBinding"},
                {"group": "monitoring.coreos.com", "kind": "Prometheus"},
                {"group": "monitoring.coreos.com", "kind": "PrometheusRule"},
                {"group": "monitoring.coreos.com", "kind": "ServiceMonitor"},
            ],
            "orphanedResources": {"warn": True, "ignore": [
                {"group": "", "kind": "Secret", "name": name} for name in (
                    "actor-fleet-tcr", "actor-mesh-observability-admission",
                    "actor-mesh-observability-grafana-admin",
                    "actor-mesh-observability-prometheus-scrape-confg",
                    "prometheus-actor-mesh-observability-prometheus",
                    "prometheus-actor-mesh-observability-prometheus-thanos-prometheus-http-client-file",
                    "prometheus-actor-mesh-observability-prometheus-tls-assets-0",
                    "prometheus-actor-mesh-observability-prometheus-web-config",
                )
            ]},
        },
    }
    application = {
        "apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
        "metadata": {"name": "actor-management-observability", "namespace": "argocd"},
        "spec": {
            "project": "actor-management-observability",
            "source": {"repoURL": repository, "targetRevision": revision, "path": "management/observability"},
            "destination": {"server": "https://kubernetes.default.svc", "namespace": "mesh-observability"},
            "syncPolicy": {"automated": {"enabled": True, "prune": True, "selfHeal": True},
                           "retry": {"limit": 5, "backoff": {"duration": "5s", "factor": 2, "maxDuration": "1m"}},
                           "syncOptions": ["ServerSideApply=true", "RespectIgnoreDifferences=true", "PruneLast=true"]},
            "ignoreDifferences": [
                {"group": "admissionregistration.k8s.io", "kind": kind,
                 "jqPathExpressions": [".webhooks[]?.clientConfig.caBundle"]}
                for kind in ("MutatingWebhookConfiguration", "ValidatingWebhookConfiguration")
            ],
            "revisionHistoryLimit": 20,
        },
    }
    return [project, application]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    if not args.output.is_absolute() or args.output.exists() or not args.output.parent.is_dir():
        parser.error("output must be a new absolute path")
    args.output.write_text(yaml.safe_dump_all(render(args.repository, args.revision), explicit_start=True, sort_keys=True))
    print(json.dumps({"observabilityApplication": "rendered", "revision": args.revision}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
