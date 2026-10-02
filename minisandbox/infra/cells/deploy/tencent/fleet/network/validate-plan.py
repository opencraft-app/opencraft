#!/usr/bin/env python3
from __future__ import annotations

import ipaddress
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
PLAN = ROOT / "ccn-plan.yaml"


def network(value: str) -> ipaddress.IPv4Network:
    result = ipaddress.ip_network(value, strict=True)
    if not isinstance(result, ipaddress.IPv4Network) or not result.is_private:
        raise ValueError(f"network must be private IPv4: {value}")
    return result


def validate(document: dict) -> None:
    if document.get("schemaVersion") != 1 or document.get("region") != "ap-beijing":
        raise ValueError("network plan must use schemaVersion 1 for ap-beijing")
    clusters = document.get("clusters")
    if set(clusters or {}) != {"hub", "runtime-a", "runtime-b"}:
        raise ValueError("network plan must contain exactly hub, runtime-a, and runtime-b")

    aggregate = network(document["regionalVpcAggregate"])
    reserved = [network(value) for value in document.get("reservedCidrs", [])]
    operations = document.get("operationsNetwork", {})
    operations_cidr = network(operations.get("vpcCidr", ""))
    if operations.get("region") != document["region"]:
        raise ValueError("operations network must be in the fleet region")
    if operations.get("attachment") != "isolated-custom-route-table":
        raise ValueError("operations network must use an isolated custom CCN route table")
    if set(operations.get("receivesRoutesFrom", [])) != {"hub"}:
        raise ValueError("operations network may receive routes only from hub")
    if set(operations.get("advertisesRoutesTo", [])) != {"hub"}:
        raise ValueError("operations network may advertise routes only to hub")
    if set(operations.get("neverDirectlyReach", [])) != {"runtime-a", "runtime-b"}:
        raise ValueError("operations network must never directly reach runtime Cells")
    if operations_cidr not in reserved:
        raise ValueError("operations VPC must be reserved from Actor fleet allocation")
    vpcs: list[tuple[str, ipaddress.IPv4Network]] = []
    all_networks: list[tuple[str, ipaddress.IPv4Network]] = []
    for name, cluster in clusters.items():
        vpc = network(cluster["vpcCidr"])
        if not vpc.subnet_of(aggregate):
            raise ValueError(f"{name} VPC is outside the regional aggregate")
        vpcs.append((name, vpc))
        subnets = [network(value) for value in cluster["subnets"].values()]
        if len(subnets) != 3 or any(not subnet.subnet_of(vpc) for subnet in subnets):
            raise ValueError(f"{name} must have three VPC subnets inside its VPC")
        spare_subnets = [network(value) for value in cluster.get("reservedSubnets", [])]
        if any(not subnet.subnet_of(vpc) for subnet in spare_subnets):
            raise ValueError(f"{name} reserved subnets must be inside its VPC")
        all_networks.extend((f"{name}.subnet", subnet) for subnet in subnets)
        all_networks.extend((f"{name}.reservedSubnet", subnet) for subnet in spare_subnets)
        all_networks.append((f"{name}.pod", network(cluster["podCidr"])))
        all_networks.append((f"{name}.service", network(cluster["serviceCidr"])))

    for index, (left_name, left) in enumerate(vpcs):
        for right_name, right in vpcs[index + 1 :]:
            if left.overlaps(right):
                raise ValueError(f"overlapping VPCs: {left_name} {left} and {right_name} {right}")
        for blocked in reserved:
            if left.overlaps(blocked):
                raise ValueError(f"{left_name} VPC {left} overlaps reserved network {blocked}")

    for index, (left_name, left) in enumerate(all_networks):
        for right_name, right in all_networks[index + 1 :]:
            if left.overlaps(right):
                raise ValueError(f"overlapping networks: {left_name} {left} and {right_name} {right}")
        for blocked in reserved:
            if left.overlaps(blocked):
                raise ValueError(f"{left_name} {left} overlaps reserved network {blocked}")

    ccn = document.get("ccn", {})
    if ccn.get("topology") != "hub-spoke" or ccn.get("advertise") != "vpc-subnets-only":
        raise ValueError("CCN must remain a VPC-subnet-only hub-spoke topology")
    if set(ccn.get("neverAdvertise", [])) != {"podCidr", "serviceCidr"}:
        raise ValueError("CCN must never advertise Kubernetes Pod or Service CIDRs")
    flows = ccn.get("allowedFlows", [])
    gateway_flows = {(item["from"], item["to"], tuple(item["ports"])) for item in flows}
    required = {
        ("hub.argocd", "runtime-a.kube-api", (443,)),
        ("hub.argocd", "runtime-b.kube-api", (443,)),
        ("hub.workers-api", "runtime-a.private-gateway-clb", (6420,)),
        ("hub.workers-api", "runtime-b.private-gateway-clb", (6420,)),
        ("hub.ingress", "runtime-a.private-gateway-clb", (443,)),
        ("hub.ingress", "runtime-b.private-gateway-clb", (443,)),
        ("operations.site-gateway", "hub.workers-api", (6688,)),
        ("runtime-a.gateway", "runtime-b.private-gateway-clb", (443,)),
        ("runtime-b.gateway", "runtime-a.private-gateway-clb", (443,)),
    }
    if not required.issubset(gateway_flows):
        raise ValueError(
            "operations, Argo, Workers API, Hub ingress, and both runtime gateways must have their exact declared paths"
        )


if __name__ == "__main__":
    document = yaml.safe_load(PLAN.read_text())
    validate(document)
    print(f"validated {PLAN}")
