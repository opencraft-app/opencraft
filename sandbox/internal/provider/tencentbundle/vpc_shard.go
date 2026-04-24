package tencentbundle

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"cvm-mock-e2b/internal/blueprint"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
)

func ApplyVPCShardPlan(ctx context.Context, factory ClientFactory, retry RetryFunc, plan VPCShardPlan) (VPCShardApplyResult, error) {
	plan, err := normalizeVPCShardPlan(plan)
	if err != nil {
		return VPCShardApplyResult{}, err
	}

	vpcID, err := createVPC(ctx, factory, retry, plan.Region, plan)
	if err != nil {
		return VPCShardApplyResult{}, &VPCShardApplyError{Step: "create_vpc", Err: err}
	}

	result := VPCShardApplyResult{
		VpcID:             vpcID,
		SupportSubnetID:   "",
		WorkloadSubnetIDs: make(map[string]string, len(plan.WorkloadSubnets)),
		NATGatewayIDs:     make(map[string]string, len(plan.NATShape.Gateways)),
		RouteTableIDs:     make(map[string]string, len(plan.RouteShape.RouteTables)),
	}

	supportSubnetID, err := createSubnet(ctx, factory, retry, plan.Region, vpcID, plan.SupportSubnet, plan.Tags)
	if err != nil {
		return result, &VPCShardApplyError{Step: "create_support_subnet", PartialResult: result, Err: err}
	}
	result.SupportSubnetID = supportSubnetID

	for _, subnetPlan := range plan.WorkloadSubnets {
		subnetID, err := createSubnet(ctx, factory, retry, plan.Region, vpcID, subnetPlan, plan.Tags)
		if err != nil {
			return result, &VPCShardApplyError{Step: fmt.Sprintf("create_workload_subnet:%s", firstNonEmptyPlanString(subnetPlan.Name, fmt.Sprintf("%d", subnetPlan.Ordinal))), PartialResult: result, Err: err}
		}
		key := strings.TrimSpace(subnetPlan.Name)
		if key == "" {
			key = fmt.Sprintf("workload-%d", subnetPlan.Ordinal)
		}
		result.WorkloadSubnetIDs[key] = subnetID
	}

	for _, gateway := range plan.NATShape.Gateways {
		subnetID, err := resolveShardSubnetRef(gateway.Subnet, result.SupportSubnetID, result.WorkloadSubnetIDs, plan.WorkloadSubnets)
		if err != nil {
			return result, &VPCShardApplyError{Step: fmt.Sprintf("resolve_nat_gateway_subnet:%s", gateway.Name), PartialResult: result, Err: err}
		}
		natID, err := createNatGateway(ctx, factory, retry, plan.Region, vpcID, gateway, subnetID, plan.Tags)
		if err != nil {
			return result, &VPCShardApplyError{Step: fmt.Sprintf("create_nat_gateway:%s", gateway.Name), PartialResult: result, Err: err}
		}
		result.NATGatewayIDs[gateway.Name] = natID
	}

	for _, table := range plan.RouteShape.RouteTables {
		routeTableID, err := resolveOrCreateRouteTable(ctx, factory, retry, plan.Region, vpcID, table, plan.Tags)
		if err != nil {
			return result, &VPCShardApplyError{Step: fmt.Sprintf("create_route_table:%s", table.Name), PartialResult: result, Err: err}
		}
		result.RouteTableIDs[table.Name] = routeTableID
		if !table.Main {
			for _, assoc := range table.Associations {
				subnetID, err := resolveShardSubnetRef(assoc.Target, result.SupportSubnetID, result.WorkloadSubnetIDs, plan.WorkloadSubnets)
				if err != nil {
					return result, &VPCShardApplyError{Step: fmt.Sprintf("resolve_route_assoc:%s", table.Name), PartialResult: result, Err: err}
				}
				if err := associateRouteTable(ctx, factory, retry, plan.Region, routeTableID, subnetID); err != nil {
					return result, &VPCShardApplyError{Step: fmt.Sprintf("associate_route_table:%s", table.Name), PartialResult: result, Err: err}
				}
			}
		}
		if err := createRoutes(ctx, factory, retry, plan.Region, routeTableID, table.Routes, result.NATGatewayIDs); err != nil {
			return result, &VPCShardApplyError{Step: fmt.Sprintf("create_routes:%s", table.Name), PartialResult: result, Err: err}
		}
	}

	return result, nil
}

