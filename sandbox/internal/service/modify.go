package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/store"
)

// 同 SP 升配（变配）：把一台已交付实例原地升到更高规格，而不是重新发放。
//
// 与 pause/resume 的关键差异是系统盘扩容不可逆，所以这里不做"失败即回滚"，而是
// 账本 + 单向续跑：每个云侧步骤成功后写 current_step，重试只会从下一步开始。
// 实例在整个过程中停在 MODIFYING，容量语义等同 ALLOCATED（既不是空闲库存，也不
// 参与 refill），worker 的 stale 清理不会把它扫成 FAILED。

// modifySteps 是唯一的步骤顺序来源；续跑时按 current_step 在这里取下一步。
var modifySteps = []string{
	core.ModifyStepStopInstance,
	core.ModifyStepResizeCompute,
	core.ModifyStepResizeDisk,
	core.ModifyStepStartInstance,
	core.ModifyStepVerifyDelivery,
	core.ModifyStepRebindPool,
}

// modifyOperationStaleAfter 是单次升配的总预算。超预算仍未收敛的操作转 failed，
// 交人工介入：继续无限重投只会掩盖问题，而云侧资源已经在计费。
var modifyOperationStaleAfter = 2 * time.Hour

// BeginModifyInput 描述一次升配请求。IdempotencyKey 由 ctl 单实例 child task ID
// 提供，同一 child task 的多次重投复用同一份账本。
//
// 只接收目标归属：源 Pool、源 SKU 和实例都由 SandboxID 派生，target template class
// 由目标 Pool 派生，避免调用方传错源规格把账本冻结在错误的目标上。
type BeginModifyInput struct {
	IdempotencyKey string
	SandboxID      string
	TargetPoolID   string
	TargetSKUID    string
}

// BeginModifyOperation 冻结目标规格、把实例切到 MODIFYING 并落账本。
// 重复调用同一 IdempotencyKey 返回既有账本，不重复执行任何云操作。
func (s *Service) BeginModifyOperation(ctx context.Context, in BeginModifyInput) (core.ModifyOperation, error) {
	key := strings.TrimSpace(in.IdempotencyKey)
	sandboxID := strings.TrimSpace(in.SandboxID)
	targetPoolID := strings.TrimSpace(in.TargetPoolID)
	if key == "" || sandboxID == "" || targetPoolID == "" {
		return core.ModifyOperation{}, errors.New("modify: idempotency key, sandbox id and target pool id are required")
	}

	sb, err := s.store.GetSandbox(ctx, sandboxID)
	if err != nil {
		return core.ModifyOperation{}, err
	}
	inst, err := s.store.GetInstance(ctx, sb.InstanceID)
	if err != nil {
		return core.ModifyOperation{}, err
	}
	sourcePool, err := s.store.GetPool(ctx, inst.PoolID)
	if err != nil {
		return core.ModifyOperation{}, err
	}
	targetPool, err := s.store.GetPool(ctx, targetPoolID)
	if err != nil {
		return core.ModifyOperation{}, err
	}

	sourceType, sourceDisk := effectivePoolSpec(sourcePool)
	targetType, targetDisk := effectivePoolSpec(targetPool)
	if targetDisk < sourceDisk {
		return core.ModifyOperation{}, fmt.Errorf("%w: system disk cannot shrink (%dG -> %dG)",
			core.ErrModifyTargetNotUpgrade, sourceDisk, targetDisk)
	}
	if targetType == sourceType && targetDisk == sourceDisk && targetPoolID == inst.PoolID {
		return core.ModifyOperation{}, fmt.Errorf("%w: %s / %dG in pool %s",
			core.ErrModifyTargetAlreadyApplied, targetType, targetDisk, targetPoolID)
	}

	if inst.State != core.StateAllocated && inst.State != core.StateModifying {
		return core.ModifyOperation{}, core.ErrInvalidTransition
	}

	// 一台实例只允许一份 running 账本。ctl 子 task 耗尽重试窗口后，父 task 会用新的
	// task ID（= 新幂等键）重派，而此时 sandbox 侧的账本往往还在跑（它有自己更长的
	// stale 预算）。这一轮必须认领在跑的那份继续前滚，否则两个 runner 会对同一台机器
	// 交错下发停机 / 改配 / 扩盘。
	if running, found, err := s.store.GetRunningModifyOperationByInstance(ctx, inst.ID); err != nil {
		return core.ModifyOperation{}, err
	} else if found && running.IdempotencyKey != key {
		if running.TargetPoolID != targetPoolID {
			return core.ModifyOperation{}, fmt.Errorf(
				"%w: instance %s already converging to pool %s, refusing a concurrent target %s",
				core.ErrModifyOperationConflict, inst.ID, running.TargetPoolID, targetPoolID)
		}
		return s.ensureInstanceModifying(ctx, inst, running)
	}

	now := time.Now().UTC()
	op := core.ModifyOperation{
		ID:                    "mod-" + uuid.NewString(),
		IdempotencyKey:        key,
		SandboxID:             sb.ID,
		InstanceID:            inst.ID,
		SourcePoolID:          inst.PoolID,
		TargetPoolID:          targetPoolID,
		TargetSKUID:           firstNonEmptyString(strings.TrimSpace(in.TargetSKUID), targetPool.SKUID),
		TargetTemplateClassID: targetPool.TemplateClassID,
		TargetInstanceType:    targetType,
		TargetSystemDiskSize:  targetDisk,
		Status:                core.ModifyOperationStatusRunning,
		StartedAt:             now,
		UpdatedAt:             now,
	}
	op, _, err = s.store.CreateModifyOperation(ctx, op)
	if err != nil {
		return core.ModifyOperation{}, err
	}
	return s.ensureInstanceModifying(ctx, inst, op)
}

