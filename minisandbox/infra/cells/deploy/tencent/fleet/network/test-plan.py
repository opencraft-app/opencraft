#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import ipaddress
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("validate_plan", ROOT / "validate-plan.py")
assert SPEC and SPEC.loader
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)

plan = yaml.safe_load((ROOT / "ccn-plan.yaml").read_text())
VALIDATOR.validate(plan)

for name in ("runtime-a", "runtime-b"):
    cluster = plan["clusters"][name]
    vpc = ipaddress.ip_network(cluster["vpcCidr"])
    assert vpc.prefixlen == 20
    allocations = set(cluster["subnets"].values()) | set(cluster["reservedSubnets"])
    assert len(cluster["reservedSubnets"]) == 1
    assert allocations == {str(subnet) for subnet in vpc.subnets(new_prefix=22)}

for reserved_cidr, expected_error in (
    (plan["clusters"]["runtime-a"]["subnets"]["ap-beijing-6"], "overlapping networks"),
    ("10.163.0.0/22", "reserved subnets must be inside"),
):
    bad_reservation = copy.deepcopy(plan)
    bad_reservation["clusters"]["runtime-a"]["reservedSubnets"] = [reserved_cidr]
    try:
        VALIDATOR.validate(bad_reservation)
    except ValueError as exc:
        assert expected_error in str(exc)
    else:
        raise AssertionError("invalid spare Cell subnet was accepted")

overlap = copy.deepcopy(plan)
overlap["clusters"]["runtime-b"]["vpcCidr"] = overlap["clusters"]["runtime-a"]["vpcCidr"]
overlap["clusters"]["runtime-b"]["subnets"] = overlap["clusters"]["runtime-a"]["subnets"]
overlap["clusters"]["runtime-b"]["reservedSubnets"] = overlap["clusters"]["runtime-a"]["reservedSubnets"]
try:
    VALIDATOR.validate(overlap)
except ValueError as exc:
    assert "overlap" in str(exc)
else:
    raise AssertionError("overlapping runtime VPCs were accepted")

advertised_pods = copy.deepcopy(plan)
advertised_pods["ccn"]["neverAdvertise"] = ["serviceCidr"]
try:
    VALIDATOR.validate(advertised_pods)
except ValueError as exc:
    assert "never advertise" in str(exc)
else:
    raise AssertionError("CCN plan accepted Pod CIDR advertisement")

operations_to_runtime = copy.deepcopy(plan)
operations_to_runtime["operationsNetwork"]["advertisesRoutesTo"] = ["hub", "runtime-a"]
try:
    VALIDATOR.validate(operations_to_runtime)
except ValueError as exc:
    assert "only to hub" in str(exc)
else:
    raise AssertionError("CCN plan accepted direct operations-to-runtime reachability")

missing_cross_cell = copy.deepcopy(plan)
missing_cross_cell["ccn"]["allowedFlows"] = [
    flow
    for flow in missing_cross_cell["ccn"]["allowedFlows"]
    if flow["from"] != "runtime-a.gateway"
]
try:
    VALIDATOR.validate(missing_cross_cell)
except ValueError as exc:
    assert "runtime gateways" in str(exc)
else:
    raise AssertionError("CCN plan accepted a missing cross-Cell Guard path")

missing_management = copy.deepcopy(plan)
missing_management["ccn"]["allowedFlows"] = [
    flow
    for flow in missing_management["ccn"]["allowedFlows"]
    if flow["from"] != "hub.argocd"
]
try:
    VALIDATOR.validate(missing_management)
except ValueError as exc:
    assert "Argo" in str(exc)
else:
    raise AssertionError("CCN plan accepted an unreachable remote Kubernetes API")

missing_serving = copy.deepcopy(plan)
missing_serving["ccn"]["allowedFlows"] = [
    flow
    for flow in missing_serving["ccn"]["allowedFlows"]
    if flow["from"] != "hub.workers-api"
]
try:
    VALIDATOR.validate(missing_serving)
except ValueError as exc:
    assert "Workers API" in str(exc)
else:
    raise AssertionError("CCN plan accepted an unreachable Cell serving gateway")

print("CCN network-plan tests passed")
