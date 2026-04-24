package tencentbundle

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
)

func createSubnet(ctx context.Context, factory ClientFactory, retry RetryFunc, region, vpcID string, plan VPCShardSubnetPlan, tags map[string]string) (string, error) {
	req := tchttp.NewCommonRequest(VPCService, VPCVersion, "CreateSubnet")
	req.SetContext(ctx)
	if err := req.SetActionParameters(map[string]interface{}{
		"VpcId":      vpcID,
		"SubnetName": firstSubnetName("subnet", plan),
		"CidrBlock":  plan.CIDR,
		"Zone":       plan.Zone,
		"Tags":       encodeTencentTags(tags),
	}); err != nil {
		return "", err
	}
	resp := tchttp.NewCommonResponse()
	if err := retry(ctx, "VPC.CreateSubnet", func() error {
		return factory(region).Send(req, resp)
	}); err != nil {
		return "", err
	}
	var payload struct {
		Response struct {
			Subnet struct {
				SubnetID string `json:"SubnetId"`
			} `json:"Subnet"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return "", err
	}
	subnetID := strings.TrimSpace(payload.Response.Subnet.SubnetID)
	if subnetID == "" {
		return "", fmt.Errorf("CreateSubnet returned empty subnet id for %s", plan.CIDR)
	}
	return subnetID, nil
}

func firstSubnetName(prefix string, plan VPCShardSubnetPlan) string {
	if trimmed := strings.TrimSpace(plan.Name); trimmed != "" {
		return trimmed
	}
	return fmt.Sprintf("%s-%d", prefix, plan.Ordinal)
}
