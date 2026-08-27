package pass

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	"ctl/pkg/adapter/openclawgateway"
	"ctl/pkg/adapter/sandbox"
	"ctl/pkg/adapter/shadow"
	"ctl/pkg/adapter/sts"
	"ctl/pkg/adapter/trade"
	"ctl/pkg/adapter/whitelist"

	"go.uber.org/zap"
)

type entitlementStubAiGateway struct {
	applyResp   *aigateway.Subscription
	applyErr    error
	applyReq    *aigateway.ApplySubscriptionRequest
	applyCalls  int
	cancelErr   error
	cancelUser  string
	cancelCalls int
}

func (s *entitlementStubAiGateway) CreateApiKey(context.Context, string, string) (*aigateway.CreateApiKeyResponse, error) {
	return nil, fmt.Errorf("CreateApiKey not configured")
}

func (s *entitlementStubAiGateway) EnsureUser(context.Context, string, string) (*aigateway.EnsureUserResponse, error) {
	return nil, fmt.Errorf("EnsureUser not configured")
}

func (s *entitlementStubAiGateway) RevokeApiKey(context.Context, string) error {
	return fmt.Errorf("RevokeApiKey not configured")
}

func (s *entitlementStubAiGateway) GetUserUsage(context.Context, string) (*aigateway.UserUsageResponse, error) {
	return nil, fmt.Errorf("GetUserUsage not configured")
}

func (s *entitlementStubAiGateway) GetPlan(context.Context, string) (*aigateway.Plan, error) {
	return nil, fmt.Errorf("GetPlan not configured")
}

func (s *entitlementStubAiGateway) ApplySubscription(_ context.Context, req *aigateway.ApplySubscriptionRequest) (*aigateway.Subscription, error) {
	s.applyCalls++
	s.applyReq = req
	return s.applyResp, s.applyErr
}

func (s *entitlementStubAiGateway) ExtendSubscription(context.Context, *aigateway.ExtendSubscriptionRequest) (*aigateway.ExtendSubscriptionResponse, error) {
	return nil, fmt.Errorf("ExtendSubscription must not be called")
}

func (s *entitlementStubAiGateway) CancelSubscription(_ context.Context, userID string) error {
	s.cancelCalls++
	s.cancelUser = userID
	return s.cancelErr
}

func (s *entitlementStubAiGateway) GetActiveSubscription(context.Context, string) (*aigateway.Subscription, error) {
	return &aigateway.Subscription{ID: "sub-1", UserID: "user-1", PlanID: "plan-1"}, nil
}

type entitlementStubAdapterFactory struct {
	aigateway aigateway.Adapter
}

func (f *entitlementStubAdapterFactory) SandboxAdapter() sandbox.Adapter                 { return nil }
func (f *entitlementStubAdapterFactory) StsAdapter() sts.Adapter                         { return nil }
func (f *entitlementStubAdapterFactory) WhitelistAdapter() whitelist.Adapter             { return nil }
func (f *entitlementStubAdapterFactory) AiGatewayAdapter() aigateway.Adapter             { return f.aigateway }
func (f *entitlementStubAdapterFactory) LLMGatewayAdapter() llmgateway.Adapter           { return nil }
func (f *entitlementStubAdapterFactory) OpenClawGatewayAdapter() openclawgateway.Adapter { return nil }
func (f *entitlementStubAdapterFactory) ShadowAdapter() shadow.Adapter                   { return nil }
func (f *entitlementStubAdapterFactory) TradeAdapter() trade.Adapter                     { return nil }

func installEntitlementStub(stub *entitlementStubAiGateway) func() {
	original := adapterfactory.DefaultAdapterFactory
	adapterfactory.DefaultAdapterFactory = &entitlementStubAdapterFactory{aigateway: stub}
	return func() {
		adapterfactory.DefaultAdapterFactory = original
	}
}

func TestEnsureAiGatewayEntitlementDoesNotSendBusinessDuration(t *testing.T) {
	stub := &entitlementStubAiGateway{
		applyResp: &aigateway.Subscription{ID: "sub-1", UserID: "user-1", PlanID: "plan-1"},
	}
	t.Cleanup(installEntitlementStub(stub))

	sub, err := EnsureAiGatewayEntitlement(
		zap.NewNop(), "user-1", "plan-1", "trade:deal-1",
	)
	if err != nil {
		t.Fatalf("ensure entitlement: %v", err)
	}
	if sub == nil || sub.ID != "sub-1" {
		t.Fatalf("subscription = %+v", sub)
	}
	if stub.applyCalls != 1 || stub.applyReq == nil {
		t.Fatalf("apply calls=%d request=%+v", stub.applyCalls, stub.applyReq)
	}
	if stub.applyReq.PeriodValue != 0 || stub.applyReq.PeriodUnit != "" {
		t.Fatalf("business duration leaked into gateway request: %+v", stub.applyReq)
	}
}

func TestCancelAiGatewayEntitlementIsReliable(t *testing.T) {
	upstreamErr := errors.New("gateway unavailable")
	stub := &entitlementStubAiGateway{cancelErr: upstreamErr}
	t.Cleanup(installEntitlementStub(stub))

	err := CancelAiGatewayEntitlement(zap.NewNop(), "user-1")
	if !errors.Is(err, upstreamErr) {
		t.Fatalf("cancel error = %v, want %v", err, upstreamErr)
	}
	if stub.cancelCalls != 1 || stub.cancelUser != "user-1" {
		t.Fatalf("cancel calls=%d user=%q", stub.cancelCalls, stub.cancelUser)
	}
}

func TestCompensateEnsuredEntitlementPreservesBothFailures(t *testing.T) {
	localErr := errors.New("local pass transaction failed")
	cancelErr := errors.New("gateway cancel failed")
	stub := &entitlementStubAiGateway{cancelErr: cancelErr}
	t.Cleanup(installEntitlementStub(stub))

	err := compensateEnsuredEntitlement(zap.NewNop(), "user-1", true, localErr)
	if !errors.Is(err, localErr) || !errors.Is(err, cancelErr) {
		t.Fatalf("compensation error = %v, want both local and cancel errors", err)
	}
	if stub.cancelCalls != 1 {
		t.Fatalf("cancel calls=%d, want 1", stub.cancelCalls)
	}
}

func TestCompensateSkipsCancelWhenEntitlementWasNotEnsured(t *testing.T) {
	localErr := errors.New("local pass transaction failed")
	stub := &entitlementStubAiGateway{}
	t.Cleanup(installEntitlementStub(stub))

	err := compensateEnsuredEntitlement(zap.NewNop(), "user-1", false, localErr)
	if !errors.Is(err, localErr) {
		t.Fatalf("compensation error = %v, want %v", err, localErr)
	}
	if stub.cancelCalls != 0 {
		t.Fatalf("cancel calls=%d, want 0", stub.cancelCalls)
	}
}