// ensureInstanceModifying 把实例停靠在 MODIFYING 后再交还账本。
//
// 建账本和切状态不在一个事务里，所以两者之间崩掉会留下"账本在跑、实例还是
// ALLOCATED"的窗口。这一步在每条返回路径上都跑（含同键重放和认领在跑账本），
// 让重试自己把窗口收掉；否则实例会带着 ALLOCATED 被分配或暂停，而云侧步骤照跑。
func (s *Service) ensureInstanceModifying(
	ctx context.Context,
	inst core.Instance,
	op core.ModifyOperation,
) (core.ModifyOperation, error) {
	if op.Status != core.ModifyOperationStatusRunning || inst.State != core.StateAllocated {
		return op, nil
	}
	if _, err := s.store.UpdateInstanceState(ctx, inst.ID, core.StateAllocated, core.StateModifying); err != nil {
		return core.ModifyOperation{}, err
	}
	return op, nil
}

// GetModifyOperation 返回账本当前状态，供 ctl 子 task 轮询。
func (s *Service) GetModifyOperation(ctx context.Context, id string) (core.ModifyOperation, error) {
	return s.store.GetModifyOperation(ctx, strings.TrimSpace(id))
}

// RunModifyOperation 从 current_step 之后开始单向续跑，直到收敛或某一步失败。
// 失败只记录 last_error 并保持 running，让调用方（worker / ctl 子 task 重投）再来一次；
// 超出 modifyOperationStaleAfter 预算才转 failed。
func (s *Service) RunModifyOperation(ctx context.Context, cp provider.CloudProvider, operationID string) (core.ModifyOperation, error) {
	resizer, ok := cp.(provider.InstanceSpecResizer)
	if !ok {
		return core.ModifyOperation{}, errors.New("cloud provider does not support instance spec resize")
	}
	op, err := s.store.GetModifyOperation(ctx, strings.TrimSpace(operationID))
	if err != nil {
		return core.ModifyOperation{}, err
	}
	if op.Status != core.ModifyOperationStatusRunning {
		return op, nil
	}
	inst, err := s.store.GetInstance(ctx, op.InstanceID)
	if err != nil {
		return core.ModifyOperation{}, err
	}
	sb, err := s.store.GetSandbox(ctx, op.SandboxID)
	if err != nil {
		return s.recordModifyOperationError(ctx, op, err)
	}
	if sb.InstanceID != op.InstanceID {
		return s.recordModifyOperationError(ctx, op, fmt.Errorf(
			"modify operation %s lost sandbox ownership: sandbox %s owns instance %s, expected %s",
			op.ID, sb.ID, sb.InstanceID, op.InstanceID))
	}

	// A crash can occur after the running ledger is committed but before the API
	// parks the instance in MODIFYING. The worker is also an entry point, so it
	// must close that window itself before issuing any cloud mutation.
	if op.CurrentStep != core.ModifyStepRebindPool {
		switch inst.State {
		case core.StateAllocated:
			inst, err = s.store.UpdateInstanceState(ctx, inst.ID, core.StateAllocated, core.StateModifying)
			if err != nil {
				return s.recordModifyOperationError(ctx, op, err)
			}
		case core.StateModifying:
			// Expected steady state while cloud steps are in progress.
		default:
			return s.recordModifyOperationError(ctx, op, fmt.Errorf(
				"%w: modify operation %s requires instance %s in ALLOCATED or MODIFYING, got %s",
				core.ErrInvalidTransition, op.ID, inst.ID, inst.State))
		}
	} else if inst.PoolID != op.TargetPoolID || sb.PoolID != op.TargetPoolID {
		return s.recordModifyOperationError(ctx, op, fmt.Errorf(
			"%w: completed rebind for operation %s requires instance and sandbox in pool %s, got instance=%s sandbox=%s",
			core.ErrInvalidTransition, op.ID, op.TargetPoolID, inst.PoolID, sb.PoolID))
	}
	if strings.TrimSpace(inst.CloudID) == "" {
		return s.failModifyOperation(ctx, op, errors.New("instance has no cloud id"))
	}

	for _, step := range remainingModifySteps(op.CurrentStep) {
		if err := s.runModifyStep(ctx, cp, resizer, op, inst, step); err != nil {
			return s.recordModifyOperationError(ctx, op, err)
		}
		op, err = s.store.UpdateModifyOperationProgress(ctx, store.ModifyOperationProgress{
			ID:          op.ID,
			Status:      core.ModifyOperationStatusRunning,
			CurrentStep: step,
		})
		if err != nil {
			return core.ModifyOperation{}, err
		}
	}

	completedAt := time.Now().UTC()
	return s.store.UpdateModifyOperationProgress(ctx, store.ModifyOperationProgress{
		ID:          op.ID,
		Status:      core.ModifyOperationStatusCompleted,
		CurrentStep: core.ModifyStepDone,
		CompletedAt: &completedAt,
	})
}

