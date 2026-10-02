#!/usr/bin/env python3
"""Decide whether an Engine/Host pair may retain its prior release identity."""

import argparse
import json
import re
from pathlib import Path


IDENTITY = re.compile(r"^[0-9a-f]{64}$")


def load_plan(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value.get("noop"), bool):
        raise ValueError(f"{path} has no boolean noop decision")
    for key in ("live_identity", "candidate_identity"):
        if not isinstance(value.get(key), str) or IDENTITY.fullmatch(value[key]) is None:
            raise ValueError(f"{path} has an invalid {key}")
    return value


def coordinate(engine: dict, runtime: dict) -> dict:
    if engine["candidate_identity"] != runtime["candidate_identity"]:
        raise ValueError("Engine and Host candidates do not share one release identity")
    preserve = (
        engine["noop"]
        and runtime["noop"]
        and engine["live_identity"] == runtime["live_identity"]
    )
    return {
        "candidate_identity": engine["candidate_identity"],
        "engine_noop": engine["noop"],
        "live_identity": engine["live_identity"] if preserve else None,
        "preserve": preserve,
        "runtime_noop": runtime["noop"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(coordinate(load_plan(args.engine), load_plan(args.runtime)), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
