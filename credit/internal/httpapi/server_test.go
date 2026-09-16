package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/credit/internal/authcode"
	"git.woa.com/wisp/mono/credit/internal/service"
	"git.woa.com/wisp/mono/credit/internal/store"
	"git.woa.com/wisp/mono/credit/internal/tradeclient"
)

type httpFakeStore struct {
	packages      map[string]*store.CreditPackage
	products      map[string]*store.CreditProduct
	archiveReason map[string]string
}

func newHTTPFakeStore() *httpFakeStore {
	return &httpFakeStore{
		packages:      map[string]*store.CreditPackage{},
		products:      map[string]*store.CreditProduct{},
		archiveReason: map[string]string{},
	}
}

func (s *httpFakeStore) GetProductByID(_ context.Context, productID string) (*store.CreditProduct, error) {
	product := s.products[productID]
	if product == nil {
		return nil, store.ErrProductNotFound
	}
	cp := *product
	return &cp, nil
}

func (s *httpFakeStore) ListOnlineProducts(context.Context) ([]store.CreditProduct, error) {
	return nil, nil
}

func (s *httpFakeStore) ListPackageAppIDs(context.Context, []string, int, int) ([]int64, int64, error) {
	return []int64{1300000001}, 1, nil
}

func (s *httpFakeStore) ListPackagesByOwner(_ context.Context, uin string, appID int64, _ []string, _, _ int) ([]*store.CreditPackage, int64, error) {
	items := make([]*store.CreditPackage, 0)
	for _, pkg := range s.packages {
		if pkg.Uin == uin && pkg.AppID == appID {
			cp := *pkg
			items = append(items, &cp)
		}
	}
	return items, int64(len(items)), nil
}

func (s *httpFakeStore) CreatePackageWithUsage(_ context.Context, pkg *store.CreditPackage, _ *store.CreditPackageUsage) error {
	cp := *pkg
	s.packages[pkg.PackageID] = &cp
	return nil
}

func (s *httpFakeStore) GetPackageByID(_ context.Context, packageID string) (*store.CreditPackage, error) {
	pkg := s.packages[packageID]
	if pkg == nil {
		return nil, store.ErrPackageNotFound
	}
	cp := *pkg
	return &cp, nil
}

func (s *httpFakeStore) GetPackageByDealName(_ context.Context, dealName string) (*store.CreditPackage, error) {
	for _, pkg := range s.packages {
		if pkg.DealName == dealName {
			cp := *pkg
			return &cp, nil
		}
	}
	return nil, store.ErrPackageNotFound
}

func (s *httpFakeStore) GetPackageBySubscriptionName(context.Context, string) (*store.CreditPackage, error) {
	return nil, store.ErrPackageNotFound
}

func (s *httpFakeStore) MovePackageToHistory(_ context.Context, packageID string, _ time.Time, reason string, _ *time.Time) error {
	s.archiveReason[packageID] = reason
	delete(s.packages, packageID)
	return nil
}

type httpFakeLLMGateway struct {
	active       service.ActiveSubscriptionList
	listUserIDTo *string
}

type httpFakeTrade struct {
	orderRequest       tradeclient.OrderRequest
	orderResult        *tradeclient.OrderResult
	orderError         error
	orderAndPayRequest tradeclient.OrderRequest
	payURLDealName     string
	payURLRequest      tradeclient.PayURLRequest
	payURLError        error
}

func (f *httpFakeTrade) Inquiry(context.Context, tradeclient.InquiryRequest) (map[string]any, error) {
	return map[string]any{}, nil
}

func (f *httpFakeTrade) PlaceOrder(_ context.Context, req tradeclient.OrderRequest) (*tradeclient.OrderResult, error) {
	f.orderRequest = req
	if f.orderResult != nil || f.orderError != nil {
		return f.orderResult, f.orderError
	}
	return &tradeclient.OrderResult{BigOrderID: "big-1", DealName: "deal-1"}, nil
}

func (f *httpFakeTrade) PlaceOrderAndPay(_ context.Context, req tradeclient.OrderRequest) (map[string]any, error) {
	f.orderAndPayRequest = req
	return map[string]any{"deal_name": "deal-1", "big_order_id": "big-1"}, nil
}

func (f *httpFakeTrade) GeneratePayURL(_ context.Context, dealName string, req tradeclient.PayURLRequest) (*tradeclient.PayURLResult, error) {
	f.payURLDealName = dealName
	f.payURLRequest = req
	if f.payURLError != nil {
		return nil, f.payURLError
	}
	tokenID := "token-1"
	return &tradeclient.PayURLResult{
		PayURL:     "https://buy.cloud.tencent.com/credit",
		TokenID:    &tokenID,
		NeedCharge: 1,
	}, nil
}

