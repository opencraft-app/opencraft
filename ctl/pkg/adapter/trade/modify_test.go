package trade

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 同 SP 升配的 ctl → trade 调用契约。需求：TAPD 1010132091137784162 §5.1

// stdModifyRequest 是三个端点共用的合法入参。
func stdModifyRequest() *ModifyOrderRequest {
	return &ModifyOrderRequest{
		ExternalUserID: "usr_test",
		ResourceID:     "lhpass-r1",
		SourceBundleID: "bundle_launch_01",
		TargetBundleID: "bundle_cruise_01",
		CurDeadline:    "2026-06-15 10:30:00",
		PayMode:        1,
	}
}

// TestModifyEndpointsHitAgreedPaths 把三个端点的 method + path 钉死。
//
// 路径是纯字符串约定，两侧各写一份；trade 改路由而 ctl 没跟上时，编译期不会有任何
// 提示，只会在联调时得到 404。
func TestModifyEndpointsHitAgreedPaths(t *testing.T) {
	cases := []struct {
		name     string
		wantPath string
		call     func(adp Adapter) error
	}{
		{
			name:     "inquiry",
			wantPath: "/internal/trade/inquiry/modify",
			call: func(adp Adapter) error {
				_, err := adp.InquiryModify(context.Background(), stdModifyRequest())
				return err
			},
		},
		{
			name:     "place order",
			wantPath: "/internal/trade/orders/modify",
			call: func(adp Adapter) error {
				_, err := adp.PlaceModifyOrder(context.Background(), stdModifyRequest())
				return err
			},
		},
		{
			name:     "place order and pay",
			wantPath: "/internal/trade/orders/modify/place-and-pay",
			call: func(adp Adapter) error {
				_, err := adp.PlaceModifyOrderAndPay(context.Background(), stdModifyRequest())
				return err
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotMethod, gotPath, gotAuth string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod, gotPath, gotAuth = r.Method, r.URL.Path, r.Header.Get("Authorization")
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"prices":[],"deal_name":"D-1"}`))
			}))
			defer server.Close()

			if err := tc.call(newTestAdapter(t, server.URL, "internal-token")); err != nil {
				t.Fatalf("call: %v", err)
			}
			if gotMethod != http.MethodPost {
				t.Fatalf("method = %s, want POST", gotMethod)
			}
			if gotPath != tc.wantPath {
				t.Fatalf("path = %s, want %s", gotPath, tc.wantPath)
			}
			if gotAuth != "Bearer internal-token" {
				t.Fatalf("authorization = %q, want bearer internal-token", gotAuth)
			}
		})
	}
}

// TestInquiryModifySendsBillingIdentityAndDecodesQuote 锁住入参 wire 名和出参解码。
//
// 四件套 (resourceId, sourceBundleId, targetBundleId, curDeadline) 少任何一个，
// trade 都无法确定这笔账；任一 JSON tag 漂移都只会在联调时以"字段为空"的形式出现。
func TestInquiryModifySendsBillingIdentityAndDecodesQuote(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"prices":[{
			"bundle_id":"bundle_cruise_01",
			"price":"5000","total_cost":"5000","tax_price":"0",
			"real_total_cost":"5000","currency":"CNY","discount":1
		}]}`))
	}))
	defer server.Close()

	result, err := newTestAdapter(t, server.URL, "tok").
		InquiryModify(context.Background(), stdModifyRequest())
	if err != nil {
		t.Fatalf("InquiryModify: %v", err)
	}

	for key, want := range map[string]any{
		"externalUserId": "usr_test",
		"resourceId":     "lhpass-r1",
		"sourceBundleId": "bundle_launch_01",
		"targetBundleId": "bundle_cruise_01",
		"curDeadline":    "2026-06-15 10:30:00",
	} {
		if got := body[key]; got != want {
			t.Errorf("body[%q] = %v, want %v", key, got, want)
		}
	}
	// 变配不改到期时间：这三个字段一旦出现，说明有人把续费语义抄了过来。
	for _, absent := range []string{"period", "timeUnit", "goodsNum"} {
		if _, ok := body[absent]; ok {
			t.Errorf("body carries %q, modify must not send renewal fields", absent)
		}
	}

	if len(result.Prices) != 1 || result.Prices[0] == nil {
		t.Fatalf("prices = %+v, want exactly one quote", result.Prices)
	}
	if q := result.Prices[0]; q.RealTotalCost != "5000" || q.Currency != "CNY" {
		t.Fatalf("quote = %+v, want real_total_cost=5000 currency=CNY", q)
	}
}

// TestModifyRequestValidationFailsFast 确认必填缺失时不打网络往返。
//
// httptest 不启动：任何请求发出去都会因连接失败而报错，但错误文案会变成网络错，
// 掩盖掉"是我这边参数没填全"。用不可达地址反过来验证：拿到的必须是校验错。
func TestModifyRequestValidationFailsFast(t *testing.T) {
	adp := newTestAdapter(t, "http://127.0.0.1:1", "tok")

	cases := []struct {
		name      string
		mutate    func(*ModifyOrderRequest)
		wantField string
	}{
		{"missing resourceId", func(r *ModifyOrderRequest) { r.ResourceID = "" }, "resourceId"},
		{"missing sourceBundleId", func(r *ModifyOrderRequest) { r.SourceBundleID = "" }, "sourceBundleId"},
		{"missing targetBundleId", func(r *ModifyOrderRequest) { r.TargetBundleID = " " }, "targetBundleId"},
		{"missing curDeadline", func(r *ModifyOrderRequest) { r.CurDeadline = "" }, "curDeadline"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := stdModifyRequest()
			tc.mutate(req)
			_, err := adp.InquiryModify(context.Background(), req)
			if err == nil {
				t.Fatal("expected validation error, got nil")
			}
			if !strings.Contains(err.Error(), tc.wantField) {
				t.Fatalf("error %q does not name the missing field %q", err, tc.wantField)
			}
		})
	}

	if _, err := adp.PlaceModifyOrder(context.Background(), nil); err == nil {
		t.Fatal("PlaceModifyOrder(nil) should fail")
	}
}
