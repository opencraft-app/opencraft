package pass

import (
	"context"
	"errors"
	"testing"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	"ctl/pkg/config"
	"ctl/pkg/errcode"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/transport"
	"ctl/test/testutil"
)

type freeCreditLLMStub struct {
	llmgateway.Adapter
	applied   llmgateway.ApplySubscriptionRequest
	cancelled llmgateway.CancelSelectedSubscriptionsRequest
}

func (s *freeCreditLLMStub) CancelSelectedSubscriptions(_ context.Context, req *llmgateway.CancelSelectedSubscriptionsRequest) error {
	s.cancelled = *req
	return nil
}

func (s *freeCreditLLMStub) ApplySubscription(_ context.Context, req *llmgateway.ApplySubscriptionRequest) (*llmgateway.Subscription, error) {
	s.applied = *req
	return &llmgateway.Subscription{ID: "sub-free-1", PlanID: req.PlanID, UserID: req.UserID}, nil
}

type freeCreditAdapterFactory struct {
	adapterfactory.AdapterFactory
	llm llmgateway.Adapter
}

func (f *freeCreditAdapterFactory) LLMGatewayAdapter() llmgateway.Adapter { return f.llm }

func TestValidateQualifyingPassForFreeCredit(t *testing.T) {
	testutil.NewSQLiteDB(t, &passmodel.Entity{})
	if err := passmodel.NewDao().Create(&passmodel.Entity{
		PassID: "pass-qualified", UserID: "usr-invitee", BundleID: "bundle-paid",
		Status: passmodel.StatusActive, ExpiredTime: time.Now().UTC().Add(24 * time.Hour),
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}
	if err := validateQualifyingPassForFreeCredit("pass-qualified", "usr-invitee"); err != nil {
		t.Fatalf("active qualifying pass rejected: %v", err)
	}
	if err := validateQualifyingPassForFreeCredit("pass-qualified", "usr-other"); !errors.Is(err, errcode.ErrPassNotActive) {
		t.Fatalf("wrong owner err=%v, want PASS_NOT_ACTIVE", err)
	}
	if err := validateQualifyingPassForFreeCredit("pass-qualified", ""); !errors.Is(err, errcode.ErrPassInvalidParam) {
		t.Fatalf("partial qualification err=%v, want PASS_INVALID_PARAM", err)
	}
}

func TestFreeCreditAmountConvertsToTokens(t *testing.T) {
	first, err := freeCreditTokens(500)
	if err != nil {
		t.Fatal(err)
	}
	second, err := freeCreditTokens(500)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first != 5_000_000 {
		t.Fatalf("unexpected token conversion: %d", first)
	}
	other, err := freeCreditTokens(200)
	if err != nil {
		t.Fatal(err)
	}
	if other == first || other != 2_000_000 {
		t.Fatalf("amount-specific conversion mismatch: first=%d other=%d", first, other)
	}
	if _, err := freeCreditTokens(0); !errors.Is(err, errcode.ErrPassInvalidParam) {
		t.Fatalf("zero amount err=%v, want PASS_INVALID_PARAM", err)
	}
}

func TestGrantFreeCreditAcceptsAmountWithoutCallerPlan(t *testing.T) {
	testutil.NewSQLiteDB(t, &passmodel.Entity{})
	if err := passmodel.NewDao().Create(&passmodel.Entity{
		PassID: "pass-beneficiary", UserID: "usr-beneficiary", BundleID: "bundle-paid",
		Status: passmodel.StatusActive, ExpiredTime: time.Now().UTC().Add(60 * 24 * time.Hour),
	}); err != nil {
		t.Fatalf("seed pass: %v", err)
	}

	originalConfig := config.ServerConf
	originalFactory := adapterfactory.DefaultAdapterFactory
	t.Cleanup(func() {
		config.ServerConf = originalConfig
		adapterfactory.DefaultAdapterFactory = originalFactory
	})
	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		LLMGateway: &config.LLMGatewayConfig{Enabled: true},
	}}
	stub := &freeCreditLLMStub{}
	adapterfactory.DefaultAdapterFactory = &freeCreditAdapterFactory{llm: stub}

	result, err := (&logic{}).GrantFreeCredit(&transport.GrantFreeCreditRequest{
		UserID: "usr-beneficiary", CreditAmount: 500,
		Source: "referral", IdempotencyKey: "referral:campaign:invitee:inviter",
	})
	if err != nil {
		t.Fatalf("grant free credit: %v", err)
	}
	if stub.applied.PlanID != "" || stub.applied.TokenAmount != 5_000_000 ||
		stub.applied.SubscriptionName != "free-credit:referral:referral:campaign:invitee:inviter" || stub.applied.IsUnique {
		t.Fatalf("unexpected apply request: %+v", stub.applied)
	}
	if result.SubscriptionID != "sub-free-1" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if remaining := time.Until(result.PeriodEnd); remaining < 59*24*time.Hour || remaining > 61*24*time.Hour {
		t.Fatalf("period_end=%s does not follow active Pass lifecycle", result.PeriodEnd)
	}
}

func TestRevokeFreeCreditUsesExactNamesOnly(t *testing.T) {
	originalConfig := config.ServerConf
	originalFactory := adapterfactory.DefaultAdapterFactory
	t.Cleanup(func() {
		config.ServerConf = originalConfig
		adapterfactory.DefaultAdapterFactory = originalFactory
	})
	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		LLMGateway: &config.LLMGatewayConfig{Enabled: true},
	}}
	stub := &freeCreditLLMStub{}
	adapterfactory.DefaultAdapterFactory = &freeCreditAdapterFactory{llm: stub}

	result, err := (&logic{}).RevokeFreeCredit(&transport.RevokeFreeCreditRequest{
		UserID:            "usr-beneficiary",
		SubscriptionNames: []string{"free-credit:referral:reward-1", "free-credit:referral:reward-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if stub.cancelled.UserID != "usr-beneficiary" || len(stub.cancelled.SubscriptionNames) != 1 ||
		stub.cancelled.SubscriptionNames[0] != "free-credit:referral:reward-1" || len(stub.cancelled.SubscriptionNamePrefixes) != 0 {
		t.Fatalf("unexpected cancel request: %+v", stub.cancelled)
	}
	if len(result.RevokedSubscriptionNames) != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}

	if _, err := (&logic{}).RevokeFreeCredit(&transport.RevokeFreeCreditRequest{
		UserID: "usr-beneficiary", SubscriptionNames: []string{"package:usr-beneficiary:pass-1"},
	}); !errors.Is(err, errcode.ErrPassInvalidParam) {
		t.Fatalf("package subscription must be rejected, err=%v", err)
	}
}
