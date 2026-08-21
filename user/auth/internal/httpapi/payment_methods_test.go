package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/paymentmethod"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

type paymentMethodHTTPShadowClient struct {
	httpTestShadowClient
}

func (*paymentMethodHTTPShadowClient) GetTemporaryCredentialsForSaaS(context.Context, shadowbinding.CloudTemporaryCredentialsInput) (shadowbinding.CloudTemporaryCredentials, error) {
	return shadowbinding.CloudTemporaryCredentials{
		Uin:          300000000053,
		OwnerUin:     300000000053,
		TmpSecretID:  "tmp-id",
		TmpSecretKey: "tmp-key",
		Token:        "tmp-token",
		ExpiredTime:  fixedHTTPTestNow().Add(time.Hour),
	}, nil
}

type paymentMethodHTTPClient struct {
	listResult  paymentmethod.ListResult
	createInput paymentmethod.CreateSignOrderInput
	createCalls int
	deleteErr   error
}

func (c *paymentMethodHTTPClient) List(context.Context, paymentmethod.TemporaryCredentials, paymentmethod.ListInput) (paymentmethod.ListResult, error) {
	return c.listResult, nil
}

func (c *paymentMethodHTTPClient) CreateSignOrder(_ context.Context, _ paymentmethod.TemporaryCredentials, input paymentmethod.CreateSignOrderInput) (paymentmethod.CreateSignOrderResult, error) {
	c.createInput = input
	c.createCalls++
	return paymentmethod.CreateSignOrderResult{
		ContractCode: "contract-2",
		RedirectURL:  "https://sandbox-card.example/sign?token=opaque",
	}, nil
}

func (*paymentMethodHTTPClient) SetDefault(context.Context, paymentmethod.TemporaryCredentials, string) error {
	return nil
}

func (c *paymentMethodHTTPClient) Delete(context.Context, paymentmethod.TemporaryCredentials, string) error {
	return c.deleteErr
}

func TestPaymentMethodRoutesRequireSession(t *testing.T) {
	t.Parallel()

	router, _, _ := newPaymentMethodHTTPTestRouter(&paymentMethodHTTPClient{})
	recorder := performJSONRequest(t, router, http.MethodGet, "/auth/payment-methods", nil)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestListPaymentMethodsReturnsFrontendContract(t *testing.T) {
	t.Parallel()

	client := &paymentMethodHTTPClient{listResult: paymentmethod.ListResult{
		Total: 1,
		Items: []paymentmethod.PaymentMethod{{
			ContractCode: "contract-1",
			MaskedNumber: "555555****4444",
			PayerName:    "Jane Doe",
			Type:         "CREDIT_CARD",
			IsDefault:    true,
		}},
	}}
	router, service, _ := newPaymentMethodHTTPTestRouter(client)
	sessionCookie, _ := completePhone3FAHTTPFlow(t, router, service)

	recorder := performJSONRequest(t, router, http.MethodGet, "/auth/payment-methods?page=1&pageSize=20", nil, sessionCookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	body := recorder.Body.String()
	for _, want := range []string{
		`"total":1`,
		`"contractCode":"contract-1"`,
		`"maskedNumber":"555555****4444"`,
		`"payerName":"Jane Doe"`,
		`"type":"CREDIT_CARD"`,
		`"isDefault":true`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("response missing %s: %s", want, body)
		}
	}
}

func TestInternalPaymentContextRequiresTokenAndReturnsBindingStateAndCredentials(t *testing.T) {
	t.Parallel()

	client := &paymentMethodHTTPClient{listResult: paymentmethod.ListResult{
		Total: 1,
		Items: []paymentmethod.PaymentMethod{{ContractCode: "contract-1"}},
	}}
	router, authService, _ := newPaymentMethodHTTPTestRouter(client)
	_, userID := completePhone3FAHTTPFlow(t, router, authService)
	path := "/internal/payment-methods/context"
	body := map[string]any{"external_user_id": userID, "client_ua": "lightvela-trade"}

	unauthorized := performJSONRequest(t, router, http.MethodPost, path, body)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", unauthorized.Code, unauthorized.Body.String())
	}

	req := newJSONRequest(t, http.MethodPost, path, body)
	req.Header.Set("Authorization", "Bearer shadow-internal-token")
	response := performRequest(router, req)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	for _, want := range []string{
		`"has_payment_method":true`,
		`"uin":300000000053`,
		`"tmp_secret_id":"tmp-id"`,
		`"token":"tmp-token"`,
	} {
		if !strings.Contains(response.Body.String(), want) {
			t.Fatalf("response missing %s: %s", want, response.Body.String())
		}
	}
}

