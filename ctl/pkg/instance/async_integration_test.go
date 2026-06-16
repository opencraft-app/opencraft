//go:build integration

package instance

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

	paigateway "ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	popenclawgateway "ctl/pkg/adapter/openclawgateway"
	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/adapter/shadow"
	"ctl/pkg/adapter/sts"
	"ctl/pkg/adapter/trade"
	"ctl/pkg/adapter/whitelist"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/logic/objectid"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	taskmodel "ctl/pkg/model/task"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/pkg/mq"
	redisMQ "ctl/pkg/mq/redis"
	"ctl/pkg/resource"
	"ctl/pkg/taskruntime/common"
	"ctl/test/testutil"
)

const testMigrationsPath = "../../migrations"

// setupEnqueueTestEnv 初始化 MySQL + Redis + config 覆写。
func setupEnqueueTestEnv(t *testing.T) (*goredis.Client, string) {
	t.Helper()

	resource.ZapLogger = zap.NewNop()

	// MySQL + migration
	testutil.NewMySQLDB(t, testMigrationsPath)

	// Redis
	client := testutil.NewRedisClient(t)

	// 独立 stream key
	streamKey := fmt.Sprintf("test-enqueue-stream-%d", time.Now().UnixNano())
	if config.ServerConf.MQConfig == nil {
		config.ServerConf.MQConfig = &config.MQConfig{}
	}
	config.ServerConf.MQConfig.StreamKey = streamKey
	config.ServerConf.MQConfig.GroupName = "test-group"
	config.ServerConf.MQConfig.MaxLen = 10000

	return client, streamKey
}

// newMinimalLogic 创建一个用于测试 enqueueTask 的最小化 logic 实例。
func newMinimalLogic(t *testing.T, producer mq.Producer) *logic {
	t.Helper()
	return &logic{
		taskDao:       modelfactory.DefaultDaoFactory.TaskDao(nil),
		producer:      producer,
		objectIdLogic: objectid.NewLogic(),
		logger:        zap.NewNop(),
	}
}

func ensureInstanceAPIConfigForInlineTests() {
	if config.ServerConf.APIConfig == nil {
		config.ServerConf.APIConfig = &config.APIConfig{}
	}
	if config.ServerConf.APIConfig.Instance == nil {
		config.ServerConf.APIConfig.Instance = &config.InstanceAPIConfig{}
	}
}

func disableCreateGuardsForInlineTests(t *testing.T) {
	t.Helper()
	ensureInstanceAPIConfigForInlineTests()
	instance := config.ServerConf.APIConfig.Instance
	originalChurn := instance.ChurnGuardEnabled
	originalAbuse := instance.UserAbuseGuardEnabled
	churnDisabled := false
	abuseDisabled := false
	instance.ChurnGuardEnabled = &churnDisabled
	instance.UserAbuseGuardEnabled = &abuseDisabled
	t.Cleanup(func() {
		instance.ChurnGuardEnabled = originalChurn
		instance.UserAbuseGuardEnabled = originalAbuse
	})
}

func TestEnqueueTask_Success(t *testing.T) {
	client, streamKey := setupEnqueueTestEnv(t)

	producer := redisMQ.NewProducer(client, &redisMQ.ProducerConfig{
		StreamKey: streamKey,
		MaxLen:    10000,
	})

	l := newMinimalLogic(t, producer)

	ctx := testutil.NewContext(t, "test-user-001")
	payload := &CreateInstanceTaskPayload{
		InstanceID: "ins-test-001",
		Timeout:    300,
	}

	taskID, err := l.enqueueTask(ctx, TaskNameCreateInstance, payload, "")
	require.NoError(t, err)
	require.NotEmpty(t, taskID)

	// 验证 DB task 记录
	var entity taskmodel.Entity
	err = resource.GormDB.Table(taskmodel.TableName).
		Where(taskmodel.ColumnTaskId+" = ?", taskID).
		First(&entity).Error
	require.NoError(t, err)

	assert.Equal(t, taskmodel.StateCreated, entity.TaskState)
	assert.Equal(t, TaskNameCreateInstance, entity.TaskName)
	assert.Equal(t, ctx.GetRequestId(), entity.TraceId)
	assert.NotEmpty(t, entity.TaskParams)

	// 验证 Redis Stream 消息
	msgs := readStreamMessages(t, client, streamKey)
	require.Len(t, msgs, 1)

	data, ok := msgs[0].Values["data"]
	require.True(t, ok)

	var taskMsg common.TaskMessage
	err = json.Unmarshal([]byte(data.(string)), &taskMsg)
	require.NoError(t, err)
	assert.Equal(t, TaskNameCreateInstance, taskMsg.TaskName)
	assert.Equal(t, taskID, taskMsg.TaskId)
	assert.Equal(t, ctx.GetRequestId(), taskMsg.TraceId)
}

