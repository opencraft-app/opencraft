package service

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/paymentmethod"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

type paymentMethodShadowClient struct {
	stubShadowRegisterClient
	credentials shadowbinding.CloudTemporaryCredentials
}

func (c *paymentMethodShadowClient) GetTemporaryCredentialsForSaaS(context.Context, shadowbinding.CloudTemporaryCredentialsInput) (shadowbinding.CloudTemporaryCredentials, error) {
	return c.credentials, nil
}

type recordingPaymentMethodClient struct {
	listResult   paymentmethod.ListResult
	deleteErr    error
	lastList     paymentmethod.ListInput
	lastContract string
	credentials  paymentmethod.TemporaryCredentials
	createCalls  int
}

func (c *recordingPaymentMethodClient) List(_ context.Context, credentials paymentmethod.TemporaryCredentials, input paymentmethod.ListInput) (paymentmethod.ListResult, error) {
	c.credentials = credentials
	c.lastList = input
	return c.listResult, nil
}

func (c *recordingPaymentMethodClient) CreateSignOrder(context.Context, paymentmethod.TemporaryCredentials, paymentmethod.CreateSignOrderInput) (paymentmethod.CreateSignOrderResult, error) {
	c.createCalls++
	return paymentmethod.CreateSignOrderResult{}, nil
}

func (c *recordingPaymentMethodClient) SetDefault(_ context.Context, credentials paymentmethod.TemporaryCredentials, contractCode string) error {
	c.credentials = credentials
	c.lastContract = contractCode
	return nil
}

func (c *recordingPaymentMethodClient) Delete(_ context.Context, credentials paymentmethod.TemporaryCredentials, contractCode string) error {
	c.credentials = credentials
	c.lastContract = contractCode
	return c.deleteErr
}

func TestListPaymentMethodsUsesCurrentUsersShadowCredentials(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 14, 11, 0, 0, 0, time.UTC)
	cardClient := &recordingPaymentMethodClient{listResult: paymentmethod.ListResult{
		Total: 1,
		Items: []paymentmethod.PaymentMethod{{
			ContractCode: "contract-1",
			MaskedNumber: "555555****4444",
			IsDefault:    true,
		}},
	}}
	service, session := newPaymentMethodService(t, now, cardClient)

	result, err := service.ListPaymentMethods(context.Background(), session.Token, 2, 10, "192.0.2.1", "card-api-test")
	if err != nil {
		t.Fatalf("ListPaymentMethods: %v", err)
	}
	if result.Total != 1 || len(result.Items) != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if cardClient.lastList.Page != 2 || cardClient.lastList.PageSize != 10 {
		t.Fatalf("unexpected pagination: %+v", cardClient.lastList)
	}
	if cardClient.credentials.SecretID != "tmp-id" || cardClient.credentials.Token != "tmp-token" {
		t.Fatalf("unexpected credentials: %+v", cardClient.credentials)
	}
}

func TestDeletePaymentMethodMapsDefaultCardRestriction(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 14, 11, 0, 0, 0, time.UTC)
	cardClient := &recordingPaymentMethodClient{
		deleteErr: &paymentmethod.CloudError{Code: "FailedOperation.DefaultCardNoDelete", Message: "default card cannot be deleted"},
	}
	service, session := newPaymentMethodService(t, now, cardClient)

	err := service.DeletePaymentMethod(context.Background(), session.Token, "contract-default", "192.0.2.1", "card-api-test")
	var authErr *Error
	if !errors.As(err, &authErr) {
		t.Fatalf("expected service error, got %v", err)
	}
	if authErr.Code != "default_payment_method_cannot_delete" || authErr.Status != http.StatusConflict {
		t.Fatalf("unexpected error: %+v", authErr)
	}
}

func TestPaymentMethodsRequireInternationalSite(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 14, 11, 0, 0, 0, time.UTC)
	cardClient := &recordingPaymentMethodClient{}
	service, session := newPaymentMethodService(t, now, cardClient)
	service.siteKind = shadowbinding.SiteKindCN

	_, err := service.ListPaymentMethods(context.Background(), session.Token, 1, 20, "192.0.2.1", "card-api-test")
	var authErr *Error
	if !errors.As(err, &authErr) {
		t.Fatalf("expected service error, got %v", err)
	}
	if authErr.Code != "payment_methods_unavailable" || authErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("unexpected error: %+v", authErr)
	}
}

