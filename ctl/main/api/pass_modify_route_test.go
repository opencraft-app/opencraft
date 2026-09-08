package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	passlogic "ctl/pkg/logic/pass"
	"ctl/pkg/transport"
)

// 同 SP 升配用户侧路由。需求：TAPD 1010132091137784162 §5.1
//
// 路由和响应 JSON 是与前端的契约，两侧各写一份，编译期对不上也不会有提示。
// 这些用例把路径、方法、鉴权和字段名钉在这里。

type recordingModifyPassLogic struct {
	passlogic.Logic
	listCalls    int
	lastUserID   string
	lastPassID   string
	lastOrderReq *transport.ModifyPassOrderRequest
}

func (l *recordingModifyPassLogic) ListPassModifyBundles(userID, passID string) (*transport.ModifyBundleSetResult, error) {
	l.listCalls++
	l.lastUserID, l.lastPassID = userID, passID
	return &transport.ModifyBundleSetResult{
		SourceBundleID: "bundle_launch_01",
		ModifyBundleSet: []transport.ModifyBundleOption{{
			TargetBundleID: "bundle_cruise_01",
			Bundle: transport.ModifyBundleDetail{
				BundleID:       "bundle_cruise_01",
				BundleName:     "巡游 Cruise",
				CPU:            4,
				Memory:         8,
				SystemDiskSize: 80,
				Credit:         200,
			},
			ModifyPrice: transport.BundlePrice{
				Price:         5000,
				TotalCost:     5000,
				TaxPrice:      0,
				RealTotalCost: 5000,
				Currency:      "CNY",
				Discount:      1,
			},
		}},
	}, nil
}

func (l *recordingModifyPassLogic) ModifyPassOrder(
	userID, passID string, req *transport.ModifyPassOrderRequest,
) (*transport.ModifyPassOrderResult, error) {
	l.lastUserID, l.lastPassID, l.lastOrderReq = userID, passID, req
	return &transport.ModifyPassOrderResult{DealName: "DEAL-MODIFY-1", BigOrderID: "BIG-1"}, nil
}

func (l *recordingModifyPassLogic) ModifyPassOrderAndPay(
	userID, passID string, req *transport.ModifyPassOrderRequest,
) (*transport.ModifyPassOrderResult, error) {
	l.lastUserID, l.lastPassID, l.lastOrderReq = userID, passID, req
	return &transport.ModifyPassOrderResult{DealName: "DEAL-MODIFY-PAID", BigOrderID: "BIG-2"}, nil
}

func (l *recordingModifyPassLogic) ModifyPassOrderUrl(
	userID, passID string, req *transport.ModifyPassOrderRequest,
) (*transport.ModifyPassOrderUrlResult, error) {
	l.lastUserID, l.lastPassID, l.lastOrderReq = userID, passID, req
	return &transport.ModifyPassOrderUrlResult{DealName: "DEAL-MODIFY-1", PayURL: "https://pay.example/x"}, nil
}

func modifyRouter(l passlogic.Logic) http.Handler {
	return newRouter(&instanceHandler{logic: &stubLogic{}}, &bundleHandler{}, &passHandler{logic: l})
}

