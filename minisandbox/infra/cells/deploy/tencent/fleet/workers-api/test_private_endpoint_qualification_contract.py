#!/usr/bin/env python3
"""Static checks for the cross-VPC private endpoint qualification gate."""

from pathlib import Path


def main() -> None:
    script = (Path(__file__).resolve().parent / "qualify-private-endpoint.sh").read_text()
    for fragment in (
        "ACTOR_WORKERS_API_ALLOWED_TAT_INSTANCE",
        "ACTOR_WORKERS_API_DENIED_TAT_INSTANCES",
        "at least two denied Cell probes are required",
        "DescribeLoadBalancers",
        "DescribeListeners",
        "DescribeInstances",
        'clb.get("SecureGroups") != [security_group]',
        'clb.get("LoadBalancerType") != "INTERNAL"',
        'listener.get("Port") != 6688',
        'listener.get("TargetType") != "NODE"',
        '"actor-workers-api-private-endpoint-qualification/v3"',
        '"result": "no-http-response"',
        '"result": "ready-before-and-after-denials"',
        "os.link(staged, output)",
    ):
        if fragment not in script:
            raise SystemExit(f"private endpoint qualification lost contract: {fragment}")


if __name__ == "__main__":
    main()