func createVPC(ctx context.Context, factory ClientFactory, retry RetryFunc, region string, plan VPCShardPlan) (string, error) {
	req := tchttp.NewCommonRequest(VPCService, VPCVersion, "CreateVpc")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"VpcName":   firstVPCName(plan),
		"CidrBlock": plan.VpcCIDR,
		"Tags":      encodeTencentTags(plan.Tags),
	}); err != nil {
		return "", err
	}
	resp := tchttp.NewCommonResponse()
	if err := retry(ctx, "VPC.CreateVpc", func() error {
		return factory(region).Send(req, resp)
	}); err != nil {
		return "", err
	}
	var payload struct {
		Response struct {
			Vpc struct {
				VpcID string `json:"VpcId"`
			} `json:"Vpc"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return "", err
	}
	vpcID := strings.TrimSpace(payload.Response.Vpc.VpcID)
	if vpcID == "" {
		return "", fmt.Errorf("CreateVpc returned empty vpc id for cidr %s", plan.VpcCIDR)
	}
	return vpcID, nil
}

func createNatGateway(ctx context.Context, factory ClientFactory, retry RetryFunc, region, vpcID string, gateway blueprint.StaticNATGateway, subnetID string, tags map[string]string) (string, error) {
	req := tchttp.NewCommonRequest(VPCService, VPCVersion, "CreateNatGateway")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"NatGatewayName": gateway.Name,
		"VpcId":          vpcID,
		"SubnetId":       subnetID,
		"Tags":           encodeTencentTags(tags),
	}); err != nil {
		return "", err
	}
	resp := tchttp.NewCommonResponse()
	if err := retry(ctx, "VPC.CreateNatGateway", func() error {
		return factory(region).Send(req, resp)
	}); err != nil {
		return "", err
	}
	var payload struct {
		Response struct {
			NatGatewayID string `json:"NatGatewayId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return "", err
	}
	natID := strings.TrimSpace(payload.Response.NatGatewayID)
	if natID == "" {
		return "", fmt.Errorf("CreateNatGateway returned empty nat gateway id for %s", gateway.Name)
	}
	return natID, nil
}

func resolveOrCreateRouteTable(ctx context.Context, factory ClientFactory, retry RetryFunc, region, vpcID string, table blueprint.StaticRouteTable, tags map[string]string) (string, error) {
	if table.Main {
		return describeMainRouteTable(ctx, factory, retry, region, vpcID)
	}
	req := tchttp.NewCommonRequest(VPCService, VPCVersion, "CreateRouteTable")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"VpcId":          vpcID,
		"RouteTableName": table.Name,
		"Tags":           encodeTencentTags(tags),
	}); err != nil {
		return "", err
	}
	resp := tchttp.NewCommonResponse()
	if err := retry(ctx, "VPC.CreateRouteTable", func() error {
		return factory(region).Send(req, resp)
	}); err != nil {
		return "", err
	}
	var payload struct {
		Response struct {
			RouteTable struct {
				RouteTableID string `json:"RouteTableId"`
			} `json:"RouteTable"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return "", err
	}
	routeTableID := strings.TrimSpace(payload.Response.RouteTable.RouteTableID)
	if routeTableID == "" {
		return "", fmt.Errorf("CreateRouteTable returned empty route table id for %s", table.Name)
	}
	return routeTableID, nil
}

func describeMainRouteTable(ctx context.Context, factory ClientFactory, retry RetryFunc, region, vpcID string) (string, error) {
	req := tchttp.NewCommonRequest(VPCService, VPCVersion, "DescribeRouteTables")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"Filters": []map[string]interface{}{
			{"Name": "vpc-id", "Values": []string{vpcID}},
			{"Name": "association.main", "Values": []string{"true"}},
		},
		"Limit": 1,
	}); err != nil {
		return "", err
	}
	resp := tchttp.NewCommonResponse()
	if err := retry(ctx, "VPC.DescribeRouteTables", func() error {
		return factory(region).Send(req, resp)
	}); err != nil {
		return "", err
	}
	var payload struct {
		Response struct {
			RouteTableSet []struct {
				RouteTableID string `json:"RouteTableId"`
			} `json:"RouteTableSet"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return "", err
	}
	if len(payload.Response.RouteTableSet) == 0 || strings.TrimSpace(payload.Response.RouteTableSet[0].RouteTableID) == "" {
		return "", fmt.Errorf("main route table not found for vpc %s", vpcID)
	}
	return strings.TrimSpace(payload.Response.RouteTableSet[0].RouteTableID), nil
}

