package tencentbundle

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"cvm-mock-e2b/internal/blueprint"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
)

type fakeShardSender struct {
	actions       []string
	subnetCounter int
	failOnAction  string
}

func (s *fakeShardSender) Send(request tchttp.Request, response tchttp.Response) error {
	s.actions = append(s.actions, request.GetAction())
	if s.failOnAction == request.GetAction() {
		return fmt.Errorf("forced %s failure", request.GetAction())
	}
	common := response.(*tchttp.CommonResponse)
	switch request.GetAction() {
	case "CreateVpc":
		return common.UnmarshalJSON([]byte(`{"Response":{"Vpc":{"VpcId":"vpc-test"}}}`))
	case "CreateSubnet":
		s.subnetCounter++
		body, _ := json.Marshal(map[string]any{
			"Response": map[string]any{
				"Subnet": map[string]any{
					"SubnetId": fmt.Sprintf("subnet-test-%d", s.subnetCounter),
				},
			},
		})
		return common.UnmarshalJSON(body)
	case "CreateNatGateway":
		return common.UnmarshalJSON([]byte(`{"Response":{"NatGatewayId":"nat-test-1"}}`))
	case "DescribeRouteTables":
		return common.UnmarshalJSON([]byte(`{"Response":{"RouteTableSet":[{"RouteTableId":"rtb-main"}]}}`))
	case "CreateRouteTable":
		return common.UnmarshalJSON([]byte(`{"Response":{"RouteTable":{"RouteTableId":"rtb-extra"}}}`))
	case "AssociateRouteTable", "CreateRoutes":
		return common.UnmarshalJSON([]byte(`{"Response":{}}`))
	default:
		return common.UnmarshalJSON([]byte(`{"Response":{}}`))
	}
}

func TestApplyVPCShardPlanReturnsPartialProgressOnFailure(t *testing.T) {
	sender := &fakeShardSender{failOnAction: "CreateSubnet"}
	_, err := ApplyVPCShardPlan(
		context.Background(),
		func(string) CommonSender { return sender },
		func(_ context.Context, _ string, fn func() error) error { return fn() },
		VPCShardPlan{
			TemplateClassID:      "tc-1",
			SKUID:                "sku-1",
			BlueprintFingerprint: "fp-1",
			NetworkTemplateID:    "net-a",
			Region:               "ap-beijing",
			VpcCIDR:              "10.0.0.0/16",
			SupportSubnet: VPCShardSubnetPlan{
				Name:    "support-subnet",
				CIDR:    "10.0.0.0/24",
				Zone:    "ap-beijing-8",
				Role:    "support",
				Ordinal: 0,
			},
			WorkloadSubnets: []VPCShardSubnetPlan{
				{Name: "workload-a", CIDR: "10.0.1.0/24", Zone: "ap-beijing-8", Role: "workload", Ordinal: 1},
			},
			NATShape: blueprint.StaticNATShape{
				Mode: "single",
				Gateways: []blueprint.StaticNATGateway{
					{Name: "nat-main", Zone: "ap-beijing-8", Subnet: "support"},
				},
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
						},
					},
				},
			},
		},
	)
	if err == nil {
		t.Fatalf("expected apply error")
	}
	applyErr, ok := err.(*VPCShardApplyError)
	if !ok {
		t.Fatalf("expected VPCShardApplyError, got %T", err)
	}
	if applyErr.Step != "create_support_subnet" || applyErr.PartialResult.VpcID != "vpc-test" {
		t.Fatalf("unexpected partial apply error: %+v", applyErr)
	}
}

