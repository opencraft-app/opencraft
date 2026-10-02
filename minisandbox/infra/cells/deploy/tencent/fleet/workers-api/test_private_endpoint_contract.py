#!/usr/bin/env python3
"""Static checks for the private product ingress boundary."""

from pathlib import Path


def main() -> None:
    script = (Path(__file__).resolve().parent / "install-private-endpoint.sh").read_text()
    for fragment in (
        "qcloud-loadbalancer-internal-subnetid",
        "loadBalancerSourceRanges",
        "service.cloud.tencent.com/security-groups",
        "service.cloud.tencent.com/pass-to-target",
        '"type": "LoadBalancer"',
        "private Workers API Service has fewer than three Ready endpoints",
        "HPA-managed replica target Ready",
        '"schema": "actor-workers-api-private-endpoint-installation/v3"',
        '"listenerPort": 6688',
        '"externalTrafficPolicy": "Cluster"',
        "HA Cluster forwarding",
        '"/readyz"',
        '"@sha256:"',
        "os.link(staged, output)",
    ):
        if fragment not in script:
            raise SystemExit(f"private Workers API endpoint lost contract: {fragment}")


if __name__ == "__main__":
    main()