func associateRouteTable(ctx context.Context, factory ClientFactory, retry RetryFunc, region, routeTableID, subnetID string) error {
	req := tchttp.NewCommonRequest(VPCService, VPCVersion, "AssociateRouteTable")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"RouteTableId": routeTableID,
		"SubnetId":     subnetID,
	}); err != nil {
		return err
	}
	resp := tchttp.NewCommonResponse()
	return retry(ctx, "VPC.AssociateRouteTable", func() error {
		return factory(region).Send(req, resp)
	})
}

func createRoutes(ctx context.Context, factory ClientFactory, retry RetryFunc, region, routeTableID string, routes []blueprint.StaticRoute, natIDs map[string]string) error {
	items := make([]map[string]interface{}, 0, len(routes))
	for _, route := range routes {
		nextHopType := strings.ToUpper(strings.TrimSpace(route.NextHopType))
		if nextHopType == "LOCAL" {
			continue
		}
		gatewayID := strings.TrimSpace(route.NextHopRef)
		if nextHopType == "NAT" {
			gatewayID = strings.TrimSpace(natIDs[gatewayID])
			if gatewayID == "" {
				return fmt.Errorf("missing nat gateway id for route ref %s", route.NextHopRef)
			}
		}
		item := map[string]interface{}{
			"DestinationCidrBlock": strings.TrimSpace(route.Destination),
			"GatewayType":          nextHopType,
			"GatewayId":            gatewayID,
			"Enabled":              route.Enabled,
		}
		items = append(items, item)
	}
	if len(items) == 0 {
		return nil
	}
	req := tchttp.NewCommonRequest(VPCService, VPCVersion, "CreateRoutes")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"RouteTableId": routeTableID,
		"Routes":       items,
	}); err != nil {
		return err
	}
	resp := tchttp.NewCommonResponse()
	return retry(ctx, "VPC.CreateRoutes", func() error {
		return factory(region).Send(req, resp)
	})
}

func resolveShardSubnetRef(target, supportSubnetID string, workloadSubnetIDs map[string]string, workloadPlans []VPCShardSubnetPlan) (string, error) {
	target = strings.TrimSpace(target)
	switch target {
	case "support":
		if strings.TrimSpace(supportSubnetID) == "" {
			return "", fmt.Errorf("support subnet not provisioned")
		}
		return supportSubnetID, nil
	default:
		if !strings.HasPrefix(target, "workload:") {
			return "", fmt.Errorf("unsupported subnet target %q", target)
		}
		ordinal := strings.TrimSpace(strings.TrimPrefix(target, "workload:"))
		for _, plan := range workloadPlans {
			if fmt.Sprintf("%d", plan.Ordinal) != ordinal {
				continue
			}
			key := strings.TrimSpace(plan.Name)
			if key == "" {
				key = fmt.Sprintf("workload-%d", plan.Ordinal)
			}
			subnetID := strings.TrimSpace(workloadSubnetIDs[key])
			if subnetID == "" {
				return "", fmt.Errorf("workload subnet %s not provisioned", target)
			}
			return subnetID, nil
		}
		return "", fmt.Errorf("workload subnet target %q not found", target)
	}
}

func firstVPCName(plan VPCShardPlan) string {
	if name := strings.TrimSpace(plan.Tags["name"]); name != "" {
		return name
	}
	return fmt.Sprintf("sandbox-vpc-shard-%s", shortID(firstNonEmptyPlanString(plan.TemplateClassID, plan.SKUID, plan.BlueprintFingerprint)))
}

func encodeTencentTags(tags map[string]string) []map[string]string {
	if len(tags) == 0 {
		return nil
	}
	items := make([]map[string]string, 0, len(tags))
	for key, value := range tags {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" || value == "" {
			continue
		}
		items = append(items, map[string]string{
			"Key":   key,
			"Value": value,
		})
	}
	return items
}

func firstNonEmptyPlanString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
