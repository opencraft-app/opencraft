package instance

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	"ctl/pkg/config"
	modelfactory "ctl/pkg/model/factory"
	modelinstance "ctl/pkg/model/instance"
	quota "ctl/pkg/model/userresourcequota"
	"ctl/test/testutil"

	"go.uber.org/zap"
)

type fakeChurnCounter struct {
	counts     map[string]int64
	retryAfter map[string]time.Duration
	recorded   map[string]int
}

func (f *fakeChurnCounter) RecordEvent(_ context.Context, _ string, eventType, _ string, _ time.Time, _ time.Duration) error {
	if f.recorded == nil {
		f.recorded = make(map[string]int)
	}
	f.recorded[eventType]++
	return nil
}

func (f *fakeChurnCounter) Count(_ context.Context, _ string, eventType string, _ time.Time, _ time.Duration) (int64, error) {
	return f.counts[eventType], nil
}

func (f *fakeChurnCounter) RetryAfter(_ context.Context, _ string, eventType string, _ int, _ time.Time, _ time.Duration) (time.Duration, error) {
	return f.retryAfter[eventType], nil
}

type fakeSnapshotStore struct {
	snapshot *poolPressureSnapshot
}

func (f *fakeSnapshotStore) Save(context.Context, *poolPressureSnapshot, time.Duration) error {
	return nil
}

func (f *fakeSnapshotStore) Load(context.Context) (*poolPressureSnapshot, error) {
	return f.snapshot, nil
}

type fakePoolPressureFetcher struct {
	pools     []psandbox.Pool
	instances map[string][]psandbox.PoolInstance
	errs      map[string]error
}

type fakeUserAbuseCooldownStore struct {
	remaining time.Duration
	active    bool
	started   bool
	count     int64
}

func (f *fakePoolPressureFetcher) ListPools(context.Context) ([]psandbox.Pool, error) {
	return f.pools, nil
}

func (f *fakePoolPressureFetcher) ListPoolInstances(_ context.Context, poolID string) ([]psandbox.PoolInstance, error) {
	if err := f.errs[poolID]; err != nil {
		return nil, err
	}
	return f.instances[poolID], nil
}

func (f *fakeUserAbuseCooldownStore) Activate(_ context.Context, _ string, _ time.Time, _ time.Duration) (time.Duration, bool, error) {
	f.active = true
	if f.remaining <= 0 {
		f.remaining = 10 * time.Minute
	}
	if f.count == 0 {
		f.count = 1
	}
	return f.remaining, f.started, nil
}

func (f *fakeUserAbuseCooldownStore) Remaining(_ context.Context, _ string, _ time.Time) (time.Duration, bool, error) {
	return f.remaining, f.active, nil
}

func (f *fakeUserAbuseCooldownStore) ActiveCount(_ context.Context, _ time.Time) (int64, error) {
	return f.count, nil
}

func testChurnGuardConfig() *config.InstanceAPIConfig {
	enabled := true
	return &config.InstanceAPIConfig{
		DefaultTemplateID:         "pool-a",
		ChurnGuardEnabled:         &enabled,
		UserAbuseGuardEnabled:     &enabled,
		ChurnWindowSeconds:        600,
		CreateThreshold:           3,
		DestroyThreshold:          2,
		UserAbuseCreateThreshold:  10,
		UserAbuseDestroyThreshold: 8,
		UserAbuseCooldownSeconds:  600,
		UserAbuseRefreshSeconds:   10,
		PressureTTLSec:            15,
		PressureCleanRatio:        0.25,
		PressureMinClean:          2,
	}
}

func TestCreateChurnGuardAllowsBelowThreshold(t *testing.T) {
	ctx := testutil.NewContext(t, "usr-allow")
	guard := &createChurnGuard{
		conf: testChurnGuardConfig(),
		counter: &fakeChurnCounter{
			counts: map[string]int64{
				churnEventCreateSuccess: 2,
				churnEventDestroyAccept: 2,
			},
			retryAfter: map[string]time.Duration{},
		},
		snapshots: &fakeSnapshotStore{
			snapshot: &poolPressureSnapshot{
				RefreshedAt: time.Now(),
				State:       poolPressureStateHot,
			},
		},
		cooldowns: &fakeUserAbuseCooldownStore{},
		logger:    zap.NewNop(),
	}

	decision, err := guard.EvaluateCreate(ctx, []string{"pool-a"})
	if err != nil {
		t.Fatalf("EvaluateCreate error: %v", err)
	}
	if !decision.Allow {
		t.Fatalf("expected allow decision, got %+v", decision)
	}
	if decision.Reason != "below_threshold" {
		t.Fatalf("unexpected reason: %s", decision.Reason)
	}
}

