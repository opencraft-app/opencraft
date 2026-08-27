package provider

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"cvm-mock-e2b/internal/blueprint"
	"cvm-mock-e2b/internal/core"
)

func TestInvokeCommandParametersTargetsOneInstanceAndEncodesRuntimeParameters(t *testing.T) {
	params, err := invokeCommandParameters("ins-1", "cmd-website1", map[string]string{
		"website_key": "vik_secret_value",
		"api_base":    "https://api.lightvela.ai",
	})
	if err != nil {
		t.Fatalf("invokeCommandParameters: %v", err)
	}
	if params["CommandId"] != "cmd-website1" {
		t.Fatalf("CommandId = %#v", params["CommandId"])
	}
	instances, ok := params["InstanceIds"].([]string)
	if !ok || len(instances) != 1 || instances[0] != "ins-1" {
		t.Fatalf("InstanceIds = %#v", params["InstanceIds"])
	}
	var runtime map[string]string
	if err := json.Unmarshal([]byte(params["Parameters"].(string)), &runtime); err != nil {
		t.Fatalf("decode Parameters: %v", err)
	}
	if runtime["website_key"] != "vik_secret_value" || runtime["api_base"] != "https://api.lightvela.ai" {
		t.Fatalf("runtime Parameters = %#v", runtime)
	}
}

func TestCommandInvocationMetadataQueryHidesOutput(t *testing.T) {
	params := commandInvocationQueryParameters("inv-1", "ins-1", true)
	if hide, ok := params["HideOutput"].(bool); !ok || !hide {
		t.Fatalf("HideOutput = %#v, want true", params["HideOutput"])
	}
	filters, ok := params["Filters"].([]map[string]interface{})
	if !ok || len(filters) != 2 {
		t.Fatalf("Filters = %#v", params["Filters"])
	}
	if filters[0]["Name"] != "invocation-id" || filters[1]["Name"] != "instance-id" {
		t.Fatalf("Filters = %#v", filters)
	}
}

func TestDecodeCommandInvocationMetadataDropsCredentialBearingOutput(t *testing.T) {
	const secret = "vik_test_should_not_escape"
	body := []byte(`{"Response":{"InvocationTaskSet":[{"CommandId":"cmd-website1","InvocationId":"inv-1","TaskStatus":"FAILED","InstanceId":"ins-1","StartTime":"start","EndTime":"end","ErrorInfo":"` + secret + `","TaskResult":{"ExitCode":17,"Output":"` + secret + `","OutputUrl":"https://example.invalid/secret","Dropped":3,"ExecutionTime":"1.0"}}]}}`)

	result, err := decodeCommandInvocationMetadata(body, "ap-beijing")
	if err != nil {
		t.Fatalf("decodeCommandInvocationMetadata: %v", err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal metadata: %v", err)
	}
	if strings.Contains(string(encoded), secret) || strings.Contains(string(encoded), "OutputUrl") {
		t.Fatalf("metadata leaked command output: %s", encoded)
	}
	if result.Status != "FAILED" || result.ExitCode != 17 || result.InvocationID != "inv-1" {
		t.Fatalf("metadata = %+v", result)
	}
}

func TestVerifyInstanceDeliveryWithOpsUsesFreshTATAgentAndHandshake(t *testing.T) {
	now := time.Date(2026, 8, 10, 20, 0, 0, 0, time.UTC)
	var describedCloudID, agentCloudID, commandCloudID, commandScript string
	ops := deliveryProbeOps{
		describeInstance: func(_ context.Context, cloudID string) (string, error) {
			describedCloudID = cloudID
			return "RUNNING", nil
		},
		describeAgent: func(_ context.Context, cloudID string) (tatAgentStatus, error) {
			agentCloudID = cloudID
			return tatAgentStatus{Status: "Online", LastHeartbeatTime: now.Format(time.RFC3339)}, nil
		},
		runCommand: func(_ context.Context, cloudID, script string) (CommandInvocation, error) {
			commandCloudID = cloudID
			commandScript = script
			return CommandInvocation{InvocationID: "inv-1", InstanceID: cloudID}, nil
		},
		getCommandInvocation: func(_ context.Context, invocationID, cloudID string) (CommandResult, error) {
			if invocationID != "inv-1" || cloudID != "ins-1" {
				t.Fatalf("unexpected invocation lookup: invocation=%q cloud=%q", invocationID, cloudID)
			}
			return CommandResult{CommandInvocation: CommandInvocation{Status: "SUCCESS"}, ExitCode: 0}, nil
		},
		now: func() time.Time { return now },
	}

	if err := verifyInstanceDeliveryWithOps(context.Background(), "ins-1", now.Add(-time.Second), ops); err != nil {
		t.Fatalf("verify delivery: %v", err)
	}
	if describedCloudID != "ins-1" || agentCloudID != "ins-1" || commandCloudID != "ins-1" {
		t.Fatalf("expected cloud id throughout delivery probe, describe=%q agent=%q command=%q", describedCloudID, agentCloudID, commandCloudID)
	}
	if commandScript != deliveryProbeScript {
		t.Fatalf("unexpected delivery probe script %q", commandScript)
	}
}

func TestValidateTATAgentReadyRejectsHeartbeatBeforeDeliveryGeneration(t *testing.T) {
	now := time.Date(2026, 8, 10, 20, 0, 0, 0, time.UTC)
	err := validateTATAgentReady(tatAgentStatus{
		Status:            "Online",
		LastHeartbeatTime: now.Add(-time.Minute).Format(time.RFC3339),
	}, now, now)
	if err == nil || !strings.Contains(err.Error(), "predates delivery generation") {
		t.Fatalf("expected stale-generation heartbeat error, got %v", err)
	}
}

func TestVerifyInstanceDeliveryWithOpsRejectsFailedHandshake(t *testing.T) {
	now := time.Date(2026, 8, 10, 20, 0, 0, 0, time.UTC)
	ops := deliveryProbeOps{
		describeInstance: func(context.Context, string) (string, error) { return "RUNNING", nil },
		describeAgent: func(context.Context, string) (tatAgentStatus, error) {
			return tatAgentStatus{Status: "Online", LastHeartbeatTime: now.Format(time.RFC3339)}, nil
		},
		runCommand: func(context.Context, string, string) (CommandInvocation, error) {
			return CommandInvocation{InvocationID: "inv-failed"}, nil
		},
		getCommandInvocation: func(context.Context, string, string) (CommandResult, error) {
			return CommandResult{CommandInvocation: CommandInvocation{Status: "FAILED"}, ExitCode: 1, ErrorInfo: "boom"}, nil
		},
		now: func() time.Time { return now },
	}

	err := verifyInstanceDeliveryWithOps(context.Background(), "ins-1", time.Time{}, ops)
	if err == nil || !errors.Is(err, errDeliveryProbeCommandFailed) {
		t.Fatalf("expected failed handshake error, got %v", err)
	}
}

func TestStartTerminalSessionParametersOnlyIncludeInstanceID(t *testing.T) {
	params := startTerminalSessionParameters("ins-test")

	if got := params["InstanceId"]; got != "ins-test" {
		t.Fatalf("unexpected instance id: %v", got)
	}
	if _, ok := params["Username"]; ok {
		t.Fatalf("StartSession should not include unsupported Username parameter: %v", params)
	}
	if _, ok := params["WorkingDirectory"]; ok {
		t.Fatalf("StartSession should not include unsupported WorkingDirectory parameter: %v", params)
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
