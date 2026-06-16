package pass

import (
	"errors"
	"strings"
	"time"

	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	instanceasync "ctl/pkg/instance"
	modelfactory "ctl/pkg/model/factory"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/resource"

	"go.uber.org/zap"
)

// === trade-pass-isolate 设计稿落地（§10 Q22-I-E / Q23 / Q35）===
//
// IsolatePass 入口被 trade 反向调用（鉴权由 transport 层把守），完成两个事情：
//   1. CAS pass.status active → isolating（CreateInstance 拦截立刻生效）
//   2. enqueue 父 task IsolatePass 异步处理 instance pause + 推进 isolated
//
// 返回值：
//   - taskID：父 task 的 task_id，用于 trade 串联 trade_flow.task_ref
//   - error：
//       - ErrPassNotFound：pass 不存在
//       - ErrPassIsolating：CAS 失败因当前 status 已是 isolating（重入幂等保护）
//       - ErrPassIsolated：CAS 失败因当前 status 已是 isolated
//       - ErrPassInvalidParam：参数缺失
//       - 其他 wrapped error：DB / MQ 异常

// 父 task 自身重试节奏：30s × 极大兜底
const (
	isolatePassParentExecuteIntervalSeconds = int64(30)
	// max 用 1<<30 ≈ 1B 次（int 字段足够），配合 30s = "永不放弃"兜底
	// 真实场景由 reconcile worker 在 stuck 30min 后清理，不会真的跑到 1B 次
	isolatePassParentMaxExecuteCount = 1 << 30
)

// IsolatePass 详见 Logic 接口注释
//
// tradeFlowID 是 trade 侧 trade_flow.id PK（端到端闭环 §10 Q22-I-E / 2026-05-15）：
//   - > 0：父 task IsolatePass 终态时 best-effort 反向调 trade
//     POST /internal/trade/flows/{flow_id}/complete 推进 trade_flow 终态
//   - == 0：兼容老调用（dev/test / 本地直接调 ctl）；ctl 父 task 终态不发 callback
//
// newDeadline / dealName 详见 Logic 接口注释（v1.7.30 BUG-35 退费隔离拓展）。
func (l *logic) IsolatePass(passID string, tradeFlowID int64, newDeadline *time.Time, dealName string) (string, error) {
	passID = strings.TrimSpace(passID)
	if passID == "" {
		return "", errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required")
	}

	logger := isolateLogger().With(
		zap.String("pass_id", passID),
		zap.Int64("trade_flow_id", tradeFlowID),
		zap.Bool("refund_branch", newDeadline != nil),
		zap.String("deal_name", dealName),
	)

	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	entity, err := passDao.GetByPassID(passID)
	if err != nil {
		if errors.Is(err, errcode.ErrPassNotFound) {
			return "", errcode.ErrPassNotFound
		}
		return "", errcode.Wrap(errcode.ErrPassNotFound, "get pass: %v", err)
	}

	// 退费分支校验（v1.7.30 BUG-35）：newDeadline != nil 时，必须严格压缩到期时间：
	//   pass.expired_time > *newDeadline
	// 不接受等于（业务无意义），不接受拉长（防止 jifei 协议层 bug 被薄薄拉长有效期）。
	//
	// 与到期隔离不同点：不检验 expired_time < now。退费可发生在 pass 未到期时。
	if newDeadline != nil {
		if !entity.ExpiredTime.After(*newDeadline) {
			logger.Warn("IsolatePass: refund newDeadline rejected (must be strictly earlier than current expired_time)",
				zap.Time("current_expired_time", entity.ExpiredTime),
				zap.Time("new_deadline", *newDeadline),
			)
			return "", errcode.Wrap(
				errcode.ErrPassNewDeadlineInvalid,
				"newDeadline=%s must be strictly earlier than pass.expired_time=%s",
				newDeadline.UTC().Format(time.RFC3339),
				entity.ExpiredTime.UTC().Format(time.RFC3339),
			)
		}
	}

	// 幂等：已处于 isolating / isolated 时不重复派发；返回明确状态码让 trade 决定
	switch entity.Status {
	case passmodel.StatusIsolating:
		logger.Info("IsolatePass: already in isolating, skip dispatch")
		return "", errcode.ErrPassIsolating
	case passmodel.StatusIsolated:
		logger.Info("IsolatePass: already isolated, skip dispatch")
		return "", errcode.ErrPassIsolated
	}

	// CAS active → isolating
	acquired, err := passDao.TryAcquireSlotForIsolate(passID)
	if err != nil {
		return "", errcode.Wrap(errcode.ErrPassNotFound, "TryAcquireSlotForIsolate: %v", err)
	}
	if !acquired {
		// 极端并发场景：刚好在 GetByPassID 之后被其他流程抢走；再读一次决定返回哪个错误
		latest, getErr := passDao.GetByPassID(passID)
		if getErr != nil {
			return "", errcode.Wrap(errcode.ErrPassNotFound, "re-read pass: %v", getErr)
		}
		switch latest.Status {
		case passmodel.StatusIsolating:
			return "", errcode.ErrPassIsolating
		case passmodel.StatusIsolated:
			return "", errcode.ErrPassIsolated
		default:
			return "", errcode.Wrap(errcode.ErrPassInvalidParam, "pass status unexpected after CAS reject: %s", latest.Status)
		}
	}
	logger.Info("IsolatePass: pass status flipped to isolating")

	// enqueue 父 task；ctx 用一个 system context 即可（不依赖调用方 user 维度）
	ctx := pctx.NewContext(nil)
	taskID, err := instanceasync.EnqueueIsolatePassTask(
		ctx,
		passID,
		entity.UserID,
		"", // operationID：trade 侧自己维护 trade_flow，本期不复用 ctl operation_history
		tradeFlowID,
		newDeadline, // 退费场景透传【退费过后的】新到期时间给父 task；生命周期场景传 nil
		dealName,    // 退费场景透传子订单号给父 task（仅日志）
		isolatePassParentExecuteIntervalSeconds,
		isolatePassParentMaxExecuteCount,
	)
	if err != nil {
		// 派发失败不回滚 isolating（CreateInstance 已被拦截，等 reconcile worker 接管或人工干预）
		logger.Error("IsolatePass: enqueue parent task failed, pass remains in isolating",
			zap.Error(err),
		)
		return "", errcode.Wrap(errcode.ErrPassNotFound, "enqueue parent task: %v", err)
	}
	logger.Info("IsolatePass: parent task enqueued", zap.String("task_id", taskID))
	return taskID, nil
}

// isolateLogger 返回非空 logger（resource.ZapLogger 在 server 启动早期可能尚未初始化）
func isolateLogger() *zap.Logger {
	if resource.ZapLogger != nil {
		return resource.ZapLogger
	}
	return zap.NewNop()
}
