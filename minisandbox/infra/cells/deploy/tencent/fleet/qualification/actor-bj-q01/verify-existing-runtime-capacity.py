#!/usr/bin/env python3
"""Verify, without mutating, the runtime-capacity prerequisite for autoscaling."""

import argparse
import json
from pathlib import Path


POLICY_FIELDS = (
    "RUNTIME_EXACT_SCALE_DOWN_ENABLED",
    "RUNTIME_TKE_CLUSTER_ID",
    "RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED",
)


def verify(document, expected_controller, expected_runtime):
    metadata = document.get("metadata", {})
    if document.get("kind") != "Deployment" or metadata.get("name") != "actor-bj-q01-runtime-capacity":
        raise ValueError("runtime-capacity prerequisite has the wrong workload identity")
    if metadata.get("namespace") != "actor-fdb-cell-system":
        raise ValueError("runtime-capacity prerequisite has the wrong namespace")
    containers = document.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
    matches = [item for item in containers if item.get("name") == "controller"]
    if len(matches) != 1 or matches[0].get("image") != expected_controller:
        raise ValueError("runtime-capacity controller image must converge before autoscaling install")
    entries = matches[0].get("env", [])
    names = [item.get("name") for item in entries]
    if len(names) != len(set(names)):
        raise ValueError("runtime-capacity provider policy contains duplicate environment names")
    environment = {item.get("name"): item.get("value") for item in entries}
    if environment.get("RUNTIME_ADMISSION_BOOTSTRAP_IMAGE") != expected_runtime:
        raise ValueError("runtime-capacity admission image must converge before autoscaling install")
    for name in POLICY_FIELDS:
        if environment.get(name) is None:
            raise ValueError("runtime-capacity provider policy is incomplete: " + name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--controller-image", required=True)
    parser.add_argument("--runtime-image", required=True)
    args = parser.parse_args()
    try:
        verify(json.loads(args.manifest.read_text()), args.controller_image, args.runtime_image)
    except (ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