func TestApplyVPCShardPlanUsesTencentSDKSequence(t *testing.T) {
	sender := &fakeShardSender{}
	result, err := ApplyVPCShardPlan(
		context.Background(),
		func(string) CommonSender { return sender },
		func(_ context.Context, _ string, fn func() error) error { return fn() },
		VPCShardPlan{
			TemplateClassID:      "tc-1",
			SKUID:                "sku-1",
			BlueprintFingerprint: "fp-1",
			NetworkTemplateID:    "net-a",
			Region:               "ap-beijing",
			VpcCIDR:              "10.0.0.0/16",
			SupportSubnet: VPCShardSubnetPlan{
				Name:    "support-subnet",
				CIDR:    "10.0.0.0/24",
				Zone:    "ap-beijing-8",
				Role:    "support",
				Ordinal: 0,
			},
			WorkloadSubnets: []VPCShardSubnetPlan{
				{
					Name:    "workload-a",
					CIDR:    "10.0.1.0/24",
					Zone:    "ap-beijing-8",
					Role:    "workload",
					Ordinal: 1,
				},
				{
					Name:    "workload-b",
					CIDR:    "10.0.2.0/24",
					Zone:    "ap-beijing-8",
					Role:    "workload",
					Ordinal: 2,
				},
			},
			NATShape: blueprint.StaticNATShape{
				Mode: "single",
				Gateways: []blueprint.StaticNATGateway{
					{Name: "nat-main", Zone: "ap-beijing-8", Subnet: "support"},
				},
			},
			RouteShape: blueprint.StaticRouteShape{
				RouteTables: []blueprint.StaticRouteTable{
					{
						Name: "rt-main",
						Main: true,
						Associations: []blueprint.StaticRouteAssociation{
							{Target: "support"},
							{Target: "workload:1"},
							{Target: "workload:2"},
						},
						Routes: []blueprint.StaticRoute{
							{Destination: "10.0.0.0/16", NextHopType: "LOCAL", NextHopRef: "local", Enabled: true},
							{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-main", Enabled: true},
						},
					},
				},
			},
		},
	)
	if err != nil {
		t.Fatalf("ApplyVPCShardPlan: %v", err)
	}
	if result.VpcID != "vpc-test" {
		t.Fatalf("unexpected vpc id: %+v", result)
	}
	if result.SupportSubnetID == "" || len(result.WorkloadSubnetIDs) != 2 {
		t.Fatalf("unexpected subnet outputs: %+v", result)
	}
	if len(sender.actions) != 7 {
		t.Fatalf("expected 7 actions, got %v", sender.actions)
	}
	if sender.actions[0] != "CreateVpc" || sender.actions[1] != "CreateSubnet" || sender.actions[2] != "CreateSubnet" || sender.actions[3] != "CreateSubnet" || sender.actions[4] != "CreateNatGateway" || sender.actions[5] != "DescribeRouteTables" || sender.actions[6] != "CreateRoutes" {
		t.Fatalf("unexpected action sequence: %v", sender.actions)
	}
}

func TestApplyVPCShardPlanCreatesAndAssociatesNonMainRouteTable(t *testing.T) {
	sender := &fakeShardSender{}
	_, err := ApplyVPCShardPlan(
		context.Background(),
		func(string) CommonSender { return sender },
		func(_ context.Context, _ string, fn func() error) error { return fn() },
		VPCShardPlan{
			TemplateClassID:      "tc-1",
			SKUID:                "sku-1",
			BlueprintFingerprint: "fp-1",
			NetworkTemplateID:    "net-a",
			Region:               "ap-beijing",
			VpcCIDR:              "10.0.0.0/16",
			SupportSubnet: VPCShardSubnetPlan{
				Name:    "support-subnet",
				CIDR:    "10.0.0.0/24",
				Zone:    "ap-beijing-8",
				Role:    "support",
				Ordinal: 0,
			},
			WorkloadSubnets: []VPCShardSubnetPlan{
				{Name: "workload-a", CIDR: "10.0.1.0/24", Zone: "ap-beijing-8", Role: "workload", Ordinal: 1},
			},
			NATShape: blueprint.StaticNATShape{
				Mode: "single",
				Gateways: []blueprint.StaticNATGateway{
					{Name: "nat-main", Zone: "ap-beijing-8", Subnet: "support"},
				},
			},
			RouteShape: blueprint.StaticRouteShape{
				RouteTables: []blueprint.StaticRouteTable{
					{
						Name: "rt-private",
						Associations: []blueprint.StaticRouteAssociation{
							{Target: "workload:1"},
						},
						Routes: []blueprint.StaticRoute{
							{Destination: "10.0.0.0/16", NextHopType: "LOCAL", NextHopRef: "local", Enabled: true},
							{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-main", Enabled: true},
						},
					},
				},
			},
		},
	)
	if err != nil {
		t.Fatalf("ApplyVPCShardPlan: %v", err)
	}
	foundCreateRouteTable := false
	foundAssociateRouteTable := false
	for _, action := range sender.actions {
		if action == "CreateRouteTable" {
			foundCreateRouteTable = true
		}
		if action == "AssociateRouteTable" {
			foundAssociateRouteTable = true
		}
	}
	if !foundCreateRouteTable || !foundAssociateRouteTable {
		t.Fatalf("expected non-main route table flow, got actions %v", sender.actions)
	}
}

func TestApplyVPCShardPlanFailsWhenRouteReferencesMissingNatGateway(t *testing.T) {
	sender := &fakeShardSender{}
	_, err := ApplyVPCShardPlan(
		context.Background(),
		func(string) CommonSender { return sender },
		func(_ context.Context, _ string, fn func() error) error { return fn() },
		VPCShardPlan{
			TemplateClassID:      "tc-1",
			SKUID:                "sku-1",
			BlueprintFingerprint: "fp-1",
			NetworkTemplateID:    "net-a",
			Region:               "ap-beijing",
			VpcCIDR:              "10.0.0.0/16",
			SupportSubnet: VPCShardSubnetPlan{
				Name:    "support-subnet",
				CIDR:    "10.0.0.0/24",
				Zone:    "ap-beijing-8",
				Role:    "support",
				Ordinal: 0,
			},
			WorkloadSubnets: []VPCShardSubnetPlan{
				{Name: "workload-a", CIDR: "10.0.1.0/24", Zone: "ap-beijing-8", Role: "workload", Ordinal: 1},
			},
			NATShape: blueprint.StaticNATShape{
				Mode: "single",
			},
			RouteShape: blueprint.StaticRouteShape{
				RouteTables: []blueprint.StaticRouteTable{
					{
						Name: "rt-main",
						Main: true,
						Routes: []blueprint.StaticRoute{
							{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-missing", Enabled: true},
						},
					},
				},
			},
		},
	)
	if err == nil {
		t.Fatalf("expected apply error")
	}
	applyErr, ok := err.(*VPCShardApplyError)
	if !ok {
		t.Fatalf("expected VPCShardApplyError, got %T", err)
	}
	if applyErr.Step != "create_routes:rt-main" {
		t.Fatalf("unexpected error step: %+v", applyErr)
	}
}

func TestApplyVPCShardPlanFailsWhenAssociationTargetUnknown(t *testing.T) {
	sender := &fakeShardSender{}
	_, err := ApplyVPCShardPlan(
		context.Background(),
		func(string) CommonSender { return sender },
		func(_ context.Context, _ string, fn func() error) error { return fn() },
		VPCShardPlan{
			TemplateClassID:      "tc-1",
			SKUID:                "sku-1",
			BlueprintFingerprint: "fp-1",
			NetworkTemplateID:    "net-a",
			Region:               "ap-beijing",
			VpcCIDR:              "10.0.0.0/16",
			SupportSubnet: VPCShardSubnetPlan{
				Name:    "support-subnet",
				CIDR:    "10.0.0.0/24",
				Zone:    "ap-beijing-8",
				Role:    "support",
				Ordinal: 0,
			},
			WorkloadSubnets: []VPCShardSubnetPlan{
				{Name: "workload-a", CIDR: "10.0.1.0/24", Zone: "ap-beijing-8", Role: "workload", Ordinal: 1},
			},
			NATShape: blueprint.StaticNATShape{
				Mode: "single",
				Gateways: []blueprint.StaticNATGateway{
					{Name: "nat-main", Zone: "ap-beijing-8", Subnet: "support"},
				},
			},
			RouteShape: blueprint.StaticRouteShape{
				RouteTables: []blueprint.StaticRouteTable{
					{
						Name: "rt-private",
						Associations: []blueprint.StaticRouteAssociation{
							{Target: "workload:99"},
						},
						Routes: []blueprint.StaticRoute{
							{Destination: "0.0.0.0/0", NextHopType: "NAT", NextHopRef: "nat-main", Enabled: true},
						},
					},
				},
			},
		},
	)
	if err == nil {
		t.Fatalf("expected apply error")
	}
	applyErr, ok := err.(*VPCShardApplyError)
	if !ok {
		t.Fatalf("expected VPCShardApplyError, got %T", err)
	}
	if applyErr.Step != "resolve_route_assoc:rt-private" {
		t.Fatalf("unexpected error step: %+v", applyErr)
	}
}
