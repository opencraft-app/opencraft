package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/store"
)

// modifyFixture 是一台已交付到 2C4G/50G 源池的实例，外加一个 4C8G/80G 目标池。
type modifyFixture struct {
	svc        *Service
	sandboxID  string
	instanceID string
	sourcePool core.Pool
	targetPool core.Pool
}

type resizeStopProvider struct {
	*provider.MockCloudProvider
	resizeStopped bool
}

type guardedModifyProvider struct {
	*provider.MockCloudProvider
	beforeStop func() error
	stopCalls  int
}

func (p *guardedModifyProvider) StopInstanceForResize(context.Context, string) error {
	p.stopCalls++
	if p.beforeStop != nil {
		return p.beforeStop()
	}
	return nil
}

func (p *resizeStopProvider) StopInstance(context.Context, string) error {
	return errors.New("ordinary pause must not be used for resize")
}

func (p *resizeStopProvider) StopInstanceForResize(context.Context, string) error {
	p.resizeStopped = true
	return nil
}

func TestModifyUsesResizeSpecificStop(t *testing.T) {
	p := &resizeStopProvider{MockCloudProvider: &provider.MockCloudProvider{}}
	s := &Service{}
	if err := s.runModifyStep(context.Background(), p, p, core.ModifyOperation{}, core.Instance{CloudID: "ins-test"}, core.ModifyStepStopInstance); err != nil {
		t.Fatal(err)
	}
	if !p.resizeStopped {
		t.Fatal("resize-specific stop was not called")
	}
}

func newModifyFixture(t *testing.T, backing ...store.Store) modifyFixture {
	t.Helper()
	ctx := context.Background()
	var st store.Store = store.NewMemoryStore()
	if len(backing) > 0 {
		st = backing[0]
	}
	svc := NewService(st)

	sourcePool := createSpecPool(t, svc, "spec-2c4g50g", "SA9.MEDIUM4", 50)
	targetPool := createSpecPool(t, svc, "spec-4c8g80g", "SA9.LARGE8", 80)

	insts, err := svc.RefillVerified(ctx, sourcePool.ID, 1, []string{"10.0.0.5"}, []string{"ins-modify-1"},
		func(context.Context, string) error { return nil })
	if err != nil {
		t.Fatalf("refill source pool: %v", err)
	}
	inst, err := svc.Allocate(ctx, sourcePool.ID)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if inst.ID != insts[0].ID {
		t.Fatalf("expected to allocate the refilled instance, got %s", inst.ID)
	}
	sb, err := svc.CreateSandbox(ctx, core.Sandbox{
		ID:              "sb-modify-1",
		InstanceID:      inst.ID,
		PoolID:          sourcePool.ID,
		TemplateClassID: sourcePool.TemplateClassID,
	})
	if err != nil {
		t.Fatalf("create sandbox: %v", err)
	}
	return modifyFixture{svc: svc, sandboxID: sb.ID, instanceID: inst.ID, sourcePool: sourcePool, targetPool: targetPool}
}

func createSpecPool(t *testing.T, svc *Service, name, instanceType string, diskSize int) core.Pool {
	t.Helper()
	ctx := context.Background()
	pool, err := svc.CreatePool(ctx, name, "", "img-modify", 1, testVpcID, testSubnetID, testZone, testSecurityGroups)
	if err != nil {
		t.Fatalf("create pool %s: %v", name, err)
	}
	pool.InstanceType = instanceType
	pool.SystemDiskSize = diskSize
	pool.TemplateClassID = name
	pool.SKUID = "sku-" + name
	pool, err = svc.UpdatePool(ctx, pool)
	if err != nil {
		t.Fatalf("update pool %s: %v", name, err)
	}
	return pool
}

func (f modifyFixture) begin(t *testing.T, key string) core.ModifyOperation {
	t.Helper()
	op, err := f.svc.BeginModifyOperation(context.Background(), BeginModifyInput{
		IdempotencyKey: key,
		SandboxID:      f.sandboxID,
		TargetPoolID:   f.targetPool.ID,
	})
	if err != nil {
		t.Fatalf("begin modify: %v", err)
	}
	return op
}

