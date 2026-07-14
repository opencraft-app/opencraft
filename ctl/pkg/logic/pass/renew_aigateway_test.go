// 本文件为 AlignAiGatewaySubscriptionPeriodEnd helper 的独立单测，与 renew.go active 同步分支
// 补调 ai-gateway 强一致语义对应。
//
// 设计决策（2026-05-23）：renew.go active 同步分支原本漏调 ai-gateway，导致用户提前
// 续费时 ctl pass.expired_time 推进、但 ai-gateway subscription.period_end 不动 —
// 走到原 period_end 即被 ai-gateway scheduler 标 expired，AI 服务断档。本次抽出
// 公用 helper AlignAiGatewaySubscriptionPeriodEnd（renew.go），同步 active 分支与 worker
// 异步分支共用同一份强一致 + CAS 幂等 + ErrLLMGatewayPlanNotFound 降级语义。
//
// 现行 renew_test.go 注释明确：valid 参数路径需依赖真实 DB，dao mock 复杂，所以
// 那条注释把"分支 A / 分支 B 成功路径"留给 R-D 集成测试。本文件**只测 helper 本身**，
// 不打 dao mock，与现行单测风格一致。
package pass

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

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

// stubLLMGatewayAdapter 仅实现 ai-gateway.Adapter 接口的全部 9 个方法以满足编译；
// 实际只在 ExtendSubscription 上注入测试夹具。其余方法返回 "not configured" 错误，
// 任何不期望的调用会被 helper 直接传播出来，方便测试发现误调用。
type stubLLMGatewayAdapter struct {
	extendResp *llmgateway.ExtendSubscriptionResponse
	extendErr  error
	gotReq     *llmgateway.ExtendSubscriptionRequest
	calls      int
}

func (s *stubLLMGatewayAdapter) ExtendSubscription(_ context.Context, req *llmgateway.ExtendSubscriptionRequest) (*llmgateway.ExtendSubscriptionResponse, error) {
	s.calls++
	s.gotReq = req
	return s.extendResp, s.extendErr
}

func (s *stubLLMGatewayAdapter) CreateApiKey(_ context.Context, _ string, _ string) (*llmgateway.CreateApiKeyResponse, error) {
	return nil, fmt.Errorf("CreateApiKey not configured")
}
func (s *stubLLMGatewayAdapter) EnsureUser(_ context.Context, _ string, _ string) (*llmgateway.EnsureUserResponse, error) {
	return nil, fmt.Errorf("EnsureUser not configured")
}
func (s *stubLLMGatewayAdapter) RevokeApiKey(_ context.Context, _ string) error {
	return fmt.Errorf("RevokeApiKey not configured")
}
func (s *stubLLMGatewayAdapter) GetUserUsage(_ context.Context, _ string) (*llmgateway.UserUsageResponse, error) {
	return nil, fmt.Errorf("GetUserUsage not configured")
}
func (s *stubLLMGatewayAdapter) GetPlan(_ context.Context, _ string) (*llmgateway.Plan, error) {
	return nil, fmt.Errorf("GetPlan not configured")
}
func (s *stubLLMGatewayAdapter) ApplySubscription(_ context.Context, _ *llmgateway.ApplySubscriptionRequest) (*llmgateway.Subscription, error) {
	return nil, fmt.Errorf("ApplySubscription not configured")
}
func (s *stubLLMGatewayAdapter) CancelSubscription(_ context.Context, _ string) error {
	return fmt.Errorf("CancelSubscription not configured")
}
func (s *stubLLMGatewayAdapter) GetActiveSubscription(_ context.Context, _ string) (*llmgateway.Subscription, error) {
	return nil, fmt.Errorf("GetActiveSubscription not configured")
}

// stubAdapterFactory 仅承载 ai-gateway，其余 adapter 返 nil；测试用例如调到这些
// nil adapter 会立刻 panic，提示测试覆盖范围超出预期。
type stubAdapterFactory struct {
	aigateway llmgateway.Adapter
}

