#!/usr/bin/env python3
import json
import sys
from pathlib import Path

import yaml


def replace_tree(value, old, new):
    if isinstance(value, str):
        return value.replace(old, new)
    if isinstance(value, list):
        return [replace_tree(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: replace_tree(item, old, new) for key, item in value.items()}
    return value


def main():
    if len(sys.argv) != 5:
        raise SystemExit(
            "usage: render.py INPUT_YAML QUALIFICATION_CELL FDB_CLUSTER OUTPUT_YAML"
        )
    source, cell, fdb_cluster, output = sys.argv[1:]
    source_cell = "local-runtime-a"
    selected = []
    for document in yaml.safe_load_all(Path(source).read_text()):
        if not document:
            continue
        kind = document.get("kind")
        name = document.get("metadata", {}).get("name")
        if (kind, name) not in {
            ("ServiceAccount", f"{source_cell}-runtime"),
            ("ConfigMap", f"{source_cell}-runtime-config"),
            ("Service", f"{source_cell}-engine"),
            ("Deployment", f"{source_cell}-engine"),
        }:
            continue
        if kind == "Service" and document.get("spec", {}).get("type") == "NodePort":
            continue
        document = replace_tree(document, source_cell, cell)
        document["metadata"].setdefault("labels", {})[
            "local.rivet.dev/qualification"
        ] = "cold-gc-physical"
        if kind == "ConfigMap":
            config = json.loads(document["data"]["config.jsonc"])
            config["runtime"]["gasoline_cell_namespace"] = cell
            config["nats"]["addresses"] = [
                "local-runtime-a-nats-0.local-runtime-a-nats.actor-fdb-cell-system.svc.cluster.local:4222"
            ]
            config["topology"] = {
                "datacenter_label": 101,
                "datacenters": {
                    cell: {
                        "datacenter_label": 101,
                        "is_leader": True,
                        "public_url": f"http://{cell}.qualification.invalid",
                        "peer_url": f"http://{cell}-engine:6421",
                        "proxy_url": f"http://{cell}-engine:6420",
                        "valid_hosts": [cell, f"{cell}-engine"],
                    }
                },
            }
            document["data"]["config.jsonc"] = json.dumps(config, indent=2) + "\n"
        elif kind == "Deployment":
            document["spec"]["template"]["metadata"].setdefault("labels", {})[
                "local.rivet.dev/qualification"
            ] = "cold-gc-physical"
            for volume in document["spec"]["template"]["spec"]["volumes"]:
                if volume["name"] == "fdb-config":
                    volume["configMap"]["name"] = f"{fdb_cluster}-config"
        selected.append(document)

    observed = sorted((item["kind"], item["metadata"]["name"]) for item in selected)
    expected = sorted(
        [
            ("ServiceAccount", f"{cell}-runtime"),
            ("ConfigMap", f"{cell}-runtime-config"),
            ("Service", f"{cell}-engine"),
            ("Deployment", f"{cell}-engine"),
        ]
    )
    if observed != expected:
        raise SystemExit(f"qualification render selected {observed}, expected {expected}")
    Path(output).write_text(yaml.safe_dump_all(selected, sort_keys=False))


if __name__ == "__main__":
    main()