func TestEnqueueTask_ProducerFail_TaskMarkedFailed(t *testing.T) {
	_, _ = setupEnqueueTestEnv(t)

	// 注入一个总是失败的 producer
	failProducer := &failingProducer{err: fmt.Errorf("redis connection refused")}
	l := newMinimalLogic(t, failProducer)

	ctx := testutil.NewContext(t, "test-user-002")
	payload := &CreateInstanceTaskPayload{
		InstanceID: "ins-test-002",
		Timeout:    300,
	}

	taskID, err := l.enqueueTask(ctx, TaskNameCreateInstance, payload, "")
	require.Error(t, err)
	require.NotEmpty(t, taskID)

	// 验证 DB task 记录被标记为 FAILED
	var entity taskmodel.Entity
	dbErr := resource.GormDB.Table(taskmodel.TableName).
		Where(taskmodel.ColumnTaskId+" = ?", taskID).
		First(&entity).Error
	require.NoError(t, dbErr)
	assert.Equal(t, taskmodel.StateFailed, entity.TaskState)
	assert.Contains(t, entity.TaskMessage, "redis connection refused")
}

func TestEnqueueTask_NilProducer_ReturnsError(t *testing.T) {
	_, _ = setupEnqueueTestEnv(t)

	l := &logic{
		taskDao:       modelfactory.DefaultDaoFactory.TaskDao(nil),
		producer:      nil,
		objectIdLogic: objectid.NewLogic(),
		logger:        zap.NewNop(),
	}

	ctx := testutil.NewContext(t, "test-user-003")
	payload := &CreateInstanceTaskPayload{
		InstanceID: "ins-test-003",
		Timeout:    300,
	}

	_, err := l.enqueueTask(ctx, TaskNameCreateInstance, payload, "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "mq producer is nil")
}

// --- helpers ---

type failingProducer struct {
	err error
}

func (p *failingProducer) Send(_ *mq.Message) error {
	return p.err
}

func readStreamMessages(t *testing.T, client *goredis.Client, streamKey string) []goredis.XMessage {
	t.Helper()
	msgs, err := client.XRange(pctx.NewContext(nil), streamKey, "-", "+").Result()
	require.NoError(t, err)
	return msgs
}

// --- Stub Adapters for Inline Tests ---

type stubSandboxAdapterInline struct {
	createFunc func(ctx context.Context, req *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error)
	deleteFunc func(ctx context.Context, sandboxID string) error
	requests   []*psandbox.CreateSandboxRequest
}

func (s *stubSandboxAdapterInline) CreateSandbox(ctx context.Context, req *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
	if req != nil {
		cloned := *req
		if req.Metadata != nil {
			cloned.Metadata = make(map[string]string, len(req.Metadata))
			for k, v := range req.Metadata {
				cloned.Metadata[k] = v
			}
		}
		s.requests = append(s.requests, &cloned)
	}
	if s.createFunc != nil {
		return s.createFunc(ctx, req)
	}
	return &psandbox.Sandbox{SandboxID: "sbx-inline-001", TemplateID: req.TemplateID}, nil
}
func (s *stubSandboxAdapterInline) GetSandbox(_ context.Context, _ string) (*psandbox.SandboxDetail, error) {
	return nil, nil
}
func (s *stubSandboxAdapterInline) ListSandboxes(_ context.Context, _ *psandbox.ListSandboxesRequest) ([]psandbox.ListedSandbox, error) {
	return nil, nil
}
func (s *stubSandboxAdapterInline) ListPools(_ context.Context) ([]psandbox.Pool, error) {
	return nil, nil
}
func (s *stubSandboxAdapterInline) ListPoolInstances(_ context.Context, _ string) ([]psandbox.PoolInstance, error) {
	return nil, nil
}
func (s *stubSandboxAdapterInline) DeleteSandbox(ctx context.Context, sandboxID string) error {
	if s.deleteFunc != nil {
		return s.deleteFunc(ctx, sandboxID)
	}
	return nil
}
func (s *stubSandboxAdapterInline) PauseSandbox(_ context.Context, _ string) error { return nil }
func (s *stubSandboxAdapterInline) ResumeSandbox(_ context.Context, _ string, _ *psandbox.ResumeSandboxRequest) (*psandbox.Sandbox, error) {
	return nil, nil
}
func (s *stubSandboxAdapterInline) SetTimeout(_ context.Context, _ string, _ int32) error { return nil }
func (s *stubSandboxAdapterInline) Refresh(_ context.Context, _ string, _ int32) error    { return nil }
func (s *stubSandboxAdapterInline) GetLogs(_ context.Context, _ string, _ *psandbox.GetLogsRequest) (*psandbox.SandboxLogs, error) {
	return nil, nil
}
func (s *stubSandboxAdapterInline) ExecCommand(_ context.Context, _ string, _ string, _ int) (*psandbox.ExecCommandResult, error) {
	return &psandbox.ExecCommandResult{Status: "SUCCESS"}, nil
}
func (s *stubSandboxAdapterInline) GetCommandResult(_ context.Context, _ string, _ string) (*psandbox.ExecCommandResult, error) {
	return nil, nil
}
func (s *stubSandboxAdapterInline) StartProcessStream(_ context.Context, _ string, _ *psandbox.ProcessStartRequest, _ func(psandbox.ProcessStreamEvent) error) error {
	return nil
}
func (s *stubSandboxAdapterInline) RunProcessWithStdin(_ context.Context, _ string, _ *psandbox.ProcessStartRequest, _ []byte) (*psandbox.ExecCommandResult, error) {
	return &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 0}, nil
}
func (s *stubSandboxAdapterInline) SendProcessSignal(_ context.Context, _ string, _ uint32, _ string) error {
	return nil
}
func (s *stubSandboxAdapterInline) CreateSnapshot(_ context.Context, _ string, _ *psandbox.CreateSnapshotRequest) (*psandbox.CreateSnapshotResponse, error) {
	return nil, nil
}
func (s *stubSandboxAdapterInline) GetSnapshotStatus(_ context.Context, _, _ string) (*psandbox.GetSnapshotStatusResponse, error) {
	return nil, nil
}

