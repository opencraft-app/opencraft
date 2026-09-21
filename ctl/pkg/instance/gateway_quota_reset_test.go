package instance

import (
	"context"
	"testing"

	pllmgateway "ctl/pkg/adapter/llmgateway"
	pctx "ctl/pkg/context"

	"go.uber.org/zap"
)

type quotaResetAdapterStub struct {
	pllmgateway.Adapter
	result *pllmgateway.UserQuotaResetResult
	userID string
	dryRun bool
	calls  int
}

func (s *quotaResetAdapterStub) ResetUserQuota(_ context.Context, userID string, dryRun bool) (*pllmgateway.UserQuotaResetResult, error) {
	s.calls++
	s.userID = userID
	s.dryRun = dryRun
	return s.result, nil
}

func TestResetLLMGatewayUserQuotaDelegatesSingleUserDryRun(t *testing.T) {
	adapter := &quotaResetAdapterStub{result: &pllmgateway.UserQuotaResetResult{
		UserID: "usr_test", SetID: "set-a", PlanID: "plan-launch", UpstreamPlanID: 13,
		SubscriptionID: "31", AmountUsedBefore: 99, AmountUsedAfter: 99, DryRun: true, Status: "ready",
	}}
	logic := &logic{llmGatewayAdapter: adapter, logger: zap.NewNop()}

	result, err := logic.ResetLLMGatewayUserQuota(pctx.NewContext(nil).WithUserID("usr_test"), true)
	if err != nil {
		t.Fatal(err)
	}
	if adapter.calls != 1 || adapter.userID != "usr_test" || !adapter.dryRun {
		t.Fatalf("unexpected adapter call: %+v", adapter)
	}
	if result.Gateway != "llm_gateway" || result.SubscriptionID != "31" || result.AmountUsedBefore != 99 {
		t.Fatalf("unexpected result: %+v", result)
	}
}
