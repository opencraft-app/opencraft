#!/usr/bin/env python3
"""
Synchronize the Hong Kong devops public allowlist into the current Tencent Cloud
security groups and related public entrypoints.

Default targets:
- app CLBs security group: sg-czkjmcvx
- TKE endpoint security group: sg-8gu7bovt
- GitLab/Argo CD public CLBs: lb-88qjnbag, lb-9whcawlg
- TKE cluster endpoint: cls-mp5b5r0y

Usage:
  python3 scripts/sync_devops_allowlist.py
  python3 scripts/sync_devops_allowlist.py --apply
  python3 scripts/sync_devops_allowlist.py --allowlist-file path/to/list.txt --apply
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import math
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_REGION = "ap-hongkong"
DEFAULT_CLUSTER_ID = "cls-mp5b5r0y"
DEFAULT_APP_SECURITY_GROUP_ID = "sg-czkjmcvx"
DEFAULT_ENDPOINT_SECURITY_GROUP_ID = "sg-8gu7bovt"
DEFAULT_APP_LOAD_BALANCERS = ["lb-88qjnbag", "lb-9whcawlg"]
DEFAULT_ALLOWLIST_FILE = Path("scripts/devops_allowlist.txt")
DEFAULT_KUBECONFIG = Path("hk-cls-mp5b5r0y-extranet.kubeconfig")
DEFAULT_ENDPOINT_SERVICE_NAMESPACE = "default"
DEFAULT_ENDPOINT_SERVICE_NAME = "kubernetes-extranet"
MAX_SECURITY_GROUP_INGRESS_RULES = 100


@dataclass(frozen=True)
class ScopeConfig:
    region: str
    cluster_id: str
    app_security_group_id: str
    endpoint_security_group_id: str
    app_load_balancer_ids: list[str]
    kubeconfig: Path
    endpoint_service_namespace: str
    endpoint_service_name: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync the devops public allowlist into Tencent Cloud security groups.",
    )
    parser.add_argument(
        "--allowlist-file",
        default=str(DEFAULT_ALLOWLIST_FILE),
        help="Path to newline-delimited IPv4/IPv6 CIDRs or single IPs.",
    )
    parser.add_argument(
        "--region",
        default=DEFAULT_REGION,
        help="Tencent Cloud region.",
    )
    parser.add_argument(
        "--cluster-id",
        default=DEFAULT_CLUSTER_ID,
        help="TKE cluster ID for the public endpoint.",
    )
    parser.add_argument(
        "--app-security-group-id",
        default=DEFAULT_APP_SECURITY_GROUP_ID,
        help="Security group ID for app-facing public CLBs.",
    )
    parser.add_argument(
        "--endpoint-security-group-id",
        default=DEFAULT_ENDPOINT_SECURITY_GROUP_ID,
        help="Security group ID for the TKE public endpoint.",
    )
    parser.add_argument(
        "--app-load-balancer-id",
        action="append",
        dest="app_load_balancer_ids",
        default=[],
        help="App-facing public CLB ID. Can be specified multiple times.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. Default is dry-run.",
    )
    parser.add_argument(
        "--kubeconfig",
        default=str(DEFAULT_KUBECONFIG),
        help="Kubeconfig path for patching the TKE public endpoint service.",
    )
    parser.add_argument(
        "--endpoint-service-namespace",
        default=DEFAULT_ENDPOINT_SERVICE_NAMESPACE,
        help="Namespace of the TKE public endpoint service.",
    )
    parser.add_argument(
        "--endpoint-service-name",
        default=DEFAULT_ENDPOINT_SERVICE_NAME,
        help="Name of the TKE public endpoint service.",
    )
    return parser.parse_args()


def read_allowlist(path: Path) -> list[str]:
    if not path.is_file():
        raise FileNotFoundError(f"allowlist file not found: {path}")

    raw_entries: list[ipaddress._BaseNetwork] = []
    for lineno, line in enumerate(path.read_text().splitlines(), start=1):
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        try:
            if "/" in text:
                raw_entries.append(ipaddress.ip_network(text, strict=False))
            else:
                addr = ipaddress.ip_address(text)
                suffix = 32 if addr.version == 4 else 128
                raw_entries.append(ipaddress.ip_network(f"{text}/{suffix}", strict=False))
        except ValueError as exc:
            raise ValueError(f"{path}:{lineno}: invalid IP/CIDR {text!r}: {exc}") from exc

    collapsed = list(ipaddress.collapse_addresses(raw_entries))
    return [str(net) for net in collapsed]


def run_tccli(service: str, action: str, *, region: str | None = None, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(3):
        cmd = ["tccli", service, action]
        if region:
            cmd.extend(["--region", region])
        if payload is None:
            result = subprocess.run(cmd, capture_output=True, text=True)
        else:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
                json.dump(payload, tmp)
                tmp.flush()
                tmp_path = tmp.name
            cmd.extend(["--cli-input-json", f"file://{tmp_path}"])
            result = subprocess.run(cmd, capture_output=True, text=True)
            Path(tmp_path).unlink(missing_ok=True)

        if result.returncode != 0:
            last_error = RuntimeError(
                f"tccli {service} {action} failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            )
        else:
            try:
                return json.loads(result.stdout)
            except json.JSONDecodeError as exc:
                last_error = RuntimeError(
                    f"tccli {service} {action} returned non-JSON output:\n{result.stdout}"
                )
                last_error.__cause__ = exc
        if attempt < 2:
            time.sleep(1.5 * (attempt + 1))

    assert last_error is not None
    raise last_error


def build_app_policies(allowlist: list[str], version: str) -> dict[str, Any]:
    ingress = []
    for cidr in allowlist:
        network = ipaddress.ip_network(cidr, strict=False)
        policy: dict[str, Any] = {
            "Protocol": "ALL",
            "Port": "all",
            "Action": "ACCEPT",
            "PolicyDescription": f"Managed by sync_devops_allowlist.py: {cidr}",
        }
        if network.version == 4:
            policy["CidrBlock"] = cidr
        else:
            policy["Ipv6CidrBlock"] = cidr
        ingress.append(policy)

    egress = [
        {
            "Protocol": "ALL",
            "Port": "all",
            "CidrBlock": "0.0.0.0/0",
            "Action": "ACCEPT",
            "PolicyDescription": "Managed by sync_devops_allowlist.py: allow all outbound IPv4",
        },
        {
            "Protocol": "ALL",
            "Port": "all",
            "Ipv6CidrBlock": "::/0",
            "Action": "ACCEPT",
            "PolicyDescription": "Managed by sync_devops_allowlist.py: allow all outbound IPv6",
        },
    ]
    return {
        "Version": version,
        "Ingress": ingress,
        "Egress": egress,
    }


def build_endpoint_policies(allowlist: list[str], version: str) -> dict[str, Any]:
    ingress = []
    for cidr in allowlist:
        network = ipaddress.ip_network(cidr, strict=False)
        policy: dict[str, Any] = {
            "Protocol": "TCP",
            "Port": "443",
            "Action": "ACCEPT",
            "PolicyDescription": f"Managed by sync_devops_allowlist.py: kube-api {cidr}",
        }
        if network.version == 4:
            policy["CidrBlock"] = cidr
        else:
            policy["Ipv6CidrBlock"] = cidr
        ingress.append(policy)

    egress = [
        {
            "Protocol": "ALL",
            "Port": "all",
            "CidrBlock": "0.0.0.0/0",
            "Action": "ACCEPT",
            "PolicyDescription": "Managed by sync_devops_allowlist.py: allow all outbound IPv4",
        },
        {
            "Protocol": "ALL",
            "Port": "all",
            "Ipv6CidrBlock": "::/0",
            "Action": "ACCEPT",
            "PolicyDescription": "Managed by sync_devops_allowlist.py: allow all outbound IPv6",
        },
    ]
    return {
        "Version": version,
        "Ingress": ingress,
        "Egress": egress,
    }


def describe_security_group_policies(region: str, security_group_id: str) -> dict[str, Any]:
    response = run_tccli(
        "vpc",
        "DescribeSecurityGroupPolicies",
        region=region,
        payload={"SecurityGroupId": security_group_id},
    )
    return response["SecurityGroupPolicySet"]


def describe_load_balancers(region: str) -> list[dict[str, Any]]:
    response = run_tccli("clb", "DescribeLoadBalancers", region=region)
    return response["LoadBalancerSet"]


def describe_security_groups(region: str) -> list[dict[str, Any]]:
    response = run_tccli("vpc", "DescribeSecurityGroups", region=region)
    return response["SecurityGroupSet"]


def split_chunks(items: list[str], size: int) -> list[list[str]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def build_single_direction_policies(allowlist: list[str], *, protocol: str, port: str, description_prefix: str) -> list[dict[str, Any]]:
    ingress = []
    for cidr in allowlist:
        network = ipaddress.ip_network(cidr, strict=False)
        policy: dict[str, Any] = {
            "Protocol": protocol,
            "Port": port,
            "Action": "ACCEPT",
            "PolicyDescription": f"{description_prefix}: {cidr}",
        }
        if network.version == 4:
            policy["CidrBlock"] = cidr
        else:
            policy["Ipv6CidrBlock"] = cidr
        ingress.append(policy)
    return ingress


def modify_security_group_policies(region: str, security_group_id: str, policy_set: dict[str, Any], *, apply: bool) -> None:
    if not apply:
        return
    run_tccli(
        "vpc",
        "ModifySecurityGroupPolicies",
        region=region,
        payload={
            "SecurityGroupId": security_group_id,
            "SecurityGroupPolicySet": policy_set,
        },
    )


def ensure_app_clb_binding(region: str, app_security_group_ids: list[str], clb_ids: list[str], *, apply: bool) -> None:
    if not apply:
        return
    for lb_id in clb_ids:
        run_tccli(
            "clb",
            "SetLoadBalancerSecurityGroups",
            region=region,
            payload={
                "LoadBalancerId": lb_id,
                "SecurityGroups": app_security_group_ids,
            },
        )


def ensure_cluster_endpoint_sync(region: str, cluster_id: str, endpoint_security_group_id: str, allowlist: list[str], *, apply: bool) -> None:
    if not apply:
        return
    ipv4_policies = [cidr for cidr in allowlist if ipaddress.ip_network(cidr, strict=False).version == 4]
    run_tccli(
        "tke",
        "ModifyClusterEndpointSP",
        region=region,
        payload={
            "ClusterId": cluster_id,
            "SecurityPolicies": ipv4_policies,
            "SecurityGroup": endpoint_security_group_id,
        },
    )


def print_plan(
    config: ScopeConfig,
    allowlist: list[str],
    app_policy_sets: list[tuple[str, dict[str, Any]]],
    endpoint_policy_sets: list[tuple[str, dict[str, Any]]],
    lbs: list[dict[str, Any]],
    *,
    apply: bool,
) -> None:
    print(f"mode: {'apply' if apply else 'dry-run'}")
    print(f"region: {config.region}")
    print(f"cluster_id: {config.cluster_id}")
    print(f"allowlist_entries: {len(allowlist)}")
    print("allowlist:")
    for cidr in allowlist:
        print(f"  - {cidr}")

    print("app_security_groups:")
    for sg_id, app_policy_set in app_policy_sets:
        print(f"  - id: {sg_id}")
        print(f"    ingress_rules: {len(app_policy_set['Ingress'])}")
        print(f"    egress_rules: {len(app_policy_set['Egress'])}")

    print("endpoint_security_group:")
    for sg_id, endpoint_policy_set in endpoint_policy_sets:
        print(f"  - id: {sg_id}")
        print(f"    ingress_rules: {len(endpoint_policy_set['Ingress'])}")
        print(f"    egress_rules: {len(endpoint_policy_set['Egress'])}")
    print(
        "  service_binding:"
        f" {config.endpoint_service_namespace}/{config.endpoint_service_name}"
    )

    print("app_clbs:")
    by_id = {lb["LoadBalancerId"]: lb for lb in lbs}
    desired_sgs = [sg_id for sg_id, _ in app_policy_sets]
    for lb_id in config.app_load_balancer_ids:
        lb = by_id.get(lb_id)
        if lb is None:
            print(f"  - {lb_id}: NOT FOUND")
            continue
        print(
            f"  - {lb_id}: {lb['LoadBalancerName']} current_sgs={lb.get('SecureGroups', [])} desired_sgs={desired_sgs}"
        )


def shard_name(base_name: str, index: int) -> str:
    if index == 0:
        return base_name
    suffix = f"-shard-{index + 1:02d}"
    max_base_len = 60 - len(suffix)
    return base_name[:max_base_len] + suffix


def ensure_security_group_shards(region: str, base_security_group_id: str, shard_count: int, *, apply: bool) -> list[dict[str, Any]]:
    groups = describe_security_groups(region)
    by_id = {group["SecurityGroupId"]: group for group in groups}
    base = by_id.get(base_security_group_id)
    if base is None:
        raise ValueError(f"base app security group not found: {base_security_group_id}")

    by_name = {group["SecurityGroupName"]: group for group in groups}
    shards = [base]
    for index in range(1, shard_count):
        name = shard_name(base["SecurityGroupName"], index)
        group = by_name.get(name)
        if group is None:
            if not apply:
                group = {
                    "SecurityGroupId": f"<create:{name}>",
                    "SecurityGroupName": name,
                    "SecurityGroupDesc": base["SecurityGroupDesc"],
                }
            else:
                response = run_tccli(
                    "vpc",
                    "CreateSecurityGroup",
                    region=region,
                    payload={
                        "GroupName": name,
                        "GroupDescription": base["SecurityGroupDesc"],
                        "ProjectId": base["ProjectId"],
                    },
                )
                group = response["SecurityGroup"]
            by_name[name] = group
        shards.append(group)
    return shards


def kubectl_patch_service(kubeconfig: Path, namespace: str, name: str, patch: dict[str, Any], *, apply: bool) -> None:
    if not apply:
        return
    subprocess.run(
        [
            "kubectl",
            "--kubeconfig",
            str(kubeconfig),
            "-n",
            namespace,
            "patch",
            "service",
            name,
            "--type",
            "merge",
            "-p",
            json.dumps(patch),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def ensure_endpoint_service_binding(config: ScopeConfig, endpoint_security_group_ids: list[str], *, apply: bool) -> None:
    patch = {
        "metadata": {
            "annotations": {
                "service.cloud.tencent.com/modification-protection": "false",
                "service.cloud.tencent.com/security-groups": ",".join(endpoint_security_group_ids),
                "tke.endpoint.security-group": config.endpoint_security_group_id,
            }
        }
    }
    kubectl_patch_service(
        config.kubeconfig,
        config.endpoint_service_namespace,
        config.endpoint_service_name,
        patch,
        apply=apply,
    )


def main() -> int:
    args = parse_args()
    config = ScopeConfig(
        region=args.region,
        cluster_id=args.cluster_id,
        app_security_group_id=args.app_security_group_id,
        endpoint_security_group_id=args.endpoint_security_group_id,
        app_load_balancer_ids=args.app_load_balancer_ids or list(DEFAULT_APP_LOAD_BALANCERS),
        kubeconfig=Path(args.kubeconfig),
        endpoint_service_namespace=args.endpoint_service_namespace,
        endpoint_service_name=args.endpoint_service_name,
    )

    try:
        allowlist = read_allowlist(Path(args.allowlist_file))
        endpoint_current = describe_security_group_policies(config.region, config.endpoint_security_group_id)
        lbs = describe_load_balancers(config.region)
        app_chunks = split_chunks(allowlist, MAX_SECURITY_GROUP_INGRESS_RULES)
        app_shard_groups = ensure_security_group_shards(
            config.region,
            config.app_security_group_id,
            len(app_chunks),
            apply=args.apply,
        )
        app_policy_sets: list[tuple[str, dict[str, Any]]] = []
        for chunk, group in zip(app_chunks, app_shard_groups, strict=True):
            if str(group["SecurityGroupId"]).startswith("<create:"):
                current = {"Version": "0"}
            else:
                current = describe_security_group_policies(config.region, group["SecurityGroupId"])
            app_policy_sets.append(
                (
                    group["SecurityGroupId"],
                    build_app_policies(chunk, current.get("Version", "0")),
                )
            )
        endpoint_chunks = split_chunks(allowlist, MAX_SECURITY_GROUP_INGRESS_RULES)
        endpoint_shard_groups = ensure_security_group_shards(
            config.region,
            config.endpoint_security_group_id,
            len(endpoint_chunks),
            apply=args.apply,
        )
        endpoint_policy_sets: list[tuple[str, dict[str, Any]]] = []
        for chunk, group in zip(endpoint_chunks, endpoint_shard_groups, strict=True):
            current = describe_security_group_policies(config.region, group["SecurityGroupId"])
            endpoint_policy_sets.append(
                (
                    group["SecurityGroupId"],
                    build_endpoint_policies(chunk, current.get("Version", "0")),
                )
            )
        print_plan(config, allowlist, app_policy_sets, endpoint_policy_sets, lbs, apply=args.apply)
        for security_group_id, app_policy_set in app_policy_sets:
            modify_security_group_policies(
                config.region,
                security_group_id,
                app_policy_set,
                apply=args.apply,
            )
        for security_group_id, endpoint_policy_set in endpoint_policy_sets:
            modify_security_group_policies(
                config.region,
                security_group_id,
                endpoint_policy_set,
                apply=args.apply,
            )
        ensure_app_clb_binding(
            config.region,
            [security_group_id for security_group_id, _ in app_policy_sets],
            config.app_load_balancer_ids,
            apply=args.apply,
        )
        ensure_endpoint_service_binding(
            config,
            [security_group_id for security_group_id, _ in endpoint_policy_sets],
            apply=args.apply,
        )
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.apply:
        print("sync complete")
    else:
        print("dry-run complete; rerun with --apply to make changes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
