package trade

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetProvisionedCreateOrderByResourceID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/internal/trade/orders/by-resource/pass-14d" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer internal-token" {
			t.Fatalf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deal_name":"deal-14d","bundle_id":"bundle-launch","period":14,"time_unit":"d"}`))
	}))
	defer server.Close()

	adapter := newTestAdapter(t, server.URL, "internal-token")
	reader, ok := adapter.(ProvisionedCreateOrderReader)
	if !ok {
		t.Fatal("trade adapter does not implement ProvisionedCreateOrderReader")
	}
	order, err := reader.GetProvisionedCreateOrderByResourceID(context.Background(), "pass-14d")
	if err != nil {
		t.Fatalf("get provisioned create order: %v", err)
	}
	if order.DealName != "deal-14d" || order.BundleID != "bundle-launch" || order.Period != 14 || order.TimeUnit != "d" {
		t.Fatalf("unexpected order: %+v", order)
	}
}
