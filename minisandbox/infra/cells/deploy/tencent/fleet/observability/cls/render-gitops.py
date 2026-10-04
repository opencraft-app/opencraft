#!/usr/bin/env python3
"""Prepare an isolated, inactive Argo CLS Application from an exact local Git tree."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("platform_cls_render", ROOT / "render.py")
RENDER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(RENDER)
REPOSITORY = "http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git"
MAX_INPUT = 64 * 1024


def git(repository: Path, *args: str) -> bytes:
    # This entry only reads a caller-selected trusted clone. No fetch, checkout,
    # hooks, Kubernetes command or external credential lookup is performed.
    environment = {**os.environ, "GIT_NO_REPLACE_OBJECTS": "1", "GIT_TERMINAL_PROMPT": "0"}
    return subprocess.run(
        ["git", "--no-pager", "--no-optional-locks", "-C", str(repository), *args],
        env=environment, check=True, capture_output=True, timeout=10,
    ).stdout


def digest(encoded: bytes) -> str:
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def prepare(repository: Path, revision: str, binding: dict, expected_cluster_id: str) -> list[dict]:
    rule = RENDER.render(binding, expected_cluster_id)
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("CLS revision must be a complete immutable commit")
    if git(repository, "remote", "get-url", "origin").decode().strip() != REPOSITORY:
        raise ValueError("CLS candidate must come from the central desired repository")
    if git(repository, "rev-parse", "--verify", revision + "^{commit}").decode().strip() != revision:
        raise ValueError("CLS revision does not name the exact commit")
    source_path = f"management/cls/{binding['managementId']}"
    leaf = source_path + "/logconfig.json"
    entry = git(repository, "ls-tree", revision, "--", leaf).decode().strip().split()
    if len(entry) != 4 or entry[0] != "100644" or entry[1] != "blob" or entry[3] != leaf:
        raise ValueError("CLS rule must be an exact regular Git file")
    if not 0 < int(git(repository, "cat-file", "-s", entry[2]).strip()) <= MAX_INPUT:
        raise ValueError("CLS rule exceeds the input limit")
    encoded = git(repository, "cat-file", "blob", entry[2])
    candidate = json.loads(encoded, object_pairs_hook=RENDER.unique_fields)
    if json.dumps(candidate, sort_keys=True, allow_nan=False) != json.dumps(rule, sort_keys=True, allow_nan=False):
        raise ValueError("CLS Git candidate differs from the bounded binding rule")
    name = rule["metadata"]["name"]
    annotations = {
        "fleet.actor.dev/cluster-id": expected_cluster_id,
        "fleet.actor.dev/git-revision": revision,
        "fleet.actor.dev/logconfig-digest": digest(encoded),
        "fleet.actor.dev/cls-binding-digest": digest(json.dumps(binding, sort_keys=True, separators=(",", ":")).encode()),
        "fleet.actor.dev/collection-admission": "unqualified",
    }
    project_name = binding["managementId"] + "-platform-logs"
    project = {
        "apiVersion": "argoproj.io/v1alpha1", "kind": "AppProject",
        "metadata": {"name": project_name, "namespace": "argocd", "annotations": annotations},
        "spec": {
            "description": "One platform LogConfig only. Collector and topic are separately owned.",
            "sourceRepos": [REPOSITORY],
            "destinations": [{"server": "https://kubernetes.default.svc", "namespace": "workers-api-system"}],
            "clusterResourceWhitelist": [{"group": "cls.cloud.tencent.com", "kind": "LogConfig", "name": name}],
            # A preparation Project cannot authorize even a manual Sync.
            # Argo's resource blacklist takes precedence over its whitelist.
            "clusterResourceBlacklist": [{"group": "cls.cloud.tencent.com", "kind": "LogConfig", "name": name}],
            "namespaceResourceBlacklist": [{"group": "*", "kind": "*"}],
            "namespaceResourceWhitelist": [],
        },
    }
    application = {
        "apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
        "metadata": {"name": project_name, "namespace": "argocd", "annotations": annotations},
        "spec": {
            "project": project_name,
            "source": {
                "repoURL": REPOSITORY, "targetRevision": revision, "path": source_path,
                "directory": {"recurse": False, "include": "logconfig.json"},
            },
            "destination": {"server": "https://kubernetes.default.svc", "namespace": "workers-api-system"},
            # Auto-sync is disabled independently of the Project deny policy.
            # Removing this option alone never authorizes first collection.
            "syncPolicy": {
                "automated": {"enabled": False, "prune": False, "selfHeal": False},
                "syncOptions": ["CreateNamespace=false", "FailOnSharedResource=true"],
            },
            "revisionHistoryLimit": 5,
        },
    }
    return [project, application]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository-dir", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--binding", type=Path, required=True)
    parser.add_argument("--expected-cluster-id", required=True)
    args = parser.parse_args()
    try:
        with args.binding.open("rb") as source:
            encoded = source.read(MAX_INPUT + 1)
        if len(encoded) > MAX_INPUT:
            raise ValueError("CLS binding exceeds the input limit")
        binding = json.loads(encoded, object_pairs_hook=RENDER.unique_fields)
        documents = prepare(args.repository_dir, args.revision, binding, args.expected_cluster_id)
    except (OSError, ValueError, TypeError, RecursionError, subprocess.SubprocessError) as error:
        # Git stderr and untrusted JSON excerpts are deliberately not emitted.
        print(f"CLS Git preparation rejected: {type(error).__name__}", file=sys.stderr)
        return 2
    yaml.safe_dump_all(documents, sys.stdout, explicit_start=True, sort_keys=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
