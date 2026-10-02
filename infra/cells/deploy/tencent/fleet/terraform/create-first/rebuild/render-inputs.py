#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ipaddress
import json
import pathlib
import re
from typing import Any


def mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def require_string(value: Any, label: str, pattern: str | None = None) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a nonempty string")
    if pattern and not re.fullmatch(pattern, value):
        raise ValueError(f"{label} is invalid")
    return value


def network(value: Any, label: str, availability_mode: str = "production-multi-zone") -> dict[str, Any]:
    source = mapping(value, label)
    result = {
        "vpc_cidr": require_string(source.get("vpcCidr"), f"{label}.vpcCidr"),
        "cluster_pod_cidr": require_string(source.get("podCidr"), f"{label}.podCidr"),
        "cluster_service_cidr": require_string(source.get("serviceCidr"), f"{label}.serviceCidr"),
    }
    parsed = [ipaddress.ip_network(item, strict=True) for item in result.values()]
    if any(left.overlaps(right) for index, left in enumerate(parsed) for right in parsed[index + 1 :]):
        raise ValueError(f"{label} VPC, Pod and Service CIDRs overlap")
    subnets = mapping(source.get("subnets"), f"{label}.subnets")
    if set(subnets) != {"z1", "z2", "z3"}:
        raise ValueError(f"{label}.subnets must contain z1/z2/z3")
    result["subnets"] = {
        key: {
            "availability_zone": require_string(item.get("availabilityZone"), f"{label}.{key}.availabilityZone"),
            "cidr_block": require_string(item.get("cidr"), f"{label}.{key}.cidr"),
        }
        for key, item in ((key, mapping(subnets[key], f"{label}.{key}")) for key in sorted(subnets))
    }
    vpc = parsed[0]
    subnet_networks = [ipaddress.ip_network(item["cidr_block"], strict=True) for item in result["subnets"].values()]
    if any(not subnet.subnet_of(vpc) for subnet in subnet_networks):
        raise ValueError(f"{label} subnet is outside its VPC")
    if availability_mode not in {"production-multi-zone", "qualification-single-zone"}:
        raise ValueError(f"{label} availability mode is invalid")
    expected_zones = 3 if availability_mode == "production-multi-zone" else 1
    if len({item["availability_zone"] for item in result["subnets"].values()}) != expected_zones:
        raise ValueError(f"{label} subnets must span {expected_zones} zone(s) for {availability_mode}")
    return result


def common(intent: dict[str, Any]) -> dict[str, Any]:
    if intent.get("schema") != "actor-clean-room-fleet-intent/v1":
        raise ValueError("fleet intent schema is invalid")
    node = mapping(intent.get("node"), "node")
    public_key = require_string(node.get("sshPublicKey"), "node.sshPublicKey")
    if not re.fullmatch(r"ssh-(?:ed25519|rsa) [A-Za-z0-9+/=]+(?: .*)?", public_key):
        raise ValueError("node.sshPublicKey is not an OpenSSH public key")
    return {
        "region": require_string(intent.get("region"), "region", r"[a-z]+-[a-z]+"),
        "terraform_state_bucket": require_string(intent.get("stateBucket"), "stateBucket", r"actor-terraform-state-[a-z0-9-]+-[0-9]+"),
        "account_app_id": require_string(intent.get("accountAppId"), "accountAppId", r"[0-9]{10}"),
        "regional_vpc_aggregate": require_string(intent.get("regionalVpcAggregate"), "regionalVpcAggregate"),
        "reserved_cidrs": intent.get("reservedCidrs"),
        "cluster_version": require_string(node.get("clusterVersion"), "node.clusterVersion", r"[0-9]+[.][0-9]+[.][0-9]+"),
        "cluster_level": require_string(node.get("clusterLevel"), "node.clusterLevel"),
        "cluster_os": require_string(node.get("clusterOs"), "node.clusterOs"),
        "node_image_name_regex": require_string(node.get("imageNameRegex"), "node.imageNameRegex"),
        "bootstrap_instance_type": require_string(node.get("bootstrapInstanceType"), "node.bootstrapInstanceType"),
        "ssh_public_key": public_key,
        "deletion_protection": True,
    }


def render_management(intent: dict[str, Any]) -> dict[str, Any]:
    management = mapping(intent.get("management"), "management")
    availability_mode = require_string(management.get("availabilityMode", "production-multi-zone"), "management.availabilityMode")
    result = common(intent) | network(management.get("network"), "management.network", availability_mode)
    result.update(
        {
            "management_id": require_string(management.get("id"), "management.id", r"actor-[a-z]{2}-c[0-9]{2}"),
            "availability_mode": availability_mode,
            "bootstrap_subnet_key": "z1",
            "trusted_api_cidrs": [],
            "trusted_workers_api_cidrs": management.get("trustedWorkersApiCidrs", []),
        }
    )
    return result