type stubAiGatewayAdapterInline struct{}

func (s *stubAiGatewayAdapterInline) CreateApiKey(_ context.Context, _ string, _ string) (*paigateway.CreateApiKeyResponse, error) {
	return nil, fmt.Errorf("ai gateway not configured")
}

func (s *stubAiGatewayAdapterInline) EnsureUser(_ context.Context, userID string, nickname string) (*paigateway.EnsureUserResponse, error) {
	return &paigateway.EnsureUserResponse{UserID: userID, Result: "created"}, nil
}

func (s *stubAiGatewayAdapterInline) RevokeApiKey(_ context.Context, _ string) error {
	return nil
}

func (s *stubAiGatewayAdapterInline) GetUserUsage(_ context.Context, _ string) (*paigateway.UserUsageResponse, error) {
	return &paigateway.UserUsageResponse{}, nil
}

func (s *stubAiGatewayAdapterInline) GetPlan(_ context.Context, _ string) (*paigateway.Plan, error) {
	return nil, fmt.Errorf("plan lookup not configured")
}

func (s *stubAiGatewayAdapterInline) ApplySubscription(_ context.Context, _ *paigateway.ApplySubscriptionRequest) (*paigateway.Subscription, error) {
	return nil, fmt.Errorf("subscription apply not configured")
}

func (s *stubAiGatewayAdapterInline) ExtendSubscription(_ context.Context, _ *paigateway.ExtendSubscriptionRequest) (*paigateway.ExtendSubscriptionResponse, error) {
	return nil, fmt.Errorf("subscription extend not configured")
}

func (s *stubAiGatewayAdapterInline) CancelSubscription(_ context.Context, _ string) error {
	return nil
}

func (s *stubAiGatewayAdapterInline) GetActiveSubscription(_ context.Context, _ string) (*paigateway.Subscription, error) {
	return nil, nil
}

type inlineStubAdapterFactory struct {
	sandbox   psandbox.Adapter
	aigateway paigateway.Adapter
}

func (f *inlineStubAdapterFactory) SandboxAdapter() psandbox.Adapter     { return f.sandbox }
func (f *inlineStubAdapterFactory) StsAdapter() sts.Adapter              { return nil }
func (f *inlineStubAdapterFactory) WhitelistAdapter() whitelist.Adapter  { return nil }
func (f *inlineStubAdapterFactory) AiGatewayAdapter() paigateway.Adapter { return f.aigateway }
func (f *inlineStubAdapterFactory) OpenClawGatewayAdapter() popenclawgateway.Adapter {
	return nil
}
func (f *inlineStubAdapterFactory) ShadowAdapter() shadow.Adapter { return nil }
func (f *inlineStubAdapterFactory) TradeAdapter() trade.Adapter   { return nil }