func (f *stubAdapterFactory) SandboxAdapter() sandbox.Adapter                 { return nil }
func (f *stubAdapterFactory) StsAdapter() sts.Adapter                         { return nil }
func (f *stubAdapterFactory) WhitelistAdapter() whitelist.Adapter             { return nil }
func (f *stubAdapterFactory) LLMGatewayAdapter() llmgateway.Adapter           { return f.aigateway }
func (f *stubAdapterFactory) OpenClawGatewayAdapter() openclawgateway.Adapter { return nil }
func (f *stubAdapterFactory) ShadowAdapter() shadow.Adapter                   { return nil }
func (f *stubAdapterFactory) TradeAdapter() trade.Adapter                     { return nil }

// installStubAiGateway 替换 adapterfactory.DefaultAdapterFactory 为只挂 stub
// ai-gateway 的工厂，返回还原闭包。所有 AlignAiGatewaySubscriptionPeriodEnd helper 单测
// 必须用 t.Cleanup 注册还原，避免污染后续测试。
func installStubAiGateway(stub *stubLLMGatewayAdapter) func() {
	original := adapterfactory.DefaultAdapterFactory
	adapterfactory.DefaultAdapterFactory = &stubAdapterFactory{aigateway: stub}
	return func() {
		adapterfactory.DefaultAdapterFactory = original
	}
}

// TestAlignAiGatewaySubscriptionPeriodEnd_Success 验证：ai-gateway 返 200 + updated=true 时
// helper 返 nil，且请求体里的 user_id / new_period_end 与入参完全一致。
func TestAlignAiGatewaySubscriptionPeriodEnd_Success(t *testing.T) {
	wantPeriodEnd := time.Date(2026, 7, 23, 9, 6, 0, 0, time.UTC)
	stub := &stubLLMGatewayAdapter{
		extendResp: &llmgateway.ExtendSubscriptionResponse{
			Subscription: &llmgateway.Subscription{UserID: "uin_test", PeriodEnd: "2026-07-23T09:06:00.000Z"},
			Updated:      true,
		},
	}
	t.Cleanup(installStubAiGateway(stub))

	err := AlignAiGatewaySubscriptionPeriodEnd(zap.NewNop(), "uin_test", "pass-test", wantPeriodEnd)
	if err != nil {
		t.Fatalf("AlignAiGatewaySubscriptionPeriodEnd expected nil err, got %v", err)
	}
	if stub.calls != 1 {
		t.Fatalf("expected ExtendSubscription called 1 time, got %d", stub.calls)
	}
	if stub.gotReq == nil {
		t.Fatalf("expected non-nil request to be captured")
	}
	if stub.gotReq.UserID != "uin_test" {
		t.Fatalf("request UserID = %q, want %q", stub.gotReq.UserID, "uin_test")
	}
	if !stub.gotReq.NewPeriodEnd.Equal(wantPeriodEnd) {
		t.Fatalf("request NewPeriodEnd = %v, want %v", stub.gotReq.NewPeriodEnd, wantPeriodEnd)
	}
}

