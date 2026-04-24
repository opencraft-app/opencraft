package blueprint

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadStaticVPCShardBlueprintAndFingerprint(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vpc-shard-blueprint.yaml")
	content := `
schema_version: v1alpha1
source_region: ap-beijing
network_template_id: net-a
vpc_cidr: 10.0.0.0/16
support_subnet:
  name: support
  cidr: 10.0.0.0/24
  zone: ap-beijing-8
  role: support
  ordinal: 0
workload_subnets:
  - name: workload-b
    cidr: 10.0.2.0/24
    zone: ap-beijing-8
    role: workload
    ordinal: 2
  - name: workload-a
    cidr: 10.0.1.0/24
    zone: ap-beijing-8
    role: workload
    ordinal: 1
nat_shape:
  mode: single
  gateways:
    - name: nat-main
      zone: ap-beijing-8
      subnet: support
route_shape:
  route_tables:
    - name: rt-main
      main: true
      associations:
        - target: support
        - target: workload:1
        - target: workload:2
      routes:
        - destination: 10.0.0.0/16
          next_hop_type: LOCAL
          next_hop_ref: local
          enabled: true
        - destination: 0.0.0.0/0
          next_hop_type: NAT
          next_hop_ref: nat-main
          enabled: true
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write blueprint: %v", err)
	}
	bp, err := LoadStaticVPCShardBlueprint(path)
	if err != nil {
		t.Fatalf("LoadStaticVPCShardBlueprint: %v", err)
	}
	if len(bp.WorkloadSubnets) != 2 || bp.WorkloadSubnets[0].Name != "workload-a" {
		t.Fatalf("expected normalized workload order, got %+v", bp.WorkloadSubnets)
	}
	fp1 := StaticBlueprintFingerprint(bp)
	fp2 := StaticBlueprintFingerprint(bp)
	if fp1 == "" || fp1 != fp2 {
		t.Fatalf("expected stable fingerprint, got %q and %q", fp1, fp2)
	}
}

func TestValidateStaticVPCShardBlueprintFailsClosed(t *testing.T) {
	err := ValidateStaticVPCShardBlueprint(StaticVPCShardBlueprint{
		SchemaVersion:     "v1alpha1",
		SourceRegion:      "ap-beijing",
		NetworkTemplateID: "net-a",
		VPCCIDR:           "10.0.0.0/16",
		SupportSubnet:     StaticSubnet{CIDR: "10.0.0.0/24", Zone: "ap-beijing-8"},
		WorkloadSubnets: []StaticSubnet{
			{CIDR: "10.0.1.0/24", Zone: "ap-beijing-8"},
		},
		// missing nat_shape / route_shape
	})
	if err == nil {
		t.Fatalf("expected validation failure")
	}
}

func TestValidateStaticVPCShardBlueprintRequiresNetworkTemplateID(t *testing.T) {
	err := ValidateStaticVPCShardBlueprint(StaticVPCShardBlueprint{
		SchemaVersion: "v1alpha1",
		SourceRegion:  "ap-beijing",
		VPCCIDR:       "10.0.0.0/16",
		SupportSubnet: StaticSubnet{CIDR: "10.0.0.0/24", Zone: "ap-beijing-8"},
		WorkloadSubnets: []StaticSubnet{
			{CIDR: "10.0.1.0/24", Zone: "ap-beijing-8"},
		},
		NATShape: StaticNATShape{
			Mode:     "single",
			Gateways: []StaticNATGateway{{Name: "nat-main", Zone: "ap-beijing-8", Subnet: "support"}},
		},
		RouteShape: StaticRouteShape{
			RouteTables: []StaticRouteTable{
				{
					Name: "rt-main",
					Main: true,
					Associations: []StaticRouteAssociation{
						{Target: "support"},
					},
					Routes: []StaticRoute{
						{Destination: "10.0.0.0/16", NextHopType: "LOCAL", NextHopRef: "local", Enabled: true},
						{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-main", Enabled: true},
					},
				},
			},
		},
	})
	if err == nil || err.Error() != "missing network_template_id" {
		t.Fatalf("expected missing network_template_id error, got %v", err)
	}
}

func TestStaticBlueprintFingerprintStableAcrossRouteTableAndNatOrder(t *testing.T) {
	bpA := StaticVPCShardBlueprint{
		SchemaVersion:     "v1alpha1",
		SourceRegion:      "ap-beijing",
		NetworkTemplateID: "net-a",
		VPCCIDR:           "10.0.0.0/16",
		SupportSubnet:     StaticSubnet{Name: "support", CIDR: "10.0.0.0/24", Zone: "ap-beijing-8", Role: "support", Ordinal: 0},
		WorkloadSubnets: []StaticSubnet{
			{Name: "workload-a", CIDR: "10.0.1.0/24", Zone: "ap-beijing-8", Role: "workload", Ordinal: 1},
			{Name: "workload-b", CIDR: "10.0.2.0/24", Zone: "ap-beijing-7", Role: "workload", Ordinal: 2},
		},
		NATShape: StaticNATShape{
			Mode: "multi",
			Gateways: []StaticNATGateway{
				{Name: "nat-b", Zone: "ap-beijing-7", Subnet: "workload:2"},
				{Name: "nat-a", Zone: "ap-beijing-8", Subnet: "support"},
			},
		},
		RouteShape: StaticRouteShape{
			RouteTables: []StaticRouteTable{
				{
					Name: "rt-z",
					Routes: []StaticRoute{
						{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-b", Enabled: true},
						{Destination: "10.0.0.0/16", NextHopType: "LOCAL", NextHopRef: "local", Enabled: true},
					},
				},
				{
					Name: "rt-a",
					Main: true,
					Associations: []StaticRouteAssociation{
						{Target: "support"},
						{Target: "workload:1"},
					},
					Routes: []StaticRoute{
						{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-a", Enabled: true},
						{Destination: "10.0.0.0/16", NextHopType: "LOCAL", NextHopRef: "local", Enabled: true},
					},
				},
			},
		},
	}
	bpB := StaticVPCShardBlueprint{
		SchemaVersion:     "v1alpha1",
		SourceRegion:      "ap-beijing",
		NetworkTemplateID: "net-a",
		VPCCIDR:           "10.0.0.0/16",
		SupportSubnet:     StaticSubnet{Name: "support", CIDR: "10.0.0.0/24", Zone: "ap-beijing-8", Role: "support", Ordinal: 0},
		WorkloadSubnets: []StaticSubnet{
			{Name: "workload-b", CIDR: "10.0.2.0/24", Zone: "ap-beijing-7", Role: "workload", Ordinal: 2},
			{Name: "workload-a", CIDR: "10.0.1.0/24", Zone: "ap-beijing-8", Role: "workload", Ordinal: 1},
		},
		NATShape: StaticNATShape{
			Mode: "multi",
			Gateways: []StaticNATGateway{
				{Name: "nat-a", Zone: "ap-beijing-8", Subnet: "support"},
				{Name: "nat-b", Zone: "ap-beijing-7", Subnet: "workload:2"},
			},
		},
		RouteShape: StaticRouteShape{
			RouteTables: []StaticRouteTable{
				{
					Name: "rt-a",
					Main: true,
					Associations: []StaticRouteAssociation{
						{Target: "workload:1"},
						{Target: "support"},
					},
					Routes: []StaticRoute{
						{Destination: "10.0.0.0/16", NextHopType: "LOCAL", NextHopRef: "local", Enabled: true},
						{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-a", Enabled: true},
					},
				},
				{
					Name: "rt-z",
					Routes: []StaticRoute{
						{Destination: "10.0.0.0/16", NextHopType: "LOCAL", NextHopRef: "local", Enabled: true},
						{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-b", Enabled: true},
					},
				},
			},
		},
	}

	fpA := StaticBlueprintFingerprint(bpA)
	fpB := StaticBlueprintFingerprint(bpB)
	if fpA == "" || fpA != fpB {
		t.Fatalf("expected stable fingerprint across nat/route ordering, got %q and %q", fpA, fpB)
	}
}