func TestCreateChurnGuardRejectsWhenUserHotAndPoolHot(t *testing.T) {
	ctx := testutil.NewContext(t, "usr-reject")
	guard := &createChurnGuard{
		conf: testChurnGuardConfig(),
		counter: &fakeChurnCounter{
			counts: map[string]int64{
				churnEventCreateSuccess: 4,
				churnEventDestroyAccept: 3,
			},
			retryAfter: map[string]time.Duration{
				churnEventCreateSuccess: 90 * time.Second,
				churnEventDestroyAccept: 45 * time.Second,
			},
		},
		snapshots: &fakeSnapshotStore{
			snapshot: &poolPressureSnapshot{
				RefreshedAt: time.Now(),
				State:       poolPressureStateHot,
			},
		},
		cooldowns: &fakeUserAbuseCooldownStore{},
		logger:    zap.NewNop(),
	}

	decision, err := guard.EvaluateCreate(ctx, []string{"pool-a", "pool-b"})
	if err != nil {
		t.Fatalf("EvaluateCreate error: %v", err)
	}
	if decision.Allow {
		t.Fatalf("expected reject decision, got %+v", decision)
	}
	if decision.RetryAfter != 45*time.Second {
		t.Fatalf("unexpected retry-after: %s", decision.RetryAfter)
	}
	if decision.PressureState != poolPressureStateHot {
		t.Fatalf("unexpected pressure state: %s", decision.PressureState)
	}
}

func TestCreateChurnGuardRejectsWhenUserAbuseCooldownIsActive(t *testing.T) {
	ctx := testutil.NewContext(t, "usr-abuse-active")
	conf := testChurnGuardConfig()
	conf.CreateThreshold = 100
	conf.DestroyThreshold = 100
	guard := &createChurnGuard{
		conf: conf,
		counter: &fakeChurnCounter{
			counts: map[string]int64{
				churnEventCreateSuccess: 12,
				churnEventDestroyAccept: 9,
			},
			retryAfter: map[string]time.Duration{},
		},
		cooldowns: &fakeUserAbuseCooldownStore{
			active:    true,
			remaining: 7 * time.Minute,
			count:     1,
		},
		snapshots: &fakeSnapshotStore{
			snapshot: &poolPressureSnapshot{
				RefreshedAt: time.Now(),
				State:       poolPressureStateCold,
			},
		},
		logger: zap.NewNop(),
	}

	decision, err := guard.EvaluateCreate(ctx, []string{"pool-a"})
	if err != nil {
		t.Fatalf("EvaluateCreate error: %v", err)
	}
	if decision.Allow {
		t.Fatalf("expected active cooldown reject, got %+v", decision)
	}
	if decision.Reason != "user_abuse_cooldown_active" {
		t.Fatalf("unexpected reason: %s", decision.Reason)
	}
	if decision.RetryAfter != 7*time.Minute {
		t.Fatalf("unexpected retry-after: %s", decision.RetryAfter)
	}
}

func TestCreateChurnGuardStartsUserAbuseCooldownWithoutGlobalHot(t *testing.T) {
	ctx := testutil.NewContext(t, "usr-abuse-start")
	conf := testChurnGuardConfig()
	conf.CreateThreshold = 100
	conf.DestroyThreshold = 100
	cooldownStore := &fakeUserAbuseCooldownStore{
		started:   true,
		remaining: 10 * time.Minute,
	}
	guard := &createChurnGuard{
		conf: conf,
		counter: &fakeChurnCounter{
			counts: map[string]int64{
				churnEventCreateSuccess: 11,
				churnEventDestroyAccept: 8,
			},
			retryAfter: map[string]time.Duration{},
		},
		cooldowns: cooldownStore,
		snapshots: &fakeSnapshotStore{
			snapshot: &poolPressureSnapshot{
				RefreshedAt: time.Now(),
				State:       poolPressureStateCold,
			},
		},
		logger: zap.NewNop(),
	}

	decision, err := guard.EvaluateCreate(ctx, []string{"pool-a"})
	if err != nil {
		t.Fatalf("EvaluateCreate error: %v", err)
	}
	if decision.Allow {
		t.Fatalf("expected user abuse reject, got %+v", decision)
	}
	if decision.Reason != "user_abuse_cooldown_started" {
		t.Fatalf("unexpected reason: %s", decision.Reason)
	}
	if decision.RetryAfter != 10*time.Minute {
		t.Fatalf("unexpected retry-after: %s", decision.RetryAfter)
	}
	if !cooldownStore.active {
		t.Fatal("expected cooldown store to become active")
	}
}

