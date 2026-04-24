package billingapi

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	billingv20180709 "git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/billing/v20180709"
	"git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/common"
	tchttp "git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/common/http"
	"git.woa.com/tencentcloud-internal/tencentcloud-sdk-go/tencentcloud/common/profile"
	otellog "go.opentelemetry.io/otel/log"

	"shadow/internal/telemetry"
)

const (
	billingService = "billing"
	billingVersion = "2018-07-09"
)

type Client interface {
	CreateOrders(ctx context.Context, req CreateOrdersRequest) (CreateOrdersResponse, error)
	CreatePayURL(ctx context.Context, req CreatePayURLRequest) (CreatePayURLResponse, error)
	DescribeDealsByCond(ctx context.Context, req DescribeDealsByCondRequest) (DescribeDealsByCondResponse, error)
}

type Options struct {
	Endpoint       string
	Region         string
	SecretID       string
	SecretKey      string
	RequestTimeout time.Duration
}

type TencentClient struct {
	opts Options
}

func NewTencentClient(opts Options) (*TencentClient, error) {
	if opts.Endpoint == "" {
		return nil, errors.New("billing api endpoint is required")
	}
	if opts.Region == "" {
		return nil, errors.New("billing api region is required")
	}
	if opts.SecretID == "" || opts.SecretKey == "" {
		return nil, errors.New("billing api credentials are required")
	}
	if opts.RequestTimeout == 0 {
		opts.RequestTimeout = 10 * time.Second
	}
	return &TencentClient{opts: opts}, nil
}

func (c *TencentClient) CreateOrders(ctx context.Context, req CreateOrdersRequest) (CreateOrdersResponse, error) {
	telemetry.Info(ctx, telemetry.Logger("shadow/internal/billingapi"), "billing CreateOrders",
		otellog.String("endpoint", c.opts.Endpoint),
		otellog.Int("goods_count", len(req.Goods)),
	)
	var resp CreateOrdersAPIResponse
	if err := c.sendCommon(ctx, "CreateOrders", req, &resp); err != nil {
		return CreateOrdersResponse{}, err
	}
	return resp.Response, nil
}

func (c *TencentClient) CreatePayURL(ctx context.Context, req CreatePayURLRequest) (CreatePayURLResponse, error) {
	telemetry.Info(ctx, telemetry.Logger("shadow/internal/billingapi"), "billing CreatePayUrl",
		otellog.String("endpoint", c.opts.Endpoint),
		otellog.Int("order_count", len(req.OrderIds)),
		otellog.String("platform", req.Platform),
	)
	var resp CreatePayURLAPIResponse
	if err := c.sendCommon(ctx, "CreatePayUrl", req, &resp); err != nil {
		return CreatePayURLResponse{}, err
	}
	return resp.Response, nil
}

func (c *TencentClient) DescribeDealsByCond(ctx context.Context, req DescribeDealsByCondRequest) (DescribeDealsByCondResponse, error) {
	telemetry.Info(ctx, telemetry.Logger("shadow/internal/billingapi"), "billing DescribeDealsByCond",
		otellog.String("endpoint", c.opts.Endpoint),
		otellog.String("big_order_id", req.BigDealId),
		otellog.String("order_id", req.OrderId),
	)
	client, err := billingv20180709.NewClient(
		common.NewCredential(c.opts.SecretID, c.opts.SecretKey),
		c.opts.Region,
		c.profile(),
	)
	if err != nil {
		return DescribeDealsByCondResponse{}, err
	}
	request := billingv20180709.NewDescribeDealsByCondRequest()
	request.StartTime = common.StringPtr(req.StartTime)
	request.EndTime = common.StringPtr(req.EndTime)
	request.Limit = common.Int64Ptr(int64(req.Limit))
	request.Offset = common.Int64Ptr(int64(req.Offset))
	if req.OrderId != "" {
		request.OrderId = common.StringPtr(req.OrderId)
	}
	if req.BigDealId != "" {
		request.BigDealId = common.StringPtr(req.BigDealId)
	}
	if len(req.StatusSet) > 0 {
		values := make([]*int64, 0, len(req.StatusSet))
		for _, v := range req.StatusSet {
			values = append(values, common.Int64Ptr(int64(v)))
		}
		request.StatusSet = values
	}
	response, err := client.DescribeDealsByCondWithContext(ctx, request)
	if err != nil {
		return DescribeDealsByCondResponse{}, err
	}
	out := DescribeDealsByCondResponse{}
	if response.Response != nil {
		out.RequestID = valueString(response.Response.RequestId)
		out.TotalCount = int(valueInt64(response.Response.TotalCount))
		for _, deal := range response.Response.Deals {
			if deal == nil {
				continue
			}
			out.Deals = append(out.Deals, Deal{
				OrderID:     valueString(deal.OrderId),
				BigDealID:   valueString(deal.BigDealId),
				Status:      int(valueInt64(deal.Status)),
				PayMode:     valueString(deal.PayMode),
				ProductCode: valueString(deal.ProductCode),
				ResourceIDs: valueStrings(deal.ResourceId),
			})
		}
	}
	return out, nil
}

func (c *TencentClient) sendCommon(ctx context.Context, action string, req any, out any) error {
	client := common.NewCommonClient(
		common.NewCredential(c.opts.SecretID, c.opts.SecretKey),
		c.opts.Region,
		c.profile(),
	)
	request := tchttp.NewCommonRequest(billingService, billingVersion, action)
	request.SetContext(ctx)
	if err := request.SetActionParameters(mustMarshal(req)); err != nil {
		return err
	}
	response := tchttp.NewCommonResponse()
	if err := client.Send(request, response); err != nil {
		return err
	}
	return json.Unmarshal(response.GetBody(), out)
}

func (c *TencentClient) profile() *profile.ClientProfile {
	cpf := profile.NewClientProfile()
	cpf.HttpProfile.Endpoint = c.opts.Endpoint
	cpf.HttpProfile.ReqMethod = "POST"
	cpf.HttpProfile.ReqTimeout = int(c.opts.RequestTimeout.Seconds())
	return cpf
}

func mustMarshal(v any) []byte {
	raw, _ := json.Marshal(v)
	return raw
}

func valueString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func valueUint64(v *uint64) uint64 {
	if v == nil {
		return 0
	}
	return *v
}

func valueInt64(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}

func valueStrings(values []*string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		if v == nil {
			continue
		}
		out = append(out, *v)
	}
	return out
}