func (s *Service) recordModifyOperationError(ctx context.Context, op core.ModifyOperation, cause error) (core.ModifyOperation, error) {
	if time.Since(op.StartedAt) > modifyOperationStaleAfter {
		return s.failModifyOperation(ctx, op, cause)
	}
	progressed, err := s.store.UpdateModifyOperationProgress(ctx, store.ModifyOperationProgress{
		ID:          op.ID,
		Status:      core.ModifyOperationStatusRunning,
		CurrentStep: op.CurrentStep,
		LastError:   cause.Error(),
	})
	if err != nil {
		return core.ModifyOperation{}, err
	}
	return progressed, cause
}

func (s *Service) runModifyStep(ctx context.Context, cp provider.CloudProvider, resizer provider.InstanceSpecResizer,
	op core.ModifyOperation, inst core.Instance, step string) error {
	switch step {
	case core.ModifyStepStopInstance:
		return resizer.StopInstanceForResize(ctx, inst.CloudID)
	case core.ModifyStepResizeCompute:
		return resizer.ResizeInstanceType(ctx, inst.CloudID, op.TargetInstanceType)
	case core.ModifyStepResizeDisk:
		return resizer.ResizeSystemDisk(ctx, inst.CloudID, op.TargetSystemDiskSize)
	case core.ModifyStepStartInstance:
		return cp.StartInstance(ctx, inst.CloudID)
	case core.ModifyStepVerifyDelivery:
		// notBefore 传零值：这一步验的是"改配重启后 agent 活着"，不是首次交付的
		// 世代归属。liveness 由探测自带的心跳新鲜度窗口保证，而停机 + 改配 + 扩盘
		// 的耗时远超那个窗口，重启前的旧心跳无法冒充。
		return provider.VerifyInstanceDelivery(ctx, cp, inst.CloudID, time.Time{})
	case core.ModifyStepRebindPool:
		return s.finishModifyRebind(ctx, op)
	default:
		return fmt.Errorf("unknown modify step %q", step)
	}
}

