package pass

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"ctl/pkg/adapter/aigateway"
	adapterfactory "ctl/pkg/adapter/factory"
	"ctl/pkg/adapter/llmgateway"
	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	instanceasync "ctl/pkg/instance"
	"ctl/pkg/logic/gatewayroute"
	bundlemodel "ctl/pkg/model/bundle"
	modelfactory "ctl/pkg/model/factory"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/resource"

	"go.uber.org/zap"
)

// extendAiGatewayCallTimeout ai-gateway ExtendSubscription 调用单次 ctx 超时（与异步
// renewPassTask 共享同一上限，10s 与现有 ApplySubscription 调用风格一致）。
const extendAiGatewayCallTimeout = 10 * time.Second

// === trade-pass-renew 设计稿落地 §3.1 / §3.4 v3.8 / R-D-1 ===
//
// RenewPass 是 trade 服务在 jifei renewResource 回调后反向调用 ctl 的入口。完成两个事情之一：
//
//	A. 提前续费（status=active 同步路径）：原子地用 newExpired = CalcExpiredTime(old_expired,
//	   timeSpan, timeUnit) 替换 pass.expired_time（status 仍 active），不动 isolated_time，
//	   不入队 task。返回 (taskID="", accepted=true, nil)。
//	B. 到期续费（status=isolated 异步路径，R-D-1 落地）：CAS isolated → renewing；
//	   不动 expired_time / isolated_time（new_expired 在父 task all-success 后才用 isolated_time
//	   为基线计算 — Q2=a）。入队 RenewPassTask 父任务，返回 (taskID, accepted=true, nil)。
//
// 异常分支（与设计稿 §3.1 异常分支表对齐）：
//
//	pass.status=='renewing'  → ErrPassRenewing  （trade 层据此返 returnCode=352014 / DeliveryFailRefund）
//	pass.status=='isolating' → ErrPassIsolating （隔离进行中不能续费）
//	pass.status 其他值 / pass 不存在 → ErrPassNotFound / ErrPassNotRenewable

// 异步父 task RenewPass 自身重试节奏（R-MR-5 升级，2026-05-24 用户拍板）：
//   - 30s × 5 次 = 2.5min 重试窗口
//   - 与 isolate 父 task "永不放弃 + INT64_MAX 兜底" 不同 — 续费失败不能无限重投，
//     否则会卡住 trade_flow（jifei 不会自动退款），且持续占着 pass.status='renewing' 让
//     用户无法发起新订单。
//   - max=5 用尽后由 finalizeFailure 派发 RollbackRenewPassTask 回滚副作用 +
//     CompleteFlow(failed) 触发 jifei 退款（详见 .tmp/trade-pass-renew-design.md
//     §3.4 失败回滚链路升级）。
const (
	renewPassParentExecuteIntervalSeconds = int64(30)
	// R-MR-5 升级：1<<30 → 5（有限重试 + 失败回滚链路接管）。
	renewPassParentMaxExecuteCount = 5
)

