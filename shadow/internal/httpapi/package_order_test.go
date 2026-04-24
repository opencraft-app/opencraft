package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"shadow/internal/billing"
	"shadow/internal/billingapi"
	"shadow/internal/httpapi"
	"shadow/internal/platform"
	"shadow/internal/shadow"
	"shadow/internal/storage"
	storagesqlite "shadow/internal/storage/sqlite"
	"shadow/internal/trade"
	"shadow/internal/wallet"
)

const packageOrderTestUserID = "usr_pkg_order_test_user"

type fakeBillingAPIClient struct{}
type recordingAuthCloudProvider struct {
	authenticateCalls int
	lastAuthInput     platform.AuthenticateUserInput
}

func (f *fakeBillingAPIClient) CreateOrders(context.Context, billingapi.CreateOrdersRequest) (billingapi.CreateOrdersResponse, error) {
	return billingapi.CreateOrdersResponse{
		OrderIds:   []string{"202604050001"},
		BigOrderId: "202604050000",
		RequestId:  "req-create-orders",
	}, nil
}

func (f *fakeBillingAPIClient) CreatePayURL(context.Context, billingapi.CreatePayURLRequest) (billingapi.CreatePayURLResponse, error) {
	return billingapi.CreatePayURLResponse{
		Url:        "https://pay.example.com/order/202604050001",
		NeedCharge: 1,
		RequestId:  "req-create-pay-url",
	}, nil
}

func (f *fakeBillingAPIClient) DescribeDealsByCond(context.Context, billingapi.DescribeDealsByCondRequest) (billingapi.DescribeDealsByCondResponse, error) {
	return billingapi.DescribeDealsByCondResponse{
		Deals: []billingapi.Deal{{
			OrderID:   "202604050001",
			BigDealID: "202604050000",
			Status:    2,
		}},
		TotalCount: 1,
		RequestID:  "req-describe-deals",
	}, nil
}

func (p *recordingAuthCloudProvider) SendRegisterSMS(context.Context, platform.SendRegisterSMSInput) error {
	return nil
}

func (p *recordingAuthCloudProvider) RegisterShadowAccount(context.Context, platform.RegisterShadowAccountInput) (platform.RegisterShadowAccountResult, error) {
	return platform.RegisterShadowAccountResult{}, nil
}

func (p *recordingAuthCloudProvider) GetAppIDByUin(context.Context, int64) (int64, error) {
	return 0, nil
}

func (p *recordingAuthCloudProvider) GetSaaSTokenByAuthCode(context.Context, string, string, string) (platform.SaaSTokenResult, error) {
	return platform.SaaSTokenResult{}, nil
}

func (p *recordingAuthCloudProvider) GetSaaSAccessToken(context.Context, platform.SaaSTokenResult, string, string) (platform.TemporaryCredentials, error) {
	return platform.TemporaryCredentials{}, nil
}

func (p *recordingAuthCloudProvider) SaveBasicAuth(context.Context, platform.SaveBasicAuthInput) error {
	return nil
}

func (p *recordingAuthCloudProvider) AuthenticateUser(_ context.Context, in platform.AuthenticateUserInput) error {
	p.authenticateCalls++
	p.lastAuthInput = in
	return nil
}

func (p *recordingAuthCloudProvider) DescribeBasicAuth(context.Context) (platform.DescribeBasicAuthResult, error) {
	return platform.DescribeBasicAuthResult{
		AccountOwnerUin: p.lastAuthInput.AuthUin,
		AccountType:     p.lastAuthInput.Type,
		Name:            p.lastAuthInput.Name,
	}, nil
}

func (p *recordingAuthCloudProvider) UpdatePhone(context.Context, platform.UpdatePhoneInput) error {
	return nil
}