func TestPoolPressureRefresherMarksHotWhenInflightExceedsClean(t *testing.T) {
	conf := testChurnGuardConfig()
	store := &fakeSnapshotStore{}
	refresher := &poolPressureRefresher{
		conf: conf,
		fetcher: &fakePoolPressureFetcher{
			pools: []psandbox.Pool{
				{ID: "pool-a", DesiredCapacity: 6, Status: "active"},
			},
			instances: map[string][]psandbox.PoolInstance{
				"pool-a": {
					{ID: "c1", State: "CLEAN"},
					{ID: "c2", State: "CLEAN"},
					{ID: "d1", State: "DRY"},
					{ID: "r1", State: "RESETTING"},
					{ID: "cr1", State: "CREATING"},
				},
			},
		},
		snapshots: store,
		logger:    zap.NewNop(),
	}

	snapshot, err := refresher.Refresh(testutil.NewContext(t, "usr-bypass"), []string{"pool-a"})
	if err != nil {
		t.Fatalf("Refresh error: %v", err)
	}
	if snapshot == nil {
		t.Fatal("expected snapshot")
	}
	if snapshot.State != poolPressureStateHot {
		t.Fatalf("expected hot snapshot, got %s", snapshot.State)
	}
	if len(snapshot.Pools) != 1 || snapshot.Pools[0].Resetting != 1 || snapshot.Pools[0].Dry != 1 || snapshot.Pools[0].Creating != 1 {
		t.Fatalf("unexpected pool snapshot: %+v", snapshot.Pools)
	}
}

func TestPoolPressureRefresherUsesRuntimeInventoryInsteadOfDesiredCapacity(t *testing.T) {
	conf := testChurnGuardConfig()
	store := &fakeSnapshotStore{}
	refresher := &poolPressureRefresher{
		conf: conf,
		fetcher: &fakePoolPressureFetcher{
			pools: []psandbox.Pool{
				{ID: "pool-bad", DesiredCapacity: 24, Status: "paused"},
				{ID: "pool-good", DesiredCapacity: 24, Status: "active"},
			},
			instances: map[string][]psandbox.PoolInstance{
				"pool-good": {
					{ID: "good-clean-1", State: "CLEAN"},
					{ID: "good-clean-2", State: "CLEAN"},
					{ID: "good-clean-3", State: "CLEAN"},
					{ID: "good-allocated-1", State: "ALLOCATED"},
				},
			},
		},
		snapshots: store,
		logger:    zap.NewNop(),
	}

	snapshot, err := refresher.Refresh(testutil.NewContext(t, "usr-bypass"), []string{"pool-bad", "pool-good"})
	if err != nil {
		t.Fatalf("Refresh error: %v", err)
	}
	if snapshot == nil {
		t.Fatal("expected snapshot")
	}
	if snapshot.State != poolPressureStateCold {
		t.Fatalf("expected cold snapshot when runtime inventory is healthy, got %s", snapshot.State)
	}
	if len(snapshot.Pools) != 2 {
		t.Fatalf("expected both pool snapshots, got %+v", snapshot.Pools)
	}
	for _, pool := range snapshot.Pools {
		if pool.PoolID != "pool-good" {
			continue
		}
		if pool.Allocated != 1 || pool.Clean != 3 {
			t.Fatalf("unexpected good pool snapshot: %+v", pool)
		}
		return
	}
	t.Fatalf("missing good pool snapshot: %+v", snapshot.Pools)
}

func TestPoolPressureRefresherSkipsSinglePoolFailure(t *testing.T) {
	conf := testChurnGuardConfig()
	store := &fakeSnapshotStore{}
	refresher := &poolPressureRefresher{
		conf: conf,
		fetcher: &fakePoolPressureFetcher{
			pools: []psandbox.Pool{
				{ID: "pool-a", DesiredCapacity: 4, Status: "active"},
				{ID: "pool-b", DesiredCapacity: 4, Status: "active"},
			},
			instances: map[string][]psandbox.PoolInstance{
				"pool-a": {
					{ID: "a-clean-1", State: "CLEAN"},
					{ID: "a-clean-2", State: "CLEAN"},
				},
			},
			errs: map[string]error{
				"pool-b": errors.New("boom"),
			},
		},
		snapshots: store,
		logger:    zap.NewNop(),
	}

	snapshot, err := refresher.Refresh(testutil.NewContext(t, "usr-bypass"), []string{"pool-a", "pool-b"})
	if err != nil {
		t.Fatalf("Refresh error: %v", err)
	}
	if snapshot == nil {
		t.Fatal("expected snapshot")
	}
	if len(snapshot.Pools) != 1 {
		t.Fatalf("expected only healthy pool snapshot, got %+v", snapshot.Pools)
	}
	if snapshot.Pools[0].PoolID != "pool-a" {
		t.Fatalf("unexpected remaining pool: %+v", snapshot.Pools[0])
	}
}