// TestModifyBundlesResponseMatchesAgreedShape 把 §5.1 的响应 JSON 逐字段钉死。
//
// 前端按这些 key 取值，尤其是 target_bundle_id —— 需求明确要求前端只能从响应里取，
// 不得拼接。key 改名后前端拿到空值会退化成"没有可升配套餐"，比报错更难发现。
func TestModifyBundlesResponseMatchesAgreedShape(t *testing.T) {
	logic := &recordingModifyPassLogic{}
	req := httptest.NewRequest(http.MethodGet, "/v1/passes/lhpass-r1/modify/bundles", nil)
	req.Header.Set("X-User-Id", "usr_test")
	rec := httptest.NewRecorder()
	modifyRouter(logic).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d want 200; body=%s", rec.Code, rec.Body.String())
	}
	if logic.listCalls != 1 || logic.lastUserID != "usr_test" || logic.lastPassID != "lhpass-r1" {
		t.Fatalf("logic called %d times as (%q, %q)", logic.listCalls, logic.lastUserID, logic.lastPassID)
	}

	var envelope struct {
		Data struct {
			SourceBundleID  string `json:"source_bundle_id"`
			ModifyBundleSet []struct {
				TargetBundleID string `json:"target_bundle_id"`
				Bundle         struct {
					BundleID       string `json:"bundle_id"`
					BundleName     string `json:"bundle_name"`
					CPU            int    `json:"cpu"`
					Memory         int    `json:"memory"`
					SystemDiskSize int    `json:"system_disk_size"`
					Credit         int64  `json:"credit"`
				} `json:"bundle"`
				ModifyPrice struct {
					Price         float64 `json:"price"`
					TotalCost     float64 `json:"total_cost"`
					TaxPrice      float64 `json:"tax_price"`
					RealTotalCost float64 `json:"real_total_cost"`
					Currency      string  `json:"currency"`
					Discount      float64 `json:"discount"`
				} `json:"modify_price"`
			} `json:"modify_bundle_set"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, rec.Body.String())
	}

	data := envelope.Data
	if data.SourceBundleID != "bundle_launch_01" {
		t.Errorf("source_bundle_id = %q", data.SourceBundleID)
	}
	if len(data.ModifyBundleSet) != 1 {
		t.Fatalf("modify_bundle_set has %d entries, want 1", len(data.ModifyBundleSet))
	}
	opt := data.ModifyBundleSet[0]
	if opt.TargetBundleID != "bundle_cruise_01" {
		t.Errorf("target_bundle_id = %q", opt.TargetBundleID)
	}
	if opt.Bundle.CPU != 4 || opt.Bundle.Memory != 8 || opt.Bundle.SystemDiskSize != 80 || opt.Bundle.Credit != 200 {
		t.Errorf("bundle spec = %+v, want 4C8G80G credit=200", opt.Bundle)
	}
	if opt.ModifyPrice.RealTotalCost != 5000 || opt.ModifyPrice.Currency != "CNY" || opt.ModifyPrice.Discount != 1 {
		t.Errorf("modify_price = %+v", opt.ModifyPrice)
	}
}

// TestModifyBundlesEmptySetSerializesAsArray 保证"无可升配目标"是 [] 而不是 null。
func TestModifyBundlesEmptySetSerializesAsArray(t *testing.T) {
	body, err := json.Marshal(transport.ModifyBundleSetResult{
		SourceBundleID:  "bundle_cruise_01",
		ModifyBundleSet: []transport.ModifyBundleOption{},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(body), `"modify_bundle_set":[]`) {
		t.Fatalf("empty set must serialize as [], got %s", body)
	}
}

// TestModifyOrderRoutesForwardTargetBundle 覆盖三个下单入口的路由与入参透传。
func TestModifyOrderRoutesForwardTargetBundle(t *testing.T) {
	cases := []struct {
		path         string
		wantDealName string
		wantPayURL   string
	}{
		{"/v1/passes/lhpass-r1/modify/order", "DEAL-MODIFY-1", ""},
		{"/v1/passes/lhpass-r1/modify/order-url", "DEAL-MODIFY-1", "https://pay.example/x"},
		{"/v1/passes/lhpass-r1/modify/order-and-pay", "DEAL-MODIFY-PAID", ""},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			logic := &recordingModifyPassLogic{}
			req := httptest.NewRequest(http.MethodPost, tc.path,
				strings.NewReader(`{"target_bundle_id":"bundle_cruise_01"}`))
			req.Header.Set("X-User-Id", "usr_test")
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			modifyRouter(logic).ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("got %d want 200; body=%s", rec.Code, rec.Body.String())
			}
			if logic.lastOrderReq == nil || logic.lastOrderReq.TargetBundleID != "bundle_cruise_01" {
				t.Fatalf("target bundle not forwarded: %+v", logic.lastOrderReq)
			}
			var envelope struct {
				Data struct {
					DealName string `json:"deal_name"`
					PayURL   string `json:"pay_url"`
				} `json:"data"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if envelope.Data.DealName != tc.wantDealName {
				t.Errorf("deal_name = %q, want %q", envelope.Data.DealName, tc.wantDealName)
			}
			if envelope.Data.PayURL != tc.wantPayURL {
				t.Errorf("pay_url = %q, want %q", envelope.Data.PayURL, tc.wantPayURL)
			}
		})
	}
}

// TestModifyRoutesRejectWrongMethodAndAnonymous 覆盖方法与鉴权门禁。
//
// bundles 是 GET、其余三个是 POST；方法写反必须是 405 而不是 404，否则前端会以为
// 路由没上线。
func TestModifyRoutesRejectWrongMethodAndAnonymous(t *testing.T) {
	cases := []struct {
		name       string
		method     string
		path       string
		withUser   bool
		wantStatus int
	}{
		{"bundles rejects post", http.MethodPost, "/v1/passes/lhpass-r1/modify/bundles", true, http.StatusMethodNotAllowed},
		{"order rejects get", http.MethodGet, "/v1/passes/lhpass-r1/modify/order", true, http.StatusMethodNotAllowed},
		{"order-url rejects get", http.MethodGet, "/v1/passes/lhpass-r1/modify/order-url", true, http.StatusMethodNotAllowed},
		{"bundles requires user header", http.MethodGet, "/v1/passes/lhpass-r1/modify/bundles", false, http.StatusUnauthorized},
		{"order requires user header", http.MethodPost, "/v1/passes/lhpass-r1/modify/order", false, http.StatusUnauthorized},
		{"unknown action is 404", http.MethodPost, "/v1/passes/lhpass-r1/modify/downgrade", true, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			if tc.withUser {
				req.Header.Set("X-User-Id", "usr_test")
			}
			rec := httptest.NewRecorder()
			modifyRouter(&recordingModifyPassLogic{}).ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Fatalf("got %d want %d; body=%s", rec.Code, tc.wantStatus, rec.Body.String())
			}
		})
	}
}

// TestNormalizeModifyPaths 保证指标里 pass_id 不会撑爆基数，且四个动作分开可观测。
func TestNormalizeModifyPaths(t *testing.T) {
	cases := map[string]string{
		"/v1/passes/lhpass-r1/modify/bundles":       "/v1/passes/{passId}/modify/bundles",
		"/v1/passes/lhpass-r1/modify/order":         "/v1/passes/{passId}/modify/order",
		"/v1/passes/lhpass-r1/modify/order-url":     "/v1/passes/{passId}/modify/order-url",
		"/v1/passes/lhpass-r2/modify/order-and-pay": "/v1/passes/{passId}/modify/order-and-pay",
	}
	for path, want := range cases {
		if got := normalizePath(path); got != want {
			t.Errorf("normalizePath(%q) = %q, want %q", path, got, want)
		}
	}
}
