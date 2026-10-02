#!/usr/bin/env python3
"""Render the bootstrap-owned Argo project and regional code-plane Application."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import urllib.parse
from pathlib import Path

import yaml


REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")


def sha(path: Path) -> str: return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def render(publication_path: Path, desired_path: Path):
    publication, desired = (json.loads(path.read_text()) for path in (publication_path, desired_path))
    if (publication.get("schema"), publication.get("verdict")) != ("actor-regional-code-plane-desired-publication/v1", "passed"):
        raise ValueError("code-plane publication did not pass")
    if (desired.get("schema"), desired.get("verdict")) != ("actor-regional-code-plane-desired-render/v1", "passed"):
        raise ValueError("code-plane desired rendering did not pass")
    if publication.get("renderReceiptSha256") != sha(desired_path) or publication.get("files") != desired.get("files"):
        raise ValueError("publication does not bind the desired rendering")
    repository = publication.get("repository", {})
    url, revision = repository.get("url", ""), publication.get("gitRevision", "")
    parsed = urllib.parse.urlsplit(url)
    if not (parsed.scheme == "http" and parsed.hostname and parsed.hostname.endswith(".svc.cluster.local") and not parsed.username) or not REVISION.fullmatch(revision):
        raise ValueError("publication repository identity is invalid")
    annotations = {
        "fleet.actor.dev/publication-receipt-digest": sha(publication_path),
        "fleet.actor.dev/desired-render-receipt-digest": sha(desired_path),
        "fleet.actor.dev/git-revision": revision,
    }
    project = {
        "apiVersion": "argoproj.io/v1alpha1", "kind": "AppProject",
        "metadata": {"name": "actor-regional-code-plane", "namespace": "argocd", "annotations": annotations},
        "spec": {
            "sourceRepos": [url],
            "destinations": [{"server": "https://kubernetes.default.svc", "namespace": name} for name in ("actor-fdb-cell-system", "worker-registry-system")],
            "clusterResourceWhitelist": [{"group": "", "kind": "Namespace"}],
            "namespaceResourceWhitelist": [
                {"group": "", "kind": kind} for kind in ("ServiceAccount", "Service")
            ] + [{"group": "apps", "kind": "Deployment"}, {"group": "policy", "kind": "PodDisruptionBudget"}] + [
                {"group": "apps.foundationdb.org", "kind": kind} for kind in ("FoundationDBCluster", "FoundationDBBackup")
            ],
            "orphanedResources": {"warn": True, "ignore": [{"group": "", "kind": "Secret", "name": "*"}]},
        },
    }
    allocated = ["/spec/clusterIP", "/spec/clusterIPs", "/spec/ipFamilies", "/spec/ipFamilyPolicy", "/spec/healthCheckNodePort", "/status"]
    application = {
        "apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
        "metadata": {"name": "actor-regional-code-plane", "namespace": "argocd", "annotations": annotations},
        "spec": {
            "project": "actor-regional-code-plane",
            "source": {"repoURL": url, "targetRevision": revision, "path": repository.get("path")},
            "destination": {"server": "https://kubernetes.default.svc", "namespace": "worker-registry-system"},
            "syncPolicy": {"automated": {"enabled": True, "prune": False, "selfHeal": True}, "syncOptions": ["CreateNamespace=false", "FailOnSharedResource=true", "RespectIgnoreDifferences=true", "ServerSideApply=false"]},
            "ignoreDifferences": [
                {"group": "apps.foundationdb.org", "kind": "FoundationDBCluster", "jsonPointers": ["/status"]},
                {"group": "apps.foundationdb.org", "kind": "FoundationDBBackup", "jsonPointers": ["/status"]},
                {"group": "", "kind": "Service", "name": "worker-registry-private", "namespace": "worker-registry-system", "jsonPointers": allocated, "jqPathExpressions": [".spec.ports[]?.nodePort", '.metadata.annotations."service.kubernetes.io/loadbalance-id"', '.metadata.annotations."service.kubernetes.io/loadbalancer-current-protection"', '.metadata.annotations."service.kubernetes.io/qcloud-loadbalancer-client-token"', '.metadata.annotations."service.kubernetes.io/qcloud-loadbalancer-sync-begin-time"', '.metadata.annotations."service.kubernetes.io/qcloud-loadbalancer-sync-end-time"']},
            ],
            "revisionHistoryLimit": 20,
        },
    }
    if application["spec"]["source"]["path"] != "management/code-plane": raise ValueError("publication path is invalid")
    return [project, application]


def main() -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("--publication-receipt",type=Path,required=True); parser.add_argument("--desired-render-receipt",type=Path,required=True); parser.add_argument("--output",type=Path,required=True); args=parser.parse_args()
    if not args.output.is_absolute() or args.output.exists() or not args.output.parent.is_dir(): parser.error("output must be a new absolute path")
    try: documents=render(args.publication_receipt,args.desired_render_receipt)
    except (OSError,ValueError,KeyError,json.JSONDecodeError) as error: parser.error(str(error))
    descriptor,staged=tempfile.mkstemp(prefix=f".{args.output.name}.",dir=args.output.parent)
    try:
        os.fchmod(descriptor,0o644)
        with os.fdopen(descriptor,"w") as stream: yaml.safe_dump_all(documents,stream,explicit_start=True,sort_keys=True); stream.flush(); os.fsync(stream.fileno())
        os.link(staged,args.output)
    finally:
        try: os.unlink(staged)
        except FileNotFoundError: pass
    return 0


if __name__ == "__main__": raise SystemExit(main())
