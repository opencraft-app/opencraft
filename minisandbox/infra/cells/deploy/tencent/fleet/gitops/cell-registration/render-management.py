#!/usr/bin/env python3
"""Render least-privilege Cell Argo projects and infrastructure ApplicationSet."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

import yaml


REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def validate_repo_url(value: str) -> str:
    parsed = urlsplit(value)
    internal_http = parsed.scheme == "http" and parsed.hostname is not None and parsed.hostname.endswith(
        ".svc.cluster.local"
    )
    if (parsed.scheme not in {"https", "ssh", "git"} and not internal_http) or not parsed.hostname:
        raise ValueError(
            "repository URL must use https, ssh, git, or cluster-local HTTP with an explicit host"
        )
    if parsed.password or parsed.query or parsed.fragment:
        raise ValueError("repository URL must not contain a password, query, or fragment")
    return value


def resources(
    repo_url: str,
    path_prefix: str,
    platform_receipt_digest: str,
    management_git_receipt_digest: str,
    cluster_uid: str,
) -> list[dict]:
    if not re.fullmatch(r"[a-zA-Z0-9._/-]+", path_prefix) or path_prefix.startswith(("/", "../")):
        raise ValueError("path prefix must be a safe repository-relative path")
    if (
        not DIGEST.fullmatch(platform_receipt_digest)
        or not DIGEST.fullmatch(management_git_receipt_digest)
        or not cluster_uid
    ):
        raise ValueError("management platform/Git receipt digests and cluster UID are required")
    platform_annotations = {
        "fleet.actor.dev/management-platform-receipt-digest": platform_receipt_digest,
        "fleet.actor.dev/management-git-receipt-digest": management_git_receipt_digest,
        "fleet.actor.dev/management-cluster-uid": cluster_uid,
    }
    project = {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "AppProject",
        "metadata": {"name": "actor-cell-bootstrap", "namespace": "argocd", "annotations": platform_annotations},
        "spec": {
            "description": "Credential-free Cell desired state; live capacity and admission remain controller-owned.",
            "sourceRepos": [repo_url],
            "destinations": [{"server": "*", "namespace": "actor-fdb-cell-system"}],
            "clusterResourceWhitelist": [
                {"group": "node.tke.cloud.tencent.com", "kind": "MachineSet"},
            ],
            "namespaceResourceWhitelist": [
                {"group": "fleet.actor.dev", "kind": "RivetCell"},
            ],
            "orphanedResources": {"warn": True},
        },
    }
    runtime_project = {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "AppProject",
        "metadata": {
            "name": "actor-cell-runtime", "namespace": "argocd",
            "annotations": platform_annotations,
        },
        "spec": {
            "description": "Unprivileged stateless runtime desired state; no cluster-scoped resources.",
            "sourceRepos": [repo_url],
            "destinations": [{"server": "*", "namespace": "actor-stateless-system"}],
            "clusterResourceWhitelist": [],
            "namespaceResourceWhitelist": [
                {"group": "", "kind": "ServiceAccount"},
                {"group": "", "kind": "Service"},
                {"group": "apps", "kind": "Deployment"},
                {"group": "policy", "kind": "PodDisruptionBudget"},
                {"group": "autoscaling", "kind": "HorizontalPodAutoscaler"},
                {"group": "cloud.tencent.com", "kind": "TkeServiceConfig"},
            ],
            "orphanedResources": {"warn": True},
        },
    }
    appset = {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "ApplicationSet",
        "metadata": {"name": "actor-cells", "namespace": "argocd", "annotations": platform_annotations},
        "spec": {
            "goTemplate": True,
            "goTemplateOptions": ["missingkey=error"],
            "syncPolicy": {"preserveResourcesOnDeletion": True},
            "generators": [
                {
                    "clusters": {
                        "selector": {
                            "matchLabels": {
                                "fleet.actor.dev/managed-cell": "true",
                                "fleet.actor.dev/desired-state": "published",
                                "fleet.actor.dev/registration-scope": "production",
                            }
                        }
                    }
                }
            ],
            "template": {
                "metadata": {
                    "name": 'actor-cell-{{.nameNormalized}}',
                    "namespace": "argocd",
                    "annotations": {
                        "fleet.actor.dev/inventory-digest": '{{index .metadata.annotations "fleet.actor.dev/inventory-digest"}}',
                        "fleet.actor.dev/handoff-receipt-digest": '{{index .metadata.annotations "fleet.actor.dev/handoff-receipt-digest"}}',
                        "fleet.actor.dev/publication-receipt-digest": '{{index .metadata.annotations "fleet.actor.dev/publication-receipt-digest"}}',
                        "fleet.actor.dev/image-inventory-digest": '{{index .metadata.annotations "fleet.actor.dev/image-inventory-digest"}}',
                        "fleet.actor.dev/profile-digest": '{{index .metadata.annotations "fleet.actor.dev/profile-digest"}}',
                        "fleet.actor.dev/platform-receipt-digest": '{{index .metadata.annotations "fleet.actor.dev/platform-receipt-digest"}}',
                        "fleet.actor.dev/cluster-uid": '{{index .metadata.annotations "fleet.actor.dev/cluster-uid"}}',
                    },
                },
                "spec": {
                    "project": "actor-cell-bootstrap",
                    "source": {
                        "repoURL": repo_url,
                        "targetRevision": '{{index .metadata.annotations "fleet.actor.dev/git-revision"}}',
                        "path": path_prefix + '/{{index .metadata.labels "fleet.actor.dev/cell-id"}}',
                    },
                    "destination": {"server": "{{.server}}", "namespace": "actor-fdb-cell-system"},
                    "syncPolicy": {
                        "automated": {"enabled": True, "prune": False, "selfHeal": True},
                        "retry": {
                            "limit": 5,
                            "backoff": {"duration": "5s", "factor": 2, "maxDuration": "1m"},
                        },
                        "syncOptions": [
                            "CreateNamespace=false",
                            "FailOnSharedResource=true",
                            "RespectIgnoreDifferences=true",
                            # Tencent's MachineSet API rejects Argo 3.5's
                            # server-side apply request because it receives an
                            # empty fieldManager. Client-side apply is required
                            # for this provider CRD.
                            "ServerSideApply=false",
                        ],
                    },
                    "ignoreDifferences": [
                        {
                            "group": "node.tke.cloud.tencent.com",
                            "kind": "MachineSet",
                            # TKE's Native provider defaults these fields and
                            # injects discovery metadata after creation. Actor
                            # controllers still own replicas and node lifecycle;
                            # Argo owns the submitted placement/template fields.
                            "jsonPointers": [
                                "/metadata/annotations",
                                "/spec/replicas",
                                "/spec/deletePolicy",
                                "/spec/healthCheckPolicyName",
                                "/spec/machineUpdateStrategy",
                                "/spec/selector",
                                "/spec/template/metadata/annotations/node.tke.cloud.tencent.com~1cluster-cloud-tags",
                                "/spec/template/metadata/labels",
                                "/spec/template/spec/gpuConfig",
                                "/spec/template/spec/providerSpec/value/lifecycle",
                                "/spec/template/spec/providerSpec/value/management",
                                "/spec/template/spec/providerSpec/value/metadata",
                                "/spec/template/spec/providerSpec/value/systemDisk/DiskPartition",
                                "/spec/template/spec/unschedulable",
                            ],
                            # The API drops an explicitly empty control-pool
                            # taint list. Non-empty FDB/runtime taints remain
                            # visible to Argo and therefore enforced.
                            "jqPathExpressions": [
                                ".spec.template.spec.taints | select(. == [])",
                            ],
                        },
                        {
                            "group": "node.tke.cloud.tencent.com",
                            "kind": "MachineSet",
                            "name": "np-fdbpool0",
                            # The fleet controller owns this floor together
                            # with replicas. Argo must not reset a DR reserve
                            # to Terraform's initial nine-node floor.
                            "jsonPointers": ["/spec/scaling/minReplicas"],
                        },
                        {"group": "fleet.actor.dev", "kind": "RivetCell", "jsonPointers": ["/spec/desiredState", "/status"]},
                    ],
                    "revisionHistoryLimit": 20,
                },
            },
        },
    }
    return [project, runtime_project, appset]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-url", required=True)
    parser.add_argument("--path-prefix", default="cells")
    parser.add_argument("--platform-receipt-digest", required=True)
    parser.add_argument("--management-git-receipt-digest", required=True)
    parser.add_argument("--cluster-uid", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo_url = validate_repo_url(args.repo_url)
    documents = resources(
        repo_url, args.path_prefix.rstrip("/"), args.platform_receipt_digest,
        args.management_git_receipt_digest, args.cluster_uid,
    )
    if args.output.exists():
        raise ValueError("refusing to overwrite management rendering")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(yaml.safe_dump_all(documents, explicit_start=True, sort_keys=True))
    print(json.dumps({"output": str(args.output.resolve()), "resources": len(documents)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
