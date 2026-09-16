package config

import (
	"fmt"
	"regexp"
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
