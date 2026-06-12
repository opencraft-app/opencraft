package provider

import (
	"context"
	"strings"
	"testing"

	"cvm-mock-e2b/internal/blueprint"
	"cvm-mock-e2b/internal/core"
)

func TestBuildHealthTargetPrivateUsesDirectInstanceIP(t *testing.T) {
	p := &TencentCloudProvider{
		cfg: TencentConfig{
			AddressType:         "private",
			IngressProxyBaseURL: "http://ingressproxy-router",
		},
	}

	gotURL, gotHost, err := p.buildHealthTarget("10.15.224.144")
	if err != nil {
		t.Fatalf("buildHealthTarget returned error: %v", err)
	}

	wantURL := "http://10.15.224.144:49983/health"
	if gotURL != wantURL {
		t.Fatalf("verify url mismatch: got %q want %q", gotURL, wantURL)
	}
	if gotHost != "" {
		t.Fatalf("host override mismatch: got %q want empty", gotHost)
	}
}

func TestBuildHealthTargetPublicUsesDirectInstanceIP(t *testing.T) {
	p := &TencentCloudProvider{
		cfg: TencentConfig{
			AddressType: "public",
		},
	}

	gotURL, gotHost, err := p.buildHealthTarget("8.8.8.8")
	if err != nil {
		t.Fatalf("buildHealthTarget returned error: %v", err)
	}

	wantURL := "http://8.8.8.8:49983/health"
	if gotURL != wantURL {
		t.Fatalf("verify url mismatch: got %q want %q", gotURL, wantURL)
	}
	if gotHost != "" {
		t.Fatalf("host override mismatch: got %q want empty", gotHost)
	}
}

func TestBuildEnvdProcessTargetPrivateUsesDirectInstanceIP(t *testing.T) {
	p := &TencentCloudProvider{
		cfg: TencentConfig{
			AddressType:         "private",
			IngressProxyBaseURL: "http://ingressproxy-router",
		},
	}

	gotURL, gotHost, err := p.buildEnvdProcessTarget("10.15.224.144")
	if err != nil {
		t.Fatalf("buildEnvdProcessTarget returned error: %v", err)
	}

	wantURL := "http://10.15.224.144:49983/process.Process/Start"
	if gotURL != wantURL {
		t.Fatalf("process url mismatch: got %q want %q", gotURL, wantURL)
	}
	if gotHost != "" {
		t.Fatalf("host override mismatch: got %q want empty", gotHost)
	}
}

func TestBuildEnvdProcessTargetPublicUsesDirectInstanceIP(t *testing.T) {
	p := &TencentCloudProvider{
		cfg: TencentConfig{
			AddressType: "public",
		},
	}

	gotURL, gotHost, err := p.buildEnvdProcessTarget("8.8.8.8")
	if err != nil {
		t.Fatalf("buildEnvdProcessTarget returned error: %v", err)
	}

	wantURL := "http://8.8.8.8:49983/process.Process/Start"
	if gotURL != wantURL {
		t.Fatalf("process url mismatch: got %q want %q", gotURL, wantURL)
	}
	if gotHost != "" {
		t.Fatalf("host override mismatch: got %q want empty", gotHost)
	}
}

func TestStartTerminalSessionParametersUseAgentUser(t *testing.T) {
	params := startTerminalSessionParameters("ins-test")

	if got := params["InstanceId"]; got != "ins-test" {
		t.Fatalf("unexpected instance id: %v", got)
	}
	if got := params["Username"]; got != defaultTerminalUsername {
		t.Fatalf("unexpected terminal username: %v", got)
	}
	if got := params["WorkingDirectory"]; got != defaultTerminalWorkingDirectory {
		t.Fatalf("unexpected terminal working directory: %v", got)
	}
}

func TestPoolSecurityGroupsReturnsTrimmedValues(t *testing.T) {
	pool := core.Pool{
		ID:             "pool-c0",
		SecurityGroups: []string{" sg-a ", "sg-b"},
	}

	got, err := poolSecurityGroups(pool)
	if err != nil {
		t.Fatalf("poolSecurityGroups returned error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 security groups, got %d", len(got))
	}
	if got[0] != "sg-a" || got[1] != "sg-b" {
		t.Fatalf("unexpected security groups: %#v", got)
	}
}

func TestPoolSecurityGroupsRejectsMissingSecurityGroups(t *testing.T) {
	_, err := poolSecurityGroups(core.Pool{ID: "pool-c0"})
	if err == nil {
		t.Fatal("expected poolSecurityGroups to reject missing security groups")
	}
	if !strings.Contains(err.Error(), "security_groups") {
		t.Fatalf("expected security_groups error, got %v", err)
	}
}

