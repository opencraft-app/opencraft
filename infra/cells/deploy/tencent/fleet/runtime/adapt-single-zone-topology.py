#!/usr/bin/env python3
"""Remove impossible cross-zone hard constraints for a qualification Cell."""

import argparse
from pathlib import Path

import yaml


ZONE_KEY = "topology.kubernetes.io/zone"


def adapt(raw: str) -> str:
    documents = list(yaml.safe_load_all(raw))
    removed = 0
    workloads = 0
    for document in documents:
        if not isinstance(document, dict) or document.get("kind") not in {"Deployment", "StatefulSet"}:
            continue
        template = document.get("spec", {}).get("template")
        if not isinstance(template, dict):
            continue
        workloads += 1
        metadata = template.setdefault("metadata", {})
        metadata.setdefault("annotations", {})["fleet.actor.dev/availability-mode"] = (
            "qualification-single-zone"
        )
        pod = template.get("spec", {})
        anti_affinity = pod.get("affinity", {}).get("podAntiAffinity", {})
        required = anti_affinity.get("requiredDuringSchedulingIgnoredDuringExecution")
        if isinstance(required, list):
            kept = [item for item in required if item.get("topologyKey") != ZONE_KEY]
            removed += len(required) - len(kept)
            anti_affinity["requiredDuringSchedulingIgnoredDuringExecution"] = kept
        constraints = pod.get("topologySpreadConstraints")
        if isinstance(constraints, list):
            kept = [
                item for item in constraints
                if not (
                    item.get("topologyKey") == ZONE_KEY
                    and item.get("whenUnsatisfiable") == "DoNotSchedule"
                )
            ]
            removed += len(constraints) - len(kept)
            pod["topologySpreadConstraints"] = kept
    if workloads == 0 or removed == 0:
        raise ValueError("manifest did not contain a strict cross-zone workload constraint")
    # TencentOS bootstrap hosts currently provide PyYAML for Python 3.6,
    # whose safe_dump_all does not yet accept the sort_keys keyword.
    return yaml.safe_dump_all(documents, default_flow_style=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    raw = args.input.read_text()
    args.output.write_text(adapt(raw))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
