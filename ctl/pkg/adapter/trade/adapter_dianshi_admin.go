package trade

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DianshiRecordFilter 是 admin 查询点石订单/参与记录的过滤条件。
type DianshiRecordFilter struct {
	ExternalUserID string
	Uin            string
	ActivityID     int64
	BundleID       string
	DealName       string
	Limit          int
}

// DianshiRecordsResult 与 trade /internal/trade/dianshi/orders 响应对齐。
type DianshiRecordsResult struct {
	Orders         []*DianshiOrder         `json:"orders"`
	Participations []*DianshiParticipation `json:"participations"`
}

type DianshiOrder struct {
	ID             int64     `json:"id"`
	BigOrderID     string    `json:"big_order_id"`
	DealName       string    `json:"deal_name"`
	ExternalUserID string    `json:"external_user_id"`
	Uin            string    `json:"uin"`
	AppID          string    `json:"app_id"`
	BundleID       string    `json:"bundle_id"`
	OrderType      string    `json:"order_type"`
	Status         string    `json:"status"`
	ResourceType   string    `json:"resource_type"`
	ResourceID     string    `json:"resource_id"`
	ActivityID     int64     `json:"activity_id"`
	ActID          int64     `json:"act_id"`
	PayURL         string    `json:"pay_url,omitempty"`
	CreatedTime    time.Time `json:"created_time"`
	UpdatedTime    time.Time `json:"updated_time"`
}

type DianshiParticipation struct {
	ID             int64     `json:"id"`
	Uin            string    `json:"uin"`
	AppID          string    `json:"app_id"`
	ExternalUserID string    `json:"external_user_id"`
	ActivityID     int64     `json:"activity_id"`
	BundleID       string    `json:"bundle_id"`
	ActID          int64     `json:"act_id"`
	DealName       string    `json:"deal_name"`
	BigDealNo      string    `json:"big_deal_no"`
	CreatedTime    time.Time `json:"created_time"`
}

type DeleteDianshiRecordResult struct {
	Deleted  bool  `json:"deleted"`
	Affected int64 `json:"affected"`
}

func (a *adapter) ListDianshiRecords(ctx context.Context, filter DianshiRecordFilter) (*DianshiRecordsResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	query := make(url.Values)
	if v := strings.TrimSpace(filter.ExternalUserID); v != "" {
		query.Set("external_user_id", v)
	}
	if v := strings.TrimSpace(filter.Uin); v != "" {
		query.Set("uin", v)
	}
	if filter.ActivityID > 0 {
		query.Set("activity_id", strconv.FormatInt(filter.ActivityID, 10))
	}
	if v := strings.TrimSpace(filter.BundleID); v != "" {
		query.Set("bundle_id", v)
	}
	if v := strings.TrimSpace(filter.DealName); v != "" {
		query.Set("deal_name", v)
	}
	if filter.Limit > 0 {
		query.Set("limit", strconv.Itoa(filter.Limit))
	}
	if len(query) == 0 {
		return nil, fmt.Errorf("trade adapter: ListDianshiRecords: at least one filter is required")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") + "/internal/trade/dianshi/orders?" + query.Encode()
	var result DianshiRecordsResult
	if err := a.doJSON(ctx, http.MethodGet, endpoint, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (a *adapter) DeleteDianshiOrder(ctx context.Context, dealName string) (*DeleteDianshiRecordResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	dealName = strings.TrimSpace(dealName)
	if dealName == "" {
		return nil, fmt.Errorf("trade adapter: DeleteDianshiOrder: dealName is required")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") +
		"/internal/trade/dianshi/orders/" + url.PathEscape(dealName)
	var result DeleteDianshiRecordResult
	if err := a.doJSON(ctx, http.MethodDelete, endpoint, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (a *adapter) DeleteDianshiParticipation(ctx context.Context, id int64) (*DeleteDianshiRecordResult, error) {
	if a.config.BaseURL == "" {
		return nil, fmt.Errorf("trade adapter: base_url not configured")
	}
	if id <= 0 {
		return nil, fmt.Errorf("trade adapter: DeleteDianshiParticipation: id must be > 0")
	}

	endpoint := strings.TrimRight(a.config.BaseURL, "/") +
		"/internal/trade/dianshi/participations/" + strconv.FormatInt(id, 10)
	var result DeleteDianshiRecordResult
	if err := a.doJSON(ctx, http.MethodDelete, endpoint, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