func TestMockProviderProvisionCapacityBundleCreatesWarmBundle(t *testing.T) {
	p := NewMockCloudProvider()

	bundle, err := p.ProvisionCapacityBundle(context.Background(), CapacityBundleProvisionRequest{
		TemplateClassID: "openclaw-default",
		Region:          "ap-beijing",
		Zone:            "ap-beijing-8",
	})
	if err != nil {
		t.Fatalf("ProvisionCapacityBundle returned error: %v", err)
	}
	if bundle.Status != core.CapacityBundleStatusWarm {
		t.Fatalf("expected warm bundle, got %s", bundle.Status)
	}
	if bundle.LineageTags["template_class_id"] != "openclaw-default" {
		t.Fatalf("unexpected lineage tags: %+v", bundle.LineageTags)
	}
}

func TestExportedBlueprintSubnetIDsFromEnv(t *testing.T) {
	t.Setenv("SANDBOX_SUPPORT_SUBNET_ID", "subnet-support")
	t.Setenv("SANDBOX_POOL_C0_SUBNET_ID", "subnet-a")
	t.Setenv("SANDBOX_POOL_C1_SUBNET_ID", "subnet-b")
	t.Setenv("NETWORK_SUBNET_POOL_A_ID", "subnet-a")
	support, workloads := exportedBlueprintSubnetIDsFromEnv()
	if support != "subnet-support" {
		t.Fatalf("unexpected support subnet id: %q", support)
	}
	if len(workloads) != 2 || workloads[0] != "subnet-a" || workloads[1] != "subnet-b" {
		t.Fatalf("unexpected workload subnet ids: %+v", workloads)
	}
}

func TestBuildExportRouteShapeIncludesRouteTableAssociationsAndNatRefs(t *testing.T) {
	shape, err := buildExportRouteShape([]describedRouteTable{
		{
			ID:   "rtb-main",
			Name: "rt-main",
			Main: true,
			Routes: []describedRoute{
				{Destination: "10.0.0.0/16", GatewayType: "LOCAL", Enabled: true},
				{Destination: "0.0.0.0/0", GatewayType: "NAT", GatewayID: "nat-1", Enabled: true},
			},
		},
	}, map[string]string{"nat-1": "nat-main"}, map[string]string{
		"subnet-support": "support",
		"subnet-a":       "workload:1",
	})
	if err != nil {
		t.Fatalf("buildExportRouteShape: %v", err)
	}
	if len(shape.RouteTables) != 1 {
		t.Fatalf("unexpected route tables: %+v", shape)
	}
	table := shape.RouteTables[0]
	if table.Name != "rt-main" || len(table.Associations) != 2 {
		t.Fatalf("unexpected route-table associations: %+v", table)
	}
	if table.Routes[1].NextHopRef != "nat-main" {
		t.Fatalf("expected NAT next hop to use de-IDed gateway name, got %+v", table.Routes)
	}
}

func TestBuildExportRouteShapeRejectsUnsupportedNextHopType(t *testing.T) {
	_, err := buildExportRouteShape([]describedRouteTable{
		{
			Name: "rt-main",
			Main: true,
			Routes: []describedRoute{
				{Destination: "0.0.0.0/0", GatewayType: "CCN", GatewayID: "ccn-123", Enabled: true},
			},
		},
	}, map[string]string{}, map[string]string{"subnet-support": "support"})
	if err == nil || !strings.Contains(err.Error(), "unsupported de-IDed next hop type") {
		t.Fatalf("expected unsupported next-hop error, got %v", err)
	}
}

func TestBuildExportRouteShapeMainTableAssociatesUnboundSubnets(t *testing.T) {
	shape, err := buildExportRouteShape([]describedRouteTable{
		{
			Name: "rt-main",
			Main: true,
			Associations: []describedRouteAssociation{
				{SubnetID: "subnet-support"},
			},
			Routes: []describedRoute{
				{Destination: "10.0.0.0/16", GatewayType: "LOCAL", Enabled: true},
			},
		},
	}, map[string]string{}, map[string]string{
		"subnet-support": "support",
		"subnet-a":       "workload:1",
		"subnet-b":       "workload:2",
	})
	if err != nil {
		t.Fatalf("buildExportRouteShape: %v", err)
	}
	if len(shape.RouteTables) != 1 {
		t.Fatalf("unexpected route table shape: %+v", shape)
	}
	got := map[string]struct{}{}
	for _, assoc := range shape.RouteTables[0].Associations {
		got[assoc.Target] = struct{}{}
	}
	for _, want := range []string{"support", "workload:1", "workload:2"} {
		if _, ok := got[want]; !ok {
			t.Fatalf("expected main table to include implicit association for %s, got %+v", want, shape.RouteTables[0].Associations)
		}
	}
}

