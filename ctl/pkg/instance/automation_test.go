package instance

import (
	"context"
	"strings"
	"testing"

	pllmgateway "ctl/pkg/adapter/llmgateway"
	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/model/instance"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

type automationGatewayAdapterStub struct {
	methods []string
	params  []interface{}
	handler func(method string, params interface{}, out interface{}) error
}

type automationLLMGatewayAdapterStub struct {
	createResp   *pllmgateway.CreateApiKeyResponse
	createErr    error
	revokedKeyID string
}

func (s *automationLLMGatewayAdapterStub) CreateApiKey(_ context.Context, _ string, _ string) (*pllmgateway.CreateApiKeyResponse, error) {
	if s.createErr != nil {
		return nil, s.createErr
	}
	if s.createResp != nil {
		return s.createResp, nil
	}
	return &pllmgateway.CreateApiKeyResponse{KeyID: "key_new", APIKey: "api_new"}, nil
}

func (s *automationLLMGatewayAdapterStub) EnsureUser(_ context.Context, userID string, nickname string) (*pllmgateway.EnsureUserResponse, error) {
	return &pllmgateway.EnsureUserResponse{UserID: userID, Result: "created"}, nil
}

func (s *automationLLMGatewayAdapterStub) RevokeApiKey(_ context.Context, keyID string) error {
	s.revokedKeyID = keyID
	return nil
}

func (s *automationLLMGatewayAdapterStub) GetUserUsage(_ context.Context, _ string) (*pllmgateway.UserUsageResponse, error) {
	return &pllmgateway.UserUsageResponse{}, nil
}

func (s *automationLLMGatewayAdapterStub) GetPlan(_ context.Context, planID string) (*pllmgateway.Plan, error) {
	return &pllmgateway.Plan{ID: planID}, nil
}

func (s *automationLLMGatewayAdapterStub) ApplySubscription(_ context.Context, req *pllmgateway.ApplySubscriptionRequest) (*pllmgateway.Subscription, error) {
	return &pllmgateway.Subscription{UserID: req.UserID, PlanID: req.PlanID}, nil
}

func (s *automationLLMGatewayAdapterStub) ExtendSubscription(_ context.Context, req *pllmgateway.ExtendSubscriptionRequest) (*pllmgateway.ExtendSubscriptionResponse, error) {
	return &pllmgateway.ExtendSubscriptionResponse{
		Subscription: &pllmgateway.Subscription{UserID: req.UserID},
		Updated:      true,
	}, nil
}

func (s *automationLLMGatewayAdapterStub) CancelSubscription(_ context.Context, _ string) error {
	return nil
}

func (s *automationLLMGatewayAdapterStub) GetActiveSubscription(_ context.Context, _ string) (*pllmgateway.Subscription, error) {
	return nil, nil
}

func (s *automationGatewayAdapterStub) Call(_ context.Context, _ string, _ string, method string, params interface{}, out interface{}) error {
	s.methods = append(s.methods, method)
	s.params = append(s.params, params)
	if s.handler != nil {
		return s.handler(method, params, out)
	}
	return nil
}

func TestListAutomationSchedulesBackfillsGatewayAuthMaterialForRunningInstance(t *testing.T) {
	prevConf := config.ServerConf
	config.ServerConf = &config.GlobalConfig{
		AdapterConfig: &config.AdapterConfig{
			LLMGateway: &config.LLMGatewayConfig{
				BaseURL:              "https://llmgateway.test",
				DefaultBaseURL:       "https://model.internal/v1",
				DefaultModelID:       "kimi-k2.5",
				DefaultCompatibility: "openai",
				DefaultGatewayPort:   18789,
			},
		},
	}
	t.Cleanup(func() {
		config.ServerConf = prevConf
	})

	sandbox := &commandSandboxAdapterStub{
		processBatches: [][]psandbox.ProcessStreamEvent{
			{
				{Stdout: "ok", Status: "running"},
				{ExitCode: 0, Status: "exited", Ended: true},
			},
			{
				{Stdout: "patched", Status: "running"},
				{ExitCode: 0, Status: "exited", Ended: true},
			},
		},
	}
	aiGateway := &automationLLMGatewayAdapterStub{
		createResp: &pllmgateway.CreateApiKeyResponse{
			KeyID:  "key_new",
			APIKey: "api_key_new",
		},
	}
	adapter := &automationGatewayAdapterStub{
		handler: func(method string, _ interface{}, out interface{}) error {
			page := out.(*openClawCronListPage)
			page.Jobs = []*openClawCronJob{}
			page.Total = 0
			return nil
		},
	}
	entity := &instance.Entity{
		Id:               42,
		InstanceId:       "ins-1",
		SandboxId:        "sbx-1",
		AiGatewayKeyID:   "key_old",
		GatewayAuthToken: "",
		Status:           instance.InstanceStatusRunning,
	}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: entity,
		},
		sandboxAdapter:         sandbox,
		aiGatewayAdapter:       aiGateway,
		openclawGatewayAdapter: adapter,
		logger:                 zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.ListAutomationSchedules(ctx, "ins-1", 0, 20)
	if err != nil {
		t.Fatalf("list automation schedules: %v", err)
	}
	if resp.Total != 0 {
		t.Fatalf("expected empty page, got %+v", resp)
	}
	if strings.TrimSpace(entity.GatewayAuthToken) == "" {
		t.Fatalf("expected gateway auth token to be backfilled")
	}
	if entity.AiGatewayKeyID != "key_new" {
		t.Fatalf("expected ai-gateway key id to update, got %s", entity.AiGatewayKeyID)
	}
	if len(adapter.methods) != 1 || adapter.methods[0] != "cron.list" {
		t.Fatalf("expected cron.list after backfill, got %+v", adapter.methods)
	}
	if len(sandbox.processCalls) != 2 {
		t.Fatalf("expected onboard and gateway patch commands to run, got %d", len(sandbox.processCalls))
	}
	if aiGateway.revokedKeyID != "key_old" {
		t.Fatalf("expected previous key to be revoked, got %s", aiGateway.revokedKeyID)
	}
}

