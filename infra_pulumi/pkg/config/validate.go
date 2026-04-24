package config

import "fmt"

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
	return nil
}
