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
	modelgateway "ctl/pkg/model/subscriptiongateway"
	"ctl/pkg/resource"
	taskcommon "ctl/pkg/taskruntime/common"
	"ctl/test/testutil"

	"go.uber.org/zap"
)

func TestDestroyPassCancelSubscriptionClearsGatewayRoute(t *testing.T) {
	originalDB := resource.GormDB
	originalFactory := adapterfactory.DefaultAdapterFactory
	t.Cleanup(func() {
		resource.GormDB = originalDB
		adapterfactory.DefaultAdapterFactory = originalFactory
	})

	testutil.NewSQLiteDB(t, &modelgateway.Entity{})
	userID := "usr_destroy_gateway_route"
	gatewayDao := modelgateway.NewDao()
	if err := gatewayDao.Upsert(&modelgateway.Entity{
		UserID:         userID,
		Gateway:        modelgateway.GatewayAIGateway,
		SubscriptionID: "sub-legacy",
		PlanID:         "plan-legacy",
		Source:         modelgateway.SourceDetectActiveSubscription,
		LastObservedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("seed gateway route: %v", err)
	}

	ai := &destroyFakeAiGatewayAdapter{}
	adapterfactory.DefaultAdapterFactory = &destroyGatewayAdapterFactory{ai: ai}
	task := &destroyPassTask{in: &taskcommon.DestroyPassTaskPayload{UserID: userID}}
	task.cancelAiGatewaySubscription(testutil.NewContext(t, userID), zap.NewNop(), "")

	if len(ai.canceledUsers) != 1 || ai.canceledUsers[0] != userID {
		t.Fatalf("expected ai-gateway CancelSubscription for %s, got %+v", userID, ai.canceledUsers)
	}
	got, err := gatewayDao.GetByUserID(userID)
	if err != nil {
		t.Fatalf("GetByUserID after cancel: %v", err)
	}
	if got != nil {
		t.Fatalf("expected gateway route deleted after destroy cancel, got %+v", got)
	}
}

type destroyFakeAiGatewayAdapter struct {
	aigateway.Adapter

	canceledUsers []string
	cancelErr     error
}

func (a *destroyFakeAiGatewayAdapter) CancelSubscription(_ context.Context, userID string) error {
	a.canceledUsers = append(a.canceledUsers, userID)
	return a.cancelErr
}

type destroyGatewayAdapterFactory struct {
	ai  aigateway.Adapter
	llm llmgateway.Adapter
}

func (f *destroyGatewayAdapterFactory) SandboxAdapter() sandbox.Adapter                 { return nil }
func (f *destroyGatewayAdapterFactory) StsAdapter() sts.Adapter                         { return nil }
func (f *destroyGatewayAdapterFactory) WhitelistAdapter() whitelist.Adapter             { return nil }
func (f *destroyGatewayAdapterFactory) AiGatewayAdapter() aigateway.Adapter             { return f.ai }
func (f *destroyGatewayAdapterFactory) LLMGatewayAdapter() llmgateway.Adapter           { return f.llm }
func (f *destroyGatewayAdapterFactory) OpenClawGatewayAdapter() openclawgateway.Adapter { return nil }
func (f *destroyGatewayAdapterFactory) ShadowAdapter() shadow.Adapter                   { return nil }
func (f *destroyGatewayAdapterFactory) TradeAdapter() trade.Adapter                     { return nil }