func TestCreatePaymentMethodSignOrderIsRateLimitedPerUser(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 14, 11, 0, 0, 0, time.UTC)
	cardClient := &recordingPaymentMethodClient{}
	service, session := newPaymentMethodService(t, now, cardClient)
	service.paymentMethodSignOrderLimit = 1
	service.paymentMethodSignOrderWindow = 10 * time.Minute
	input := paymentmethod.CreateSignOrderInput{
		ReturnURL:    "https://lightvela.ai/account/?payment-method=success",
		CancelURL:    "https://lightvela.ai/account/?payment-method=cancelled",
		LanguageCode: "en",
	}

	if _, err := service.CreatePaymentMethodSignOrder(context.Background(), session.Token, input, "192.0.2.1", "card-api-test"); err != nil {
		t.Fatalf("first CreatePaymentMethodSignOrder: %v", err)
	}
	_, err := service.CreatePaymentMethodSignOrder(context.Background(), session.Token, input, "192.0.2.1", "card-api-test")
	var authErr *Error
	if !errors.As(err, &authErr) {
		t.Fatalf("expected rate limit error, got %v", err)
	}
	if authErr.Code != "payment_method_rate_limited" || authErr.Status != http.StatusTooManyRequests {
		t.Fatalf("unexpected error: %+v", authErr)
	}
	if cardClient.createCalls != 1 {
		t.Fatalf("CreateSignOrder calls = %d, want 1", cardClient.createCalls)
	}
}

func TestPaymentMethodContractCodeHasBoundedLength(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 14, 11, 0, 0, 0, time.UTC)
	cardClient := &recordingPaymentMethodClient{}
	service, session := newPaymentMethodService(t, now, cardClient)

	err := service.SetDefaultPaymentMethod(context.Background(), session.Token, strings.Repeat("x", maxPaymentMethodContractCodeLength+1), "192.0.2.1", "card-api-test")
	var authErr *Error
	if !errors.As(err, &authErr) {
		t.Fatalf("expected validation error, got %v", err)
	}
	if authErr.Code != "invalid_payment_method" || authErr.Status != http.StatusBadRequest {
		t.Fatalf("unexpected error: %+v", authErr)
	}
	if cardClient.lastContract != "" {
		t.Fatalf("provider received invalid contract code %q", cardClient.lastContract)
	}
}

func newPaymentMethodService(t *testing.T, now time.Time, cardClient paymentmethod.Client) (*Service, *AuthSession) {
	t.Helper()

	shadowClient := &paymentMethodShadowClient{
		stubShadowRegisterClient: stubShadowRegisterClient{
			result: shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000},
		},
		credentials: shadowbinding.CloudTemporaryCredentials{
			Uin:          300000000053,
			OwnerUin:     300000000053,
			TmpSecretID:  "tmp-id",
			TmpSecretKey: "tmp-key",
			Token:        "tmp-token",
			ExpiredTime:  now.Add(time.Hour),
		},
	}
	shadowService := shadowbinding.New(shadowbinding.NewMemoryStore(), shadowClient, shadowbinding.Options{
		Enabled: true,
		Now:     func() time.Time { return now },
	})
	store := NewMemoryStore(StoreOptions{Now: func() time.Time { return now }, SeedDefaultInvites: true})
	service := NewWithStore(store, Options{
		Now:            func() time.Time { return now },
		SiteKind:       shadowbinding.SiteKindIntl,
		ShadowBinding:  shadowService,
		PaymentMethods: cardClient,
	})
	session, err := service.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:     "Card User",
		Email:    "card-user@example.com",
		Password: "password123",
	})
	if err != nil {
		t.Fatalf("SignUpWithPassword: %v", err)
	}
	if _, err := shadowService.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID: session.User.ID,
		Phone:  "6500000000",
	}); err != nil {
		t.Fatalf("BindShadowAccount: %v", err)
	}
	return service, session
}
