//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	adapterfactory "ctl/pkg/adapter/factory"
	pllmgateway "ctl/pkg/adapter/llmgateway"
	popenclawgateway "ctl/pkg/adapter/openclawgateway"
	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/adapter/shadow"
	"ctl/pkg/adapter/sts"
	"ctl/pkg/adapter/whitelist"
	modelinstance "ctl/pkg/model/instance"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/mq"
	"ctl/pkg/resource"
	"ctl/pkg/taskruntime/common"
	"ctl/pkg/taskruntime/processor"
)

// --- Stub Sandbox Adapter ---

type stubSandboxAdapter struct {
	createSandboxFunc func(ctx context.Context, req *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error)
	deleteSandboxFunc func(ctx context.Context, sandboxID string) error
}

func (s *stubSandboxAdapter) CreateSandbox(ctx context.Context, req *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
	if s.createSandboxFunc != nil {
		return s.createSandboxFunc(ctx, req)
	}
	return &psandbox.Sandbox{SandboxID: "sbx-test-001", TemplateID: req.TemplateID}, nil
}

func (s *stubSandboxAdapter) GetSandbox(_ context.Context, _ string) (*psandbox.SandboxDetail, error) {
	return nil, nil
}

func (s *stubSandboxAdapter) ListSandboxes(_ context.Context, _ *psandbox.ListSandboxesRequest) ([]psandbox.ListedSandbox, error) {
	return nil, nil
}

func (s *stubSandboxAdapter) ListPools(_ context.Context) ([]psandbox.Pool, error) {
	return nil, nil
}

func (s *stubSandboxAdapter) ListPoolInstances(_ context.Context, _ string) ([]psandbox.PoolInstance, error) {
	return nil, nil
}

func (s *stubSandboxAdapter) DeleteSandbox(ctx context.Context, sandboxID string) error {
	if s.deleteSandboxFunc != nil {
		return s.deleteSandboxFunc(ctx, sandboxID)
	}
	return nil
}

func (s *stubSandboxAdapter) PauseSandbox(_ context.Context, _ string) error {
	return nil
}

func (s *stubSandboxAdapter) ResumeSandbox(_ context.Context, _ string, _ *psandbox.ResumeSandboxRequest) (*psandbox.Sandbox, error) {
	return nil, nil
}

func (s *stubSandboxAdapter) SetTimeout(_ context.Context, _ string, _ int32) error {
	return nil
}

func (s *stubSandboxAdapter) Refresh(_ context.Context, _ string, _ int32) error {
	return nil
}

func (s *stubSandboxAdapter) GetLogs(_ context.Context, _ string, _ *psandbox.GetLogsRequest) (*psandbox.SandboxLogs, error) {
	return nil, nil
}

func (s *stubSandboxAdapter) ExecCommand(_ context.Context, _ string, _ string, _ int) (*psandbox.ExecCommandResult, error) {
	return &psandbox.ExecCommandResult{Status: "SUCCESS"}, nil
}

func (s *stubSandboxAdapter) GetCommandResult(_ context.Context, _ string, _ string) (*psandbox.ExecCommandResult, error) {
	return nil, nil
}

func (s *stubSandboxAdapter) StartProcessStream(_ context.Context, _ string, _ *psandbox.ProcessStartRequest, _ func(psandbox.ProcessStreamEvent) error) error {
	return nil
}

func (s *stubSandboxAdapter) RunProcessWithStdin(_ context.Context, _ string, _ *psandbox.ProcessStartRequest, _ []byte) (*psandbox.ExecCommandResult, error) {
	return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
}

func (s *stubSandboxAdapter) SendProcessSignal(_ context.Context, _ string, _ uint32, _ string) error {
	return nil
}

// --- Stub AI Gateway Adapter ---

type stubLLMGatewayAdapter struct{}

func (s *stubLLMGatewayAdapter) CreateApiKey(_ context.Context, _ string, _ string) (*pllmgateway.CreateApiKeyResponse, error) {
	return nil, fmt.Errorf("ai gateway not configured in test")
}

func (s *stubLLMGatewayAdapter) EnsureUser(_ context.Context, userID string, nickname string) (*pllmgateway.EnsureUserResponse, error) {
	return &pllmgateway.EnsureUserResponse{UserID: userID, Result: "created"}, nil
}

func (s *stubLLMGatewayAdapter) RevokeApiKey(_ context.Context, _ string) error {
	return nil
}

func (s *stubLLMGatewayAdapter) GetUserUsage(_ context.Context, _ string) (*pllmgateway.UserUsageResponse, error) {
	return &pllmgateway.UserUsageResponse{}, nil
}

