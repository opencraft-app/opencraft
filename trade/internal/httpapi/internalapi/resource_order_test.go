package internalapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"git.woa.com/wisp/mono/trade/internal/store"
)

func TestGetProvisionedCreateOrderByResourceID(t *testing.T) {
	env := newTestEnv(t)
	env.orderStore.getProvisionedCreateOrderByResourceIDFn = func(_ context.Context, resourceID string) (*store.TradeOrder, error) {
		if resourceID != "pass-14d" {
			t.Fatalf("resourceID = %q", resourceID)
		}
		return &store.TradeOrder{
			DealName: "deal-14d",
			BundleID: "bundle-launch",
			Period:   14,
			TimeUnit: "d",
		}, nil
	}

	resp := env.doJSON(http.MethodGet, "/internal/trade/orders/by-resource/pass-14d", nil, true)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", resp.Code, resp.Body.String())
	}
	var body struct {
		DealName string `json:"deal_name"`
		BundleID string `json:"bundle_id"`
		Period   int    `json:"period"`
		TimeUnit string `json:"time_unit"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.DealName != "deal-14d" || body.BundleID != "bundle-launch" || body.Period != 14 || body.TimeUnit != "d" {
		t.Fatalf("unexpected body: %+v", body)
	}
}

func TestGetProvisionedCreateOrderByResourceIDNotFound(t *testing.T) {
	env := newTestEnv(t)
	resp := env.doJSON(http.MethodGet, "/internal/trade/orders/by-resource/missing", nil, true)
	if resp.Code != http.StatusNotFound {
		t.Fatalf("status = %d body=%s", resp.Code, resp.Body.String())
	}
}