func installInlineStubFactory(sandbox psandbox.Adapter) func() {
	original := adapterfactory.DefaultAdapterFactory
	adapterfactory.DefaultAdapterFactory = &inlineStubAdapterFactory{
		sandbox:   sandbox,
		aigateway: &stubAiGatewayAdapterInline{},
	}
	return func() {
		adapterfactory.DefaultAdapterFactory = original
	}
}

func insertInlineInstance(t *testing.T, instanceID, userID, status, sandboxID string) {
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

func insertInlineQuota(t *testing.T, userID string) {
	t.Helper()
	err := resource.GormDB.Table(quota.TableName).Create(&quota.Entity{
		UserID:                 userID,
		ResourceName:           "OPENCLAW_INSTANCE",
		ResourceKey:            "",
		ResourceQuotaAvailable: 4,
		ResourceQuotaTotal:     5,
	}).Error
	require.NoError(t, err)
}

// --- Inline Tests ---

func TestInlineCreateTask_Success(t *testing.T) {
	_, _ = setupEnqueueTestEnv(t)
	ensureInstanceAPIConfigForInlineTests()
	originalDefaultSKUID := config.ServerConf.APIConfig.Instance.DefaultSKUID
	config.ServerConf.APIConfig.Instance.DefaultSKUID = "sku-hermes-4c8g"
	t.Cleanup(func() {
		config.ServerConf.APIConfig.Instance.DefaultSKUID = originalDefaultSKUID
	})

	sandboxStub := &stubSandboxAdapterInline{
		createFunc: func(_ context.Context, req *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
			return &psandbox.Sandbox{SandboxID: "sbx-inline-create", TemplateID: req.TemplateID}, nil
		},
	}
	restore := installInlineStubFactory(sandboxStub)
	defer restore()

	userID := "user-inline-create"
	instanceID := "ins-inline-create"

	insertInlineInstance(t, instanceID, userID, modelinstance.InstanceStatusCreating, "pending-"+instanceID)
	insertInlineQuota(t, userID)

	instanceDao := modelfactory.DefaultDaoFactory.InstanceDao(nil)
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(nil)
	l := NewLogicForTest(instanceDao, quotaDao, sandboxStub, nil, nil, zap.NewNop(), "test-template")

	ctx := testutil.NewContext(t, userID)
	testutil.SeedActivePass(t, ctx)
	resp, err := l.CreateInstance(ctx, nil)
	require.NoError(t, err)
	require.NotNil(t, resp)

	// 验证 task state
	var taskEntity taskmodel.Entity
	err = resource.GormDB.Table(taskmodel.TableName).
		Where(taskmodel.ColumnTaskName+" = ? AND "+taskmodel.ColumnUserID+" = ?", common.TaskNameCreateInstance, userID).
		Order("id DESC").First(&taskEntity).Error
	require.NoError(t, err)
	assert.Equal(t, taskmodel.StateSuccess, taskEntity.TaskState)

	// 验证 instance 状态
	var inst modelinstance.Entity
	err = resource.GormDB.Table(modelinstance.TableName).
		Where("instance_id = ?", resp.InstanceID).First(&inst).Error
	require.NoError(t, err)
	assert.Equal(t, modelinstance.InstanceStatusRunning, inst.Status)
	require.NotEmpty(t, sandboxStub.requests)
	assert.Equal(t, "sku-hermes-4c8g", sandboxStub.requests[0].SKUID)
}

func TestInlineCreateTask_SandboxFail(t *testing.T) {
	_, _ = setupEnqueueTestEnv(t)

	sandboxStub := &stubSandboxAdapterInline{
		createFunc: func(_ context.Context, _ *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
			return nil, fmt.Errorf("sandbox unavailable")
		},
	}
	restore := installInlineStubFactory(sandboxStub)
	defer restore()

	userID := "user-inline-fail"

	insertInlineQuota(t, userID)

	instanceDao := modelfactory.DefaultDaoFactory.InstanceDao(nil)
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(nil)
	l := NewLogicForTest(instanceDao, quotaDao, sandboxStub, nil, nil, zap.NewNop(), "test-template")

	ctx := testutil.NewContext(t, userID)
	testutil.SeedActivePass(t, ctx)
	_, err := l.CreateInstance(ctx, nil)
	require.Error(t, err)

	// 验证 task state=FAILED
	var taskEntity taskmodel.Entity
	dbErr := resource.GormDB.Table(taskmodel.TableName).
		Where(taskmodel.ColumnTaskName+" = ? AND "+taskmodel.ColumnUserID+" = ?", common.TaskNameCreateInstance, userID).
		Order("id DESC").First(&taskEntity).Error
	require.NoError(t, dbErr)
	assert.Equal(t, taskmodel.StateFailed, taskEntity.TaskState)

	// 验证 instance status=Failed
	var inst modelinstance.Entity
	dbErr = resource.GormDB.Table(modelinstance.TableName).
		Where(taskmodel.ColumnUserID+" = ?", userID).
		Order("id DESC").First(&inst).Error
	require.NoError(t, dbErr)
	assert.Equal(t, modelinstance.InstanceStatusFailed, inst.Status)
}

func TestInlineCreateTask_ReordersPoolsFromPressureSnapshotAndRetries(t *testing.T) {
	client, _ := setupEnqueueTestEnv(t)
	ensureInstanceAPIConfigForInlineTests()
	disableCreateGuardsForInlineTests(t)
	config.ServerConf.APIConfig.Instance.DefaultTemplateID = "pool-a"
	config.ServerConf.APIConfig.Instance.CandidateTemplateIDs = []string{"pool-b", "pool-c"}
	config.ServerConf.APIConfig.Instance.CreatePoolMaxAttempts = 3
	config.ServerConf.APIConfig.Instance.PressureTTLSec = 15

	snapshot := &poolPressureSnapshot{
		RefreshedAt: time.Now().UTC(),
		Pools: []poolPressurePoolSnapshot{
			{PoolID: "pool-a", Status: "RUNNING", Clean: 1, Creating: 2},
			{PoolID: "pool-b", Status: "RUNNING", Clean: 5},
		},
	}
	store := newRedisPoolPressureSnapshotStore(client)
	require.NoError(t, store.Save(context.Background(), snapshot, 15*time.Second))

	var attempted []string
	sandboxStub := &stubSandboxAdapterInline{
		createFunc: func(_ context.Context, req *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
			attempted = append(attempted, req.TemplateID)
			if req.TemplateID == "pool-b" {
				return nil, fmt.Errorf("pool-b unavailable")
			}
			return &psandbox.Sandbox{SandboxID: "sbx-inline-create-lb", TemplateID: req.TemplateID}, nil
		},
	}
	restore := installInlineStubFactory(sandboxStub)
	defer restore()

	userID := "user-inline-create-lb"
	insertInlineQuota(t, userID)

	instanceDao := modelfactory.DefaultDaoFactory.InstanceDao(nil)
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(nil)
	l := NewLogicForTest(instanceDao, quotaDao, sandboxStub, nil, nil, zap.NewNop(), "pool-a", "pool-b", "pool-c")

	ctx := testutil.NewContext(t, userID)
	testutil.SeedActivePass(t, ctx)
	resp, err := l.CreateInstance(ctx, nil)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, []string{"pool-b", "pool-a"}, attempted)
	assert.Equal(t, modelinstance.InstanceStatusRunning, resp.Status)
	assert.Equal(t, "pool-a", sandboxStub.requests[1].TemplateID)
	assert.Equal(t, "pool-b", sandboxStub.requests[0].TemplateID)
	assert.Len(t, sandboxStub.requests, 2)

	var taskEntity taskmodel.Entity
	err = resource.GormDB.Table(taskmodel.TableName).
		Where(taskmodel.ColumnTaskName+" = ? AND "+taskmodel.ColumnUserID+" = ?", common.TaskNameCreateInstance, userID).
		Order("id DESC").First(&taskEntity).Error
	require.NoError(t, err)
	assert.Equal(t, taskmodel.StateSuccess, taskEntity.TaskState)
	assert.Empty(t, taskEntity.TaskMessage)
}