func TestListAutomationSchedulesMapsCronJobs(t *testing.T) {
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &instance.Entity{
				InstanceId:       "ins-1",
				SandboxId:        "sbx-1",
				GatewayAuthToken: "gw-token",
				Status:           instance.InstanceStatusRunning,
			},
		},
		openclawGatewayAdapter: &automationGatewayAdapterStub{
			handler: func(method string, params interface{}, out interface{}) error {
				page := out.(*openClawCronListPage)
				page.Jobs = []*openClawCronJob{{
					ID:            "job_1",
					Name:          "Morning sync",
					Enabled:       true,
					SessionTarget: "main",
					WakeMode:      "now",
					Schedule: map[string]interface{}{
						"kind": "cron",
						"expr": "0 9 * * *",
						"tz":   "Asia/Shanghai",
					},
					Payload: map[string]interface{}{
						"kind": "systemEvent",
						"text": "Check overnight alerts.",
					},
					State: &openClawCronJobState{
						LastRunStatus: "ok",
					},
				}}
				page.Total = 1
				return nil
			},
		},
		logger: zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	resp, err := logic.ListAutomationSchedules(ctx, "ins-1", 0, 20)
	if err != nil {
		t.Fatalf("list automation schedules: %v", err)
	}
	if len(resp.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(resp.Items))
	}
	item := resp.Items[0]
	if item.Title != "Morning sync" || item.Prompt != "Check overnight alerts." || item.Cron != "0 9 * * *" || item.Timezone != "Asia/Shanghai" {
		t.Fatalf("unexpected mapped item: %+v", item)
	}
}

func TestCreateAutomationScheduleBuildsCronAddParamsFromSimplifiedInput(t *testing.T) {
	adapter := &automationGatewayAdapterStub{
		handler: func(method string, params interface{}, out interface{}) error {
			job := out.(*openClawCronJob)
			job.ID = "job_1"
			job.Name = "Morning sync"
			job.Enabled = true
			job.SessionTarget = "main"
			job.WakeMode = "now"
			job.Schedule = map[string]interface{}{"kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Shanghai"}
			job.Payload = map[string]interface{}{"kind": "systemEvent", "text": "Check overnight alerts."}
			return nil
		},
	}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{
			entity: &instance.Entity{
				InstanceId:       "ins-1",
				SandboxId:        "sbx-1",
				GatewayAuthToken: "gw-token",
				Status:           instance.InstanceStatusRunning,
			},
		},
		openclawGatewayAdapter: adapter,
		logger:                 zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")

	enabled := true
	_, err := logic.CreateAutomationSchedule(ctx, "ins-1", &transport.CreateAutomationScheduleRequest{
		Title:    "Morning sync",
		Prompt:   "Check overnight alerts.",
		Cron:     "0 9 * * *",
		Timezone: "Asia/Shanghai",
		Enabled:  &enabled,
	})
	if err != nil {
		t.Fatalf("create automation schedule: %v", err)
	}
	if len(adapter.methods) != 1 || adapter.methods[0] != "cron.add" {
		t.Fatalf("expected cron.add call, got %+v", adapter.methods)
	}
	params := adapter.params[0].(map[string]interface{})
	if params["name"] != "Morning sync" || params["sessionTarget"] != "main" || params["wakeMode"] != "now" {
		t.Fatalf("unexpected top-level params: %+v", params)
	}
	schedule := params["schedule"].(map[string]interface{})
	if schedule["expr"] != "0 9 * * *" || schedule["tz"] != "Asia/Shanghai" {
		t.Fatalf("unexpected schedule: %+v", schedule)
	}
	payload := params["payload"].(map[string]interface{})
	if payload["kind"] != "systemEvent" || payload["text"] != "Check overnight alerts." {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}