// RenewPass 详见 Logic 接口注释
//
// tradeFlowID 含义与 IsolatePass 同语义（> 0 时 task 终态 best-effort 反向 callback；
// 本期同步分支 A 不入队 task，trade 层自己处理 callback）。
func (l *logic) RenewPass(passID string, tradeFlowID int64, timeSpan int, timeUnit string) (string, bool, error) {
	// 步骤 0：入参强校验
	passID = strings.TrimSpace(passID)
	if passID == "" {
		return "", false, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required")
	}
	if timeSpan <= 0 {
		return "", false, errcode.Wrap(errcode.ErrPassInvalidParam, "time_span must be > 0, got %d", timeSpan)
	}
	if timeUnit != bundlemodel.TimeUnitMonth && timeUnit != bundlemodel.TimeUnitDay && timeUnit != bundlemodel.TimeUnitYear {
		return "", false, errcode.Wrap(errcode.ErrPassInvalidParam, "time_unit must be 'm', 'd' or 'y', got %q", timeUnit)
	}

	logger := renewLogger().With(
		zap.String("pass_id", passID),
		zap.Int64("trade_flow_id", tradeFlowID),
		zap.Int("time_span", timeSpan),
		zap.String("time_unit", timeUnit),
	)

	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)
	entity, err := passDao.GetByPassID(passID)
	if err != nil {
		if errors.Is(err, errcode.ErrPassNotFound) {
			return "", false, errcode.ErrPassNotFound
		}
		return "", false, errcode.Wrap(errcode.ErrPassNotFound, "get pass: %v", err)
	}

	// 步骤 1：按 status 路由分支（active 同步 / isolated 异步 / 其他拒收）
	switch entity.Status {
	case passmodel.StatusActive:
		// === R-MR-5 升级（2026-05-24 用户拍板）：active 分支彻底异步化 ===
		//
		// 旧设计：active 续费走同步路径 — 直接 UpdateExpiredTimeIfActive + AlignAiGatewaySubscription，
		// 不入队 task；任意一环失败由 trade callback 重投 ctl.RenewPass 兜底。
		//
		// 升级理由：
		//  1. 续费失败回滚要求强一致 + 跨 instance / pass / ai-gateway 多步原子语义，同步路径
		//     无法承载（同步路径失败回滚需要在 RenewPass 函数内部硬写回滚，混乱且并发不安全）；
		//  2. active 续费同样可能伴随 ai-gateway 失败，统一走异步父 task + 失败回滚 task 模型，
		//     语义对齐 isolated 分支，避免两套失败处理路径。
		//
		// 新行为：
		//  - CAS active → renewing（与 isolated 分支 isolated→renewing 对偶）
		//  - 不动 expired_time / isolated_time，让父 task 收尾时一次性写
		//  - 入队 RenewPassTask 父 task；payload.OriginalIsolatedTime = nil（标识"原态是 active"，
		//    回滚目标也是 active）
		//  - 父 task 失败 → finalizeFailure 派发 RollbackRenewPassTask 回滚到 active + 旧 expired_time
		acquired, err := passDao.UpdateStatus(passID, passmodel.StatusActive, passmodel.StatusRenewing)
		if err != nil {
			return "", false, errcode.Wrap(errcode.ErrPassNotFound, "UpdateStatus active→renewing: %v", err)
		}
		if !acquired {
			// 极端并发：刚好在 GetByPassID 之后被其他流程抢走；再读一次决定返回哪个错误
			latest, getErr := passDao.GetByPassID(passID)
			if getErr != nil {
				return "", false, errcode.Wrap(errcode.ErrPassNotFound, "re-read pass: %v", getErr)
			}
			switch latest.Status {
			case passmodel.StatusRenewing:
				return "", false, errcode.ErrPassRenewing
			case passmodel.StatusIsolating:
				return "", false, errcode.ErrPassIsolating
			default:
				return "", false, classifyRenewStatusError(latest.Status)
			}
		}
		logger.Info("RenewPass: pass status flipped to renewing (active→renewing async path; R-MR-5)",
			zap.Time("expired_time_baseline", entity.ExpiredTime),
		)

		// 入队父 task RenewPassTask；ctx 用 system context（与 isolated 分支同范式）。
		// OriginalIsolatedTime = nil 表示原态是 active，回滚目标 = active（不需要 IsolateInstance）。
		ctx := pctx.NewContext(nil)
		taskID, err := instanceasync.EnqueueRenewPassTask(
			ctx,
			passID,
			entity.UserID,
			"", // operationID：trade 侧维护 trade_flow，本期不复用 ctl operation_history
			tradeFlowID,
			timeSpan,
			timeUnit,
			entity.ExpiredTime, // R-MR-5 回滚基线
			nil,                // active 续费：originalIsolatedTime = nil
			renewPassParentExecuteIntervalSeconds,
			renewPassParentMaxExecuteCount,
		)
		if err != nil {
			logger.Error("RenewPass (active branch): enqueue parent task failed, pass remains in renewing",
				zap.Error(err),
			)
			return "", false, errcode.Wrap(errcode.ErrPassNotFound, "enqueue parent task: %v", err)
		}
		logger.Info("RenewPass: parent task enqueued (active path)", zap.String("task_id", taskID))
		return taskID, true, nil

	case passmodel.StatusIsolated:
		// 分支 B：到期续费异步路径（R-D-1 落地）
		// 1. CAS isolated → renewing（与 IsolatePass 的 active→isolating 拿锁语义对偶）
		acquired, err := passDao.UpdateStatus(passID, passmodel.StatusIsolated, passmodel.StatusRenewing)
		if err != nil {
			return "", false, errcode.Wrap(errcode.ErrPassNotFound, "UpdateStatus isolated→renewing: %v", err)
		}
		if !acquired {
			// 极端并发：刚好在 GetByPassID 之后被其他流程抢走；再读一次决定返回哪个错误
			latest, getErr := passDao.GetByPassID(passID)
			if getErr != nil {
				return "", false, errcode.Wrap(errcode.ErrPassNotFound, "re-read pass: %v", getErr)
			}
			switch latest.Status {
			case passmodel.StatusRenewing:
				return "", false, errcode.ErrPassRenewing
			case passmodel.StatusIsolating:
				return "", false, errcode.ErrPassIsolating
			default:
				return "", false, classifyRenewStatusError(latest.Status)
			}
		}
		logger.Info("RenewPass: pass status flipped to renewing (async path)")

		// R-MR-5 基线快照：深拷贝 entity.IsolatedTime 指针，避免 entity 后续被回收时
		// task payload 内的指针指向被 GC 的内存。entity.IsolatedTime 已是 *time.Time
		// （DDL 列允许 NULL，gorm 映射成指针）；isolated 状态下保证非 nil。
		var isolatedTimeCopy *time.Time
		if entity.IsolatedTime != nil {
			t := *entity.IsolatedTime
			isolatedTimeCopy = &t
		} else {
			// 防御：DB 漂移时（理论 isolated 状态下不可能为 NULL）记录后兜底返错
			return "", false, errcode.Wrap(errcode.ErrPassNotFound,
				"pass.isolated_time is NULL while status=isolated (data corruption?)")
		}

		// 2. 入队父 task RenewPassTask；ctx 用 system context（与 IsolatePass 同范式）
		ctx := pctx.NewContext(nil)
		taskID, err := instanceasync.EnqueueRenewPassTask(
			ctx,
			passID,
			entity.UserID,
			"", // operationID：trade 侧自己维护 trade_flow，本期不复用 ctl operation_history
			tradeFlowID,
			timeSpan,
			timeUnit,
			entity.ExpiredTime, // R-MR-5 回滚基线（与 active 分支同 — entity.ExpiredTime 在 isolated
			//                     状态期间不被改动，所以入口快照即原值）
			isolatedTimeCopy, // isolated 续费：originalIsolatedTime 非 nil → 回滚目标 = isolated
			renewPassParentExecuteIntervalSeconds,
			renewPassParentMaxExecuteCount,
		)
		if err != nil {
			// 派发失败不回滚 renewing（CreateInstance 已被拦截，等 reconcile worker 接管或人工干预）
			logger.Error("RenewPass: enqueue parent task failed, pass remains in renewing",
				zap.Error(err),
			)
			return "", false, errcode.Wrap(errcode.ErrPassNotFound, "enqueue parent task: %v", err)
		}
		logger.Info("RenewPass: parent task enqueued", zap.String("task_id", taskID))
		return taskID, true, nil

	default:
		return "", false, classifyRenewStatusError(entity.Status)
	}
}