// TestAlignAiGatewaySubscriptionPeriodEnd_IdempotentNoOp 验证：ai-gateway CAS 幂等返 updated=false
// 时 helper 同样返 nil（视为幂等成功）。
func TestAlignAiGatewaySubscriptionPeriodEnd_IdempotentNoOp(t *testing.T) {
	stub := &stubLLMGatewayAdapter{
		extendResp: &llmgateway.ExtendSubscriptionResponse{
			Subscription: &llmgateway.Subscription{UserID: "uin_test"},
			Updated:      false, // ai-gateway 端 current >= new 时返 false
		},
	}
	t.Cleanup(installStubAiGateway(stub))

	err := AlignAiGatewaySubscriptionPeriodEnd(zap.NewNop(), "uin_test", "pass-test",
		time.Date(2026, 7, 23, 9, 6, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("AlignAiGatewaySubscriptionPeriodEnd expected nil err for idempotent no-op, got %v", err)
	}
}

// TestAlignAiGatewaySubscriptionPeriodEnd_PlanNotFoundDegradesToNil 验证：用户在 ai-gateway 端
// 无 active 订阅（ErrLLMGatewayPlanNotFound）时 helper 降级为 nil，不阻断 pass renew
// 主链；这与异步 renewPassTask 行为一致，与 R-MR-4 §5.2 文档语义对齐。
func TestAlignAiGatewaySubscriptionPeriodEnd_PlanNotFoundDegradesToNil(t *testing.T) {
	stub := &stubLLMGatewayAdapter{
		extendErr: llmgateway.ErrLLMGatewayPlanNotFound,
	}
	t.Cleanup(installStubAiGateway(stub))

	err := AlignAiGatewaySubscriptionPeriodEnd(zap.NewNop(), "uin_test", "pass-test",
		time.Date(2026, 7, 23, 9, 6, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("AlignAiGatewaySubscriptionPeriodEnd expected nil for ErrLLMGatewayPlanNotFound, got %v", err)
	}
}

// TestAlignAiGatewaySubscriptionPeriodEnd_OtherErrorPropagates 验证：除 PlanNotFound 之外的
// 任何 err 都必须透传给 caller，让 caller 触发重试（强一致语义；trade callback 重投
// 同步分支 / 父 task fail 重投异步分支）。
func TestAlignAiGatewaySubscriptionPeriodEnd_OtherErrorPropagates(t *testing.T) {
	upstreamErr := errors.New("ai-gateway 503 service unavailable")
	stub := &stubLLMGatewayAdapter{extendErr: upstreamErr}
	t.Cleanup(installStubAiGateway(stub))

	err := AlignAiGatewaySubscriptionPeriodEnd(zap.NewNop(), "uin_test", "pass-test",
		time.Date(2026, 7, 23, 9, 6, 0, 0, time.UTC))
	if err == nil {
		t.Fatalf("AlignAiGatewaySubscriptionPeriodEnd expected non-nil err, got nil")
	}
	if !errors.Is(err, upstreamErr) {
		t.Fatalf("AlignAiGatewaySubscriptionPeriodEnd err = %v, want errors.Is %v", err, upstreamErr)
	}
}

// TestAlignAiGatewaySubscriptionPeriodEnd_RouteNotFoundPropagates 验证：
// ErrLLMGatewayRouteNotFound（ai-gateway 镜像滞后未注册路由）必须透传给 caller，
// 不能像 ErrLLMGatewayPlanNotFound 那样被降级为 nil — 否则 ai-gateway 部署事故
// 会被背面遮蔽，pass.expired_time 推进了但 ai-gateway period_end 永远没动。
func TestAlignAiGatewaySubscriptionPeriodEnd_RouteNotFoundPropagates(t *testing.T) {
	stub := &stubLLMGatewayAdapter{extendErr: llmgateway.ErrLLMGatewayRouteNotFound}
	t.Cleanup(installStubAiGateway(stub))

	err := AlignAiGatewaySubscriptionPeriodEnd(zap.NewNop(), "uin_test", "pass-test",
		time.Date(2026, 7, 23, 9, 6, 0, 0, time.UTC))
	if err == nil {
		t.Fatalf("expected RouteNotFound err to propagate, got nil")
	}
	if !errors.Is(err, llmgateway.ErrLLMGatewayRouteNotFound) {
		t.Fatalf("expected errors.Is ErrLLMGatewayRouteNotFound, got %v", err)
	}
	if errors.Is(err, llmgateway.ErrLLMGatewayPlanNotFound) {
		t.Fatalf("RouteNotFound must NOT be degraded as PlanNotFound, got %v", err)
	}
}

// TestAlignAiGatewaySubscriptionPeriodEnd_EmptyUserID 验证：user_id 为空时 helper 立刻返
// 错误（防御性 — caller 不应把空 user_id 传进来；与异步 renewPassTask 收尾前
// `if t.in.UserID != ""` 守卫语义对偶）。
func TestAlignAiGatewaySubscriptionPeriodEnd_EmptyUserID(t *testing.T) {
	stub := &stubLLMGatewayAdapter{}
	t.Cleanup(installStubAiGateway(stub))

	err := AlignAiGatewaySubscriptionPeriodEnd(zap.NewNop(), "   ", "pass-test",
		time.Date(2026, 7, 23, 9, 6, 0, 0, time.UTC))
	if err == nil {
		t.Fatalf("expected non-nil err for empty user_id, got nil")
	}
	if stub.calls != 0 {
		t.Fatalf("expected ExtendSubscription not called for empty user_id, got %d calls", stub.calls)
	}
}