func TestDestroyInstanceDoesNotRecordAcceptedEventWhenAlreadyDeleting(t *testing.T) {
	testutil.NewMySQLDB(t, "..", "..", "migrations")

	ctx := testutil.NewContext(t, "usr-deleting")
	originalServerConf := config.ServerConf
	config.ServerConf = &config.GlobalConfig{
		APIConfig: &config.APIConfig{
			Instance: testChurnGuardConfig(),
		},
	}
	t.Cleanup(func() {
		config.ServerConf = originalServerConf
	})
	if err := modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx).DB().Create(&quota.Entity{
		UserID:                 ctx.GetUserID(),
		ResourceName:           resourceNameOpenClawInstance,
		ResourceKey:            "",
		ResourceQuotaAvailable: 0,
		ResourceQuotaTotal:     1,
	}).Error; err != nil {
		t.Fatalf("seed quota: %v", err)
	}

	entity := &modelinstance.Entity{
		InstanceId: "ins-already-deleting",
		Status:     modelinstance.InstanceStatusDeleting,
		SandboxId:  "sbx-already-deleting",
		TimeoutAt:  time.Now().Add(time.Hour),
	}
	if err := modelfactory.DefaultDaoFactory.InstanceDao(ctx).Create(ctx, entity); err != nil {
		t.Fatalf("create instance: %v", err)
	}

	l := NewLogicForTest(
		modelfactory.DefaultDaoFactory.InstanceDao(ctx),
		modelfactory.DefaultDaoFactory.UserResourceQuotaDao(ctx),
		&testSandboxAdapter{},
		nil,
		nil,
		zap.NewNop(),
		"pool-a",
	).(*logic)
	counter := &fakeChurnCounter{
		counts:     map[string]int64{},
		retryAfter: map[string]time.Duration{},
		recorded:   map[string]int{},
	}
	l.churnGuard = &createChurnGuard{
		conf:      testChurnGuardConfig(),
		counter:   counter,
		snapshots: &fakeSnapshotStore{},
		logger:    zap.NewNop(),
	}

	resp, err := l.DestroyInstance(ctx, entity.InstanceId)
	if err != nil {
		t.Fatalf("DestroyInstance error: %v", err)
	}
	if resp.Status != modelinstance.InstanceStatusDeleted {
		t.Fatalf("unexpected response status: %s", resp.Status)
	}
	if counter.recorded[churnEventDestroyAccept] != 0 {
		t.Fatalf("expected no destroy-accepted event to be recorded, got %+v", counter.recorded)
	}
}

type testSandboxAdapter struct{}

func (testSandboxAdapter) CreateSandbox(context.Context, *psandbox.CreateSandboxRequest) (*psandbox.Sandbox, error) {
	panic("unexpected call")
}

func (testSandboxAdapter) GetSandbox(context.Context, string) (*psandbox.SandboxDetail, error) {
	panic("unexpected call")
}

func (testSandboxAdapter) ListSandboxes(context.Context, *psandbox.ListSandboxesRequest) ([]psandbox.ListedSandbox, error) {
	panic("unexpected call")
}

func (testSandboxAdapter) DeleteSandbox(context.Context, string) error {
	return nil
}

func (testSandboxAdapter) PauseSandbox(context.Context, string) error {
	panic("unexpected call")
}

func (testSandboxAdapter) ResumeSandbox(context.Context, string, *psandbox.ResumeSandboxRequest) (*psandbox.Sandbox, error) {
	panic("unexpected call")
}

func (testSandboxAdapter) SetTimeout(context.Context, string, int32) error {
	panic("unexpected call")
}

func (testSandboxAdapter) Refresh(context.Context, string, int32) error {
	panic("unexpected call")
}

func (testSandboxAdapter) GetLogs(context.Context, string, *psandbox.GetLogsRequest) (*psandbox.SandboxLogs, error) {
	panic("unexpected call")
}