// classifyRenewStatusError 把 pass.status 映射到对应 errcode（用于 CAS 失败 / 非法分支）。
//
// 与设计稿 §3.1 异常分支表完全对齐：
//
//	renewing  → ErrPassRenewing      （拒收触发退款）
//	isolating → ErrPassIsolating    （隔离进行中）
//	active / isolated → 不应到此（switch 分支已处理）
//	其他 / 未知 → ErrPassNotRenewable（如未来引入 deleting / deleted 状态）
func classifyRenewStatusError(status string) error {
	switch status {
	case passmodel.StatusRenewing:
		return errcode.ErrPassRenewing
	case passmodel.StatusIsolating:
		return errcode.ErrPassIsolating
	case passmodel.StatusActive, passmodel.StatusIsolated:
		// 理论不会进到这里（active/isolated 已在主 switch 处理），兜底
		return errcode.Wrap(errcode.ErrPassInvalidParam, "unexpected status flow: %s", status)
	default:
		return errcode.Wrap(errcode.ErrPassNotRenewable, "pass status not renewable: %s", status)
	}
}

// renewLogger 返回非空 logger（resource.ZapLogger 在 server 启动早期可能尚未初始化）
func renewLogger() *zap.Logger {
	if resource.ZapLogger != nil {
		return resource.ZapLogger
	}
	return zap.NewNop()
}

