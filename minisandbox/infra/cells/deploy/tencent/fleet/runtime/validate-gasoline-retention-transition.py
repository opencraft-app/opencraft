#!/usr/bin/env python3
"""Reject irreversible retention decreases in a rollback-capable runtime release."""

import argparse
import json
from pathlib import Path


DEFAULTS = {
    "gasoline_history_prune_eligibility_duration": 15 * 60,
    "gasoline_prune_eligibility_duration": 7 * 24 * 60 * 60,
}


def runtime(document):
    value = document.get("runtime", {})
    if not isinstance(value, dict):
        raise ValueError("runtime config must be an object")
    return value


def duration(config, field):
    value = runtime(config).get(field, DEFAULTS[field])
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def load_old(path):
    outer = json.loads(path.read_text())
    encoded = outer.get("data", {}).get("config.jsonc")
    if not isinstance(encoded, str):
        raise ValueError("old ConfigMap has no config.jsonc")
    return json.loads(encoded)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("old_configmap", type=Path)
    parser.add_argument("new_config", type=Path)
    args = parser.parse_args()
    old = load_old(args.old_configmap)
    new = json.loads(args.new_config.read_text())

    for field in DEFAULTS:
        previous = duration(old, field)
        candidate = duration(new, field)
        # Zero means disabled/infinite retention. Enabling from zero and reducing
        # any positive duration can delete data before an automatic rollback.
        decreases = candidate != 0 and (previous == 0 or candidate < previous)
        if decreases:
            raise SystemExit(
                f"irreversible Gasoline retention decrease rejected for {field}: "
                f"{previous} -> {candidate}; use the StorageProfile policy activation path"
            )
    print("gasoline_retention_transition=rollback_safe")


if __name__ == "__main__":
    main()
