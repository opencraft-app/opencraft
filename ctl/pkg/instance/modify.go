package instance

import (
	"errors"
	"fmt"
	"strings"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"
	"ctl/pkg/taskruntime/common"

	"go.uber.org/zap"
)

// 同 SP 变配的单实例执行。需求：TAPD 1010132091137784162 §5.4 / §8.1
//
// 一台机器的升配在腾讯云侧要走停机 → 改计算规格 → 扩系统盘 → 开机 → 重绑目标 Pool，
// 整体可达十几分钟，所以这里不做同步等待：创建 sandbox operation 后把 operation_id
// 持久化进 payload，之后每轮重投只是轮询账本。
//
// 系统盘扩容不可逆，因此 operation_id 一旦落进 payload 就绝不能丢——重投时必须复用
// 原 operation，否则会对同一块盘发第二次扩容。

// modifyPollWaitErr 表示 sandbox operation 已受理但云侧还没跑完。
// worker 层把它当暂态错处理，让框架按 60s 间隔重投继续轮询。
var modifyPollWaitErr = errors.New("waiting for sandbox modify operation")

// ErrModifyPermanentFailed 是 fail-fast 哨兵：命中后子 task 跳过剩余重试窗口直接终态失败，
// 让父 task 立即看到失败而不是空转 1 小时。命中场景是 payload 关键字段缺失和
// sandbox 报账本冲突——这两类重试无法自愈。
var ErrModifyPermanentFailed = errors.New("modify permanent failed")

