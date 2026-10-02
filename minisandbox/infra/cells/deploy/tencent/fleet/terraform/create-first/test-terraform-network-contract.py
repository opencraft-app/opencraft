#!/usr/bin/env python3

import ipaddress
import re
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
NETWORK_PLAN = ROOT.parents[1] / "network" / "ccn-plan.yaml"


def source(path: str) -> str:
    return (ROOT / path).read_text()


def scalar(text: str, name: str) -> str:
    match = re.search(rf"(?m)^\s*{re.escape(name)}\s*=\s*\"([^\"]+)\"", text)
    if not match:
        raise AssertionError(f"missing scalar {name}")
    return match.group(1)


def integer(text: str, name: str) -> int:
    match = re.search(rf"(?m)^\s*{re.escape(name)}\s*=\s*([0-9]+)", text)
    if not match:
        raise AssertionError(f"missing integer {name}")
    return int(match.group(1))


def subnet_cidrs(text: str) -> set[str]:
    block = re.search(r"(?ms)^subnets\s*=\s*\{(.*?)^\}", text)
    if not block:
        raise AssertionError("missing subnets block")
    return set(re.findall(r'cidr_block\s*=\s*"([^\"]+)"', block.group(1)))


def string_list(text: str, name: str) -> set[str]:
    match = re.search(rf"(?m)^\s*{re.escape(name)}\s*=\s*\[([^]]*)\]", text)
    if not match:
        raise AssertionError(f"missing list {name}")
    return set(re.findall(r'"([^\"]+)"', match.group(1)))