// finishModifyRebind 把实例的归属改到目标池并放回 ALLOCATED。CVM 本体、IP、
// VPC、子网和安全组都不动，改的只是路由归属元数据。
func (s *Service) finishModifyRebind(ctx context.Context, op core.ModifyOperation) error {
	if _, err := s.store.RebindAllocatedInstance(ctx, store.RebindInstanceInput{
		InstanceID:      op.InstanceID,
		ExpectedState:   core.StateModifying,
		TargetPoolID:    op.TargetPoolID,
		TemplateClassID: op.TargetTemplateClassID,
		// resolution_source is a VARCHAR(32) provenance category, not an
		// operation identifier. The full UUID remains in modify_operations.
		ResolutionSource: "modify",
	}); err != nil {
		return err
	}
	_, err := s.store.UpdateInstanceState(ctx, op.InstanceID, core.StateModifying, core.StateAllocated)
	return err
}

// failModifyOperation 把超预算的操作定格为 failed。实例留在 MODIFYING：它仍在计费
// 且规格可能已部分变更，只有人工才能判断是继续升配还是退款销毁。
func (s *Service) failModifyOperation(ctx context.Context, op core.ModifyOperation, cause error) (core.ModifyOperation, error) {
	failedAt := time.Now().UTC()
	failed, err := s.store.UpdateModifyOperationProgress(ctx, store.ModifyOperationProgress{
		ID:          op.ID,
		Status:      core.ModifyOperationStatusFailed,
		CurrentStep: op.CurrentStep,
		LastError:   cause.Error(),
		CompletedAt: &failedAt,
	})
	if err != nil {
		return core.ModifyOperation{}, err
	}
	return failed, cause
}

// ReconcileModifyOperations 推进所有在跑的升配操作，返回收敛完成的条数。
// 单条失败不打断其余操作：它们互不相关，各自有独立的重试预算。
func (s *Service) ReconcileModifyOperations(ctx context.Context, cp provider.CloudProvider, limit int) (int, error) {
	ops, err := s.store.ListModifyOperationsByStatus(ctx, core.ModifyOperationStatusRunning, limit)
	if err != nil {
		return 0, err
	}
	completed := 0
	var firstErr error
	for _, op := range ops {
		result, err := s.RunModifyOperation(ctx, cp, op.ID)
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("modify operation %s: %w", op.ID, err)
			}
			continue
		}
		if result.Status == core.ModifyOperationStatusCompleted {
			completed++
		}
	}
	return completed, firstErr
}

// remainingModifySteps 返回 current_step 之后待执行的步骤。
func remainingModifySteps(currentStep string) []string {
	if strings.TrimSpace(currentStep) == "" {
		return modifySteps
	}
	for i, step := range modifySteps {
		if step == currentStep {
			return modifySteps[i+1:]
		}
	}
	return nil
}

// effectivePoolSpec 返回池实际下发给 CVM 的规格，补齐历史行留空的字段。
func effectivePoolSpec(pool core.Pool) (instanceType string, systemDiskSize int) {
	instanceType = firstNonEmptyString(strings.TrimSpace(pool.InstanceType), defaultInstanceType)
	systemDiskSize = pool.SystemDiskSize
	if systemDiskSize <= 0 {
		systemDiskSize = defaultSystemDiskSize
	}
	return instanceType, systemDiskSize
}
