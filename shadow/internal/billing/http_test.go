package billing_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"shadow/internal/billing"
	"shadow/internal/storage"
	storagesqlite "shadow/internal/storage/sqlite"
)

func TestHTTPProvider_CreateFreeTrialOrderAndPay(t *testing.T) {
	store := newBillingSQLiteStore(t)

	var sawDianshi bool
	dianshiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawDianshi = true
		var payload struct {
			Interface struct {
				Para struct {
					Uin        string `json:"uin"`
					ActivityID string `json:"activity_id"`
					Goods      []struct {
						ActID           string `json:"act_id"`
						PreferenceParam struct {
							Version string `json:"version"`
						} `json:"preference_param"`
					} `json:"goods"`
					SaaSInfo struct {
						SaaSToken     string `json:"SaaSToken"`
						Platform      string `json:"Platform"`
						TokenUin      int64  `json:"TokenUin"`
						TokenOwnerUin int64  `json:"TokenOwnerUin"`
					} `json:"saas_info"`
				} `json:"para"`
			} `json:"interface"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode dianshi payload: %v", err)
		}
		if payload.Interface.Para.ActivityID != "15152" {
			t.Fatalf("unexpected activity id=%s", payload.Interface.Para.ActivityID)
		}
		if len(payload.Interface.Para.Goods) != 1 || payload.Interface.Para.Goods[0].ActID != "134393" {
			t.Fatalf("unexpected goods payload=%+v", payload.Interface.Para.Goods)
		}
		if payload.Interface.Para.Goods[0].PreferenceParam.Version != "sp_tced_saas" {
			t.Fatalf("unexpected version=%s", payload.Interface.Para.Goods[0].PreferenceParam.Version)
		}
		if payload.Interface.Para.SaaSInfo.Platform != "shadow_test" {
			t.Fatalf("unexpected platform=%s", payload.Interface.Para.SaaSInfo.Platform)
		}
		if payload.Interface.Para.SaaSInfo.SaaSToken != "saas-token" {
			t.Fatalf("unexpected token=%s", payload.Interface.Para.SaaSInfo.SaaSToken)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"returnCode":    0,
			"returnMessage": "ok",
			"data": map[string]any{
				"big_deal_no": "bigdeal-1",
			},
		})
	}))
	defer dianshiServer.Close()

	var sawBilling bool
	billingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawBilling = true
		var payload struct {
			Interface struct {
				InterfaceName string `json:"interfaceName"`
				Para          struct {
					BigDealIDs []string `json:"bigDealIds"`
				} `json:"para"`
			} `json:"interface"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode billing payload: %v", err)
		}
		if payload.Interface.InterfaceName != "qcloud.Deal.payDealsNew" {
			t.Fatalf("unexpected billing interface=%s", payload.Interface.InterfaceName)
		}
		if len(payload.Interface.Para.BigDealIDs) != 1 || payload.Interface.Para.BigDealIDs[0] != "bigdeal-1" {
			t.Fatalf("unexpected deal ids=%+v", payload.Interface.Para.BigDealIDs)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"returnCode":    0,
			"returnMessage": "ok",
			"data": map[string]any{
				"dealNames": []string{"deal-1"},
				"resourceIds": map[string]any{
					"deal-1": []string{"ins-1"},
				},
			},
		})
	}))
	defer billingServer.Close()

	provider, err := billing.NewHTTPProvider(billing.HTTPOptions{
		Platform:            "shadow_test",
		DianshiEndpoint:     dianshiServer.URL,
		BillingEndpoint:     billingServer.URL,
		FreeTrialActivityID: "15152",
		FreeTrialActID:      "134393",
		SubProductCode:      "sp_tced_saas",
		RequestTimeout:      time.Second,
	}, store)
	if err != nil {
		t.Fatalf("new http provider: %v", err)
	}

	result, err := provider.CreateFreeTrialOrderAndPay(context.Background(), billing.FreeTrialOrderInput{
		UserID:         "usr_00000000-0000-4000-8000-000000000301",
		ShadowUserName: "usr_00000000-0000-4000-8000-000000000301",
		CountryCode:    "+86",
		PhoneNumber:    "13800000040",
		Uin:            300000000001,
		OwnerUin:       300000000001,
		AppID:          1000000001,
		SaaSToken:      "saas-token",
		ClientIP:       "127.0.0.1",
		ClientUA:       "billing-test",
	})
	if err != nil {
		t.Fatalf("create order: %v", err)
	}
	if !sawDianshi || !sawBilling {
		t.Fatalf("expected both remote endpoints to be called, sawDianshi=%v sawBilling=%v", sawDianshi, sawBilling)
	}
	if result.BigDealID != "bigdeal-1" || result.DealName != "deal-1" || result.InstanceID != "ins-1" {
		t.Fatalf("unexpected billing result=%+v", result)
	}
}

