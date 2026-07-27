package pass

import (
	"context"
	"testing"
	"time"

	"ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	"ctl/pkg/adapter/openclawgateway"
	"ctl/pkg/adapter/sandbox"
	"ctl/pkg/adapter/shadow"
	"ctl/pkg/adapter/sts"
	"ctl/pkg/adapter/trade"
	"ctl/pkg/adapter/whitelist"
	"ctl/pkg/config"
	bundlemodel "ctl/pkg/model/bundle"
	passmodel "ctl/pkg/model/pass"
	taskcommon "ctl/pkg/taskruntime/common"
	"ctl/test/testutil"

	"go.uber.org/zap"
)

type workerEntitlementAdapter struct {
	llmgateway.Adapter
	applyCalls int
	applyReq   *llmgateway.ApplySubscriptionRequest
}

func (s *workerEntitlementAdapter) ApplySubscription(_ context.Context, req *llmgateway.ApplySubscriptionRequest) (*llmgateway.Subscription, error) {
	s.applyCalls++
	s.applyReq = req
	return &llmgateway.Subscription{ID: "sub-1", UserID: req.UserID, PlanID: req.PlanID}, nil
}

type workerEntitlementFactory struct {
	llmgateway llmgateway.Adapter
}

func (f *workerEntitlementFactory) SandboxAdapter() sandbox.Adapter                 { return nil }
func (f *workerEntitlementFactory) StsAdapter() sts.Adapter                         { return nil }
func (f *workerEntitlementFactory) WhitelistAdapter() whitelist.Adapter             { return nil }
func (f *workerEntitlementFactory) AiGatewayAdapter() aigateway.Adapter             { return nil }
func (f *workerEntitlementFactory) LLMGatewayAdapter() llmgateway.Adapter           { return f.llmgateway }
func (f *workerEntitlementFactory) OpenClawGatewayAdapter() openclawgateway.Adapter { return nil }
func (f *workerEntitlementFactory) ShadowAdapter() shadow.Adapter                   { return nil }
func (f *workerEntitlementFactory) TradeAdapter() trade.Adapter                     { return nil }

func installWorkerEntitlementAdapter(stub *workerEntitlementAdapter) func() {
	original := adapterfactory.DefaultAdapterFactory
	originalConfig := config.ServerConf
	adapterfactory.DefaultAdapterFactory = &workerEntitlementFactory{llmgateway: stub}
	config.ServerConf = &config.GlobalConfig{AdapterConfig: &config.AdapterConfig{
		LLMGateway: &config.LLMGatewayConfig{
			Enabled:                    true,
			NewAllocationUserAllowlist: []string{"*"},
		},
	}}
	return func() {
		adapterfactory.DefaultAdapterFactory = original
		config.ServerConf = originalConfig
	}
}

func TestRenewEntitlementOnlyRunsForIsolatedOrigin(t *testing.T) {
	testutil.NewSQLiteDB(t, &bundlemodel.Entity{})
	bundleDao := bundlemodel.NewDao()
	if err := bundleDao.Upsert(&bundlemodel.Entity{
		BundleID: "bundle-1", Credit: 100, AiGatewayPlanID: "plan-1",
	}); err != nil {
		t.Fatal(err)
	}
	stub := &workerEntitlementAdapter{}
	t.Cleanup(installWorkerEntitlementAdapter(stub))
	entity := &passmodel.Entity{
		PassID: "pass-1", UserID: "user-1", BundleID: "bundle-1",
	}
	originalExpired := time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC)

	activeTask := &renewPassTask{in: &taskcommon.RenewPassTaskPayload{
		PassID: "pass-1", UserID: "user-1",
		TimeSpan: 1, TimeUnit: "m", OriginalExpiredTime: originalExpired,
	}}
	if err := activeTask.ensureEntitlementBeforeResume(zap.NewNop(), entity); err != nil {
		t.Fatal(err)
	}
	if stub.applyCalls != 0 {
		t.Fatalf("active renewal called gateway %d times", stub.applyCalls)
	}

	isolatedAt := originalExpired.Add(time.Hour)
	isolatedTask := &renewPassTask{in: &taskcommon.RenewPassTaskPayload{
		PassID: "pass-1", UserID: "user-1",
		TimeSpan: 1, TimeUnit: "m", OriginalExpiredTime: originalExpired,
		OriginalIsolatedTime: &isolatedAt,
	}}
	if err := isolatedTask.ensureEntitlementBeforeResume(zap.NewNop(), entity); err != nil {
		t.Fatal(err)
	}
	if stub.applyCalls != 1 || stub.applyReq == nil {
		t.Fatalf("isolated renewal apply calls=%d request=%+v", stub.applyCalls, stub.applyReq)
	}
	if stub.applyReq.PeriodValue != 0 || stub.applyReq.PeriodUnit != "" {
		t.Fatalf("business duration leaked into gateway request: %+v", stub.applyReq)
	}
}
