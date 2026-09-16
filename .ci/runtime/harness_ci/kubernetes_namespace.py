"""Build the minimal namespace resource required by one-off CI database Jobs."""

from __future__ import annotations

import re
from typing import Any


NAMESPACE_RE = re.compile(r"^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$")


def build_bootstrap_namespace_manifest(namespace: str, *, service: str, env: str) -> dict[str, Any]:
    if not NAMESPACE_RE.fullmatch(namespace):
        raise ValueError(f"invalid Kubernetes namespace: {namespace}")
    return {
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": {
            "name": namespace,
            "labels": {
                "gitops.clawhub.dev/bootstrap": "db-job",
                "gitops.clawhub.dev/service": service,
                "gitops.clawhub.dev/env": env,
            },
        },
    }