func (f *httpFakeTrade) RefundPackage(context.Context, string, tradeclient.RefundRequest) (map[string]any, error) {
	return map[string]any{}, nil
}

type httpFakeAuthCodeStore struct {
	issueCode     string
	issueError    error
	issuedTicket  *authcode.Ticket
	consumeTicket *authcode.Ticket
	consumeError  error
	consumeCalls  int
	consumeCode   string
	consumeOnce   bool
}

func (f *httpFakeAuthCodeStore) Issue(_ context.Context, ticket *authcode.Ticket) (string, error) {
	if ticket != nil {
		copy := *ticket
		f.issuedTicket = &copy
	}
	return f.issueCode, f.issueError
}

func (f *httpFakeAuthCodeStore) Consume(_ context.Context, code string) (*authcode.Ticket, error) {
	f.consumeCalls++
	f.consumeCode = code
	if f.consumeOnce && f.consumeCalls > 1 {
		return nil, authcode.ErrTicketNotFound
	}
	return f.consumeTicket, f.consumeError
}

func (httpFakeLLMGateway) ApplySubscription(context.Context, service.ApplySubscriptionRequest) (service.Subscription, error) {
	return service.Subscription{}, nil
}

func (httpFakeLLMGateway) CancelSelectedSubscriptions(context.Context, service.CancelSelectedSubscriptionsRequest) error {
	return nil
}

func (g httpFakeLLMGateway) ListActiveSubscriptions(_ context.Context, userID string) (service.ActiveSubscriptionList, error) {
	if g.listUserIDTo != nil {
		*g.listUserIDTo = userID
	}
	return g.active, nil
}