func TestInlineCreateTask_StopsAtConfiguredAttemptLimit(t *testing.T) {
	client, _ := setupEnqueueTestEnv(t)
	ensureInstanceAPIConfigForInlineTests()
	disableCreateGuardsForInlineTests(t)
	config.ServerConf.APIConfig.Instance.DefaultTemplateID = "pool-a"
	config.ServerConf.APIConfig.Instance.CandidateTemplateIDs = []string{"pool-b", "pool-c"}
	config.ServerConf.APIConfig.Instance.CreatePoolMaxAttempts = 2
	config.ServerConf.APIConfig.Instance.PressureTTLSec = 15

	snapshot := &poolPressureSnapshot{
		RefreshedAt: time.Now().UTC(),
		Pools: []poolPressurePoolSnapshot{
			{PoolID: "pool-a", Status: "RUNNING", Clean: 1},
			{PoolID: "pool-b", Status: "RUNNING", Clean: 4},
			{PoolID: "pool-c", Status: "RUNNING", Clean: 3},
		},
	}
	store := newRedisPoolPressureSnapshotStore(client)
	require.NoError(t, store.Save(context.Background(), snapshot, 15*time.Second))

	var attempted []string
	sandboxStub := &stubSandboxAdapterInline{
		createFunc: func(_ context.Context, req *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
			attempted = append(attempted, req.TemplateID)
			return nil, fmt.Errorf("all pools unavailable: %s", req.TemplateID)
		},
	}
	restore := installInlineStubFactory(sandboxStub)
	defer restore()

	userID := "user-inline-create-limit"
	insertInlineQuota(t, userID)

	instanceDao := modelfactory.DefaultDaoFactory.InstanceDao(nil)
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(nil)
	l := NewLogicForTest(instanceDao, quotaDao, sandboxStub, nil, nil, zap.NewNop(), "pool-a", "pool-b", "pool-c")

	ctx := testutil.NewContext(t, userID)
	testutil.SeedActivePass(t, ctx)
	_, err := l.CreateInstance(ctx, nil)
	require.Error(t, err)
	assert.Equal(t, []string{"pool-b", "pool-c"}, attempted)
	assert.Len(t, sandboxStub.requests, 2)
	assert.Contains(t, err.Error(), "pool-b")
	assert.Contains(t, err.Error(), "pool-c")
	assert.NotContains(t, err.Error(), "pool-a")

	var taskEntity taskmodel.Entity
	dbErr := resource.GormDB.Table(taskmodel.TableName).
		Where(taskmodel.ColumnTaskName+" = ? AND "+taskmodel.ColumnUserID+" = ?", common.TaskNameCreateInstance, userID).
		Order("id DESC").First(&taskEntity).Error
	require.NoError(t, dbErr)
	assert.Equal(t, taskmodel.StateFailed, taskEntity.TaskState)
	assert.Contains(t, taskEntity.TaskMessage, "pool-b")
	assert.Contains(t, taskEntity.TaskMessage, "pool-c")

	var inst modelinstance.Entity
	dbErr = resource.GormDB.Table(modelinstance.TableName).
		Where(taskmodel.ColumnUserID+" = ?", userID).
		Order("id DESC").First(&inst).Error
	require.NoError(t, dbErr)
	assert.Equal(t, modelinstance.InstanceStatusFailed, inst.Status)
}