// RunModifyInstanceTask 是变配子 task 的 execute 入口。
func (l *logic) RunModifyInstanceTask(ctx pctx.Context, taskID string, payload *common.ModifyInstanceTaskPayload) error {
	if payload == nil || strings.TrimSpace(payload.InstanceID) == "" {
		return fmt.Errorf("%w: %v", ErrModifyPermanentFailed, errcode.ErrInstanceInvalidParam)
	}
	if strings.TrimSpace(payload.TargetPoolID) == "" {
		return fmt.Errorf("%w: payload.TargetPoolID is required", ErrModifyPermanentFailed)
	}
	if taskID == "" {
		// taskID 同时是 sandbox 幂等键，缺了它无法保证不重复扩盘。
		return fmt.Errorf("%w: taskID is required as sandbox idempotency key", ErrModifyPermanentFailed)
	}

	logger := l.logger.With(
		zap.String("instance_id", payload.InstanceID),
		zap.String("pass_id", payload.PassID),
		zap.String("task_id", taskID),
		zap.String("target_pool_id", payload.TargetPoolID),
	)

	entity, err := l.instanceDao.GetByInstanceID(ctx, payload.InstanceID)
	if err != nil {
		if errors.Is(err, errcode.ErrInstanceNotFound) {
			// 用户在升配途中把实例删了：没有升配目标，业务目标天然达成。
			logger.Info("modify task: instance not found, treat as success")
			return nil
		}
		return fmt.Errorf("get instance: %w", err)
	}
	switch entity.Status {
	case modelinstance.InstanceStatusDeleted, modelinstance.InstanceStatusFailed:
		logger.Info("modify task: instance in terminal state, no-op", zap.String("status", entity.Status))
		return nil
	case modelinstance.InstanceStatusRunning:
		// 正常路径。已经跑完的重投也从这里进来，靠 operation 状态判断是否收尾过。
	default:
		// Creating / Paused / Resuming / Deleting：等它先稳定下来再动规格。
		// 入口 assertInstancesModifiable 已要求全 Running，走到这里说明途中有别的操作插了进来。
		return fmt.Errorf("instance status=%s not eligible for modify yet", entity.Status)
	}

	sandboxID := strings.TrimSpace(payload.SandboxID)
	if sandboxID == "" {
		sandboxID = entity.SandboxId
	}
	if sandboxID == "" || isPendingSandboxID(sandboxID) {
		// 没有可用 sandbox 意味着没有云资源可升配；套餐级权益仍会由父 task 升级。
		logger.Warn("modify task: instance has no usable sandbox, skip cloud modify",
			zap.String("sandbox_id", sandboxID))
		return nil
	}

	// === 阶段 1：创建或命中 sandbox operation ===
	if payload.SandboxOperationID == "" {
		op, err := l.sandboxAdapter.Modify(ctx, sandboxID, &psandbox.ModifyRequest{
			IdempotencyKey: taskID,
			TargetPoolID:   payload.TargetPoolID,
			TargetSKUID:    payload.TargetSKUID,
		})
		if err != nil {
			if isModifyAlreadyApplied(err) {
				// 实例已经在目标规格和目标池上：上一份账本收尾了，但那一轮的子 task
				// 已经超时被重派。这是"已收敛"而不是错误——继续重试只会让永不放弃的
				// 父 task 空转。
				logger.Info("modify task: instance already at target spec, treat as success")
				return nil
			}
			if isModifyOperationConflict(err) || isModifyTargetNotUpgrade(err) {
				// 冲突 = 同一 idempotency_key 换了目标规格；not-upgrade = 目标规格更低。
				// 两者都是解析结果本身有问题，重试无法自愈。
				return fmt.Errorf("%w: sandbox rejected modify target: %v", ErrModifyPermanentFailed, err)
			}
			return fmt.Errorf("sandbox.Modify: %w", err)
		}
		payload.SandboxOperationID = op.OperationID
		if err := l.updateTaskPayload(ctx, taskID, payload); err != nil {
			// 必须先落盘再返回：operation_id 丢了就会在下一轮重投里对同一块盘发第二次扩容。
			return fmt.Errorf("persist sandbox operation id: %w", err)
		}
		logger.Info("modify task: sandbox operation accepted",
			zap.String("sandbox_operation_id", op.OperationID))
		return modifyPollWaitErr
	}

	// === 阶段 2：轮询账本 ===
	op, err := l.sandboxAdapter.GetModifyOperation(ctx, payload.SandboxOperationID)
	if err != nil {
		return fmt.Errorf("sandbox.GetModifyOperation: %w", err)
	}
	switch op.Status {
	case psandbox.ModifyOperationStatusCompleted:
		logger.Info("modify task: sandbox operation completed",
			zap.String("sandbox_operation_id", op.OperationID),
			zap.String("target_pool_id", op.TargetPoolID),
			zap.String("target_instance_type", op.TargetInstanceType),
			zap.Int("target_system_disk_size", op.TargetSystemDiskSize),
		)
		return nil
	case psandbox.ModifyOperationStatusFailed:
		// sandbox 的 failed 是终态（超出它自己的重试预算），本子 task 继续轮询也不会翻盘，
		// 但这里不 fail-fast：让 1h 窗口耗尽再终态失败，父 task 随后会用新的 task ID 重派，
		// 从而拿到一份新账本重新前滚。provider 每步都先回读云上实际规格，已落地的
		// 改配和扩盘不会被重复下发。
		return fmt.Errorf("sandbox modify operation failed at step %q: %s", op.CurrentStep, op.LastError)
	case psandbox.ModifyOperationStatusRunning:
		logger.Info("modify task: sandbox operation still running",
			zap.String("current_step", op.CurrentStep))
		return modifyPollWaitErr
	default:
		return fmt.Errorf("sandbox modify operation unexpected status: %q", op.Status)
	}
}

// 以下三个判定按 sandbox 返回的 code 字符串匹配，避免 ctl 反向依赖 sandbox 的错误类型。

// isModifyOperationConflict 识别 409 MODIFY_OPERATION_CONFLICT。
func isModifyOperationConflict(err error) bool {
	return containsSandboxCode(err, "MODIFY_OPERATION_CONFLICT")
}

// isModifyAlreadyApplied 识别 409 MODIFY_TARGET_ALREADY_APPLIED。
func isModifyAlreadyApplied(err error) bool {
	return containsSandboxCode(err, "MODIFY_TARGET_ALREADY_APPLIED")
}

// isModifyTargetNotUpgrade 识别 422 MODIFY_TARGET_NOT_UPGRADE。
func isModifyTargetNotUpgrade(err error) bool {
	return containsSandboxCode(err, "MODIFY_TARGET_NOT_UPGRADE")
}

func containsSandboxCode(err error, code string) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), code)
}
