#!/usr/bin/env python3
"""Static checks for the production private endpoint HA gate."""

from pathlib import Path


def main() -> None:
    script = (Path(__file__).resolve().parent / "qualify-private-endpoint-ha.py").read_text()
    for fragment in (
        "at least three Ready replicas on distinct nodes",
        '"delete", "pod"',
        '"--wait=false"',
        '"failures": 0',
        '"successfulDuringReplacement"',
        '"actor-workers-api-private-endpoint-ha/v2"',
        "os.link(staged, path)",
    ):
        if fragment not in script:
            raise SystemExit(f"private endpoint HA qualification lost contract: {fragment}")


if __name__ == "__main__":
    main()
