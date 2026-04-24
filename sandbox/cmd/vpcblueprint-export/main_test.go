package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cvm-mock-e2b/internal/blueprint"
	"cvm-mock-e2b/internal/provider"
)

func TestConvertStaticSubnets(t *testing.T) {
	items := convertStaticSubnets([]provider.VPCShardSubnetSpec{
		{Name: "workload-a", CIDR: "10.0.1.0/24", Zone: "ap-beijing-8", Role: "workload", Ordinal: 1},
	})
	if len(items) != 1 || items[0].Name != "workload-a" || items[0].Role != "workload" {
		t.Fatalf("unexpected converted subnets: %+v", items)
	}
}

func TestSaveStaticBlueprintExport(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vpc-shard-blueprint.yaml")
	bp := blueprint.StaticVPCShardBlueprint{
		SchemaVersion:     "v1alpha1",
		SourceRegion:      "ap-beijing",
		NetworkTemplateID: "net-a",
		VPCCIDR:           "10.0.0.0/16",
		SupportSubnet: blueprint.StaticSubnet{
			Name:    "support",
			CIDR:    "10.0.0.0/24",
			Zone:    "ap-beijing-8",
			Role:    "support",
			Ordinal: 0,
		},
		WorkloadSubnets: []blueprint.StaticSubnet{
			{Name: "workload-a", CIDR: "10.0.1.0/24", Zone: "ap-beijing-8", Role: "workload", Ordinal: 1},
		},
		NATShape: blueprint.StaticNATShape{
			Mode:     "single",
			Gateways: []blueprint.StaticNATGateway{{Name: "nat-main", Zone: "ap-beijing-8", Subnet: "support"}},
		},
		RouteShape: blueprint.StaticRouteShape{
			RouteTables: []blueprint.StaticRouteTable{
				{
					Name: "rt-main",
					Main: true,
					Associations: []blueprint.StaticRouteAssociation{
						{Target: "support"},
					},
					Routes: []blueprint.StaticRoute{
						{Destination: "10.0.0.0/16", NextHopType: "LOCAL", NextHopRef: "local", Enabled: true},
						{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-main", Enabled: true},
					},
				},
			},
		},
	}
	if err := blueprint.SaveStaticVPCShardBlueprint(path, bp); err != nil {
		t.Fatalf("SaveStaticVPCShardBlueprint: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !strings.Contains(string(raw), "schema_version: v1alpha1") {
		t.Fatalf("unexpected blueprint file contents: %s", string(raw))
	}
	if strings.Contains(string(raw), "source_vpc_id:") || strings.Contains(string(raw), "exported_at:") || strings.Contains(string(raw), "k8s_adjacent_shape:") {
		t.Fatalf("expected minimal blueprint artifact, got %s", string(raw))
	}
}