func TestPackageOrderFlow_CreateConfirmAndWalletQuery(t *testing.T) {
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new sqlite store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})

	user, _, err := store.EnsureUser(context.Background(), packageOrderTestUserID, "+86", "13800000200")
	if err != nil {
		t.Fatalf("ensure user: %v", err)
	}
	if err := store.SaveBinding(context.Background(), storage.Binding{
		UserID:         user.ID,
		ShadowUserName: user.ID,
		Uin:            300000000200,
		OwnerUin:       300000000200,
		AppID:          1000000200,
		InstanceID:     "ins-test",
		CountryCode:    "+86",
		PhoneNumber:    "13800000200",
		CreatedAt:      time.Now().UTC(),
	}); err != nil {
		t.Fatalf("save binding: %v", err)
	}
	if err := store.UpsertPackageProduct(context.Background(), storage.PackageProduct{
		Code:                   "balance_basic",
		DisplayName:            "Balance Basic",
		CreditAmount:           1000,
		Currency:               "CNY",
		BillingGoodsCategoryID: 101444,
		BillingRegion:          "ap-guangzhou",
		BillingZone:            "ap-guangzhou-1",
		BillingPayMode:         "1",
		BillingGoodsDetailJSON: `{"productCode":"p_balance","subProductCode":"sp_balance","pid":10001,"timeUnit":"m","timeSpan":1,"action":"purchase"}`,
		Enabled:                true,
	}); err != nil {
		t.Fatalf("upsert package product: %v", err)
	}

	shadowSvc := shadow.NewService(store, platform.NewFakeCloudProvider(), billing.NewFakeProvider(), 10*time.Minute, "shadow_test")
	walletSvc := wallet.NewService(store)
	tradeSvc := trade.NewService(store, &fakeBillingAPIClient{}, walletSvc)
	handler := httpapi.NewWithOptions(shadowSvc, httpapi.Options{
		TradeService:        tradeSvc,
		WalletService:       walletSvc,
		PaymentConfirmToken: "confirm-secret",
	}).Handler()

	createReq := httptest.NewRequest(http.MethodPost, "/v1/shadow/package-orders", bytes.NewReader([]byte(`{
		"user_id":"`+packageOrderTestUserID+`",
		"package_code":"balance_basic",
		"platform":"mobile"
	}`)))
	createReq.Header.Set("Content-Type", "application/json")
	createRes := httptest.NewRecorder()
	handler.ServeHTTP(createRes, createReq)
	if createRes.Code != http.StatusOK {
		t.Fatalf("create package order status=%d body=%s", createRes.Code, createRes.Body.String())
	}

	var order storage.PackageOrder
	if err := json.NewDecoder(createRes.Body).Decode(&order); err != nil {
		t.Fatalf("decode create order: %v", err)
	}
	if order.ID == "" || order.PayURL == "" || order.BillingBigOrderID == "" {
		t.Fatalf("unexpected created order=%+v", order)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/v1/shadow/package-orders/"+order.ID, nil)
	getRes := httptest.NewRecorder()
	handler.ServeHTTP(getRes, getReq)
	if getRes.Code != http.StatusOK {
		t.Fatalf("get package order status=%d body=%s", getRes.Code, getRes.Body.String())
	}

	confirmReq := httptest.NewRequest(http.MethodPost, "/internal/shadow/package-orders/"+order.ID+"/confirm?token=confirm-secret", nil)
	confirmRes := httptest.NewRecorder()
	handler.ServeHTTP(confirmRes, confirmReq)
	if confirmRes.Code != http.StatusOK {
		t.Fatalf("confirm package order status=%d body=%s", confirmRes.Code, confirmRes.Body.String())
	}

	var confirmPayload struct {
		Order  storage.PackageOrder  `json:"order"`
		Wallet storage.WalletAccount `json:"wallet"`
	}
	if err := json.NewDecoder(confirmRes.Body).Decode(&confirmPayload); err != nil {
		t.Fatalf("decode confirm order: %v", err)
	}
	if confirmPayload.Order.Status != storage.PackageOrderStatusCreditApplied {
		t.Fatalf("unexpected confirmed order status=%s", confirmPayload.Order.Status)
	}
	if confirmPayload.Wallet.AvailableAmount != 1000 {
		t.Fatalf("unexpected wallet amount=%d", confirmPayload.Wallet.AvailableAmount)
	}

	walletReq := httptest.NewRequest(http.MethodGet, "/v1/shadow/wallet?user_id="+packageOrderTestUserID, nil)
	walletRes := httptest.NewRecorder()
	handler.ServeHTTP(walletRes, walletReq)
	if walletRes.Code != http.StatusOK {
		t.Fatalf("get wallet status=%d body=%s", walletRes.Code, walletRes.Body.String())
	}
}

func TestPackageOrderFlow_RequiresStandardRealnameWhenConfigured(t *testing.T) {
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new sqlite store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})

	user, _, err := store.EnsureUser(context.Background(), packageOrderTestUserID, "+86", "13800000201")
	if err != nil {
		t.Fatalf("ensure user: %v", err)
	}
	if err := store.SaveBinding(context.Background(), storage.Binding{
		UserID:         user.ID,
		ShadowUserName: user.ID,
		Uin:            300000000201,
		OwnerUin:       300000000201,
		AppID:          1000000201,
		InstanceID:     "ins-test",
		CountryCode:    "+86",
		PhoneNumber:    "13800000201",
		CreatedAt:      time.Now().UTC(),
	}); err != nil {
		t.Fatalf("save binding: %v", err)
	}
	if err := store.UpsertPackageProduct(context.Background(), storage.PackageProduct{
		Code:                     "balance_realname",
		DisplayName:              "Balance Need Realname",
		CreditAmount:             1000,
		Currency:                 "CNY",
		BillingGoodsCategoryID:   101444,
		BillingRegion:            "ap-guangzhou",
		BillingZone:              "ap-guangzhou-1",
		BillingPayMode:           "1",
		ProductCode:              "p_orcaterm",
		SubProductCode:           "sp_orcaterm_pro",
		BillingItemTypeCode:      "v_orcaterm_pro",
		BillingItemCode:          "sv_orcaterm_pro_normal",
		BillingPID:               10001,
		BillingTimeUnit:          "m",
		BillingTimeSpan:          1,
		BillingAction:            "purchase",
		RequiresStandardRealname: true,
		Enabled:                  true,
	}); err != nil {
		t.Fatalf("upsert package product: %v", err)
	}

	shadowSvc := shadow.NewService(store, platform.NewFakeCloudProvider(), billing.NewFakeProvider(), 10*time.Minute, "shadow_test")
	walletSvc := wallet.NewService(store)
	tradeSvc := trade.NewService(store, &fakeBillingAPIClient{}, walletSvc)
	handler := httpapi.NewWithOptions(shadowSvc, httpapi.Options{
		TradeService:  tradeSvc,
		WalletService: walletSvc,
	}).Handler()

	createReq := httptest.NewRequest(http.MethodPost, "/v1/shadow/package-orders", bytes.NewReader([]byte(`{
		"user_id":"`+packageOrderTestUserID+`",
		"package_code":"balance_realname",
		"platform":"mobile"
	}`)))
	createReq.Header.Set("Content-Type", "application/json")
	createRes := httptest.NewRecorder()
	handler.ServeHTTP(createRes, createReq)
	if createRes.Code != http.StatusBadGateway {
		t.Fatalf("expected bad gateway before realname, got status=%d body=%s", createRes.Code, createRes.Body.String())
	}
	if !bytes.Contains(createRes.Body.Bytes(), []byte("standard realname authentication is required")) {
		t.Fatalf("unexpected create body=%s", createRes.Body.String())
	}
}