def render_operations_network(intent: dict[str, Any]) -> dict[str, Any]:
    operations = mapping(intent.get("operationsNetwork"), "operationsNetwork")
    return {
        "region": require_string(intent.get("region"), "region", r"[a-z]+-[a-z]+"),
        "terraform_state_bucket": require_string(
            intent.get("stateBucket"), "stateBucket", r"actor-terraform-state-[a-z0-9-]+-[0-9]+"
        ),
        "foundation_state_prefix": "actor-fleet/foundation",
        "management_state_prefix": "actor-fleet/management",
        "operations_vpc_name": require_string(operations.get("vpcName"), "operationsNetwork.vpcName"),
        "operations_vpc_cidr": require_string(operations.get("vpcCidr"), "operationsNetwork.vpcCidr"),
        "route_table_name": require_string(
            operations.get("routeTableName"), "operationsNetwork.routeTableName"
        ),
    }


def render_cell(intent: dict[str, Any], cell_id: str, binding: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    cells = mapping(intent.get("cells"), "cells")
    cell = mapping(cells.get(cell_id), f"cells.{cell_id}")
    fleet = mapping(intent.get("fleet"), "fleet")
    expected = {
        "pool_name": require_string(fleet.get("poolName"), "fleet.poolName"),
        "class_name": require_string(fleet.get("className"), "fleet.className"),
        "datacenter_name": require_string(fleet.get("datacenterName"), "fleet.datacenterName"),
    }
    dynamic = {
        "pool_uid": require_string(binding.get("poolUid"), "binding.poolUid"),
        "claim_name": require_string(binding.get("claimName"), "binding.claimName"),
        "claim_uid": require_string(binding.get("claimUid"), "binding.claimUid"),
        "scale_out_epoch": binding.get("scaleOutEpoch"),
        "profile_digest": require_string(binding.get("profileDigest"), "binding.profileDigest", r"sha256:[0-9a-f]{64}"),
    }
    if binding.get("poolName") != expected["pool_name"] or binding.get("className") != expected["class_name"]:
        raise ValueError("fresh Claim binding differs from fleet intent")
    if not isinstance(dynamic["scale_out_epoch"], int) or dynamic["scale_out_epoch"] < 0:
        raise ValueError("binding.scaleOutEpoch must be a nonnegative integer")
    availability_mode = require_string(cell.get("availabilityMode", "production-multi-zone"), f"cells.{cell_id}.availabilityMode")
    result = common(intent) | network(cell.get("network"), f"cells.{cell_id}.network", availability_mode)
    machine_pools = mapping(fleet.get("machinePools"), "fleet.machinePools")
    stateless = mapping(machine_pools.get("stateless"), "fleet.machinePools.stateless")
    result.update(
        {
            "cell_id": cell_id,
            "environment": require_string(cell.get("environment"), f"cells.{cell_id}.environment"),
            "storage_identity_mode": require_string(cell.get("storageIdentityMode"), f"cells.{cell_id}.storageIdentityMode"),
            "availability_mode": availability_mode,
            "fleet_binding": expected | dynamic,
            "bootstrap_subnet_key": "z1",
            "trusted_api_cidrs": [],
            "stateless_node_pool": {
                "instance_types": stateless.get("instanceTypes"),
                "replicas": stateless.get("replicas"),
                "min_replicas": stateless.get("minReplicas"),
                "max_replicas": stateless.get("maxReplicas"),
            },
        }
    )
    spec = {
        "schemaVersion": 1,
        "cellId": cell_id,
        "className": expected["class_name"],
        "poolName": expected["pool_name"],
        "profileDigest": dynamic["profile_digest"],
        "machinePools": machine_pools,
    }
    return result, spec


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--intent", required=True, type=pathlib.Path)
    parser.add_argument("--target", required=True)
    parser.add_argument("--binding", type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--cell-spec-output", type=pathlib.Path)
    args = parser.parse_args()
    intent = mapping(json.loads(args.intent.read_text()), "intent")
    if args.target == "management":
        if args.binding or args.cell_spec_output:
            raise ValueError("management rendering does not accept Cell options")
        rendered = render_management(intent)
    elif args.target == "operations-network":
        if args.binding or args.cell_spec_output:
            raise ValueError("operations-network rendering does not accept Cell options")
        rendered = render_operations_network(intent)
    else:
        if args.target not in mapping(intent.get("cells"), "cells"):
            raise ValueError("target is not a declared Cell")
        if not args.binding or not args.cell_spec_output:
            raise ValueError("Cell rendering requires --binding and --cell-spec-output")
        rendered, spec = render_cell(
            intent, args.target, mapping(json.loads(args.binding.read_text()), "binding")
        )
        args.cell_spec_output.write_text(json.dumps(spec, indent=2, sort_keys=True) + "\n")
    args.output.write_text(json.dumps(rendered, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