class TerraformNetworkContractTests(unittest.TestCase):
    def test_new_cell_example_reserves_one_quarter_of_its_vpc(self):
        example = source("cell/terraform.tfvars.example")
        vpc = ipaddress.ip_network(scalar(example, "vpc_cidr"))
        self.assertEqual(vpc.prefixlen, 20)
        subnets = {ipaddress.ip_network(cidr) for cidr in subnet_cidrs(example)}
        quarters = set(vpc.subnets(new_prefix=22))
        self.assertEqual(len(subnets), 3)
        self.assertTrue(subnets < quarters)
        plan = yaml.safe_load(NETWORK_PLAN.read_text())
        reserved = {ipaddress.ip_network(cidr) for cidr in plan["clusters"]["runtime-b"]["reservedSubnets"]}
        self.assertEqual(quarters - subnets, reserved)
        # Address planning must not silently open a larger runtime/FDB envelope.
        self.assertEqual(integer(source("cell/main.tf"), "cluster_max_pod_num"), 64)

    def test_cluster_vpc_creation_has_live_cvm_zone_preconditions(self):
        for component in ("management", "cell"):
            main = source(f"{component}/main.tf")
            self.assertIn('data "tencentcloud_zones" "cvm"', main)
            self.assertIn('product = "cvm"', main)
            self.assertIn('zone.zone_state == "AVAILABLE"', main)
            self.assertIn('zone.zone_type == "availability-zone"', main)
            block = re.search(
                rf'resource "tencentcloud_vpc" "{component}" \{{(.*?)\n\}}',
                main,
                re.S,
            )
            self.assertIsNotNone(block)
            self.assertIn("precondition {", block.group(1))
            self.assertIn('var.availability_mode == "production-multi-zone" ? 3 : 1', block.group(1))
            self.assertIn("contains(local.available_cvm_zones, subnet.availability_zone)", block.group(1))

    def test_examples_match_reviewed_network_plan(self):
        plan = yaml.safe_load(NETWORK_PLAN.read_text())
        management = source("management/terraform.tfvars.example")
        cell = source("cell/terraform.tfvars.example")

        for text, component, cluster_name in (
            (management, "management", "hub"),
            (cell, "cell", "runtime-b"),
        ):
            cluster = plan["clusters"][cluster_name]
            self.assertEqual(scalar(text, "regional_vpc_aggregate"), plan["regionalVpcAggregate"])
            self.assertEqual(string_list(text, "reserved_cidrs"), set(plan["reservedCidrs"]))
            self.assertEqual(scalar(text, "vpc_cidr"), cluster["vpcCidr"])
            self.assertEqual(scalar(text, "cluster_pod_cidr"), cluster["podCidr"])
            self.assertEqual(scalar(text, "cluster_service_cidr"), cluster["serviceCidr"])
            self.assertEqual(subnet_cidrs(text), set(cluster["subnets"].values()))
            service_prefix = int(cluster["serviceCidr"].split("/", 1)[1])
            self.assertGreaterEqual(service_prefix, 17)
            self.assertLessEqual(service_prefix, 27)
            self.assertEqual(
                ipaddress.ip_network(cluster["serviceCidr"]).num_addresses,
                integer(source(f"{component}/main.tf"), "cluster_max_service_num"),
            )

    def test_foundation_is_the_only_ccn_owner(self):
        foundation = source("foundation/main.tf")
        foundation_variables = source("foundation/variables.tf")
        management = source("management/main.tf")
        cell = source("cell/main.tf")
        self.assertIn('resource "tencentcloud_ccn" "fleet"', foundation)
        self.assertIn("bandwidth_limit_type = var.ccn_bandwidth_limit_type", foundation)
        self.assertIn("instance_metering_type = var.ccn_metering_type", foundation)
        self.assertIn("route_overlap_flag = true", foundation)
        self.assertRegex(
            foundation_variables,
            r'variable "ccn_bandwidth_limit_type"[\s\S]*?default\s*=\s*"INTER_REGION_LIMIT"',
        )
        self.assertRegex(
            foundation_variables,
            r'variable "ccn_metering_type"[\s\S]*?default\s*=\s*"TRAFFIC"',
        )
        self.assertNotIn('resource "tencentcloud_ccn"', management)
        self.assertNotIn('resource "tencentcloud_ccn"', cell)

    def test_operations_network_is_fail_closed_to_cells(self):
        main = source("operations-network/main.tf")
        variables = source("operations-network/variables.tf")
        management = source("management/main.tf")
        self.assertIn('data "tencentcloud_vpc_instances" "operations"', main)
        self.assertIn("name       = var.operations_vpc_name", main)
        self.assertIn("cidr_block = var.operations_vpc_cidr", main)
        self.assertNotIn("operations_vpc_id", variables)
        self.assertIn("ccnRouteTableId", management)
        self.assertIn('resource "tencentcloud_ccn_route_table" "operations"', main)
        self.assertIn('resource "tencentcloud_ccn_route_table_input_policies" "operations"', main)
        self.assertIn('resource "tencentcloud_ccn_route_table_broadcast_policies" "default_isolation"', main)
        self.assertRegex(
            main,
            r'action\s*=\s*"accept"[\s\S]*?values\s*=\s*\[local\.management_vpc_id\][\s\S]*?action\s*=\s*"drop"',
        )
        self.assertRegex(
            main,
            r'action\s*=\s*"drop"[\s\S]*?name\s*=\s*"instance-type"[\s\S]*?values\s*=\s*\["VPC"\]',
        )
        self.assertIn("tencentcloud_ccn_route_table_broadcast_policies.default_isolation", main)

    def test_foundation_is_the_only_account_oidc_policy_owner(self):
        foundation = source("foundation/main.tf")
        outputs = source("foundation/outputs.tf")
        management = source("management/main.tf")
        cell = source("cell/main.tf")
        resource = (
            'resource "tencentcloud_cam_role_policy_attachment_by_name" '
            '"tke_oidc_config"'
        )
        self.assertIn(resource, foundation)
        self.assertNotIn(resource, management)
        self.assertNotIn(resource, cell)
        self.assertIn("tke_oidc_config_ready", outputs)
        self.assertIn(
            "try(local.regional_network.tke_oidc_config_ready, false)",
            cell,
        )

    def test_foundation_tcr_repository_descriptions_converge(self):
        foundation = source("foundation/main.tf")
        brief = re.search(r'brief_desc\s*=\s*"([^"]+)"', foundation)
        description = re.search(r'(?m)^\s*description\s*=\s*"([^"]+)"', foundation)
        self.assertIsNotNone(brief)
        self.assertIsNotNone(description)
        self.assertEqual(brief.group(1), description.group(1))

    def test_management_and_cell_attach_their_exact_vpcs(self):
        management = source("management/main.tf")
        cell = source("cell/main.tf")
        self.assertRegex(
            management,
            r'resource "tencentcloud_ccn_attachment_v2" "management"[\s\S]*?'
            r'ccn_id\s*=\s*local\.regional_network\.ccn_id[\s\S]*?'
            r'instance_id\s*=\s*tencentcloud_vpc\.management\.id',
        )
        self.assertRegex(
            cell,
            r'resource "tencentcloud_ccn_attachment_v2" "cell"[\s\S]*?'
            r'ccn_id\s*=\s*local\.regional_network\.ccn_id[\s\S]*?'
            r'instance_id\s*=\s*tencentcloud_vpc\.cell\.id',
        )
        for component in (management, cell):
            self.assertRegex(component, r"enable_public_domain_dns\s*=\s*true")
            self.assertRegex(component, r"enable_vpc_domain_dns\s*=\s*true")

    def test_management_nodes_accept_reviewed_cell_vpc_aggregate(self):
        management = source("management/main.tf")
        self.assertIn(
            "var.vpc_cidr, var.cluster_pod_cidr, var.regional_vpc_aggregate",
            management,
        )

    def test_workers_api_has_a_dedicated_management_only_security_group(self):
        management = source("management/main.tf")
        variables = source("management/variables.tf")
        example = source("management/terraform.tfvars.example")
        self.assertIn('resource "tencentcloud_security_group" "workers_api"', management)
        self.assertIn('resource "tencentcloud_security_group_rule" "workers_api_ingress"', management)
        self.assertIn('port_range        = "6688"', management)
        self.assertIn("toset([var.vpc_cidr])", management)
        self.assertNotIn("var.regional_vpc_aggregate,\n    var.trusted_workers_api_cidrs", management)
        self.assertRegex(
            management,
            r"workersApiSecurityGroup\s*=\s*tencentcloud_security_group\.workers_api\.id",
        )
        self.assertIn('variable "trusted_workers_api_cidrs"', variables)
        plan = yaml.safe_load(NETWORK_PLAN.read_text())
        self.assertEqual(
            string_list(example, "trusted_workers_api_cidrs"),
            {"9.134.163.40/32", plan["operationsNetwork"]["vpcCidr"]},
        )

    def test_worker_registry_has_a_dedicated_regional_security_group(self):
        management = source("management/main.tf")
        self.assertIn('resource "tencentcloud_security_group" "worker_registry"', management)
        self.assertIn(
            'resource "tencentcloud_security_group_rule" "worker_registry_ingress"',
            management,
        )
        self.assertIn("worker_registry_ingress_cidrs = toset([var.regional_vpc_aggregate])", management)
        self.assertIn('port_range        = "8080"', management)
        self.assertRegex(
            management,
            r"workerRegistrySecurityGroup\s*=\s*tencentcloud_security_group\.worker_registry\.id",
            r"federationSecurityGroup\s*=\s*tencentcloud_security_group\.federation\.id",
        )
        self.assertRegex(
            management,
            r"regionalVpcAggregate\s*=\s*var\.regional_vpc_aggregate",
        )

    def test_object_router_reuses_workers_api_group_with_port_isolation(self):
        management = source("management/main.tf")
        self.assertNotIn('resource "tencentcloud_security_group" "object_router"', management)
        self.assertIn(
            'object_router_ingress_cidrs = toset([var.regional_vpc_aggregate])',
            management,
        )
        self.assertRegex(
            management,
            r'resource "tencentcloud_security_group_rule" "object_router_ingress"[\s\S]*?security_group_id\s*=\s*tencentcloud_security_group\.workers_api\.id[\s\S]*?port_range\s*=\s*"19085"',
        )
        self.assertRegex(
            management,
            r"objectRouterSecurityGroup\s*=\s*tencentcloud_security_group\.workers_api\.id",
        )

    def test_cell_nodes_accept_reviewed_management_vpc_aggregate(self):
        cell = source("cell/main.tf")
        self.assertIn(
            "var.vpc_cidr, var.cluster_pod_cidr, var.regional_vpc_aggregate",
            cell,
        )

    def test_stateless_capacity_is_an_official_autoscaling_native_node_pool(self):
        cell = source("cell/main.tf")
        self.assertIn(
            'resource "tencentcloud_kubernetes_native_node_pool" "stateless"',
            cell,
        )
        for fragment in (
            'type       = "Native"',
            "enable_autoscaling = true",
            "min_replicas  = var.stateless_node_pool.min_replicas",
            "max_replicas  = var.stateless_node_pool.max_replicas",
            'create_policy = "ZoneEquality"',
            'key    = "startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission"',
            'resource "tencentcloud_kubernetes_addon_config" "cluster_autoscaler"',
            'data "tencentcloud_kubernetes_addons" "cluster_autoscaler"',
            "max-nodes-total                  = var.cluster_autoscaler_max_nodes_total",
            'haRestartAt      = try(local.cluster_autoscaler_observed.global.cluster.haRestartAt, "0")',
            'statelessNodePoolId = split("#", tencentcloud_kubernetes_native_node_pool.stateless.id)[1]',
            "is_scale_in_enabled            = true",
            "max_concurrent_scale_in        = 1",
            "ignore_changes = [native[0].replicas]",
        ):
            self.assertIn(fragment, cell)
        renderer = source("render-cell-assets.py")
        self.assertIn('ARGO_MACHINE_POOL_NAMES = ("control", "fdb", "runtime")', renderer)
        self.assertNotIn('"stateless": "np-statels0"', renderer)

    def test_every_cluster_owns_the_network_policy_controller_addon(self):
        for component, cluster in (("management", "management"), ("cell", "cell")):
            main = source(f"{component}/main.tf")
            variables = source(f"{component}/variables.tf")
            self.assertIn(
                'resource "tencentcloud_kubernetes_addon" "network_policy"', main
            )
            self.assertRegex(
                main,
                rf'cluster_id\s*=\s*tencentcloud_kubernetes_cluster\.{cluster}\.id',
            )
            for fragment in (
                'addon_name    = "networkpolicy"',
                "addon_version = var.network_policy_addon_version",
                "clusterCidr      = var.cluster_pod_cidr",
                "highAvailability = true",
                "serviceCidr      = var.cluster_service_cidr",
                'networkType      = "GR"',
                'controller   = "kube-system/networkpolicy"',
            ):
                self.assertIn(fragment, main)
            self.assertRegex(
                variables,
                r'variable "network_policy_addon_version"[\s\S]*?default\s*=\s*"1\.0\.6"',
            )

    def test_network_checks_use_terraform_1_9_functions(self):
        for component in ("management", "cell"):
            main = source(f"{component}/main.tf")
            self.assertNotIn("cidrcontains(", main)
            self.assertIn("network_starts", main)
            self.assertIn("network_ends", main)
            self.assertIn('replace(var.', main)

    def test_cell_derives_management_identity_and_api_cidr_from_state(self):
        cell = source("cell/main.tf")
        self.assertIn('data "terraform_remote_state" "management"', cell)
        self.assertIn("local.management.network.vpcCidr", cell)
        self.assertIn("local.management.network.ccnId == local.regional_network.ccn_id", cell)
        renderer = source("render-cell-assets.py")
        self.assertIn('"managementCluster": inventory["kubernetes"]["clusterId"]', renderer)

    def test_management_starts_with_three_zonal_workers_for_argocd_ha(self):
        management = source("management/main.tf")
        variables = source("management/variables.tf")
        self.assertIn("length(var.subnets) == 3", variables)
        self.assertIn('resource "tencentcloud_instance" "bootstrap"', management)
        self.assertIn('resource "tencentcloud_instance" "ha_worker"', management)
        self.assertIn("for_each = local.ha_worker_subnets", management)
        self.assertIn('resource "tencentcloud_kubernetes_cluster_attachment" "ha_worker"', management)
        self.assertIn("initialWorkerInstanceIds", management)


if __name__ == "__main__":
    unittest.main()