func TestAuthenticateUserFlow_AllowsRealnameProtectedPackageOrder(t *testing.T) {
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new sqlite store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})

	cloud := &recordingAuthCloudProvider{}
	user, _, err := store.EnsureUser(context.Background(), packageOrderTestUserID, "+86", "13800000202")
	if err != nil {
		t.Fatalf("ensure user: %v", err)
	}
	if err := store.SaveBinding(context.Background(), storage.Binding{
		UserID:         user.ID,
		ShadowUserName: user.ID,
		Uin:            300000000202,
		OwnerUin:       300000000202,
		AppID:          1000000202,
		InstanceID:     "ins-test",
		CountryCode:    "+86",
		PhoneNumber:    "13800000202",
		CreatedAt:      time.Now().UTC(),
	}); err != nil {
		t.Fatalf("save binding: %v", err)
	}
	if err := store.UpsertPackageProduct(context.Background(), storage.PackageProduct{
		Code:                     "balance_realname_ok",
		DisplayName:              "Balance Need Realname",
		CreditAmount:             1000,
		Currency:                 "CNY",
		BillingGoodsCategoryID:   101444,
		BillingRegion:            "ap-guangzhou",
		BillingZone:              "ap-guangzhou-1",
		BillingPayMode:           "1",
		ProductCode:              "p_orcaterm",
		SubProductCode:           "sp_orcaterm_pro",
		BillingItemTypeCode:      "v_orcaterm_pro",
		BillingItemCode:          "sv_orcaterm_pro_normal",
		BillingPID:               10001,
		BillingTimeUnit:          "m",
		BillingTimeSpan:          1,
		BillingAction:            "purchase",
		RequiresStandardRealname: true,
		Enabled:                  true,
	}); err != nil {
		t.Fatalf("upsert package product: %v", err)
	}

	shadowSvc := shadow.NewService(store, cloud, billing.NewFakeProvider(), 10*time.Minute, "shadow_test")
	walletSvc := wallet.NewService(store)
	tradeSvc := trade.NewService(store, &fakeBillingAPIClient{}, walletSvc)
	handler := httpapi.NewWithOptions(shadowSvc, httpapi.Options{
		TradeService:  tradeSvc,
		WalletService: walletSvc,
	}).Handler()

	authReq := httptest.NewRequest(http.MethodPost, "/v1/shadow/realname/authenticate", bytes.NewReader([]byte(`{
		"user_id":"`+packageOrderTestUserID+`",
		"name":"深圳腾讯科技有限公司",
		"type":1,
		"area":0,
		"checker":"ess",
		"check_type":"OCR",
		"idcard_type":2,
		"idcard":"91440300192185379H",
		"contact":"小马哥",
		"province":"广东",
		"city":"深圳",
		"district":"南山区"
	}`)))
	authReq.Header.Set("Content-Type", "application/json")
	authRes := httptest.NewRecorder()
	handler.ServeHTTP(authRes, authReq)
	if authRes.Code != http.StatusNoContent {
		t.Fatalf("authenticate status=%d body=%s", authRes.Code, authRes.Body.String())
	}
	if cloud.authenticateCalls != 1 || cloud.lastAuthInput.AuthUin != 300000000202 {
		t.Fatalf("unexpected authenticate call=%d input=%+v", cloud.authenticateCalls, cloud.lastAuthInput)
	}

	createReq := httptest.NewRequest(http.MethodPost, "/v1/shadow/package-orders", bytes.NewReader([]byte(`{
		"user_id":"`+packageOrderTestUserID+`",
		"package_code":"balance_realname_ok",
		"platform":"mobile"
	}`)))
	createReq.Header.Set("Content-Type", "application/json")
	createRes := httptest.NewRecorder()
	handler.ServeHTTP(createRes, createReq)
	if createRes.Code != http.StatusOK {
		t.Fatalf("create after authenticate status=%d body=%s", createRes.Code, createRes.Body.String())
	}
}