func (s *stubLLMGatewayAdapter) GetPlan(_ context.Context, planID string) (*pllmgateway.Plan, error) {
	return &pllmgateway.Plan{ID: planID, IsActive: true}, nil
}

func (s *stubLLMGatewayAdapter) ApplySubscription(_ context.Context, req *pllmgateway.ApplySubscriptionRequest) (*pllmgateway.Subscription, error) {
	return &pllmgateway.Subscription{UserID: req.UserID, PlanID: req.PlanID, Status: "active"}, nil
}

func (s *stubLLMGatewayAdapter) ExtendSubscription(_ context.Context, req *pllmgateway.ExtendSubscriptionRequest) (*pllmgateway.ExtendSubscriptionResponse, error) {
	return &pllmgateway.ExtendSubscriptionResponse{
		Subscription: &pllmgateway.Subscription{UserID: req.UserID, Status: "active"},
		Updated:      true,
	}, nil
}

func (s *stubLLMGatewayAdapter) CancelSubscription(_ context.Context, _ string) error {
	return nil
}

func (s *stubLLMGatewayAdapter) GetActiveSubscription(_ context.Context, _ string) (*pllmgateway.Subscription, error) {
	return nil, nil
}

// --- Stub Adapter Factory ---

type stubAdapterFactory struct {
	sandbox   psandbox.Adapter
	aigateway pllmgateway.Adapter
}

func (f *stubAdapterFactory) SandboxAdapter() psandbox.Adapter       { return f.sandbox }
func (f *stubAdapterFactory) StsAdapter() sts.Adapter                { return nil }
func (f *stubAdapterFactory) WhitelistAdapter() whitelist.Adapter    { return nil }
func (f *stubAdapterFactory) LLMGatewayAdapter() pllmgateway.Adapter { return f.aigateway }
func (f *stubAdapterFactory) OpenClawGatewayAdapter() popenclawgateway.Adapter {
	return nil
}
func (f *stubAdapterFactory) ShadowAdapter() shadow.Adapter { return nil }

// installStubAdapterFactory 替换全局 adapter factory，返回还原函数。
func installStubAdapterFactory(sandbox psandbox.Adapter) func() {
	original := adapterfactory.DefaultAdapterFactory
	adapterfactory.DefaultAdapterFactory = &stubAdapterFactory{
		sandbox:   sandbox,
		aigateway: &stubLLMGatewayAdapter{},
	}
	return func() {
		adapterfactory.DefaultAdapterFactory = original
	}
}

// --- helpers ---

func sendTaskMessage(t *testing.T, client *goredis.Client, streamKey string, taskName, taskID, userID string, payload interface{}) {
	t.Helper()

	payloadBytes, err := json.Marshal(payload)
	require.NoError(t, err)

	msg := &common.TaskMessage{
		TaskName: taskName,
		TaskId:   taskID,
		TraceId:  "test-trace",
		Data:     payloadBytes,
	}
	msg.Account.UserID = userID

	msgBytes, err := json.Marshal(msg)
	require.NoError(t, err)

	_, err = client.XAdd(context.Background(), &goredis.XAddArgs{
		Stream: streamKey,
		ID:     "*",
		Values: map[string]interface{}{"data": string(msgBytes)},
	}).Result()
	require.NoError(t, err)
}

func processOneMessage(t *testing.T, client *goredis.Client, streamKey string) error {
	t.Helper()

	msgs, err := client.XRange(context.Background(), streamKey, "-", "+").Result()
	require.NoError(t, err)
	require.NotEmpty(t, msgs, "no messages in stream")

	proc := processor.NewProcessor(zap.NewNop())
	mqMsg := &mq.Message{
		Id:   msgs[0].ID,
		Data: []byte(msgs[0].Values["data"].(string)),
	}
	if err := proc.Process(mqMsg); err != nil {
		return err
	}
	return proc.Wait()
}

func insertInstance(t *testing.T, instanceID, userID, status, sandboxID string) {
	t.Helper()
	entity := &modelinstance.Entity{
		InstanceId: instanceID,
		UserId:     userID,
		Status:     status,
		SandboxId:  sandboxID,
		TimeoutAt:  time.Now().Add(1 * time.Hour),
	}
	err := resource.GormDB.Table(modelinstance.TableName).Create(entity).Error
	require.NoError(t, err)
}

func insertQuota(t *testing.T, userID string) {
	t.Helper()
	err := resource.GormDB.Exec(
		"INSERT INTO user_resource_quota (user_id, resource_name, resource_key, resource_quota_available, resource_quota_total) VALUES (?, 'OPENCLAW_INSTANCE', '', 4, 5)",
		userID,
	).Error
	require.NoError(t, err)
}

