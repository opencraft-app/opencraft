#!/usr/bin/env python3
"""Verify an exact LogConfig server-side dry-run without enabling collection."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("cls_preflight_render", ROOT / "render.py")
RENDER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(RENDER)
MAX_RESPONSE = 8 * 1024 * 1024


class Rejected(ValueError):
    """A code-defined, non-sensitive preflight rejection."""


def encoded(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def request(kubectl: str, kubeconfig: Path, *arguments: str) -> tuple[dict, bytes]:
    try:
        result = subprocess.run(
            [kubectl, "--kubeconfig", str(kubeconfig), "--request-timeout=15s", *arguments],
            check=True, capture_output=True, timeout=30,
        )
        if not 0 < len(result.stdout) <= MAX_RESPONSE:
            raise Rejected("response_size_invalid")
        value = json.loads(result.stdout, object_pairs_hook=RENDER.unique_fields)
        if not isinstance(value, dict):
            raise Rejected("response_shape_invalid")
        return value, result.stdout
    except (subprocess.SubprocessError, OSError):
        # Kubernetes stderr can contain identities, admission messages or URLs.
        raise Rejected("kubernetes_request_failed") from None


def cluster_identity(kubectl: str, kubeconfig: Path, expected_uid: str) -> None:
    namespace, _ = request(kubectl, kubeconfig, "get", "namespace", "kube-system", "-o", "json")
    if (namespace.get("apiVersion") != "v1" or namespace.get("kind") != "Namespace"
            or namespace.get("metadata", {}).get("name") != "kube-system"
            or namespace.get("metadata", {}).get("uid") != expected_uid
            or namespace.get("metadata", {}).get("deletionTimestamp") is not None):
        raise Rejected("cluster_identity_changed")


def preflight(binding: dict, expected_cluster: str, expected_uid: str,
              kubeconfig: Path, kubectl: str) -> dict:
    rule = RENDER.render(binding, expected_cluster)
    if not RENDER.UUID.fullmatch(expected_uid):
        raise Rejected("expected_cluster_uid_invalid")
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    cluster_identity(kubectl, kubeconfig, expected_uid)
    crd, crd_bytes = request(kubectl, kubeconfig, "get", "customresourcedefinition",
                             "logconfigs.cls.cloud.tencent.com", "-o", "json")
    definition = crd.get("spec", {})
    conditions = {item.get("type"): item.get("status") for item in crd.get("status", {}).get("conditions", [])}
    versions = [item for item in definition.get("versions", []) if item.get("name") == "v1"]
    if (crd.get("kind") != "CustomResourceDefinition"
            or crd.get("apiVersion") != "apiextensions.k8s.io/v1"
            or crd.get("metadata", {}).get("name") != "logconfigs.cls.cloud.tencent.com"
            or not RENDER.UUID.fullmatch(crd.get("metadata", {}).get("uid", ""))
            or crd.get("metadata", {}).get("deletionTimestamp") is not None
            or definition.get("group") != "cls.cloud.tencent.com"
            or definition.get("scope") != "Cluster"
            or definition.get("names", {}).get("kind") != "LogConfig"
            or definition.get("names", {}).get("plural") != "logconfigs"
            or len(versions) != 1 or versions[0].get("served") is not True
            or conditions.get("Established") != "True" or conditions.get("NamesAccepted") != "True"):
        raise Rejected("logconfig_crd_unready")
    with tempfile.TemporaryDirectory(prefix="cls-rule-preflight-") as directory:
        candidate = Path(directory) / "logconfig.json"
        candidate.write_bytes(encoded(rule))
        observed, _ = request(kubectl, kubeconfig, "create", "--dry-run=server", "--validate=strict",
                              "-f", str(candidate), "-o", "json")
    metadata = observed.get("metadata", {})
    if (observed.get("apiVersion") != rule["apiVersion"] or observed.get("kind") != rule["kind"]
            or metadata.get("name") != rule["metadata"]["name"] or metadata.get("namespace") not in (None, "")
            or metadata.get("annotations") != rule["metadata"]["annotations"]
            or metadata.get("labels", {}) or metadata.get("ownerReferences", []) or metadata.get("finalizers", [])
            or encoded(observed.get("spec")) != encoded(rule["spec"])):
        raise Rejected("logconfig_roundtrip_changed")
    latest_crd, latest_crd_bytes = request(kubectl, kubeconfig, "get", "customresourcedefinition",
                                         "logconfigs.cls.cloud.tencent.com", "-o", "json")
    if (latest_crd.get("apiVersion") != crd["apiVersion"] or latest_crd.get("kind") != crd["kind"]
            or latest_crd.get("metadata", {}).get("uid") != crd["metadata"]["uid"]
            or latest_crd.get("metadata", {}).get("deletionTimestamp") is not None
            or encoded(latest_crd.get("spec")) != encoded(definition)
            or encoded(latest_crd.get("status")) != encoded(crd.get("status"))):
        raise Rejected("logconfig_crd_changed")
    cluster_identity(kubectl, kubeconfig, expected_uid)
    return {
        "schema": "actor-platform-cls-rule-preflight/v1",
        "claim": "server-side-logconfig-roundtrip-only", "verdict": "passed",
        "collectionAdmission": "unqualified", "canaryAuthorized": False,
        "clusterId": expected_cluster, "kubeSystemNamespaceUid": expected_uid,
        "ruleName": rule["metadata"]["name"], "bindingDigest": digest(encoded(binding)),
        "ruleDigest": digest(encoded(rule)), "crdUid": crd["metadata"]["uid"],
        "crdResponseDigest": digest(crd_bytes),
        "crdFinalResponseDigest": digest(latest_crd_bytes),
        "observationsStartedAt": started,
        "observationsCompletedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binding", type=Path, required=True)
    parser.add_argument("--expected-cluster-id", required=True)
    parser.add_argument("--expected-kube-system-uid", required=True)
    parser.add_argument("--kubeconfig", type=Path, required=True)
    parser.add_argument("--kubectl", default="kubectl")
    args = parser.parse_args()
    try:
        with args.binding.open("rb") as source:
            raw = source.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            raise Rejected("binding_size_invalid")
        binding = json.loads(raw, object_pairs_hook=RENDER.unique_fields)
        result = preflight(binding, args.expected_cluster_id, args.expected_kube_system_uid,
                           args.kubeconfig, args.kubectl)
    except Rejected as error:
        print(f"CLS rule preflight rejected: {error}", file=sys.stderr)
        return 2
    except (OSError, ValueError, TypeError, AttributeError, RecursionError):
        print("CLS rule preflight rejected: input_invalid", file=sys.stderr)
        return 2
    print(encoded(result).decode())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
