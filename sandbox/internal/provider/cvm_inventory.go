package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
)

const cvmInventoryFilterValuesLimit = 5

type CVMInventoryItem struct {
	Zone               string
	InstanceType       string
	InstanceChargeType string
	InstanceQuota      *int64
}

type CVMInventoryBatch struct {
	Items     []CVMInventoryItem
	RequestID string
}

type cvmInventoryResponse struct {
	*tchttp.BaseResponse
	Response *struct {
		InstanceTypeQuotaSet []struct {
			Zone               string `json:"Zone"`
			InstanceType       string `json:"InstanceType"`
			InstanceChargeType string `json:"InstanceChargeType"`
			InstanceQuota      *int64 `json:"InstanceQuota"`
		} `json:"InstanceTypeQuotaSet"`
		RequestID string `json:"RequestId"`
	} `json:"Response"`
}

type CVMInventoryClient interface {
	DescribeCVMInventory(ctx context.Context, region string, families, zones []string) (CVMInventoryBatch, error)
}

func cvmInventoryParameters(families, zones []string) (map[string]interface{}, error) {
	if len(families) == 0 || len(families) > cvmInventoryFilterValuesLimit || len(zones) == 0 || len(zones) > cvmInventoryFilterValuesLimit {
		return nil, fmt.Errorf("CVM inventory filters require 1-%d families and zones", cvmInventoryFilterValuesLimit)
	}
	type filter struct {
		Name   string   `json:"Name"`
		Values []string `json:"Values"`
	}
	return map[string]interface{}{
		"Filters": []filter{
			{Name: "instance-charge-type", Values: []string{"POSTPAID_BY_HOUR"}},
			{Name: "instance-family", Values: families},
			{Name: "zone", Values: zones},
			{Name: "extra-params", Values: []string{"realStatus"}},
		},
	}, nil
}

func parseCVMInventoryResponse(body []byte) (CVMInventoryBatch, error) {
	var payload cvmInventoryResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return CVMInventoryBatch{}, fmt.Errorf("decode CVM inventory response: %w", err)
	}
	return payload.batch()
}

func (payload *cvmInventoryResponse) batch() (CVMInventoryBatch, error) {
	if payload.Response == nil {
		return CVMInventoryBatch{}, fmt.Errorf("CVM inventory response has no Response object")
	}
	batch := CVMInventoryBatch{RequestID: payload.Response.RequestID, Items: make([]CVMInventoryItem, 0, len(payload.Response.InstanceTypeQuotaSet))}
	for _, item := range payload.Response.InstanceTypeQuotaSet {
		batch.Items = append(batch.Items, CVMInventoryItem{
			Zone: item.Zone, InstanceType: item.InstanceType,
			InstanceChargeType: item.InstanceChargeType, InstanceQuota: item.InstanceQuota,
		})
	}
	return batch, nil
}

func (p *TencentCloudProvider) DescribeCVMInventory(ctx context.Context, region string, families, zones []string) (CVMInventoryBatch, error) {
	params, err := cvmInventoryParameters(families, zones)
	if err != nil {
		return CVMInventoryBatch{}, err
	}
	req := tchttp.NewCommonRequest("cvm", "2017-03-12", "DescribeZoneInstanceConfigInfos")
	req.SetContext(ctx)
	if err := req.SetActionParameters(params); err != nil {
		return CVMInventoryBatch{}, err
	}
	endpoint := strings.TrimSpace(p.cfg.Endpoint)
	if endpoint == "" {
		endpoint = "cvm.tencentcloudapi.com"
	}
	resp := &cvmInventoryResponse{BaseResponse: &tchttp.BaseResponse{}}
	if err := retryRateLimit(ctx, "CVM.DescribeZoneInstanceConfigInfos", func() error {
		return p.newCommonClient(region, endpoint).Send(req, resp)
	}); err != nil {
		return CVMInventoryBatch{}, err
	}
	return resp.batch()
}
