#!/usr/bin/env python3
"""Render a narrow CLS declaration. No cloud, Kubernetes, or Git writes."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml


FIELDS = {
    "schema", "managementId", "clusterId", "region", "logsetId", "topicId", "retentionDays",
    "workload", "namespace", "container", "logSchema", "collectionMode",
}
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def unique_fields(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate CLS binding field")
        result[key] = value
    return result


def render(binding: dict, expected_cluster_id: str) -> dict:
    if not isinstance(binding, dict) or set(binding) != FIELDS:
        raise ValueError("CLS binding must have the exact supported fields")
    if binding["schema"] != "actor-platform-cls-binding/v1":
        raise ValueError("unsupported CLS binding schema")
    if not re.fullmatch(r"cls-[a-z0-9]{8,32}", expected_cluster_id) or binding["clusterId"] != expected_cluster_id:
        raise ValueError("CLS binding belongs to a different or invalid cluster")
    if not isinstance(binding["managementId"], str) or not re.fullmatch(r"actor-[a-z]{2}-c[0-9]{2}", binding["managementId"]):
        raise ValueError("CLS binding has an invalid management identity")
    if not isinstance(binding["region"], str) or not re.fullmatch(r"(?:ap|eu|na|sa|me)-[a-z]+", binding["region"]):
        raise ValueError("CLS binding has an invalid region")
    for field in ("topicId", "logsetId"):
        if not isinstance(binding[field], str) or not UUID.fullmatch(binding[field]):
            raise ValueError("CLS binding must name exact topic and logset UUIDs")
    days = binding["retentionDays"]
    if isinstance(days, bool) or not isinstance(days, (int, float)) or not 1 <= days <= 30 or int(days) != days:
        raise ValueError("CLS retention must be a finite integer from 1 to 30")
    required = {
        "workload": "workers-api", "namespace": "workers-api-system", "container": "workers-api",
        "logSchema": "workers-api-platform-json/v1", "collectionMode": "incremental-warn-error",
    }
    if any(binding[key] != value for key, value in required.items()):
        raise ValueError("CLS binding cannot broaden the audited Workers API scope")
    return {
        "apiVersion": "cls.cloud.tencent.com/v1", "kind": "LogConfig",
        "metadata": {
            "name": f"{binding['managementId']}-workers-api-errors",
            "annotations": {
                "fleet.actor.dev/cluster-id": binding["clusterId"],
                "fleet.actor.dev/platform-log-schema": binding["logSchema"],
            },
        },
        "spec": {
            "inputDetail": {
                "type": "container_stdout",
                "containerStdout": {
                    "allContainers": False,
                    "workloads": [{"kind": "deployment", "name": "workers-api",
                                   "namespace": "workers-api-system", "container": "workers-api"}],
                    "metadataLabels": ["app.kubernetes.io/name"],
                    "metadataContainer": ["namespace", "pod_name", "pod_uid", "container_name", "cluster_id"],
                },
            },
            "clsDetail": {
                "topicId": binding["topicId"], "logsetId": binding["logsetId"], "region": binding["region"],
                "logType": "json_log", "logFormat": "default",
                "extractRule": {
                    "jsonStandard": "true", "unMatchUpload": "false", "backtracking": "0", "isGBK": "false",
                    "filterKeys": ["level"], "filterRegex": ["^(WARN|ERROR)$"],
                },
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binding", type=Path, required=True)
    parser.add_argument("--expected-cluster-id", required=True)
    parser.add_argument("--format", choices=("yaml", "json"), default="yaml")
    args = parser.parse_args()
    try:
        with args.binding.open("rb") as source:
            encoded = source.read(64 * 1024 + 1)
        if len(encoded) > 64 * 1024:
            raise ValueError("CLS binding exceeds the input limit")
        document = render(json.loads(encoded, object_pairs_hook=unique_fields), args.expected_cluster_id)
    except (OSError, ValueError, TypeError, RecursionError) as error:
        # Never echo an untrusted binding or JSON parser excerpt.
        print(f"CLS render rejected: {type(error).__name__}", file=sys.stderr)
        return 2
    if args.format == "json":
        print(json.dumps(document, sort_keys=True, separators=(",", ":")))
    else:
        yaml.safe_dump(document, sys.stdout, sort_keys=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
