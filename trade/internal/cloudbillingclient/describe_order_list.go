package cloudbillingclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common"
	tchttp "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/http"
	"github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/profile"
)

type DescribeOrderListRequest struct {
	OrderIDs []string
	Limit    int64
	Offset   int64
	PayMode  string
}

type OrderInfo struct {
	BigOrderID                            string
	OrderID                               string
	PriceDetailHighPrecisionRealTotalCost string
	PriceDetailRealTotalCost              string
}

type DescribeOrderListResponse struct {
	Orders    []OrderInfo
	RequestID string
}

func (c *TencentCloudClient) DescribeOrderList(ctx context.Context, credentials TemporaryCredentials, in *DescribeOrderListRequest) (*DescribeOrderListResponse, error) {
	if c == nil || c.transport == nil {
		return nil, fmt.Errorf("billing tencentcloud client is not configured")
	}
	secretID := strings.TrimSpace(credentials.SecretID)
	secretKey := strings.TrimSpace(credentials.SecretKey)
	token := strings.TrimSpace(credentials.Token)
	if secretID == "" || secretKey == "" || token == "" {
		return nil, errors.New("billing temporary credentials are incomplete")
	}
	req, err := newDescribeOrderListCommonRequest(ctx, in, c.xQCloudUserID)
	if err != nil {
		return nil, err
	}
	cpf := profile.NewClientProfile()
	cpf.HttpProfile.Endpoint = c.endpoint
	cpf.HttpProfile.ReqTimeout = int(c.timeout.Seconds())
	if cpf.HttpProfile.ReqTimeout < 1 {
		cpf.HttpProfile.ReqTimeout = 1
	}
	client := common.NewCommonClient(common.NewTokenCredential(secretID, secretKey, token), c.region, cpf)
	client.WithHttpTransport(c.transport)
	resp := tchttp.NewCommonResponse()
	if err := client.Send(req, resp); err != nil {
		return nil, fmt.Errorf("send DescribeOrderList: %w", err)
	}

	var payload struct {
		Response struct {
			Data []struct {
				BigOrderID string `json:"BigOrderId"`
				OrderInfos []struct {
					OrderID     string `json:"OrderId"`
					PriceDetail string `json:"PriceDetail"`
				} `json:"OrderInfos"`
			} `json:"Data"`
			RequestID string `json:"RequestId"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(resp.GetBody(), &payload); err != nil {
		return nil, fmt.Errorf("decode DescribeOrderList response: %w", err)
	}
	out := &DescribeOrderListResponse{RequestID: strings.TrimSpace(payload.Response.RequestID)}
	for _, bigOrder := range payload.Response.Data {
		for _, order := range bigOrder.OrderInfos {
			highPrecisionRealTotalCost, realTotalCost, err := decodeOrderPriceDetail(order.PriceDetail)
			if err != nil {
				return nil, fmt.Errorf("decode DescribeOrderList PriceDetail orderId=%s: %w", order.OrderID, err)
			}
			out.Orders = append(out.Orders, OrderInfo{
				BigOrderID:                            strings.TrimSpace(bigOrder.BigOrderID),
				OrderID:                               strings.TrimSpace(order.OrderID),
				PriceDetailHighPrecisionRealTotalCost: highPrecisionRealTotalCost,
				PriceDetailRealTotalCost:              realTotalCost,
			})
		}
	}
	return out, nil
}

func decodeOrderPriceDetail(raw string) (highPrecisionRealTotalCost string, realTotalCost string, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", nil
	}
	var detail struct {
		RealTotalCost      json.RawMessage `json:"realTotalCost"`
		HighPrecisionPrice struct {
			RealTotalCostHigh json.RawMessage `json:"realTotalCostHigh"`
		} `json:"highPrecisionPrice"`
	}
	if err := json.Unmarshal([]byte(raw), &detail); err != nil {
		return "", "", err
	}
	highPrecisionRealTotalCost, err = billingAmountText(detail.HighPrecisionPrice.RealTotalCostHigh)
	if err != nil {
		return "", "", fmt.Errorf("highPrecisionPrice.realTotalCostHigh: %w", err)
	}
	if highPrecisionRealTotalCost != "" {
		return highPrecisionRealTotalCost, "", nil
	}
	realTotalCost, err = billingAmountText(detail.RealTotalCost)
	if err != nil {
		return "", "", fmt.Errorf("realTotalCost: %w", err)
	}
	return highPrecisionRealTotalCost, realTotalCost, nil
}

func billingAmountText(raw json.RawMessage) (string, error) {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}
	if raw[0] == '"' {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return "", err
		}
		return strings.TrimSpace(value), nil
	}
	var value json.Number
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", err
	}
	return strings.TrimSpace(value.String()), nil
}

func newDescribeOrderListCommonRequest(ctx context.Context, in *DescribeOrderListRequest, xQCloudUserID string) (*tchttp.CommonRequest, error) {
	params, err := describeOrderListParams(in)
	if err != nil {
		return nil, err
	}
	req := tchttp.NewCommonRequest("billing", "2018-07-09", "DescribeOrderList")
	if err := req.SetActionParameters(params); err != nil {
		return nil, fmt.Errorf("set DescribeOrderList parameters: %w", err)
	}
	if value := strings.TrimSpace(xQCloudUserID); value != "" {
		req.SetHeader(map[string]string{headerXQCloudUserID: value})
	}
	req.SetContext(ctx)
	return req, nil
}

func describeOrderListParams(in *DescribeOrderListRequest) (map[string]any, error) {
	if in == nil {
		return nil, errors.New("DescribeOrderList request is required")
	}
	orderIDs := make([]string, 0, len(in.OrderIDs))
	for _, id := range in.OrderIDs {
		if v := strings.TrimSpace(id); v != "" {
			orderIDs = append(orderIDs, v)
		}
	}
	if len(orderIDs) == 0 {
		return nil, errors.New("DescribeOrderList OrderIds is required")
	}
	if in.Limit <= 0 || in.Limit > 500 {
		return nil, errors.New("DescribeOrderList Limit must be between 1 and 500")
	}
	if in.Offset < 0 {
		return nil, errors.New("DescribeOrderList Offset must be >= 0")
	}
	payMode := strings.TrimSpace(in.PayMode)
	if payMode == "" {
		return nil, errors.New("DescribeOrderList PayMode is required")
	}
	return map[string]any{
		"OrderIds": orderIDs,
		"Limit":    in.Limit,
		"Offset":   in.Offset,
		"PayMode":  payMode,
	}, nil
}
