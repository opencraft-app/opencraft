package pass

import (
	"errors"
	"strings"

	pctx "ctl/pkg/context"
	"ctl/pkg/config"
	"ctl/pkg/errcode"
	instanceasync "ctl/pkg/instance"
	modelfactory "ctl/pkg/model/factory"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/resource"

	"go.uber.org/zap"
)

// === trade-pass-destroy 销毁主链入口（设计稿 §3.5 / §4.5.2 / §4.5.3 / §11-A Q1 / Q2 / Q24） ===
//
// DestroyPass 是 jifei → trade.destroyResource handler 反向调 ctl 的主链入口（与 IsolatePass
// 同范式）：
//   1. 入参强校验（passID 必填）
//   2. CAS pass.status: deleting∨isolated → terminating（dao.TryAcquireSlotForTerminate）
//        - 双源 from 兼容入口 A（deleting）+ 入口 B（isolated）；详见状态机 §3.5
//   3. enqueue 父 task DestroyPass 异步推进（30s × 极大兜底，"永不放弃"，与 isolate 同范式）
//   4. 返 taskID 让 caller (trade) 串联 trade_flow.task_ref 后续轮询查询
//
// 关键差异（vs IsolatePass）：
//   - IsolatePass：CAS active→isolating（单源）+ 派 IsolatePass 父 task
//   - DestroyPass：CAS deleting∨isolated→terminating（双源）+ 派 DestroyPass 父 task

// 父 task 自身重试节奏：30s × 极大兜底（与 IsolatePass 父 task 同范式）
const (
	destroyPassParentExecuteIntervalSeconds = int64(30)
	destroyPassParentMaxExecuteCount        = 1 << 30
)

// DestroyPass 详见 Logic 接口注释（设计稿 §3.5 / §4.5.2 / §4.5.3 / §11-A Q1 / Q2 / Q24）
//
// tradeFlowID 与 IsolatePass 同语义：> 0 时父 task 终态 best-effort 反向 callback；== 0 不发 callback。
// destroyReason 镜像 jifei `para.source` 原值（biz/qn/other/空串），父 task 收尾步 5b 写入
// history_pass.destroy_reason 列。
func (l *logic) DestroyPass(passID string, tradeFlowID int64, destroyReason string) (string, error) {
	passID = strings.TrimSpace(passID)
	if passID == "" {
		return "", errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required")
	}

	logger := destroyLogger().With(
		zap.String("pass_id", passID),
		zap.Int64("trade_flow_id", tradeFlowID),
		zap.String("destroy_reason", destroyReason),
	)

	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)

	// 步骤 1：反查 pass 取 entity（拿 user_id 透传给父 task；同时给后续状态判断打底）
	entity, err := passDao.GetByPassID(passID)
	if err != nil {
		if errors.Is(err, errcode.ErrPassNotFound) {
			return "", errcode.ErrPassNotFound
		}
		return "", errcode.Wrap(errcode.ErrPassNotFound, "get pass: %v", err)
	}

	// 步骤 2：状态预判（提前给出明确错误码 — 与 IsolatePass / DeletePass 同范式）
	switch entity.Status {
	case passmodel.StatusTerminating:
		// 重投或并发抢占 — 销毁主链已启动，幂等返 ErrPassTerminating
		// trade 侧 destroyResource handler 应据此视为 idempotent 成功（已在跑）。
		logger.Info("DestroyPass: pass already in terminating, idempotent reject")
		return "", errcode.ErrPassTerminating
	case passmodel.StatusDeleting, passmodel.StatusIsolated:
		// 正确入口态，进入 CAS（双源 from）
	default:
		// active / isolating / renewing 等：不应进入销毁主链
		logger.Warn("DestroyPass: pass status not in {deleting, isolated}, reject",
			zap.String("status", entity.Status))
		return "", errcode.Wrap(errcode.ErrPassInvalidParam,
			"pass status %q not eligible for destroy (expect deleting or isolated)", entity.Status)
	}

	// 步骤 3：CAS deleting∨isolated → terminating
	acquired, err := passDao.TryAcquireSlotForTerminate(passID)
	if err != nil {
		return "", errcode.Wrap(errcode.ErrPassNotFound, "TryAcquireSlotForTerminate: %v", err)
	}
	if !acquired {
		// 极端并发：刚才 GetByPassID 拿到 deleting/isolated，CAS 时被并发抢走（极罕见）
		// 再读一次决定精确错误码
		latest, getErr := passDao.GetByPassID(passID)
		if getErr != nil {
			return "", errcode.Wrap(errcode.ErrPassNotFound, "re-read pass: %v", getErr)
		}
		if latest.Status == passmodel.StatusTerminating {
			return "", errcode.ErrPassTerminating
		}
		return "", errcode.Wrap(errcode.ErrPassInvalidParam,
			"pass status unexpected after CAS reject: %s", latest.Status)
	}
	logger.Info("DestroyPass: pass status flipped to terminating",
		zap.String("from_status", entity.Status))

	// 步骤 4：enqueue 父 task；ctx 用 system context（不依赖调用方 user 维度，与 IsolatePass 一致）
	ctx := pctx.NewContext(nil)
	// Region（Q21 ✅ 拍板）：透传 ctl 进程配置 config.ServerConf.MiscConfig.Region 给父 task，
	// 父 task 派子 task 时透传到 DestroyInstanceForPassTaskPayload，
	// 子 task 入 snapshot 表时作为 snapshot.region 列值（本期单集群单 region 前提下 = 实例所在 region）。
	region := ""
	if config.ServerConf != nil {
		region = config.ServerConf.MiscConfig.Region
	}
	taskID, err := instanceasync.EnqueueDestroyPassTask(
		ctx,
		passID,
		entity.UserID,
		"", // operationID：trade 侧自己维护 trade_flow，本期不复用 ctl operation_history（与 IsolatePass 一致）
		tradeFlowID,
		destroyReason,
		region,
		destroyPassParentExecuteIntervalSeconds,
		destroyPassParentMaxExecuteCount,
	)
	if err != nil {
		// 派发失败不回滚 terminating（与 IsolatePass 派发失败的"留 isolating 不回滚"同决策）：
		// pass 已被推进到 terminating，等 reconcile worker / 人工补 task。
		logger.Error("DestroyPass: enqueue parent task failed, pass remains in terminating",
			zap.Error(err))
		return "", errcode.Wrap(errcode.ErrPassNotFound, "enqueue parent task: %v", err)
	}
	logger.Info("DestroyPass: parent task enqueued", zap.String("task_id", taskID))
	return taskID, nil
}

// destroyLogger 返回非空 logger（resource.ZapLogger 在 server 启动早期可能尚未初始化）
func destroyLogger() *zap.Logger {
	if resource.ZapLogger != nil {
		return resource.ZapLogger
	}
	return zap.NewNop()
}
