package config

import (
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
)

var pulsarNamespacePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,16}$`)

func ValidateInventory(inv *Inventory) error {
	if inv == nil {
		return fmt.Errorf("inventory is nil")
	}
	if inv.EnvName == "" || inv.Region == "" {
		return fmt.Errorf("inventory missing env_name or region")
	}
	if inv.Network.VpcCIDR == "" {
		return fmt.Errorf("inventory missing network.vpc_cidr")
	}
	switch inv.Profile {
	case ProfileSandboxNetwork:
		return validateSandboxNetworkInventory(inv)
	case ProfileFull:
	default:
		return fmt.Errorf("inventory has unsupported profile %q", inv.Profile)
	}
	if inv.Stacks.TKE.ClusterVersion == "" {
		return fmt.Errorf("inventory missing stacks.tke.cluster_version")
	}
	if inv.Stacks.TKE.NetworkType == "" {
		return fmt.Errorf("inventory missing stacks.tke.network_type")
	}
	if inv.Stacks.TKE.NetworkType == "VPC-CNI" {
		if inv.Stacks.TKE.ServiceCIDR == "" {
			return fmt.Errorf("inventory missing stacks.tke.service_cidr for VPC-CNI")
		}
		if inv.Stacks.TKE.VpcCniType == "" {
			return fmt.Errorf("inventory missing stacks.tke.vpc_cni_type for VPC-CNI")
		}
	}
	if inv.Stacks.Connectivity.Enabled {
		if inv.Stacks.Connectivity.AccessVPC.CIDR == "" {
			return fmt.Errorf("inventory missing stacks.connectivity.access_vpc.cidr")
		}
		if inv.Stacks.Connectivity.AccessVPC.SubnetCIDR == "" {
			return fmt.Errorf("inventory missing stacks.connectivity.access_vpc.subnet_cidr")
		}
		if inv.Stacks.Connectivity.AccessVPC.AvailabilityZone == "" {
			return fmt.Errorf("inventory missing stacks.connectivity.access_vpc.availability_zone")
		}
		if inv.Stacks.Connectivity.CCN.Name == "" {
			return fmt.Errorf("inventory missing stacks.connectivity.ccn.name")
		}
		if inv.Stacks.Connectivity.CCN.RemoteRegion == "" {
			return fmt.Errorf("inventory missing stacks.connectivity.ccn.remote_region")
		}
		if inv.Stacks.Connectivity.CCN.RemoteVpcID == "" {
			return fmt.Errorf("inventory missing stacks.connectivity.ccn.remote_vpc_id")
		}
		if inv.Stacks.Connectivity.CCN.RemoteVpcCIDR == "" {
			return fmt.Errorf("inventory missing stacks.connectivity.ccn.remote_vpc_cidr")
		}
		if inv.Stacks.Connectivity.CCN.RemoteRouteTableID == "" {
			return fmt.Errorf("inventory missing stacks.connectivity.ccn.remote_route_table_id")
		}
		if inv.Stacks.Connectivity.PrivateLink.Enabled {
			if inv.Stacks.Connectivity.PrivateLink.ProviderServiceName == "" {
				return fmt.Errorf("inventory missing stacks.connectivity.private_link.provider_service_name")
			}
			if inv.Stacks.Connectivity.PrivateLink.ConsumerEndpointName == "" {
				return fmt.Errorf("inventory missing stacks.connectivity.private_link.consumer_endpoint_name")
			}
		}
	}
	if err := validatePulsarInventory(inv.Stacks.Pulsar); err != nil {
		return err
	}
	if err := validateCollaborationInventory(inv.Stacks.Collaboration); err != nil {
		return err
	}
	return nil
}

func validateSandboxNetworkInventory(inv *Inventory) error {
	if strings.TrimSpace(inv.Network.SupportSubnetKey) == "" {
		return fmt.Errorf("sandbox-network inventory missing network.support_subnet_key")
	}
	if len(inv.Network.SandboxPoolSubnetKeys) == 0 {
		return fmt.Errorf("sandbox-network inventory requires at least one pool subnet")
	}
	seen := map[string]struct{}{}
	for _, key := range inv.Network.SandboxPoolSubnetKeys {
		key = strings.TrimSpace(key)
		if key == "" || key == inv.Network.SupportSubnetKey {
			return fmt.Errorf("sandbox-network inventory has invalid pool subnet key %q", key)
		}
		if _, ok := seen[key]; ok {
			return fmt.Errorf("sandbox-network inventory has duplicate pool subnet key %q", key)
		}
		seen[key] = struct{}{}
	}
	networking := inv.Stacks.Networking
	if strings.TrimSpace(networking.PrimaryNATGatewayName) == "" {
		return fmt.Errorf("sandbox-network inventory missing stacks.networking.primary_nat_gateway_name")
	}
	if strings.TrimSpace(networking.RouteTableName) == "" {
		return fmt.Errorf("sandbox-network inventory missing stacks.networking.route_table_name")
	}
	if len(networking.PrimaryEIPs) == 0 || len(networking.PrimaryEIPs) > 5 {
		return fmt.Errorf("sandbox-network inventory requires 1 to 5 primary EIPs")
	}
	if networking.SecondaryNATEnabled() {
		if strings.TrimSpace(networking.SecondaryNATGatewayName) == "" || len(networking.SecondaryEIPs) == 0 {
			return fmt.Errorf("sandbox-network inventory enabled secondary NAT without name/EIPs")
		}
	}
	requiredSubnets := append([]string(nil), inv.Network.SandboxPoolSubnetKeys...)
	requiredSubnets = append(requiredSubnets, inv.Network.SupportSubnetKey)
	for _, key := range requiredSubnets {
		subnet, ok := networking.SNATSubnets[key]
		if !ok || strings.TrimSpace(subnet.AvailabilityZone) == "" || strings.TrimSpace(subnet.Description) == "" {
			return fmt.Errorf("sandbox-network inventory missing complete SNAT subnet %q", key)
		}
	}
	if strings.TrimSpace(inv.Stacks.Security.SandboxSG.SecurityGroupName) == "" {
		return fmt.Errorf("sandbox-network inventory missing Sandbox security group name")
	}
	if len(inv.Stacks.Security.SandboxSG.Egress) == 0 {
		return fmt.Errorf("sandbox-network inventory requires Sandbox security group egress rules")
	}
	return nil
}

func validateCollaborationInventory(inv CollaborationInventory) error {
	if !inv.Enabled {
		return nil
	}
	required := map[string]string{
		"existing_cluster_id": inv.ExistingClusterID,
		"existing_endpoint":   inv.ExistingEndpoint,
		"database":            inv.Database,
		"account":             inv.Account,
		"account_host":        inv.AccountHost,
		"ssm_secret_name":     inv.SSMSecretName,
		"namespace":           inv.Namespace,
		"node_pool":           inv.NodePool,
	}
	for field, value := range required {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("inventory missing stacks.collaboration.%s", field)
		}
	}
	if inv.AccountHost != "%" {
		return fmt.Errorf("inventory stacks.collaboration.account_host must be %% for dynamic TKE clients")
	}
	host, rawPort, err := net.SplitHostPort(inv.ExistingEndpoint)
	if err != nil || strings.TrimSpace(host) == "" {
		return fmt.Errorf("inventory stacks.collaboration.existing_endpoint must be host:port")
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil || port <= 0 || port > 65535 {
		return fmt.Errorf("inventory stacks.collaboration.existing_endpoint has an invalid port")
	}
	return nil
}

func validatePulsarInventory(inv PulsarInventory) error {
	if !inv.Enabled {
		return nil
	}
	required := map[string]string{
		"expected_cluster_name":   inv.ExpectedClusterName,
		"expected_product_name":   inv.ExpectedProductName,
		"expected_vpc_id":         inv.ExpectedVPCID,
		"expected_subnet_id":      inv.ExpectedSubnetID,
		"namespace":               inv.Namespace,
		"topic":                   inv.Topic,
		"dead_letter_topic":       inv.DeadLetterTopic,
		"user_auth_producer_role": inv.UserAuthProducerRole,
		"ctl_producer_role":       inv.CTLProducerRole,
		"referral_consumer_role":  inv.ReferralConsumerRole,
		"user_auth_ssm_secret":    inv.UserAuthSSMSecret,
		"ctl_ssm_secret":          inv.CTLSSMSecret,
		"referral_ssm_secret":     inv.ReferralSSMSecret,
	}
	if !inv.ManageCluster {
		required["existing_cluster_id"] = inv.ExistingClusterID
		required["broker_url"] = inv.BrokerURL
	}
	for field, value := range required {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("inventory missing stacks.pulsar.%s", field)
		}
	}
	if !pulsarNamespacePattern.MatchString(inv.Namespace) {
		return fmt.Errorf("inventory stacks.pulsar.namespace must be 1-16 ASCII letters, digits, hyphens, or underscores")
	}
	if len(inv.ExpectedZoneIDs) == 0 {
		return fmt.Errorf("inventory missing stacks.pulsar.expected_zone_ids")
	}
	for _, zoneID := range inv.ExpectedZoneIDs {
		if zoneID <= 0 {
			return fmt.Errorf("inventory stacks.pulsar.expected_zone_ids must contain positive values")
		}
	}
	if inv.ManageCluster {
		if (inv.ExistingClusterID == "") != (inv.BrokerURL == "") {
			return fmt.Errorf("managed Pulsar existing_cluster_id and broker_url must both be empty before creation or both record the created cluster")
		}
		if inv.PurchaseMonths < 1 || inv.PurchaseMonths > 50 {
			return fmt.Errorf("managed Pulsar purchase_months must be between 1 and 50")
		}
		if inv.StorageSizeGB < 0 {
			return fmt.Errorf("managed Pulsar storage_size_gb must not be negative")
		}
		if inv.AutoRenewFlag != 0 && inv.AutoRenewFlag != 1 {
			return fmt.Errorf("managed Pulsar auto_renew_flag must be 0 or 1")
		}
		if inv.AutoVoucher != 0 && inv.AutoVoucher != 1 {
			return fmt.Errorf("managed Pulsar auto_voucher must be 0 or 1")
		}
	}
	if inv.MessageTTLSeconds <= 0 {
		return fmt.Errorf("inventory stacks.pulsar.message_ttl_seconds must be positive")
	}
	if inv.RetentionMinutes < 0 {
		return fmt.Errorf("inventory stacks.pulsar.retention_minutes must not be negative")
	}
	if inv.RetentionSizeMB < 0 {
		return fmt.Errorf("inventory stacks.pulsar.retention_size_mb must not be negative")
	}
	if (inv.RetentionMinutes == 0) != (inv.RetentionSizeMB == 0) {
		return fmt.Errorf("inventory stacks.pulsar retention time and size must either both be zero or both be configured")
	}
	if inv.RetentionSizeMB > 0 && inv.RetentionSizeMB < 10240 {
		return fmt.Errorf("inventory stacks.pulsar.retention_size_mb must be at least 10240 when retention is enabled")
	}
	return nil
}