func TestCreatePaymentMethodSignOrderUsesServerCallbacks(t *testing.T) {
	t.Parallel()

	client := &paymentMethodHTTPClient{}
	router, service, _ := newPaymentMethodHTTPTestRouter(client)
	sessionCookie, _ := completePhone3FAHTTPFlow(t, router, service)

	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/payment-methods/sign-orders", map[string]any{
		"languageCode": "en",
	}, sessionCookie)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if client.createInput.ReturnURL != "https://lightvela.ai/account/?payment-method=success" {
		t.Fatalf("ReturnURL = %q", client.createInput.ReturnURL)
	}
	if client.createInput.CancelURL != "https://lightvela.ai/account/?payment-method=cancelled" {
		t.Fatalf("CancelURL = %q", client.createInput.CancelURL)
	}
	if body := recorder.Body.String(); !strings.Contains(body, `"contractCode":"contract-2"`) || !strings.Contains(body, `"redirectUrl":"https://sandbox-card.example/sign?token=opaque"`) {
		t.Fatalf("unexpected response: %s", body)
	}
}

func TestCreatePaymentMethodSignOrderRequiresJSONBody(t *testing.T) {
	t.Parallel()

	client := &paymentMethodHTTPClient{}
	router, service, _ := newPaymentMethodHTTPTestRouter(client)
	sessionCookie, _ := completePhone3FAHTTPFlow(t, router, service)

	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/payment-methods/sign-orders", nil, sessionCookie)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestCreatePaymentMethodSignOrderReturnsRateLimit(t *testing.T) {
	t.Parallel()

	client := &paymentMethodHTTPClient{}
	router, service, _ := newPaymentMethodHTTPTestRouter(client)
	sessionCookie, _ := completePhone3FAHTTPFlow(t, router, service)
	for attempt := 1; attempt <= 5; attempt++ {
		recorder := performJSONRequest(t, router, http.MethodPost, "/auth/payment-methods/sign-orders", map[string]any{}, sessionCookie)
		if recorder.Code != http.StatusOK {
			t.Fatalf("attempt %d: expected 200, got %d: %s", attempt, recorder.Code, recorder.Body.String())
		}
	}
	recorder := performJSONRequest(t, router, http.MethodPost, "/auth/payment-methods/sign-orders", map[string]any{}, sessionCookie)
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"payment_method_rate_limited"`) {
		t.Fatalf("unexpected response: %s", recorder.Body.String())
	}
	if client.createCalls != 5 {
		t.Fatalf("provider calls = %d, want 5", client.createCalls)
	}
}

func TestDeleteDefaultPaymentMethodReturnsConflict(t *testing.T) {
	t.Parallel()

	client := &paymentMethodHTTPClient{
		deleteErr: &paymentmethod.CloudError{Code: "FailedOperation.DefaultCardNoDelete", Message: "default card cannot be deleted"},
	}
	router, service, _ := newPaymentMethodHTTPTestRouter(client)
	sessionCookie, _ := completePhone3FAHTTPFlow(t, router, service)

	recorder := performJSONRequest(t, router, http.MethodDelete, "/auth/payment-methods/contract-default", nil, sessionCookie)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"default_payment_method_cannot_delete"`) {
		t.Fatalf("unexpected response: %s", recorder.Body.String())
	}
}

func newPaymentMethodHTTPTestRouter(client paymentmethod.Client) (*gin.Engine, *service.Service, *shadowbinding.Service) {
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{Now: fixedHTTPTestNow, SeedDefaultInvites: true})
	shadowService := shadowbinding.New(shadowbinding.NewMemoryStore(), &paymentMethodHTTPShadowClient{}, shadowbinding.Options{
		Enabled: true,
		Now:     fixedHTTPTestNow,
	})
	authService := service.NewWithStore(store, service.Options{
		Now:                        fixedHTTPTestNow,
		SessionTTL:                 30 * 24 * time.Hour,
		SiteKind:                   shadowbinding.SiteKindIntl,
		RealnameVerifier:           httpStubRealnameVerifier{},
		RealnameCipher:             httpStubRealnameCipher{},
		ShadowBinding:              shadowService,
		ShadowBasicAuthSyncEnabled: true,
		PaymentMethods:             client,
	})
	router := NewRouter(authService, ServerConfig{
		CookieSecure:               true,
		CookieSameSite:             http.SameSiteNoneMode,
		SessionTTL:                 30 * 24 * time.Hour,
		PublicBaseURL:              "https://api.lightvela.ai",
		FrontendBaseURL:            "https://lightvela.ai",
		ShadowBindingInternalToken: "shadow-internal-token",
	})
	return router, authService, shadowService
}
