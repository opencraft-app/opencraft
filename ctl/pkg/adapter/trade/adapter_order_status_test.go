package trade

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// === ctl-order-status-query 设计稿落地（QueryOrderStatus adapter 单测）===
// 设计稿：.tmp/ctl-order-status-query-design.md §5.5
//
// 测试覆盖：
//   - 200 happy path（含路径拼接 / body 序列化 / 响应解码）
//   - 200 B7 降级（Source=local + UpstreamErr）
//   - 4xx 业务错（trade 返 OrderNotFound / InvalidRequest）
//   - 入参校验（dealName / externalUserID 必填）
//   - BaseURL 缺失防御

func TestQueryOrderStatus_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 路径校验
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		wantPath := "/internal/trade/orders/deal-1/query-status"
		if r.URL.Path != wantPath {
			t.Errorf("path = %s, want %s", r.URL.Path, wantPath)
		}
		// Auth 校验
		if got := r.Header.Get("Authorization"); got != "Bearer internal-token" {
			t.Errorf("auth = %q, want Bearer internal-token", got)
		}
		// body 反序列化 + external_user_id 校验
		raw, _ := io.ReadAll(r.Body)
		var body queryOrderStatusRequest
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body.ExternalUserID != "u-test-1" {
			t.Errorf("external_user_id = %q, want u-test-1", body.ExternalUserID)
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deal_name":"deal-1","order_type":"create","status":"success","source":"local","local_status":"provisioned","big_order_id":"BIG-1"}`))
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "internal-token")
	res, err := adp.QueryOrderStatus(context.Background(), "deal-1", "u-test-1")
	if err != nil {
		t.Fatalf("QueryOrderStatus: %v", err)
	}
	if res.DealName != "deal-1" || res.Status != "success" || res.Source != "local" || res.OrderType != "create" {
		t.Errorf("unexpected result: %+v", res)
	}
	if res.LocalStatus != "provisioned" || res.BigOrderID != "BIG-1" {
		t.Errorf("unexpected metadata: localStatus=%q bigOrderID=%q", res.LocalStatus, res.BigOrderID)
	}
}

// TestQueryOrderStatus_B7_FallbackPassThrough 验证 B7 降级链路：
// trade 返 200 + Source="local" + upstream_err 非空时，adapter 不触发错误，直接透传给上层。
func TestQueryOrderStatus_B7_FallbackPassThrough(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deal_name":"deal-7","order_type":"create","status":"pending","source":"local","local_status":"pending_pay","upstream_err":"connection refused"}`))
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")
	res, err := adp.QueryOrderStatus(context.Background(), "deal-7", "u-7")
	if err != nil {
		t.Fatalf("B7 violated: jifei fallback should be 200 + result, got err: %v", err)
	}
	if res.Source != "local" {
		t.Errorf("source = %q, want local (B7 fallback)", res.Source)
	}
	if !strings.Contains(res.UpstreamErr, "connection refused") {
		t.Errorf("upstream_err = %q, want contain 'connection refused'", res.UpstreamErr)
	}
}

// TestQueryOrderStatus_404_OrderNotFound 验证 trade 返 404 时 adapter 包成 *Error 透传。
func TestQueryOrderStatus_404_OrderNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"OrderNotFound","message":"trade_order not found"}`))
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")
	_, err := adp.QueryOrderStatus(context.Background(), "deal-x", "u-x")
	if err == nil {
		t.Fatal("expected error for 404 response, got nil")
	}
	var tErr *Error
	if !errors.As(err, &tErr) {
		t.Fatalf("expected *Error, got %T: %v", err, err)
	}
	if tErr.Status != http.StatusNotFound || tErr.Code != "OrderNotFound" {
		t.Errorf("unexpected *Error: status=%d code=%q msg=%q",
			tErr.Status, tErr.Code, tErr.Message)
	}
}

// TestQueryOrderStatus_InvalidInput 验证入参防御。
func TestQueryOrderStatus_InvalidInput(t *testing.T) {
	adp := newTestAdapter(t, "http://example.invalid", "")
	cases := []struct {
		name           string
		dealName       string
		externalUserID string
	}{
		{"empty_deal", "", "u-1"},
		{"whitespace_deal", "   ", "u-1"},
		{"empty_user", "deal-1", ""},
		{"whitespace_user", "deal-1", "   "},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := adp.QueryOrderStatus(context.Background(), c.dealName, c.externalUserID)
			if err == nil {
				t.Fatalf("expected validation error for (%q, %q), got nil", c.dealName, c.externalUserID)
			}
		})
	}
}

// TestQueryOrderStatus_BaseURLMissing 验证 BaseURL 未配置时早期返错。
func TestQueryOrderStatus_BaseURLMissing(t *testing.T) {
	adp := newTestAdapter(t, "", "tok")
	_, err := adp.QueryOrderStatus(context.Background(), "deal-1", "u-1")
	if err == nil {
		t.Fatal("expected error for empty base_url, got nil")
	}
	if !strings.Contains(err.Error(), "base_url not configured") {
		t.Errorf("error = %q, want contain 'base_url not configured'", err.Error())
	}
}

// TestQueryOrderStatus_PathEscaping 验证 dealName 含特殊字符时的 PathEscape。
func TestQueryOrderStatus_PathEscaping(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// jifei dealName 形如 "20260509000000001-001"，含 "-" 普通字符；这里用 "deal/with/slash"
		// 验证 url.PathEscape 把 "/" 转义为 "%2F"
		if !strings.Contains(r.URL.Path, "deal%2Fwith%2Fslash") &&
			!strings.Contains(r.URL.RawPath, "deal%2Fwith%2Fslash") {
			t.Errorf("path not escaped: path=%s rawPath=%s",
				r.URL.Path, r.URL.RawPath)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deal_name":"deal/with/slash","status":"pending","source":"local"}`))
	}))
	defer server.Close()

	adp := newTestAdapter(t, server.URL, "tok")
	_, err := adp.QueryOrderStatus(context.Background(), "deal/with/slash", "u-1")
	if err != nil {
		t.Errorf("unexpected error with escaped dealName: %v", err)
	}
}