// AlignAiGatewaySubscriptionPeriodEnd 把 ctl 算好的新 pass.expired_time 强制对齐
// 到 ai-gateway subscription.period_end，保证两侧天级一致。
//
// 设计：.tmp/aigateway-monthly-token-refresh-design.md §5.2 / §8 stage 4 R-MR-4
// + 2026-05-24 用户拍板"对齐"原则。
//
// 适用场景（任何让 ctl pass.expired_time 改变的事件）：
//   - 续费 active 同步分支（renew.go RenewPass case StatusActive）：向后延期
//   - 续费 isolated 异步分支（worker/renew_task.go execute 收尾）：向后延期
//   - 退费隔离父 task 终态（worker/isolate_task.go refund branch）：可能向前缩短
//
// 强一致语义（与各 caller 共享）：
//   - 调用失败 → 返回 err 让 caller 触发重试（同步分支：trade callback 重投；
//     异步分支：父 task fail 重试 30s × INT64_MAX）。
//   - PeriodEnd 没推进 = ai-gateway scheduler 5min 内会标 expired = AI 服务断档，
//     必须强一致而非 best-effort。
//
// 幂等：ai-gateway 端 ExtendSubscription 现采用"等值即 no-op、不等强制覆盖"语义
// （2026-05-24 升级，废弃旧 only-forward CAS）；重复调用同一 newPeriodEnd 返回
// 200 OK + updated=false 不报错；退费向前缩短同样安全（向前缩短一次后再调
// updated=false）。
//
// 例外：ErrLLMGatewayPlanNotFound 表示该用户在 ai-gateway 端从未通过
// ApplySubscription 建立订阅（如付费产品迁移到免费试用期外的边缘场景），记 Warn
// + 当作成功放过（不阻断 pass 主链路 — 用户本来就没 AI 订阅，不存在"对齐"目标）；
// caller 收到 nil 视同成功。其它错误（含 ErrLLMGatewayRouteNotFound 路由 404）
// 一律透传给 caller，由 caller 决定重试 / failTask / Warn 不阻断。
func AlignAiGatewaySubscriptionPeriodEnd(logger *zap.Logger, userID, passID string, newPeriodEnd time.Time) error {
	if logger == nil {
		logger = renewLogger()
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return fmt.Errorf("align ai-gateway subscription: user_id is empty")
	}

	ctx, cancel := context.WithTimeout(context.Background(), extendAiGatewayCallTimeout)
	defer cancel()

	if gateway, ok, err := gatewayroute.Get(userID); err != nil {
		logger.Warn("get recorded subscription gateway failed, fallback to probe",
			zap.String("user_id", userID),
			zap.String("pass_id", passID),
			zap.Error(err))
	} else if ok {
		switch gateway {
		case gatewayroute.GatewayAIGateway:
			legacyAdapter := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter()
			if legacyAdapter == nil {
				return fmt.Errorf("recorded ai-gateway subscription but ai-gateway adapter is nil")
			}
			resp, err := legacyAdapter.ExtendSubscription(ctx, &aigateway.ExtendSubscriptionRequest{
				UserID:       userID,
				NewPeriodEnd: newPeriodEnd,
			})
			if err != nil {
				if errors.Is(err, aigateway.ErrAiGatewayPlanNotFound) {
					logger.Warn("recorded ai-gateway subscription not found, skipping align",
						zap.String("user_id", userID),
						zap.String("pass_id", passID))
					return nil
				}
				return err
			}
			if resp != nil && resp.Subscription != nil {
				gatewayroute.RecordBestEffort(logger, userID, gatewayroute.GatewayAIGateway, resp.Subscription.ID, resp.Subscription.PlanID, gatewayroute.SourceDetectActiveSubscription)
			}
			logger.Info("ai-gateway subscription period_end aligned",
				zap.String("user_id", userID),
				zap.String("pass_id", passID),
				zap.Time("new_period_end", newPeriodEnd),
				zap.Bool("updated", resp != nil && resp.Updated))
			return nil
		case gatewayroute.GatewayLLMGateway:
			if !config.LLMGatewayEnabled() {
				logger.Warn("recorded llmgateway subscription ignored because llmgateway is disabled",
					zap.String("user_id", userID),
					zap.String("pass_id", passID))
				break
			}
			resp, err := adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter().
				ExtendSubscription(ctx, &llmgateway.ExtendSubscriptionRequest{
					UserID:       userID,
					NewPeriodEnd: newPeriodEnd,
				})
			if err != nil {
				if errors.Is(err, llmgateway.ErrLLMGatewayPlanNotFound) {
					logger.Warn("recorded llmgateway subscription not found, skipping align",
						zap.String("user_id", userID),
						zap.String("pass_id", passID))
					return nil
				}
				return err
			}
			if resp != nil && resp.Subscription != nil {
				gatewayroute.RecordBestEffort(logger, userID, gatewayroute.GatewayLLMGateway, resp.Subscription.ID, resp.Subscription.PlanID, gatewayroute.SourceDetectActiveSubscription)
			}
			logger.Info("llmgateway subscription period_end aligned",
				zap.String("user_id", userID),
				zap.String("pass_id", passID),
				zap.Time("new_period_end", newPeriodEnd),
				zap.Bool("updated", resp != nil && resp.Updated))
			return nil
		default:
			logger.Warn("unknown recorded subscription gateway, fallback to probe",
				zap.String("user_id", userID),
				zap.String("pass_id", passID),
				zap.String("gateway", gateway))
		}
	}

	if legacyAdapter := adapterfactory.DefaultAdapterFactory.AiGatewayAdapter(); legacyAdapter != nil {
		legacyResp, legacyErr := legacyAdapter.
			ExtendSubscription(ctx, &aigateway.ExtendSubscriptionRequest{
				UserID:       userID,
				NewPeriodEnd: newPeriodEnd,
			})
		if legacyErr == nil {
			if legacyResp != nil && legacyResp.Subscription != nil {
				gatewayroute.RecordBestEffort(logger, userID, gatewayroute.GatewayAIGateway, legacyResp.Subscription.ID, legacyResp.Subscription.PlanID, gatewayroute.SourceDetectActiveSubscription)
			}
			logger.Info("ai-gateway subscription period_end aligned",
				zap.String("user_id", userID),
				zap.String("pass_id", passID),
				zap.Time("new_period_end", newPeriodEnd),
				zap.Bool("updated", legacyResp != nil && legacyResp.Updated)) // false = 等值幂等 no-op
			return nil
		}
		if !errors.Is(legacyErr, aigateway.ErrAiGatewayPlanNotFound) && !isLegacyGatewayDisabled(legacyErr) {
			return legacyErr
		}
	}

	if !config.LLMGatewayEnabled() {
		logger.Info("skip llmgateway subscription period_end align because llmgateway is disabled",
			zap.String("user_id", userID),
			zap.String("pass_id", passID))
		return nil
	}

	resp, err := adapterfactory.DefaultAdapterFactory.LLMGatewayAdapter().
		ExtendSubscription(ctx, &llmgateway.ExtendSubscriptionRequest{
			UserID:       userID,
			NewPeriodEnd: newPeriodEnd,
		})
	if err != nil {
		if errors.Is(err, llmgateway.ErrLLMGatewayPlanNotFound) {
			logger.Warn("no active subscription for user in ai-gateway or llmgateway, skipping align",
				zap.String("user_id", userID),
				zap.String("pass_id", passID))
			return nil
		}
		return err
	}
	if resp != nil && resp.Subscription != nil {
		gatewayroute.RecordBestEffort(logger, userID, gatewayroute.GatewayLLMGateway, resp.Subscription.ID, resp.Subscription.PlanID, gatewayroute.SourceDetectActiveSubscription)
	}
	logger.Info("llmgateway subscription period_end aligned",
		zap.String("user_id", userID),
		zap.String("pass_id", passID),
		zap.Time("new_period_end", newPeriodEnd),
		zap.Bool("updated", resp != nil && resp.Updated)) // false = 等值幂等 no-op
	return nil
}
