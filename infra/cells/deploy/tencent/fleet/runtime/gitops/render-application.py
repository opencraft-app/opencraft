#!/usr/bin/env python3
"""Render one evidence-bound Argo Application for a Cell stateless runtime."""

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
CELL = re.compile(r"^actor-[a-z0-9]+-[a-z][0-9]{2}$")


def sha(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def load(path: Path, name: str) -> dict:
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"{name} must be a regular file")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{name} must contain one JSON object")
    return value


def repository_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    local_http = parsed.scheme == "http" and parsed.hostname and parsed.hostname.endswith(".svc.cluster.local")
    if (
        parsed.password or parsed.query or parsed.fragment or not parsed.path
        or not (local_http or (parsed.scheme in {"https", "ssh"} and parsed.hostname and not parsed.username))
    ):
        raise ValueError("runtime publication repository URL is invalid")
    return value


def render(publication_path: Path, desired_path: Path, registration_path: Path) -> dict:
    publication = load(publication_path, "runtime publication receipt")
    desired = load(desired_path, "runtime desired render receipt")
    registration = load(registration_path, "Cell registration receipt")
    if (
        (publication.get("schema"), publication.get("verdict"))
        != ("actor-stateless-runtime-desired-publication/v1", "passed")
    ):
        raise ValueError("runtime publication did not pass")
    if (
        (desired.get("schema"), desired.get("verdict"))
        != ("actor-stateless-runtime-desired-render/v1", "passed")
    ):
        raise ValueError("runtime desired rendering did not pass")
    if registration.get("schemaVersion") != 3 or registration.get("registrationScope") != "production":
        raise ValueError("Cell registration is not a production registration")
    if registration.get("permissions") != {
        "machineSetDelete": False,
        "rivetCellDelete": False,
        "secretRead": False,
        "fdbWorkloadCreate": False,
        "statelessSecretRead": False,
        "statelessWorkloadDelete": False,
    }:
        raise ValueError("Cell registration did not prove the runtime RBAC boundary")
    cell = publication.get("cell")
    if (
        not isinstance(cell, str) or not CELL.fullmatch(cell)
        or desired.get("cell") != cell
        or registration.get("cellId") != cell
    ):
        raise ValueError("runtime Application Cell identities differ")
    if publication.get("renderReceiptSha256") != sha(desired_path) or publication.get("files") != desired.get("files"):
        raise ValueError("runtime publication does not bind the exact rendering")
    repository = publication.get("repository", {})
    registered_repository = registration.get("publicationRepository", {})
    url = repository_url(str(repository.get("url", "")))
    revision = publication.get("gitRevision")
    if (
        not REVISION.fullmatch(str(revision))
        or repository.get("branch") != "main"
        or repository.get("path") != f"runtime-cells/{cell}"
        or registered_repository.get("url") != url
        or registered_repository.get("branch") != "main"
    ):
        raise ValueError("runtime publication and registered repository identities differ")
    server = registration.get("server")
    parsed_server = urllib.parse.urlsplit(str(server))
    if parsed_server.scheme != "https" or not parsed_server.hostname or parsed_server.query or parsed_server.fragment:
        raise ValueError("registered Cell server is invalid")
    secret = registration.get("argoClusterSecret", {})
    if secret.get("name") != f"actor-cell-{cell}" or not secret.get("uid"):
        raise ValueError("registered Argo cluster identity is invalid")
    annotations = {
        "fleet.actor.dev/runtime-publication-receipt-digest": sha(publication_path),
        "fleet.actor.dev/runtime-render-receipt-digest": sha(desired_path),
        "fleet.actor.dev/cell-registration-receipt-digest": sha(registration_path),
        "fleet.actor.dev/argo-cluster-secret-uid": secret["uid"],
        "fleet.actor.dev/git-revision": revision,
    }
    allocated_service_fields = [
        "/spec/clusterIP", "/spec/clusterIPs", "/spec/ipFamilies",
        "/spec/ipFamilyPolicy", "/spec/healthCheckNodePort", "/status",
    ]
    return {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "Application",
        "metadata": {
            "name": f"actor-runtime-{cell}",
            "namespace": "argocd",
            "annotations": annotations,
            "labels": {"fleet.actor.dev/cell-id": cell, "fleet.actor.dev/plane": "stateless-runtime"},
        },
        "spec": {
            "project": "actor-cell-runtime",
            "source": {"repoURL": url, "targetRevision": revision, "path": repository["path"]},
            "destination": {"server": server, "namespace": "actor-stateless-system"},
            "syncPolicy": {
                "automated": {"enabled": True, "prune": False, "selfHeal": True},
                "retry": {"limit": 5, "backoff": {"duration": "5s", "factor": 2, "maxDuration": "1m"}},
                "syncOptions": [
                    "CreateNamespace=false", "FailOnSharedResource=true",
                    "RespectIgnoreDifferences=true", "ServerSideApply=false",
                ],
            },
            "ignoreDifferences": [
                {"group": "apps", "kind": "Deployment", "name": f"{cell}-stateless-executor", "jsonPointers": ["/spec/replicas"]},
                {
                    "group": "", "kind": "Service",
                    "name": f"{cell}-stateless-executor-private",
                    "namespace": "actor-stateless-system",
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--publication-receipt", type=Path, required=True)
    parser.add_argument("--desired-render-receipt", type=Path, required=True)
    parser.add_argument("--cell-registration-receipt", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.output.is_absolute() or args.output.exists() or not args.output.parent.is_dir():
        parser.error("output must be a new absolute path with an existing parent")
    try:
        document = render(args.publication_receipt, args.desired_render_receipt, args.cell_registration_receipt)
        descriptor, staged_name = tempfile.mkstemp(prefix=f".{args.output.name}.", dir=args.output.parent)
        staged = Path(staged_name)
        try:
            os.fchmod(descriptor, 0o644)
            with os.fdopen(descriptor, "w") as stream:
                yaml.safe_dump(document, stream, sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.link(staged, args.output)
        finally:
            try:
                staged.unlink()
            except FileNotFoundError:
                pass
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError, yaml.YAMLError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