func insertTaskRecord(t *testing.T, taskID, taskName, userID string, state string, executeCount, maxExecuteCount int) {
	t.Helper()
	now := time.Now()
	entity := &taskmodel.Entity{
		TaskId:          taskID,
		TaskName:        taskName,
		TaskState:       state,
		TaskParams:      "{}",
		TraceId:         "test-trace",
		ExecuteInterval: 30,
		ExecuteCount:    executeCount,
		MaxExecuteCount: maxExecuteCount,
		LastExecuteTime: time.Unix(0, 0),
	}
	entity.UserID = userID
	entity.CreatedTime = &now
	err := resource.GormDB.Table(taskmodel.TableName).Create(entity).Error
	require.NoError(t, err)
}

// --- Tests ---

func TestProcessorConsume_CreateInstance_Success(t *testing.T) {
	client, streamKey := setupTestEnv(t)

	sandboxStub := &stubSandboxAdapter{
		createSandboxFunc: func(_ context.Context, req *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
			return &psandbox.Sandbox{SandboxID: "sbx-integ-001", TemplateID: req.TemplateID}, nil
		},
	}
	restore := installStubAdapterFactory(sandboxStub)
	defer restore()

	userID := "user-create-success"
	instanceID := "ins-create-success"
	taskID := "task-create-success"

	// 预置数据
	insertInstance(t, instanceID, userID, modelinstance.InstanceStatusCreating, "pending-"+instanceID)
	insertQuota(t, userID)
	insertTaskRecord(t, taskID, common.TaskNameCreateInstance, userID, taskmodel.StateCreated, 0, 20)

	// 发送消息
	payload := &common.CreateInstanceTaskPayload{InstanceID: instanceID, Timeout: 300}
	sendTaskMessage(t, client, streamKey, common.TaskNameCreateInstance, taskID, userID, payload)

	// 处理
	err := processOneMessage(t, client, streamKey)
	require.NoError(t, err)

	// 验证 task state
	taskEntity := getTaskByTaskID(t, taskID)
	assert.Equal(t, taskmodel.StateSuccess, taskEntity.TaskState)

	// 验证 instance 状态
	var inst modelinstance.Entity
	err = resource.GormDB.Table(modelinstance.TableName).
		Where("instance_id = ?", instanceID).First(&inst).Error
	require.NoError(t, err)
	assert.Equal(t, modelinstance.InstanceStatusRunning, inst.Status)
	assert.Equal(t, "sbx-integ-001", inst.SandboxId)
}

func TestProcessorConsume_CreateInstance_SandboxFail(t *testing.T) {
	client, streamKey := setupTestEnv(t)

	sandboxStub := &stubSandboxAdapter{
		createSandboxFunc: func(_ context.Context, _ *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
			return nil, fmt.Errorf("sandbox service unavailable")
		},
	}
	restore := installStubAdapterFactory(sandboxStub)
	defer restore()

	userID := "user-create-fail"
	instanceID := "ins-create-fail"
	taskID := "task-create-fail"

	insertInstance(t, instanceID, userID, modelinstance.InstanceStatusCreating, "pending-"+instanceID)
	insertQuota(t, userID)
	insertTaskRecord(t, taskID, common.TaskNameCreateInstance, userID, taskmodel.StateCreated, 0, 20)

	payload := &common.CreateInstanceTaskPayload{InstanceID: instanceID, Timeout: 300}
	sendTaskMessage(t, client, streamKey, common.TaskNameCreateInstance, taskID, userID, payload)

	// 处理 — processor 本身不返回 error（execute 在 goroutine 中运行）
	err := processOneMessage(t, client, streamKey)
	require.NoError(t, err)

	// 验证 task state: 单次失败也必须收口，避免 bypass 重放同一个 RUNNING task。
	taskEntity := getTaskByTaskID(t, taskID)
	assert.Equal(t, taskmodel.StateFailed, taskEntity.TaskState)
	assert.NotEmpty(t, taskEntity.TaskMessage)

	var inst modelinstance.Entity
	err = resource.GormDB.Table(modelinstance.TableName).
		Where("instance_id = ?", instanceID).First(&inst).Error
	require.NoError(t, err)
	assert.Equal(t, modelinstance.InstanceStatusFailed, inst.Status)
}