func TestBeginModifyFreezesTargetSpecAndParksInstance(t *testing.T) {
	f := newModifyFixture(t)
	op := f.begin(t, "task-1")

	if op.TargetInstanceType != "SA9.LARGE8" || op.TargetSystemDiskSize != 80 {
		t.Fatalf("expected frozen 4C8G/80G target, got %s/%dG", op.TargetInstanceType, op.TargetSystemDiskSize)
	}
	if op.SourcePoolID != f.sourcePool.ID || op.TargetPoolID != f.targetPool.ID {
		t.Fatalf("unexpected pool pair: %s -> %s", op.SourcePoolID, op.TargetPoolID)
	}
	if op.Status != core.ModifyOperationStatusRunning || op.CurrentStep != "" {
		t.Fatalf("expected fresh running operation, got %s/%s", op.Status, op.CurrentStep)
	}
	inst, err := f.svc.GetInstance(context.Background(), f.instanceID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if inst.State != core.StateModifying {
		t.Fatalf("expected instance parked in MODIFYING, got %s", inst.State)
	}
}

// 目标 SKU 在运营侧被改动时，同一次升配不能因此漂移到新规格。
func TestBeginModifyReusesLedgerForSameIdempotencyKey(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	first := f.begin(t, "task-1")

	f.targetPool.SystemDiskSize = 200
	if _, err := f.svc.UpdatePool(ctx, f.targetPool); err != nil {
		t.Fatalf("update target pool: %v", err)
	}

	second := f.begin(t, "task-1")
	if second.ID != first.ID {
		t.Fatalf("expected the same operation, got %s and %s", first.ID, second.ID)
	}
	if second.TargetSystemDiskSize != 80 {
		t.Fatalf("expected frozen 80G target to survive a pool spec change, got %dG", second.TargetSystemDiskSize)
	}
}

// ctl 子 task 超时后父 task 会用新的 task ID 重派，而 sandbox 侧账本往往还在跑。
// 这一轮必须认领在跑的账本，否则两个 runner 会对同一台机器交错下发停机 / 改配 / 扩盘。
func TestBeginModifyAdoptsRunningOperationForNewIdempotencyKey(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	first := f.begin(t, "task-1")

	// 模拟账本已经跑掉一步：认领必须保留进度，而不是从头再来。
	if _, err := f.svc.store.UpdateModifyOperationProgress(ctx, store.ModifyOperationProgress{
		ID:          first.ID,
		Status:      core.ModifyOperationStatusRunning,
		CurrentStep: core.ModifyStepStopInstance,
	}); err != nil {
		t.Fatalf("advance first operation: %v", err)
	}

	adopted := f.begin(t, "task-2-redispatched")
	if adopted.ID != first.ID {
		t.Fatalf("expected the redispatch to adopt operation %s, got a second ledger %s", first.ID, adopted.ID)
	}
	if adopted.IdempotencyKey != "task-1" {
		t.Fatalf("adopted ledger should keep its original key, got %s", adopted.IdempotencyKey)
	}
	if adopted.CurrentStep != core.ModifyStepStopInstance {
		t.Fatalf("adoption lost progress, current step = %q", adopted.CurrentStep)
	}
}

func TestMemoryStoreCreateModifyOperationAllowsOnlyOneRunningLedgerPerInstance(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemoryStore()
	now := time.Now().UTC()
	base := core.ModifyOperation{
		SandboxID:    "sb-1",
		InstanceID:   "inst-1",
		SourcePoolID: "pool-old",
		TargetPoolID: "pool-new",
		TargetSKUID:  "sku-new",
		Status:       core.ModifyOperationStatusRunning,
		StartedAt:    now,
		UpdatedAt:    now,
	}

	type result struct {
		op      core.ModifyOperation
		created bool
		err     error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for i := 1; i <= 2; i++ {
		candidate := base
		candidate.ID = fmt.Sprintf("mod-%d", i)
		candidate.IdempotencyKey = fmt.Sprintf("task-%d", i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			op, created, err := st.CreateModifyOperation(ctx, candidate)
			results <- result{op: op, created: created, err: err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	createdCount := 0
	operationIDs := make(map[string]struct{})
	for got := range results {
		if got.err != nil {
			t.Fatalf("create running ledger: %v", got.err)
		}
		if got.created {
			createdCount++
		}
		operationIDs[got.op.ID] = struct{}{}
	}
	if createdCount != 1 || len(operationIDs) != 1 {
		t.Fatalf("created=%d distinct_operations=%d, want one shared running ledger", createdCount, len(operationIDs))
	}
}

// 在跑的账本目标不同，说明有另一笔变配插了进来，必须拒绝而不是并行改同一台机器。
func TestBeginModifyRejectsConcurrentDifferentTarget(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	f.begin(t, "task-1")

	other := createSpecPool(t, f.svc, "spec-8c16g120g", "SA9.2XLARGE16", 120)
	_, err := f.svc.BeginModifyOperation(ctx, BeginModifyInput{
		IdempotencyKey: "task-2",
		SandboxID:      f.sandboxID,
		TargetPoolID:   other.ID,
	})
	if !errors.Is(err, core.ErrModifyOperationConflict) {
		t.Fatalf("expected concurrent target conflict, got %v", err)
	}
}

// 建账本和切状态不在一个事务里。中间崩掉后重试必须把实例补进 MODIFYING，
// 否则它会带着 ALLOCATED 被分配或暂停，而云侧步骤照跑。
func TestBeginModifyReconcilesInstanceStateOnReplay(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	first := f.begin(t, "task-1")

	// 手工回滚状态，模拟"账本已落、切状态失败"的窗口。
	if _, err := f.svc.store.UpdateInstanceState(ctx, f.instanceID, core.StateModifying, core.StateAllocated); err != nil {
		t.Fatalf("rewind instance state: %v", err)
	}

	replayed := f.begin(t, "task-1")
	if replayed.ID != first.ID {
		t.Fatalf("replay created a second ledger %s", replayed.ID)
	}
	inst, err := f.svc.GetInstance(ctx, f.instanceID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if inst.State != core.StateModifying {
		t.Fatalf("replay left the instance in %s, want MODIFYING", inst.State)
	}
}

// 同一个 key 被复用到不同目标，说明调用方状态错乱，必须拒绝而不是静默续跑旧账本。
func TestBeginModifyRejectsIdempotencyKeyReuseForDifferentTarget(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	f.begin(t, "task-1")

	other := createSpecPool(t, f.svc, "spec-8c16g120g", "SA9.2XLARGE16", 120)
	_, err := f.svc.BeginModifyOperation(ctx, BeginModifyInput{
		IdempotencyKey: "task-1",
		SandboxID:      f.sandboxID,
		TargetPoolID:   other.ID,
	})
	if !errors.Is(err, core.ErrModifyOperationConflict) {
		t.Fatalf("expected key reuse conflict, got %v", err)
	}
}

func TestBeginModifyRejectsDowngradeAndNoop(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)

	_, err := f.svc.BeginModifyOperation(ctx, BeginModifyInput{
		IdempotencyKey: "task-noop",
		SandboxID:      f.sandboxID,
		TargetPoolID:   f.sourcePool.ID,
	})
	// 目标 == 现状不是配置错误，而是"已收敛"：调用方据此把子 task 收成功，
	// 所以它必须和降配用不同的哨兵。
	if !errors.Is(err, core.ErrModifyTargetAlreadyApplied) {
		t.Fatalf("expected no-op target to report already-applied, got %v", err)
	}

	smaller := createSpecPool(t, f.svc, "spec-1c2g20g", "SA9.SMALL2", 20)
	_, err = f.svc.BeginModifyOperation(ctx, BeginModifyInput{
		IdempotencyKey: "task-downgrade",
		SandboxID:      f.sandboxID,
		TargetPoolID:   smaller.ID,
	})
	if !errors.Is(err, core.ErrModifyTargetNotUpgrade) {
		t.Fatalf("expected disk downgrade to be rejected, got %v", err)
	}
}

func TestBeginModifyRejectsPausedInstance(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	if _, err := f.svc.Pause(ctx, f.instanceID); err != nil {
		t.Fatalf("pause: %v", err)
	}
	if _, err := f.svc.MarkPaused(ctx, f.instanceID); err != nil {
		t.Fatalf("mark paused: %v", err)
	}
	_, err := f.svc.BeginModifyOperation(ctx, BeginModifyInput{
		IdempotencyKey: "task-paused",
		SandboxID:      f.sandboxID,
		TargetPoolID:   f.targetPool.ID,
	})
	if !errors.Is(err, core.ErrInvalidTransition) {
		t.Fatalf("expected paused instance to be rejected, got %v", err)
	}
}

func TestRunModifyConvergesAndRebindsToTargetPool(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	op := f.begin(t, "task-1")
	cp := provider.NewMockCloudProvider()

	done, err := f.svc.RunModifyOperation(ctx, cp, op.ID)
	if err != nil {
		t.Fatalf("run modify: %v", err)
	}
	if done.Status != core.ModifyOperationStatusCompleted || done.CurrentStep != core.ModifyStepDone {
		t.Fatalf("expected completed/done, got %s/%s", done.Status, done.CurrentStep)
	}
	if done.CompletedAt == nil {
		t.Fatalf("expected completed_at to be set")
	}

	spec, err := cp.DescribeInstanceSpec(ctx, "ins-modify-1")
	if err != nil {
		t.Fatalf("describe spec: %v", err)
	}
	if spec.InstanceType != "SA9.LARGE8" || spec.SystemDiskSize != 80 {
		t.Fatalf("expected cloud instance upgraded to SA9.LARGE8/80G, got %s/%dG", spec.InstanceType, spec.SystemDiskSize)
	}

	inst, err := f.svc.GetInstance(ctx, f.instanceID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if inst.State != core.StateAllocated || inst.PoolID != f.targetPool.ID {
		t.Fatalf("expected instance back in ALLOCATED on target pool, got %s on %s", inst.State, inst.PoolID)
	}
	sb, err := f.svc.GetSandbox(ctx, f.sandboxID)
	if err != nil {
		t.Fatalf("get sandbox: %v", err)
	}
	if sb.PoolID != f.targetPool.ID || sb.TemplateClassID != f.targetPool.TemplateClassID {
		t.Fatalf("expected sandbox routing moved to target class, got pool=%s class=%s", sb.PoolID, sb.TemplateClassID)
	}
}

func TestRunModifyReconcilesAllocatedInstanceBeforeCloudMutation(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	op := f.begin(t, "task-crash-window")
	if _, err := f.svc.store.UpdateInstanceState(ctx, f.instanceID, core.StateModifying, core.StateAllocated); err != nil {
		t.Fatalf("rewind instance state: %v", err)
	}

	cp := &guardedModifyProvider{
		MockCloudProvider: provider.NewMockCloudProvider(),
		beforeStop: func() error {
			inst, err := f.svc.GetInstance(ctx, f.instanceID)
			if err != nil {
				return err
			}
			if inst.State != core.StateModifying {
				return fmt.Errorf("cloud mutation observed instance state %s, want MODIFYING", inst.State)
			}
			return nil
		},
	}
	got, err := f.svc.RunModifyOperation(ctx, cp, op.ID)
	if err != nil {
		t.Fatalf("run modify after ledger/state crash window: %v", err)
	}
	if got.Status != core.ModifyOperationStatusCompleted || cp.stopCalls != 1 {
		t.Fatalf("status=%s stop_calls=%d, want completed with one guarded stop", got.Status, cp.stopCalls)
	}
}

func TestRunModifyRejectsUnexpectedInstanceStateBeforeCloudMutation(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	op := f.begin(t, "task-invalid-state")
	if _, err := f.svc.store.UpdateInstanceState(ctx, f.instanceID, core.StateModifying, core.StatePausing); err != nil {
		t.Fatalf("move instance to competing lifecycle state: %v", err)
	}
	cp := &guardedModifyProvider{MockCloudProvider: provider.NewMockCloudProvider()}

	_, err := f.svc.RunModifyOperation(ctx, cp, op.ID)
	if !errors.Is(err, core.ErrInvalidTransition) {
		t.Fatalf("expected invalid transition, got %v", err)
	}
	if cp.stopCalls != 0 {
		t.Fatalf("cloud stop called %d times for an instance outside MODIFYING", cp.stopCalls)
	}
}

func TestRunModifyRejectsLostSandboxOwnershipBeforeCloudMutation(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	op := f.begin(t, "task-lost-sandbox")
	if err := f.svc.DeleteSandbox(ctx, f.sandboxID); err != nil {
		t.Fatalf("delete sandbox: %v", err)
	}
	cp := &guardedModifyProvider{MockCloudProvider: provider.NewMockCloudProvider()}

	_, err := f.svc.RunModifyOperation(ctx, cp, op.ID)
	if !errors.Is(err, core.ErrSandboxNotFound) {
		t.Fatalf("expected lost sandbox ownership to stop modify, got %v", err)
	}
	if cp.stopCalls != 0 {
		t.Fatalf("cloud stop called %d times after sandbox ownership was lost", cp.stopCalls)
	}
}

func TestRunModifyFinalizesPersistedRebindAfterInstancePauses(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	op := f.begin(t, "task-finalize-rebind")
	if _, err := f.svc.RunModifyOperation(ctx, provider.NewMockCloudProvider(), op.ID); err != nil {
		t.Fatalf("complete initial modify: %v", err)
	}
	if _, err := f.svc.store.UpdateModifyOperationProgress(ctx, store.ModifyOperationProgress{
		ID:          op.ID,
		Status:      core.ModifyOperationStatusRunning,
		CurrentStep: core.ModifyStepRebindPool,
	}); err != nil {
		t.Fatalf("restore post-rebind crash window: %v", err)
	}
	if _, err := f.svc.Pause(ctx, f.instanceID); err != nil {
		t.Fatalf("pause rebound instance: %v", err)
	}
	if _, err := f.svc.MarkPaused(ctx, f.instanceID); err != nil {
		t.Fatalf("mark rebound instance paused: %v", err)
	}
	cp := &guardedModifyProvider{MockCloudProvider: provider.NewMockCloudProvider()}

	got, err := f.svc.RunModifyOperation(ctx, cp, op.ID)
	if err != nil {
		t.Fatalf("finalize persisted rebind: %v", err)
	}
	if got.Status != core.ModifyOperationStatusCompleted || got.CurrentStep != core.ModifyStepDone {
		t.Fatalf("status=%s step=%s, want completed/done", got.Status, got.CurrentStep)
	}
	if cp.stopCalls != 0 {
		t.Fatalf("cloud stop called %d times after rebind was already persisted", cp.stopCalls)
	}
}

// networkGuardedProvider 在 modify 期间把"会换机器 / 动网络"的云 API 变成硬失败。
//
// 这些方法一个都不该在升配链路上被调到：重绑只改 sandbox DB 的归属元数据，CVM、
// 数据盘、IP、VPC、子网、安全组全部保持原状（§4.3 / §7.3）。用 embed 而不是逐个
// 实现是刻意的——将来 CloudProvider 加了新的破坏性方法，会通过 mock 默认放行，
// 但下面对 cloud_id / address 的断言仍会兜住"换了机器"这个最终后果。
type networkGuardedProvider struct {
	*provider.MockCloudProvider
	t *testing.T
}

func (p *networkGuardedProvider) CreateInstance(context.Context, core.Pool) (string, string, error) {
	p.t.Fatal("modify must not create a new instance: pool rebind is metadata-only")
	return "", "", nil
}

func (p *networkGuardedProvider) TerminateInstance(context.Context, string) error {
	p.t.Fatal("modify must not terminate the instance")
	return nil
}

func (p *networkGuardedProvider) ReinstallInstance(context.Context, string, string) error {
	p.t.Fatal("modify must not reinstall the instance: user data lives on the system disk")
	return nil
}

// TestRunModifyRebindDoesNotTouchNetworkOrIdentity 覆盖 §10.1 的"重绑不动网络"。
//
// 升级完成后实例落在目标池，但它必须还是**同一台**机器：cloud_id 和 IP 不变，
// 且全程没有走过任何换机路径。这条不变量在代码里是"没写某些调用"，靠读代码无法回归，
// 只能由 provider 侧的硬失败守住。
func TestRunModifyRebindDoesNotTouchNetworkOrIdentity(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)

	before, err := f.svc.GetInstance(ctx, f.instanceID)
	if err != nil {
		t.Fatalf("get instance before: %v", err)
	}
	// 身份字段为空时下面的比较会恒真，这条断言就成了摆设。
	if before.CloudID == "" || before.Address == "" {
		t.Fatalf("fixture must deliver a real cloud identity, got id=%q addr=%q", before.CloudID, before.Address)
	}

	op := f.begin(t, "task-1")
	cp := &networkGuardedProvider{MockCloudProvider: provider.NewMockCloudProvider(), t: t}
	done, err := f.svc.RunModifyOperation(ctx, cp, op.ID)
	if err != nil {
		t.Fatalf("run modify: %v", err)
	}
	if done.Status != core.ModifyOperationStatusCompleted {
		t.Fatalf("expected completed, got %s", done.Status)
	}

	after, err := f.svc.GetInstance(ctx, f.instanceID)
	if err != nil {
		t.Fatalf("get instance after: %v", err)
	}
	if after.CloudID != before.CloudID {
		t.Errorf("cloud_id changed %q -> %q; the user's machine was replaced", before.CloudID, after.CloudID)
	}
	if after.Address != before.Address {
		t.Errorf("address changed %q -> %q; modify must preserve the IP", before.Address, after.Address)
	}
	if after.PoolID != f.targetPool.ID {
		t.Errorf("pool = %q, want target pool %q", after.PoolID, f.targetPool.ID)
	}
}

// TestReleaseAfterModifyReturnsInventoryToTargetPool 覆盖 §10.1 的释放归属。
//
// 升配后用户释放实例，这台 4C8G/80G 的机器必须作为**目标池**库存回收，而不是回到
// 启航池。回错池的后果是启航池里混进一台大规格机器，被下一个启航用户免费拿走，
// 同时目标池库存永远补不上。
func TestReleaseAfterModifyReturnsInventoryToTargetPool(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	op := f.begin(t, "task-1")
	if _, err := f.svc.RunModifyOperation(ctx, provider.NewMockCloudProvider(), op.ID); err != nil {
		t.Fatalf("run modify: %v", err)
	}

	released, err := f.svc.Release(ctx, f.instanceID)
	if err != nil {
		t.Fatalf("release: %v", err)
	}
	if released.State != core.StateDry {
		t.Fatalf("state = %s, want DRY (reset worker only sweeps DRY/RESETTING)", released.State)
	}
	if released.PoolID != f.targetPool.ID {
		t.Fatalf("released into pool %q, want target pool %q (source was %q)",
			released.PoolID, f.targetPool.ID, f.sourcePool.ID)
	}
}

func TestRunModifyIsIdempotentOnceCompleted(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	op := f.begin(t, "task-1")
	cp := provider.NewMockCloudProvider()

	if _, err := f.svc.RunModifyOperation(ctx, cp, op.ID); err != nil {
		t.Fatalf("first run: %v", err)
	}
	again, err := f.svc.RunModifyOperation(ctx, cp, op.ID)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}
	if again.Status != core.ModifyOperationStatusCompleted {
		t.Fatalf("expected completed operation to stay completed, got %s", again.Status)
	}
}

// 磁盘扩容不可逆：一旦这一步落账，重试必须从下一步开始，绝不重复扩容。
func TestRunModifyResumesAfterRecordedStepWithoutRepeatingDiskResize(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	op := f.begin(t, "task-1")

	if _, err := f.svc.store.UpdateModifyOperationProgress(ctx, store.ModifyOperationProgress{
		ID:          op.ID,
		Status:      core.ModifyOperationStatusRunning,
		CurrentStep: core.ModifyStepResizeDisk,
	}); err != nil {
		t.Fatalf("checkpoint resize_disk: %v", err)
	}

	cp := &countingResizer{MockCloudProvider: provider.NewMockCloudProvider()}
	done, err := f.svc.RunModifyOperation(ctx, cp, op.ID)
	if err != nil {
		t.Fatalf("resume modify: %v", err)
	}
	if done.Status != core.ModifyOperationStatusCompleted {
		t.Fatalf("expected completion, got %s", done.Status)
	}
	if cp.diskResizes != 0 {
		t.Fatalf("expected no disk resize after the step was already recorded, got %d", cp.diskResizes)
	}
	if cp.computeResizes != 0 {
		t.Fatalf("expected no compute resize after the step was already recorded, got %d", cp.computeResizes)
	}
}

func TestRunModifyKeepsOperationRunningOnStepFailure(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	op := f.begin(t, "task-1")
	cp := &failingResizer{MockCloudProvider: provider.NewMockCloudProvider()}

	_, err := f.svc.RunModifyOperation(ctx, cp, op.ID)
	if err == nil {
		t.Fatalf("expected the failing compute resize to surface")
	}
	stored, err := f.svc.GetModifyOperation(ctx, op.ID)
	if err != nil {
		t.Fatalf("get operation: %v", err)
	}
	if stored.Status != core.ModifyOperationStatusRunning {
		t.Fatalf("expected operation to stay running for retry, got %s", stored.Status)
	}
	if stored.CurrentStep != core.ModifyStepStopInstance {
		t.Fatalf("expected progress to stop at the last successful step, got %q", stored.CurrentStep)
	}
	if stored.LastError == "" {
		t.Fatalf("expected last_error to be recorded")
	}

	inst, err := f.svc.GetInstance(ctx, f.instanceID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if inst.State != core.StateModifying {
		t.Fatalf("expected instance to stay in MODIFYING while retrying, got %s", inst.State)
	}
}

// 超出总预算的操作必须定格为 failed，避免无限重投掩盖问题。
func TestRunModifyFailsOperationPastStaleBudget(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	op := f.begin(t, "task-1")

	original := modifyOperationStaleAfter
	modifyOperationStaleAfter = -time.Second
	t.Cleanup(func() { modifyOperationStaleAfter = original })

	_, err := f.svc.RunModifyOperation(ctx, &failingResizer{MockCloudProvider: provider.NewMockCloudProvider()}, op.ID)
	if err == nil {
		t.Fatalf("expected the failing step to surface")
	}
	stored, err := f.svc.GetModifyOperation(ctx, op.ID)
	if err != nil {
		t.Fatalf("get operation: %v", err)
	}
	if stored.Status != core.ModifyOperationStatusFailed || stored.CompletedAt == nil {
		t.Fatalf("expected failed terminal state, got %s completed_at=%v", stored.Status, stored.CompletedAt)
	}
}

func TestReconcileModifyOperationsAdvancesRunningLedger(t *testing.T) {
	ctx := context.Background()
	f := newModifyFixture(t)
	f.begin(t, "task-1")

	completed, err := f.svc.ReconcileModifyOperations(ctx, provider.NewMockCloudProvider(), 10)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if completed != 1 {
		t.Fatalf("expected 1 completed operation, got %d", completed)
	}
}

func TestRunModifyRequiresResizerCapability(t *testing.T) {
	f := newModifyFixture(t)
	op := f.begin(t, "task-1")
	_, err := f.svc.RunModifyOperation(context.Background(), noResizeProvider{}, op.ID)
	if err == nil {
		t.Fatalf("expected a provider without resize support to be rejected")
	}
}

// countingResizer 记录云侧规格调用次数，用于断言不可逆步骤没有被重复执行。
type countingResizer struct {
	*provider.MockCloudProvider
	computeResizes int
	diskResizes    int
}

func (c *countingResizer) ResizeInstanceType(ctx context.Context, cloudID, instanceType string) error {
	c.computeResizes++
	return c.MockCloudProvider.ResizeInstanceType(ctx, cloudID, instanceType)
}

func (c *countingResizer) ResizeSystemDisk(ctx context.Context, cloudID string, sizeGB int) error {
	c.diskResizes++
	return c.MockCloudProvider.ResizeSystemDisk(ctx, cloudID, sizeGB)
}

// failingResizer 让计算规格升级这一步永远失败，停机步骤仍然成功。
type failingResizer struct {
	*provider.MockCloudProvider
}

func (failingResizer) ResizeInstanceType(context.Context, string, string) error {
	return errors.New("cvm rejected the instance type change")
}

// noResizeProvider 只实现 CloudProvider，用来模拟不支持变配的 provider。
type noResizeProvider struct{}

func (noResizeProvider) CreateInstance(context.Context, core.Pool) (string, string, error) {
	return "", "", nil
}
func (noResizeProvider) ReinstallInstance(context.Context, string, string) error { return nil }
func (noResizeProvider) DescribeInstance(context.Context, string) (string, error) {
	return "RUNNING", nil
}
func (noResizeProvider) TerminateInstance(context.Context, string) error { return nil }
func (noResizeProvider) VerifyInstance(context.Context, string) error    { return nil }
func (noResizeProvider) StopInstance(context.Context, string) error      { return nil }
func (noResizeProvider) StartInstance(context.Context, string) error     { return nil }
func (noResizeProvider) CreateInstanceSnapshot(context.Context, provider.CreateInstanceSnapshotRequest) (string, error) {
	return "", nil
}
func (noResizeProvider) DescribeInstanceSnapshot(context.Context, string) (provider.SnapshotStatus, string, error) {
	return provider.SnapshotStatusReady, "", nil
}
