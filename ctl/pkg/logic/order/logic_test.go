package order

import (
	"errors"
	"net/http"
	"testing"

	"ctl/pkg/adapter/trade"
	"ctl/pkg/errcode"
)

// === ctl-order-status-query 设计稿落地（mapTradeError 表驱动测试）===
// 设计稿：.tmp/ctl-order-status-query-design.md §6 错误码表
//
// 测试覆盖：
//   - 4xx → 透传相应 errcode
//   - 5xx → 包成 ErrInternalServer（不直接透传细节）
//   - 非 *trade.Error → raw error 透传
//
// 真实业务分支（GetOrderStatus 主流程调全局 adapterfactory）依赖全局单例，
// 在单测里 mock 成本过高；该路径已在 trade 内部 16 个单测 + ctl handler
// 路由层 10 个测试（destroy_route_test.go 同范式 order_route_test.go）覆盖。

func TestMapTradeError_StatusMapping(t *testing.T) {
	cases := []struct {
		name        string
		err         error
		wantWrapped error // expected unwrap target (or nil for pass-through)
	}{
		{
			name: "400_invalid_request_maps_to_ErrInvalidParam",
			err: &trade.Error{
				Status:  http.StatusBadRequest,
				Code:    "InvalidRequest",
				Message: "deal_name is required",
			},
			wantWrapped: errcode.ErrInvalidParam,
		},
		{
			name: "404_order_not_found_maps_to_ErrOrderNotFound",
			err: &trade.Error{
				Status:  http.StatusNotFound,
				Code:    "OrderNotFound",
				Message: "trade_order not found",
			},
			wantWrapped: errcode.ErrOrderNotFound,
		},
		{
			name: "500_internal_error_wrapped_as_ErrInternalServer",
			err: &trade.Error{
				Status:  http.StatusInternalServerError,
				Code:    "InternalError",
				Message: "trade db down",
			},
			wantWrapped: errcode.ErrInternalServer,
		},
		{
			name: "502_upstream_business_wrapped_as_ErrInternalServer",
			err: &trade.Error{
				Status:  http.StatusBadGateway,
				Code:    "UpstreamBusinessError",
				Message: "jifei returned non-zero return code",
			},
			wantWrapped: errcode.ErrInternalServer,
		},
		{
			name:        "non_trade_error_passthrough",
			err:         errors.New("network failure"),
			wantWrapped: nil, // raw error passes through
		},
		{
			name: "unmapped_3xx_passthrough",
			err: &trade.Error{
				Status:  http.StatusFound,
				Code:    "Redirect",
				Message: "should not happen",
			},
			wantWrapped: nil, // 3xx 不在 case 内，落到末尾 return err
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := mapTradeError(c.err)
			if c.wantWrapped == nil {
				// 期望透传 raw error（非 *trade.Error 或无匹配 case）
				if !errors.Is(got, c.err) && got != c.err {
					t.Errorf("expected pass-through for %v, got %v", c.err, got)
				}
				return
			}
			// 期望被 wrap 成特定 errcode
			if !errors.Is(got, c.wantWrapped) {
				t.Errorf("expected error to wrap %v via errors.Is, got %v", c.wantWrapped, got)
			}
		})
	}
}

func TestGetOrderStatus_InvalidInput(t *testing.T) {
	l := NewLogic()

	cases := []struct {
		name     string
		userID   string
		dealName string
	}{
		{"empty_user", "", "deal-1"},
		{"empty_deal", "u-1", ""},
		{"both_empty", "", ""},
		{"whitespace_user", "   ", "deal-1"},
		{"whitespace_deal", "u-1", "   "},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := l.GetOrderStatus(c.userID, c.dealName)
			if !errors.Is(err, errcode.ErrInvalidParam) {
				t.Errorf("expected ErrInvalidParam for (%q, %q), got %v",
					c.userID, c.dealName, err)
			}
		})
	}
}