func TestInlineDestroyTask_Success(t *testing.T) {
	_, _ = setupEnqueueTestEnv(t)

	sandboxStub := &stubSandboxAdapterInline{
		deleteFunc: func(_ context.Context, _ string) error {
			return nil
		},
	}
	restore := installInlineStubFactory(sandboxStub)
	defer restore()

	userID := "user-inline-destroy"
	instanceID := "ins-inline-destroy"

	insertInlineInstance(t, instanceID, userID, modelinstance.InstanceStatusRunning, "sbx-to-destroy")
	insertInlineQuota(t, userID)

	instanceDao := modelfactory.DefaultDaoFactory.InstanceDao(nil)
	quotaDao := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(nil)
	l := NewLogicForTest(instanceDao, quotaDao, sandboxStub, nil, nil, zap.NewNop(), "test-template")

	ctx := testutil.NewContext(t, userID)
	resp, err := l.DestroyInstance(ctx, instanceID)
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, modelinstance.InstanceStatusDeleted, resp.Status)

	// 验证 task state=SUCCESS
	var taskEntity taskmodel.Entity
	dbErr := resource.GormDB.Table(taskmodel.TableName).
		Where(taskmodel.ColumnTaskName+" = ? AND "+taskmodel.ColumnUserID+" = ?", common.TaskNameDestroyInstance, userID).
		Order("id DESC").First(&taskEntity).Error
	require.NoError(t, dbErr)
	assert.Equal(t, taskmodel.StateSuccess, taskEntity.TaskState)
}