func TestInternalUsedAmountReturnsDecimalRatio(t *testing.T) {
	st := newHTTPFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID: "cpkg-test001", UserID: "usr_1", ProductID: "credit_100", DealName: "deal-1",
		Uin: "700000164995", AppID: 1300000001, LLMSubscriptionName: "credit-package:cpkg-test001",
		ExpiredTime: time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC), Status: store.PackageStatusActive,
	}
	now := time.Date(2026, 8, 3, 2, 0, 0, 0, time.UTC)
	router := NewRouter(service.New(st, httpFakeLLMGateway{active: service.ActiveSubscriptionList{Subscriptions: []service.Subscription{{
		Name: "credit-package:cpkg-test001", TokenTotal: 10000, TokenBalance: 7644,
	}}}}, service.Options{
		Now: func() time.Time { return now },
	}), st, nil, nil, "internal-token")
	body, _ := json.Marshal(map[string]any{
		"uin": "700000164995", "app_id": int64(1300000001), "resource_ids": []string{"cpkg-test001"},
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/credit/packages/used-amount", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer internal-token")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"used_ratio":0.2356`)) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestInternalQueryResourcesReturnsBillingView(t *testing.T) {
	st := newHTTPFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID: "cpkg-test001", ProductID: "credit_100", Uin: "700000164995", AppID: 1300000001,
		CreatedTime: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		ExpiredTime: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), Status: store.PackageStatusActive,
	}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{
		Now: func() time.Time { return time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC) },
	}), st, nil, nil, "internal-token")
	body, _ := json.Marshal(map[string]any{
		"uin": "700000164995", "app_id": int64(1300000001), "resource_ids": []string{"cpkg-test001"},
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/credit/packages/query-resources", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer internal-token")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !bytes.Contains(rec.Body.Bytes(), []byte(`"allow_return":true`)) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestInternalResourceCenterListRoutes(t *testing.T) {
	st := newHTTPFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID: "cpkg-test001", ProductID: "credit_100", Uin: "700000164995", AppID: 1300000001,
		ExpiredTime: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), Status: store.PackageStatusActive,
	}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, nil, nil, "internal-token")

	for _, tc := range []struct {
		path string
		body string
		want string
	}{
		{"/internal/credit/packages/app-ids", `{"product_ids":["credit_100"],"page_no":0,"page_size":20000}`, `"app_ids":[1300000001]`},
		{"/internal/credit/packages/by-owner", `{"uin":"700000164995","app_id":1300000001,"product_ids":["credit_100"],"page_no":0,"page_size":1000}`, `"package_id":"cpkg-test001"`},
	} {
		req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Authorization", "Bearer internal-token")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), tc.want) {
			t.Fatalf("path=%s status=%d body=%s", tc.path, rec.Code, rec.Body.String())
		}
	}
}

func TestInternalResetExpireRouteIsRemoved(t *testing.T) {
	st := newHTTPFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{PackageID: "cpkg-test001"}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, nil, nil, "internal-token")
	req := httptest.NewRequest(http.MethodPost, "/internal/credit/packages/cpkg-test001/reset-expire", bytes.NewBufferString(`{}`))
	req.Header.Set("Authorization", "Bearer internal-token")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserOrderAndPayRequiresTrustedUserHeader(t *testing.T) {
	st := newHTTPFakeStore()
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, nil, nil, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-and-pay", strings.NewReader(`{"product_id":"credit_100"}`))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserOrderIssuesAuthCode(t *testing.T) {
	st := newHTTPFakeStore()
	st.products["credit_1000"] = &store.CreditProduct{ProductID: "credit_1000", State: store.ProductStateOnline}
	trade := &httpFakeTrade{orderResult: &tradeclient.OrderResult{BigOrderID: "big-credit-1", DealName: "deal-credit-1"}}
	authCodes := &httpFakeAuthCodeStore{issueCode: "auth-code-1"}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, trade, authCodes, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order", strings.NewReader(`{
		"product_id":"credit_1000",
		"time_span":1,
		"time_unit":"m"
	}`))
	req.Header.Set("X-User-Id", "usr-trusted")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if trade.orderRequest.ExternalUserID != "usr-trusted" {
		t.Fatalf("order user = %q", trade.orderRequest.ExternalUserID)
	}
	if authCodes.issuedTicket == nil || authCodes.issuedTicket.UserID != "usr-trusted" || authCodes.issuedTicket.DealName != "deal-credit-1" {
		t.Fatalf("issued ticket = %+v", authCodes.issuedTicket)
	}
	if !strings.Contains(rec.Body.String(), `"bigOrderId":"big-credit-1"`) ||
		!strings.Contains(rec.Body.String(), `"dealName":"deal-credit-1"`) ||
		!strings.Contains(rec.Body.String(), `"auth_code":"auth-code-1"`) {
		t.Fatalf("body=%s", rec.Body.String())
	}
}

func TestUserOrderKeepsCreatedOrderWhenAuthCodeIssueFails(t *testing.T) {
	st := newHTTPFakeStore()
	st.products["credit_1000"] = &store.CreditProduct{ProductID: "credit_1000", State: store.ProductStateOnline}
	trade := &httpFakeTrade{orderResult: &tradeclient.OrderResult{BigOrderID: "big-credit-1", DealName: "deal-credit-1"}}
	authCodes := &httpFakeAuthCodeStore{issueError: errors.New("redis unavailable")}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, trade, authCodes, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order", strings.NewReader(`{"product_id":"credit_1000"}`))
	req.Header.Set("X-User-Id", "usr-trusted")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"auth_code":""`) {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserOrderRejectsEmptyTradeDeal(t *testing.T) {
	st := newHTTPFakeStore()
	st.products["credit_1000"] = &store.CreditProduct{ProductID: "credit_1000", State: store.ProductStateOnline}
	trade := &httpFakeTrade{orderResult: &tradeclient.OrderResult{BigOrderID: "big-credit-1"}}
	authCodes := &httpFakeAuthCodeStore{issueCode: "must-not-be-issued"}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, trade, authCodes, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order", strings.NewReader(`{"product_id":"credit_1000"}`))
	req.Header.Set("X-User-Id", "usr-trusted")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway || authCodes.issuedTicket != nil {
		t.Fatalf("status=%d ticket=%+v body=%s", rec.Code, authCodes.issuedTicket, rec.Body.String())
	}
}

func TestUserOrderAndPayUsesTrustedHeaderIdentity(t *testing.T) {
	st := newHTTPFakeStore()
	st.products["credit_100"] = &store.CreditProduct{ProductID: "credit_100", State: store.ProductStateOnline}
	trade := &httpFakeTrade{}
	router := NewRouter(
		service.New(st, httpFakeLLMGateway{}, service.Options{}),
		st,
		trade,
		nil,
		"",
	)
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-and-pay", strings.NewReader(`{
		"external_user_id":"usr_spoofed",
		"product_id":"credit_100",
		"time_span":1,
		"time_unit":"m"
	}`))
	req.Header.Set("X-User-Id", "usr_trusted")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if trade.orderAndPayRequest.ExternalUserID != "usr_trusted" {
		t.Fatalf("external_user_id=%q, want trusted header identity", trade.orderAndPayRequest.ExternalUserID)
	}
}

func TestUserOrderURLAuthCodePrecedesTrustedHeader(t *testing.T) {
	st := newHTTPFakeStore()
	trade := &httpFakeTrade{}
	authCodes := &httpFakeAuthCodeStore{
		consumeTicket: &authcode.Ticket{UserID: "usr-ticket-owner", DealName: "deal-credit-1"},
	}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, trade, authCodes, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-url", strings.NewReader(`{
		"deal_name":"deal-credit-1",
		"auth_code":"auth-code-1",
		"external_user_id":"usr_spoofed",
		"platform":"pc",
		"wx_open_id":"openid-1",
		"wx_app_id":"spoofed-app-id",
		"return_url":"https://lightvela.com/credit?paid=1"
	}`))
	req.Header.Set("X-User-Id", "usr-scanner")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if trade.payURLDealName != "deal-credit-1" || trade.payURLRequest.ExternalUserID != "usr-ticket-owner" {
		t.Fatalf("deal_name=%q request=%+v", trade.payURLDealName, trade.payURLRequest)
	}
	if authCodes.consumeCalls != 1 || authCodes.consumeCode != "auth-code-1" {
		t.Fatalf("consume calls=%d code=%q", authCodes.consumeCalls, authCodes.consumeCode)
	}
	if trade.payURLRequest.WxAppID != wechatPaymentAppID {
		t.Fatalf("wx_app_id=%q", trade.payURLRequest.WxAppID)
	}
	if !strings.Contains(rec.Body.String(), `"pay_url":"https://buy.cloud.tencent.com/credit"`) ||
		!strings.Contains(rec.Body.String(), `"need_charge":1`) {
		t.Fatalf("body=%s", rec.Body.String())
	}
}

func TestUserOrderURLUsesTrustedHeaderWithoutAuthCode(t *testing.T) {
	st := newHTTPFakeStore()
	trade := &httpFakeTrade{}
	authCodes := &httpFakeAuthCodeStore{consumeError: errors.New("must not consume")}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, trade, authCodes, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-url", strings.NewReader(`{
		"deal_name":"deal-credit-1",
		"platform":"pc"
	}`))
	req.Header.Set("X-User-Id", "usr_trusted")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if trade.payURLRequest.ExternalUserID != "usr_trusted" {
		t.Fatalf("pay URL user = %q", trade.payURLRequest.ExternalUserID)
	}
	if authCodes.consumeCalls != 0 {
		t.Fatalf("header fallback consumed ticket %d times", authCodes.consumeCalls)
	}
}

func TestUserOrderURLUsesAuthCodeWithoutTrustedHeader(t *testing.T) {
	st := newHTTPFakeStore()
	trade := &httpFakeTrade{}
	authCodes := &httpFakeAuthCodeStore{
		consumeTicket: &authcode.Ticket{UserID: "usr-ticket-owner", DealName: "deal-credit-1"},
	}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, trade, authCodes, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-url", strings.NewReader(`{
		"deal_name":"deal-credit-1",
		"auth_code":"auth-code-1",
		"platform":"pc"
	}`))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if authCodes.consumeCalls != 1 || authCodes.consumeCode != "auth-code-1" {
		t.Fatalf("consume calls=%d code=%q", authCodes.consumeCalls, authCodes.consumeCode)
	}
	if trade.payURLRequest.ExternalUserID != "usr-ticket-owner" {
		t.Fatalf("pay URL user = %q", trade.payURLRequest.ExternalUserID)
	}
}

func TestUserOrderURLRejectsMissingCredentials(t *testing.T) {
	st := newHTTPFakeStore()
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, &httpFakeTrade{}, &httpFakeAuthCodeStore{}, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-url", strings.NewReader(`{"deal_name":"deal-credit-1"}`))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserOrderURLRejectsInvalidOrReplayedAuthCode(t *testing.T) {
	st := newHTTPFakeStore()
	trade := &httpFakeTrade{}
	authCodes := &httpFakeAuthCodeStore{
		consumeTicket: &authcode.Ticket{UserID: "usr-ticket-owner", DealName: "deal-credit-1"},
		consumeOnce:   true,
	}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, trade, authCodes, "")
	body := `{"deal_name":"deal-credit-1","auth_code":"one-shot-code"}`

	first := httptest.NewRecorder()
	router.ServeHTTP(first, httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-url", strings.NewReader(body)))
	if first.Code != http.StatusOK {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	replayReq := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-url", strings.NewReader(body))
	replayReq.Header.Set("X-User-Id", "usr-scanner")
	second := httptest.NewRecorder()
	router.ServeHTTP(second, replayReq)
	if second.Code != http.StatusUnauthorized {
		t.Fatalf("replay status=%d body=%s", second.Code, second.Body.String())
	}
}

func TestUserOrderURLRejectsAuthCodeDealMismatch(t *testing.T) {
	st := newHTTPFakeStore()
	authCodes := &httpFakeAuthCodeStore{
		consumeTicket: &authcode.Ticket{UserID: "usr-ticket-owner", DealName: "deal-credit-other"},
	}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, &httpFakeTrade{}, authCodes, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-url", strings.NewReader(`{
		"deal_name":"deal-credit-1",
		"auth_code":"auth-code-1"
	}`))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserOrderURLHandlesAuthCodeStoreFailure(t *testing.T) {
	st := newHTTPFakeStore()
	authCodes := &httpFakeAuthCodeStore{consumeError: errors.New("redis unavailable")}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, &httpFakeTrade{}, authCodes, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-url", strings.NewReader(`{
		"deal_name":"deal-credit-1",
		"auth_code":"auth-code-1"
	}`))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "redis unavailable") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserOrderURLPreservesTradeNotFoundForAuthCodeOwner(t *testing.T) {
	st := newHTTPFakeStore()
	trade := &httpFakeTrade{payURLError: &tradeclient.Error{
		Status:  http.StatusNotFound,
		Code:    "OrderNotFound",
		Message: "order not found",
	}}
	authCodes := &httpFakeAuthCodeStore{
		consumeTicket: &authcode.Ticket{UserID: "usr-ticket-owner", DealName: "missing"},
	}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, trade, authCodes, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-url", strings.NewReader(`{
		"deal_name":"missing",
		"auth_code":"auth-code-1"
	}`))
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "order not found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserOrderURLPreservesTradeNotFound(t *testing.T) {
	st := newHTTPFakeStore()
	trade := &httpFakeTrade{payURLError: &tradeclient.Error{
		Status:  http.StatusNotFound,
		Code:    "OrderNotFound",
		Message: "order not found",
	}}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, trade, nil, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/order-url", strings.NewReader(`{"deal_name":"missing"}`))
	req.Header.Set("X-User-Id", "usr_trusted")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserCreditsRequiresTrustedUserHeader(t *testing.T) {
	st := newHTTPFakeStore()
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, &httpFakeTrade{}, nil, "")
	req := httptest.NewRequest(http.MethodGet, "/v1/credit/packages?user_id=usr_spoofed", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserCreditsUsesTrustedHeaderIdentity(t *testing.T) {
	st := newHTTPFakeStore()
	var gotUserID string
	router := NewRouter(service.New(st, httpFakeLLMGateway{listUserIDTo: &gotUserID}, service.Options{}), st, nil, nil, "")
	req := httptest.NewRequest(http.MethodGet, "/v1/credit/packages?user_id=usr_spoofed", nil)
	req.Header.Set("X-User-Id", "usr_trusted")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if gotUserID != "usr_trusted" {
		t.Fatalf("list user_id=%q, want trusted header identity", gotUserID)
	}
}

func TestUserRefundRejectsPackageOwnedByAnotherUser(t *testing.T) {
	st := newHTTPFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID: "cpkg-test001",
		UserID:    "usr_owner",
	}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, nil, nil, "")
	req := httptest.NewRequest(http.MethodPost, "/v1/credit/packages/cpkg-test001/refund", nil)
	req.Header.Set("X-User-Id", "usr_other")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestInternalIsolateArchivesImmediatelyWithBillingReason(t *testing.T) {
	st := newHTTPFakeStore()
	st.packages["cpkg-test001"] = &store.CreditPackage{
		PackageID: "cpkg-test001", UserID: "usr_1", LLMSubscriptionName: "credit-package:cpkg-test001",
		Status: store.PackageStatusActive,
	}
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, nil, nil, "")
	req := httptest.NewRequest(
		http.MethodPost,
		"/internal/credit/packages/cpkg-test001/isolate",
		strings.NewReader(`{"reason":"refund"}`),
	)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if st.packages["cpkg-test001"] != nil || st.archiveReason["cpkg-test001"] != "refund" {
		t.Fatalf("package=%+v archive reason=%q", st.packages["cpkg-test001"], st.archiveReason["cpkg-test001"])
	}
}

func TestInternalDestroyActionIsRemoved(t *testing.T) {
	st := newHTTPFakeStore()
	router := NewRouter(service.New(st, httpFakeLLMGateway{}, service.Options{}), st, nil, nil, "")
	req := httptest.NewRequest(http.MethodPost, "/internal/credit/packages/cpkg-test001/destroy", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
