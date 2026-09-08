package internalapi

import (
	"context"
	"net/http"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 同 SP 变配的三个内部端点。需求：TAPD 1010132091137784162 §5.1 / §7.1

const (
	modifySourceBundle = "bundle_sail"
	modifyTargetBundle = "bundle_cruise"
)

// stubModifyBundleDefStore 让 env 返回一对同 SP 的源/目标套餐定义，
// 目标套餐带 scene=modify 的 categoryId。
func stubModifyBundleDefStore(env *testEnv) {
	env.bundle.getBundleDefinitionByIDFn = func(_ context.Context, bundleID string) (*store.BundleDefinition, error) {
		def := &store.BundleDefinition{
			BundleID:       bundleID,
			ProductCode:    "p_lighthouse",
			SubProductCode: "sp_test",
			Pid:            1234,
			CategoryIDs: []store.CategoryIDEntry{
				{Scene: "purchase", Category: 100059},
			},
		}
		switch bundleID {
		case modifySourceBundle:
			def.SVList = map[string]int64{"sv_cpu": 2, "sv_disk": 60}
		case modifyTargetBundle:
			def.SVList = map[string]int64{"sv_cpu": 4, "sv_disk": 80}
			def.CategoryIDs = append(def.CategoryIDs, store.CategoryIDEntry{Scene: "modify", Category: 2025048})
		default:
			return nil, store.ErrBundleDefinitionNotFound
		}
		return def, nil
	}
}

func modifyBody() map[string]any {
	return map[string]any{
		"externalUserId": "user-1",
		"uin":            "1000123456",
		"appId":          "10001",
		"resourceId":     "lhpass-r1",
		"sourceBundleId": modifySourceBundle,
		"targetBundleId": modifyTargetBundle,
		"curDeadline":    "2026-06-15 10:30:00",
		"payMode":        1,
	}
}

func TestInquiryModify_HappyPath(t *testing.T) {
	env := newTestEnv(t)
	stubModifyBundleDefStore(env)

	rec := env.doJSON(http.MethodPost, "/internal/trade/inquiry/modify", modifyBody(), true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	prices, ok := resp["prices"].([]any)
	if !ok || len(prices) != 1 {
		t.Fatalf("prices = %v, want exactly one quote", resp["prices"])
	}
	quote, ok := prices[0].(map[string]any)
	if !ok {
		t.Fatalf("prices[0] type = %T", prices[0])
	}
	if quote["real_total_cost"] != "35.10" {
		t.Errorf("real_total_cost = %v, want 35.10", quote["real_total_cost"])
	}
	if quote["bundle_id"] != modifyTargetBundle {
		t.Errorf("bundle_id = %v, want target %q", quote["bundle_id"], modifyTargetBundle)
	}
}

func TestModifyEndpoints_InvalidInput(t *testing.T) {
	paths := []string{
		"/internal/trade/inquiry/modify",
		"/internal/trade/orders/modify",
		"/internal/trade/orders/modify/place-and-pay",
	}
	cases := []struct {
		name string
		mut  func(b map[string]any)
	}{
		{"missing resource_id", func(b map[string]any) { delete(b, "resourceId") }},
		{"missing source_bundle_id", func(b map[string]any) { delete(b, "sourceBundleId") }},
		{"missing target_bundle_id", func(b map[string]any) { delete(b, "targetBundleId") }},
		{"missing cur_deadline", func(b map[string]any) { delete(b, "curDeadline") }},
		{"same source and target", func(b map[string]any) { b["targetBundleId"] = b["sourceBundleId"] }},
	}
	for _, path := range paths {
		for _, tc := range cases {
			t.Run(path+"/"+tc.name, func(t *testing.T) {
				env := newTestEnv(t)
				stubModifyBundleDefStore(env)
				body := modifyBody()
				tc.mut(body)
				rec := env.doJSON(http.MethodPost, path, body, true)
				if rec.Code != http.StatusBadRequest {
					t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
				}
				if resp := decodeBody(t, rec); resp["code"] != "InvalidRequest" {
					t.Errorf("code = %v, want InvalidRequest", resp["code"])
				}
			})
		}
	}
}

func TestModifyEndpoints_RequireAuth(t *testing.T) {
	paths := []string{
		"/internal/trade/inquiry/modify",
		"/internal/trade/orders/modify",
		"/internal/trade/orders/modify/place-and-pay",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			env := newTestEnv(t)
			stubModifyBundleDefStore(env)
			rec := env.doJSON(http.MethodPost, path, modifyBody(), false)
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("expected 401, got %d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestPlaceModifyOrder_HappyPath(t *testing.T) {
	env := newTestEnv(t)
	stubModifyBundleDefStore(env)

	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/modify", modifyBody(), true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["dealName"] != "deal-1" || resp["bigOrderId"] != "big-1" {
		t.Errorf("dealName/bigOrderId = %v/%v", resp["dealName"], resp["bigOrderId"])
	}

	if env.orderWriter.createOrderCalls.Load() != 1 {
		t.Fatalf("CreateOrder calls = %d, want 1", env.orderWriter.createOrderCalls.Load())
	}
	got := env.orderWriter.lastCreateOrderInput
	if got.OrderType != store.OrderTypeModify {
		t.Errorf("OrderType = %q, want %q", got.OrderType, store.OrderTypeModify)
	}
	// 订单卖的是"升到目标套餐"，bundle_id 必须落目标而不是源。
	if got.BundleID != modifyTargetBundle || got.ResourceID != "lhpass-r1" {
		t.Errorf("BundleID/ResourceID = %q/%q", got.BundleID, got.ResourceID)
	}
}

func TestPlaceModifyOrderAndPay_HappyPath(t *testing.T) {
	env := newTestEnv(t)
	stubModifyBundleDefStore(env)

	rec := env.doJSON(http.MethodPost, "/internal/trade/orders/modify/place-and-pay", modifyBody(), true)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if resp["dealName"] != "deal-pay-1" || resp["bigOrderId"] != "big-pay-1" {
		t.Errorf("dealName/bigOrderId = %v/%v", resp["dealName"], resp["bigOrderId"])
	}
}

// 跨 SP 变配（启航 → 巡游 AI）本期不支持，端点必须给出可区分的错误码，
// 而不是混进通用的 InvalidRequest。
func TestModifyEndpoints_CrossSubProduct(t *testing.T) {
	paths := []string{
		"/internal/trade/inquiry/modify",
		"/internal/trade/orders/modify",
		"/internal/trade/orders/modify/place-and-pay",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			env := newTestEnv(t)
			env.bundle.getBundleDefinitionByIDFn = func(_ context.Context, bundleID string) (*store.BundleDefinition, error) {
				def := &store.BundleDefinition{
					BundleID:       bundleID,
					ProductCode:    "p_lighthouse",
					SubProductCode: "sp_test",
					Pid:            1234,
					CategoryIDs: []store.CategoryIDEntry{
						{Scene: "purchase", Category: 100059},
						{Scene: "modify", Category: 2025048},
					},
					SVList: map[string]int64{"sv_cpu": 2},
				}
				if bundleID == modifyTargetBundle {
					def.SubProductCode = "sp_test_ai"
				}
				return def, nil
			}

			rec := env.doJSON(http.MethodPost, path, modifyBody(), true)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("expected 422, got %d body=%s", rec.Code, rec.Body.String())
			}
			if resp := decodeBody(t, rec); resp["code"] != "ModifyCrossSubProduct" {
				t.Errorf("code = %v, want ModifyCrossSubProduct", resp["code"])
			}
		})
	}
}

func TestModifyEndpoints_BundleNotFound(t *testing.T) {
	paths := []string{
		"/internal/trade/inquiry/modify",
		"/internal/trade/orders/modify",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			env := newTestEnv(t)
			stubModifyBundleDefStore(env)
			env.ctl.getBundleByIDFn = func(_ context.Context, _ string) (*ctlclient.BundleDetail, error) {
				return nil, ctlclient.ErrNotFound
			}
			rec := env.doJSON(http.MethodPost, path, modifyBody(), true)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
			}
			if resp := decodeBody(t, rec); resp["code"] != "BundleNotFound" {
				t.Errorf("code = %v, want BundleNotFound", resp["code"])
			}
			if env.orderWriter.createOrderCalls.Load() != 0 {
				t.Errorf("CreateOrder must not be called, calls=%d", env.orderWriter.createOrderCalls.Load())
			}
		})
	}
}