func TestProcessorConsume_DestroyInstance_Success(t *testing.T) {
	client, streamKey := setupTestEnv(t)

	sandboxStub := &stubSandboxAdapter{
		deleteSandboxFunc: func(_ context.Context, _ string) error {
			return nil
		},
	}
	restore := installStubAdapterFactory(sandboxStub)
	defer restore()

	userID := "user-destroy-success"
	instanceID := "ins-destroy-success"
	taskID := "task-destroy-success"

	insertInstance(t, instanceID, userID, modelinstance.InstanceStatusDeleting, "sbx-to-delete")
	insertQuota(t, userID)
	insertTaskRecord(t, taskID, common.TaskNameDestroyInstance, userID, taskmodel.StateCreated, 0, 20)

	payload := &common.DestroyInstanceTaskPayload{InstanceID: instanceID, ReleaseQuota: true}
	sendTaskMessage(t, client, streamKey, common.TaskNameDestroyInstance, taskID, userID, payload)

	err := processOneMessage(t, client, streamKey)
	require.NoError(t, err)

	taskEntity := getTaskByTaskID(t, taskID)
	assert.Equal(t, taskmodel.StateSuccess, taskEntity.TaskState)

	// 验证 instance 软删除（查 unscoped）
	var inst modelinstance.Entity
	err = resource.GormDB.Unscoped().Table(modelinstance.TableName).
		Where("instance_id = ?", instanceID).First(&inst).Error
	require.NoError(t, err)
	assert.Equal(t, modelinstance.InstanceStatusDeleted, inst.Status)
}

func TestProcessorConsume_UnknownTaskName_ReturnsError(t *testing.T) {
	_, _ = setupTestEnv(t)

	restore := installStubAdapterFactory(&stubSandboxAdapter{})
	defer restore()

	// 直接构造消息，不需要 DB 数据
	msg := &common.TaskMessage{
		TaskName: "UnknownTask",
		TaskId:   "task-unknown",
		TraceId:  "trace-unknown",
	}
	msg.Account.UserID = "user-unknown"

	msgBytes, err := json.Marshal(msg)
	require.NoError(t, err)

	proc := processor.NewProcessor(zap.NewNop())
	err = proc.Process(&mq.Message{Data: msgBytes})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "processFunc not exist")
}

func TestWorkerStepFlow_ExceedMaxExecuteCount(t *testing.T) {
	client, streamKey := setupTestEnv(t)

	restore := installStubAdapterFactory(&stubSandboxAdapter{})
	defer restore()

	userID := "user-exceed-max"
	instanceID := "ins-exceed-max"
	taskID := "task-exceed-max"

	insertInstance(t, instanceID, userID, modelinstance.InstanceStatusCreating, "pending-"+instanceID)
	insertQuota(t, userID)
	// execute_count 已达 max
	insertTaskRecord(t, taskID, common.TaskNameCreateInstance, userID, taskmodel.StateRunning, 20, 20)

	payload := &common.CreateInstanceTaskPayload{InstanceID: instanceID, Timeout: 300}
	sendTaskMessage(t, client, streamKey, common.TaskNameCreateInstance, taskID, userID, payload)

	err := processOneMessage(t, client, streamKey)
	require.NoError(t, err)

	taskEntity := getTaskByTaskID(t, taskID)
	assert.Equal(t, taskmodel.StateFailed, taskEntity.TaskState)
	assert.Contains(t, taskEntity.TaskMessage, "MaxExecuteCount")
}

func TestWorkerStepFlow_IdempotentCheck_InstanceAlreadyRunning(t *testing.T) {
	client, streamKey := setupTestEnv(t)

	restore := installStubAdapterFactory(&stubSandboxAdapter{})
	defer restore()

	userID := "user-idempotent"
	instanceID := "ins-idempotent"
	taskID := "task-idempotent"

	// 预置 instance 已经 Running + sandbox_id 有效
	insertInstance(t, instanceID, userID, modelinstance.InstanceStatusRunning, "sbx-running-ok")
	insertQuota(t, userID)
	insertTaskRecord(t, taskID, common.TaskNameCreateInstance, userID, taskmodel.StateCreated, 0, 20)

	// 在 Redis 中预设 task 锁（模拟 LockTask 会失败）
	lockKey := fmt.Sprintf("lock-task-%s", taskID)
	err := client.Set(context.Background(), lockKey, "other-request", 5*time.Minute).Err()
	require.NoError(t, err)

	payload := &common.CreateInstanceTaskPayload{InstanceID: instanceID, Timeout: 300}
	sendTaskMessage(t, client, streamKey, common.TaskNameCreateInstance, taskID, userID, payload)

	err = processOneMessage(t, client, streamKey)
	require.NoError(t, err)

	// 验证: tasks 表 state=SUCCESS（幂等检查跳过执行）
	taskEntity := getTaskByTaskID(t, taskID)
	assert.Equal(t, taskmodel.StateSuccess, taskEntity.TaskState)
}