func (testSandboxAdapter) StartTerminalSession(context.Context, string) (*psandbox.TerminalSession, error) {
	panic("unexpected call")
}

func (testSandboxAdapter) ExecCommand(context.Context, string, string, int) (*psandbox.ExecCommandResult, error) {
	panic("unexpected call")
}

func (testSandboxAdapter) GetCommandResult(context.Context, string, string) (*psandbox.ExecCommandResult, error) {
	panic("unexpected call")
}

func (testSandboxAdapter) StartProcessStream(context.Context, string, *psandbox.ProcessStartRequest, func(psandbox.ProcessStreamEvent) error) error {
	panic("unexpected call")
}

func (testSandboxAdapter) RunProcessWithStdin(context.Context, string, *psandbox.ProcessStartRequest, []byte) (*psandbox.ExecCommandResult, error) {
	panic("unexpected call")
}

func (testSandboxAdapter) SendProcessSignal(context.Context, string, uint32, string) error {
	panic("unexpected call")
}

func (testSandboxAdapter) ListPools(context.Context) ([]psandbox.Pool, error) {
	panic("unexpected call")
}

func (testSandboxAdapter) ListPoolInstances(context.Context, string) ([]psandbox.PoolInstance, error) {
	panic("unexpected call")
}

func TestOrderCandidatePoolsForCreateUsesSnapshotRanking(t *testing.T) {
	conf := testChurnGuardConfig()
	conf.CreatePoolMaxAttempts = 2
	now := time.Now().UTC()

	selection := orderCandidatePoolsForCreate(conf, now, []string{"pool-a", "pool-b", "pool-c"}, &poolPressureSnapshot{
		RefreshedAt: now,
		Pools: []poolPressurePoolSnapshot{
			{PoolID: "pool-a", Status: "RUNNING", Clean: 1, Creating: 2},
			{PoolID: "pool-b", Status: "RUNNING", Clean: 4},
			{PoolID: "pool-c", Status: "PAUSED", Clean: 8},
		},
	})

	if !selection.UsedSnapshot {
		t.Fatal("expected snapshot ordering to be used")
	}
	if selection.AttemptLimit != 2 {
		t.Fatalf("expected attempt limit 2, got %d", selection.AttemptLimit)
	}
	if got := strings.Join(selection.Pools, ","); got != "pool-b,pool-a,pool-c" {
		t.Fatalf("unexpected ordered pools: %s", got)
	}
}

func TestOrderCandidatePoolsForCreateFallsBackWhenSnapshotMissingOrPartial(t *testing.T) {
	conf := testChurnGuardConfig()
	now := time.Now().UTC()

	selection := orderCandidatePoolsForCreate(conf, now, []string{"pool-a", "pool-b", "pool-c"}, &poolPressureSnapshot{
		RefreshedAt: now,
		Pools: []poolPressurePoolSnapshot{
			{PoolID: "pool-b", Status: "RUNNING", Clean: 3},
		},
	})
	if got := strings.Join(selection.Pools, ","); got != "pool-b,pool-a,pool-c" {
		t.Fatalf("unexpected partial snapshot order: %s", got)
	}

	stale := orderCandidatePoolsForCreate(conf, now, []string{"pool-a", "pool-b"}, &poolPressureSnapshot{
		RefreshedAt: now.Add(-time.Minute),
		Pools: []poolPressurePoolSnapshot{
			{PoolID: "pool-b", Status: "RUNNING", Clean: 10},
		},
	})
	if stale.UsedSnapshot {
		t.Fatal("expected stale snapshot to be ignored")
	}
	if got := strings.Join(stale.Pools, ","); got != "pool-a,pool-b" {
		t.Fatalf("unexpected fallback order for stale snapshot: %s", got)
	}
}

func TestResolveCreatePoolAttemptLimit(t *testing.T) {
	conf := &config.InstanceAPIConfig{CreatePoolMaxAttempts: 2}
	if got := resolveCreatePoolAttemptLimit(conf, 3); got != 2 {
		t.Fatalf("expected configured attempt limit, got %d", got)
	}
	if got := resolveCreatePoolAttemptLimit(conf, 1); got != 1 {
		t.Fatalf("expected limit capped by candidate count, got %d", got)
	}
	conf.CreatePoolMaxAttempts = 0
	if got := resolveCreatePoolAttemptLimit(conf, 3); got != 3 {
		t.Fatalf("expected zero config to fallback to candidate count, got %d", got)
	}
}
