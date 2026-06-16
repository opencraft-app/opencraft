package pass

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	adapterfactory "ctl/pkg/adapter/factory"
	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/errcode"
	"ctl/pkg/metric"
	modelfactory "ctl/pkg/model/factory"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/resource"

	"go.uber.org/zap"
)

// === trade-pass-destroy 入口 A 用户主动销毁链路（设计稿 §3.5 / §4.5.1 / §11-A Q1 / Q2 / Q26 / Q27） ===
//
// DeletePass 是前端控制台用户主动触发销毁的入口（与 IsolatePass 同范式但**不派 task**）：
//   1. 校验入参 + pass 存在 + 归属 userID
//   2. CAS pass.status: isolated → deleting（同步落 DB）
//   3. 同步调 trade.DeleteResource(passID, uin, appID, bundleID)
//      → trade 内部反查 BundleDefinition 取 ProductCode + SubProductCode（Q26 + Q27），
//        调 jifei.ModifyResourceStatus(operateName=PRE_DESTROY) 通知销毁意图
//   4. 成功 → 返 PassDetail（含 status='deleting'）
//   5. 失败 → pass 留在 deleting 不回滚（设计稿 §4.2 拍板：监控兜底 + 人工干预）
//
// 与 IsolatePass 的关键差异：
//   - IsolatePass：CAS active→isolating + enqueue 父 task 异步处理 instance pause
//   - DeletePass：  CAS isolated→deleting + 同步调 trade，**不入队任何 task**
//     （销毁主链由 jifei 异步回调 trade.destroyResource → ctl.DestroyPass 启动）

// trade.DeleteResource 调用超时（与 RenewPassOrderUrl 走 trade 的 15s 同口径）。
const deleteResourceTimeoutSeconds = 15

// DeletePass 详见 Logic 接口注释（设计稿 §3.5 / §4.5.1 / §11-A Q1 / Q2 / Q26 / Q27）。
func (l *logic) DeletePass(userID, passID string) (*PassDetail, error) {
	userID = strings.TrimSpace(userID)
	passID = strings.TrimSpace(passID)
	if userID == "" || passID == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "userID and passID are required")
	}

	logger := deleteLogger().With(
		zap.String("user_id", userID),
		zap.String("pass_id", passID),
	)

	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)

	// 步骤 1：反查 pass + 校验归属
	entity, err := passDao.GetByPassID(passID)
	if err != nil {
		if errors.Is(err, errcode.ErrPassNotFound) {
			return nil, errcode.ErrPassNotFound
		}
		return nil, errcode.Wrap(errcode.ErrPassNotFound, "get pass: %v", err)
	}
	if entity.UserID != userID {
		// 防越权：当前用户不是 pass 持有者，统一返 NotFound 不暴露存在性
		logger.Warn("DeletePass: userID mismatch",
			zap.String("entity_user_id", entity.UserID))
		return nil, errcode.ErrPassNotFound
	}

	// 步骤 2：状态预判（提前给出明确错误码，CAS 短路）
	switch entity.Status {
	case passmodel.StatusDeleting:
		// 重复点击销毁按钮 — 幂等防重
		logger.Info("DeletePass: pass already in deleting, idempotent reject")
		return nil, errcode.ErrPassDeleting
	case passmodel.StatusTerminating:
		// 销毁主链已启动，前端应继续灰化
		logger.Info("DeletePass: pass already in terminating, idempotent reject")
		return nil, errcode.ErrPassTerminating
	case passmodel.StatusIsolated:
		// 正确入口态，进入 CAS
	default:
		// active / isolating / renewing 等：用户应先完成隔离再销毁
		logger.Info("DeletePass: pass status not isolated, reject",
			zap.String("status", entity.Status))
		return nil, errcode.ErrPassNotIsolated
	}

	// 步骤 3：CAS isolated → deleting
	acquired, err := passDao.TryAcquireSlotForDelete(passID)
	if err != nil {
		return nil, errcode.Wrap(errcode.ErrPassNotFound, "TryAcquireSlotForDelete: %v", err)
	}
	if !acquired {
		// 极端并发：刚才 GetByPassID 拿到 isolated，CAS 时被其他流程抢走；再读一次给精确错误码
		latest, getErr := passDao.GetByPassID(passID)
		if getErr != nil {
			return nil, errcode.Wrap(errcode.ErrPassNotFound, "re-read pass: %v", getErr)
		}
		switch latest.Status {
		case passmodel.StatusDeleting:
			return nil, errcode.ErrPassDeleting
		case passmodel.StatusTerminating:
			return nil, errcode.ErrPassTerminating
		default:
			return nil, errcode.ErrPassNotIsolated
		}
	}
	logger.Info("DeletePass: pass status flipped isolated→deleting")

	// 步骤 4：同步调 trade.DeleteResource
	//
	// Q27 修订（2026-05-17）：DTO 仅 3 字段（UIN/AppID/BundleID），
	// SubProductCode + ProductCode 由 trade 反查 BundleDefinition 取得。
	tradeReq := &tradeadapter.DeleteResourceRequest{
		UIN:      strconv.FormatInt(entity.Uin, 10),
		AppID:    entity.AppID,
		BundleID: entity.BundleID,
	}
	ctx, cancel := context.WithTimeout(context.Background(), deleteResourceTimeoutSeconds*time.Second)
	defer cancel()
	tradeResp, err := adapterfactory.DefaultAdapterFactory.TradeAdapter().DeleteResource(ctx, passID, tradeReq)
	if err != nil {
		// 设计稿 §4.2 / §4.5.1：trade 调用失败 → pass 留在 deleting **不回滚**
		// 监控兜底告警（lightvela_destroy_pass_total{status="failed"} + lightvela_destroy_trade_call_failed_total），
		// 由人工或后续 reconcile worker 处理。
		logger.Warn("DeletePass: trade.DeleteResource failed; pass kept in deleting",
			zap.Error(err))
		metric.DestroyTradeCallFailedTotal.Inc()
		metric.DestroyPassTotal.WithLabelValues("user_active", "deleting_pending").Inc()
		return nil, errcode.Wrap(errcode.ErrPassNotFound, "trade.DeleteResource: %v", err)
	}

	logger.Info("DeletePass: trade.DeleteResource accepted",
		zap.String("reference_id", tradeResp.ReferenceID))

	// 步骤 5：返 PassDetail（含最新 status='deleting'）
	// 重新读一次 entity 拿最新 status / UpdatedTime（CAS 修改后的真实快照）。
	latest, err := passDao.GetByPassID(passID)
	if err != nil {
		// 极端：CAS 已成功但读不到，降级返"基础字段 + 状态置 deleting"
		logger.Warn("DeletePass: re-read entity after CAS failed; degraded response",
			zap.Error(err))
		entity.Status = passmodel.StatusDeleting
		return entityToDetail(entity), nil
	}
	return entityToDetail(latest), nil
}

func deleteLogger() *zap.Logger {
	if resource.ZapLogger != nil {
		return resource.ZapLogger
	}
	return zap.NewNop()
}