func TestHTTPProvider_ReusesPaidPendingOrderWithoutRemoteCalls(t *testing.T) {
	store := newBillingSQLiteStore(t)
	if err := store.SavePendingFreeTrialOrder(context.Background(), storage.PendingFreeTrialOrder{
		OwnerUin:   300000000002,
		UserID:     "usr_00000000-0000-4000-8000-000000000302",
		AppID:      1000000002,
		BigDealID:  "bigdeal-paid",
		DealName:   "deal-paid",
		InstanceID: "ins-paid",
		Status:     storage.PendingFreeTrialOrderStatusPaid,
		CreatedAt:  time.Now().UTC(),
		UpdatedAt:  time.Now().UTC(),
	}); err != nil {
		t.Fatalf("save pending order: %v", err)
	}

	dianshiCalled := false
	dianshiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dianshiCalled = true
		t.Fatalf("dianshi should not be called when paid checkpoint exists")
	}))
	defer dianshiServer.Close()

	billingCalled := false
	billingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		billingCalled = true
		t.Fatalf("billing should not be called when paid checkpoint exists")
	}))
	defer billingServer.Close()

	provider, err := billing.NewHTTPProvider(billing.HTTPOptions{
		Platform:            "shadow_test",
		DianshiEndpoint:     dianshiServer.URL,
		BillingEndpoint:     billingServer.URL,
		FreeTrialActivityID: "15152",
		FreeTrialActID:      "134393",
		SubProductCode:      "sp_tced_saas",
		RequestTimeout:      time.Second,
	}, store)
	if err != nil {
		t.Fatalf("new http provider: %v", err)
	}

	result, err := provider.CreateFreeTrialOrderAndPay(context.Background(), billing.FreeTrialOrderInput{
		UserID:         "usr_00000000-0000-4000-8000-000000000302",
		ShadowUserName: "usr_00000000-0000-4000-8000-000000000302",
		CountryCode:    "+86",
		PhoneNumber:    "13800000041",
		Uin:            300000000002,
		OwnerUin:       300000000002,
		AppID:          1000000002,
		SaaSToken:      "saas-token",
		ClientIP:       "127.0.0.1",
		ClientUA:       "billing-test",
	})
	if err != nil {
		t.Fatalf("reuse paid order: %v", err)
	}
	if dianshiCalled || billingCalled {
		t.Fatalf("unexpected remote calls: dianshi=%v billing=%v", dianshiCalled, billingCalled)
	}
	if result.InstanceID != "ins-paid" || result.BigDealID != "bigdeal-paid" {
		t.Fatalf("unexpected reused result=%+v", result)
	}
}

func TestHTTPProvider_RecoversAfterAlreadyPaidWhenPendingOrderIsStillOrdered(t *testing.T) {
	store := newBillingSQLiteStore(t)
	if err := store.SavePendingFreeTrialOrder(context.Background(), storage.PendingFreeTrialOrder{
		OwnerUin:  300000000003,
		UserID:    "usr_00000000-0000-4000-8000-000000000303",
		AppID:     1000000003,
		BigDealID: "bigdeal-ordered",
		Status:    storage.PendingFreeTrialOrderStatusOrdered,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("save pending order: %v", err)
	}

	dianshiCalled := false
	dianshiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dianshiCalled = true
		t.Fatalf("dianshi should not be called when pending order exists")
	}))
	defer dianshiServer.Close()

	billingCalled := false
	billingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		billingCalled = true
		_ = json.NewEncoder(w).Encode(map[string]any{
			"returnCode":    100102,
			"returnMessage": "already paid",
			"data":          map[string]any{},
		})
	}))
	defer billingServer.Close()

	recoveryCalled := false
	recoveryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recoveryCalled = true
		var payload struct {
			BigDealID string `json:"big_deal_id"`
			OwnerUin  int64  `json:"owner_uin"`
			AppID     int64  `json:"app_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode recovery payload: %v", err)
		}
		if payload.BigDealID != "bigdeal-ordered" || payload.OwnerUin != 300000000003 || payload.AppID != 1000000003 {
			t.Fatalf("unexpected recovery payload=%+v", payload)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"deal_name":   "deal-recovered",
			"instance_id": "ins-recovered",
		})
	}))
	defer recoveryServer.Close()

	provider, err := billing.NewHTTPProvider(billing.HTTPOptions{
		Platform:            "shadow_test",
		DianshiEndpoint:     dianshiServer.URL,
		BillingEndpoint:     billingServer.URL,
		RecoveryEndpoint:    recoveryServer.URL,
		FreeTrialActivityID: "15152",
		FreeTrialActID:      "134393",
		SubProductCode:      "sp_tced_saas",
		RequestTimeout:      time.Second,
	}, store)
	if err != nil {
		t.Fatalf("new http provider: %v", err)
	}

	result, err := provider.CreateFreeTrialOrderAndPay(context.Background(), billing.FreeTrialOrderInput{
		UserID:         "usr_00000000-0000-4000-8000-000000000303",
		ShadowUserName: "usr_00000000-0000-4000-8000-000000000303",
		CountryCode:    "+86",
		PhoneNumber:    "13800000042",
		Uin:            300000000003,
		OwnerUin:       300000000003,
		AppID:          1000000003,
		SaaSToken:      "saas-token",
		ClientIP:       "127.0.0.1",
		ClientUA:       "billing-test",
	})
	if err != nil {
		t.Fatalf("recover ordered paid order: %v", err)
	}
	if dianshiCalled || !billingCalled || !recoveryCalled {
		t.Fatalf("unexpected remote calls: dianshi=%v billing=%v recovery=%v", dianshiCalled, billingCalled, recoveryCalled)
	}
	if result.DealName != "deal-recovered" || result.InstanceID != "ins-recovered" {
		t.Fatalf("unexpected recovery result=%+v", result)
	}

	pending, err := store.GetPendingFreeTrialOrderByOwnerUin(context.Background(), 300000000003)
	if err != nil {
		t.Fatalf("get pending order: %v", err)
	}
	if pending.Status != storage.PendingFreeTrialOrderStatusPaid || pending.InstanceID != "ins-recovered" {
		t.Fatalf("pending order not updated after recovery: %+v", pending)
	}
}

func newBillingSQLiteStore(t *testing.T) storage.Store {
	t.Helper()
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new sqlite store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})
	return store
}