func TestBuildExportRouteShapeDoesNotDuplicateExplicitAssociationIntoMainTable(t *testing.T) {
	shape, err := buildExportRouteShape([]describedRouteTable{
		{
			Name: "rt-main",
			Main: true,
			Associations: []describedRouteAssociation{
				{SubnetID: "subnet-support"},
			},
			Routes: []describedRoute{
				{Destination: "10.0.0.0/16", GatewayType: "LOCAL", Enabled: true},
			},
		},
		{
			Name: "rt-private",
			Associations: []describedRouteAssociation{
				{SubnetID: "subnet-a"},
			},
			Routes: []describedRoute{
				{Destination: "0.0.0.0/0", GatewayType: "LOCAL", Enabled: true},
			},
		},
	}, map[string]string{}, map[string]string{
		"subnet-support": "support",
		"subnet-a":       "workload:1",
		"subnet-b":       "workload:2",
	})
	if err != nil {
		t.Fatalf("buildExportRouteShape: %v", err)
	}
	var mainTable, privateTable blueprint.StaticRouteTable
	for _, table := range shape.RouteTables {
		switch table.Name {
		case "rt-main":
			mainTable = table
		case "rt-private":
			privateTable = table
		}
	}
	mainAssoc := map[string]struct{}{}
	for _, assoc := range mainTable.Associations {
		mainAssoc[assoc.Target] = struct{}{}
	}
	if _, ok := mainAssoc["workload:1"]; ok {
		t.Fatalf("expected explicitly-associated workload:1 to stay off main table, got %+v", mainTable.Associations)
	}
	if _, ok := mainAssoc["workload:2"]; !ok {
		t.Fatalf("expected unbound workload:2 to fall back to main table, got %+v", mainTable.Associations)
	}
	if len(privateTable.Associations) != 1 || privateTable.Associations[0].Target != "workload:1" {
		t.Fatalf("unexpected private table associations: %+v", privateTable.Associations)
	}
}

func TestBuildExportRouteShapeUsesIPv6DestinationFallback(t *testing.T) {
	shape, err := buildExportRouteShape([]describedRouteTable{
		{
			Name: "rt-main",
			Main: true,
			Routes: []describedRoute{
				{DestinationIPv6: "::/0", GatewayType: "LOCAL", Enabled: true},
			},
		},
	}, map[string]string{}, map[string]string{"subnet-support": "support"})
	if err != nil {
		t.Fatalf("buildExportRouteShape: %v", err)
	}
	if len(shape.RouteTables) != 1 || len(shape.RouteTables[0].Routes) != 1 {
		t.Fatalf("unexpected ipv6 route shape: %+v", shape)
	}
	if shape.RouteTables[0].Routes[0].Destination != "::/0" {
		t.Fatalf("expected ipv6 destination fallback, got %+v", shape.RouteTables[0].Routes[0])
	}
}

func TestBuildExportNATShapeUsesMultiModeAndStableOrder(t *testing.T) {
	shape, namesByID := buildExportNATShape([]describedNatGateway{
		{ID: "nat-b", Name: "nat-b", Zone: "ap-beijing-7", SubnetID: "subnet-b"},
		{ID: "nat-a", Name: "nat-a", Zone: "ap-beijing-8", SubnetID: "subnet-a"},
	}, map[string]string{
		"subnet-a": "support",
		"subnet-b": "workload:1",
	})
	if shape.Mode != "multi" {
		t.Fatalf("expected multi nat mode, got %+v", shape)
	}
	if len(shape.Gateways) != 2 || shape.Gateways[0].Name != "nat-a" || shape.Gateways[1].Name != "nat-b" {
		t.Fatalf("expected stable nat ordering, got %+v", shape.Gateways)
	}
	if namesByID["nat-a"] != "nat-a" || namesByID["nat-b"] != "nat-b" {
		t.Fatalf("unexpected nat id->name mapping: %+v", namesByID)
	}
}

func TestBuildExportRouteShapeUsesStableRouteTableOrdering(t *testing.T) {
	shape, err := buildExportRouteShape([]describedRouteTable{
		{
			Name: "rt-z",
			Main: false,
			Routes: []describedRoute{
				{Destination: "10.0.0.0/16", GatewayType: "LOCAL", Enabled: true},
			},
		},
		{
			Name: "rt-a",
			Main: true,
			Routes: []describedRoute{
				{Destination: "10.0.0.0/16", GatewayType: "LOCAL", Enabled: true},
			},
		},
	}, map[string]string{}, map[string]string{"subnet-support": "support"})
	if err != nil {
		t.Fatalf("buildExportRouteShape: %v", err)
	}
	if len(shape.RouteTables) != 2 || shape.RouteTables[0].Name != "rt-a" || shape.RouteTables[1].Name != "rt-z" {
		t.Fatalf("expected route tables to be name-sorted, got %+v", shape.RouteTables)
	}
}

func TestMockProviderExportBlueprintUsesStructuredShapes(t *testing.T) {
	exported, err := NewMockCloudProvider().ExportVPCShardBlueprint(context.Background(), "ap-beijing", "ignored")
	if err != nil {
		t.Fatalf("ExportVPCShardBlueprint: %v", err)
	}
	if exported.NATShape.Mode != "single" || len(exported.RouteShape.RouteTables) != 1 {
		t.Fatalf("unexpected structured shapes: %+v", exported)
	}
	found := false
	for _, route := range exported.RouteShape.RouteTables[0].Routes {
		if route == (blueprint.StaticRoute{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-main", Enabled: true}) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("unexpected route semantics: %+v", exported.RouteShape.RouteTables[0].Routes)
	}
}
