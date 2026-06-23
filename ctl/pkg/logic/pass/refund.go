// trade-pass-refund 设计稿 ctl logic 落地（v0.5 §3 + §11 拍板项）。
//
// RefundPass 是后台 admin / 客服为指定 pass 发起退款的入口。
// 链路：admin → ctl.RefundPass → trade.RefundResource → jifei.OnlineRefund → 同步返 dealName/bigDealId。
//
// 设计稿核心拍板（v0.5）：
//   - Q1=a：仅 admin 后台暴露（用户面不开）
//   - Q2=a：起始态仅 active && expired_time>NOW()
//   - Q3=a：单条退款（resourceIdList 长度恒 1，由 trade 端兜底）
//   - Q3=b：**不引入 refunding 中间态**，完全复用现有 isolate 状态机；本接口**不动 pass.status**
//   - Q4=a：不建 ctl.pass_refund 审计表，仅依赖 trade_flow 兜底 + zap 日志留痕
//   - Q5=a：trade 拼装 OnlineRefund 时不传 category_ids
//   - Q7=a：jifei 同步返 0 但 ctl 持久化失败不做自动恢复，靠后台运维 + 后续 isolateResource 回调兜底
//   - Q8=a：ctl 不预校验退款金额（jifei 内部自算）
//   - Q8b=b：trade 端无状态翻译层，并发抑制由 jifei 协议层 + isolateResource(refund) 抢占式幂等兜底
//   - Q9=a：不补 reconcile job
//
// 与 DeletePass 的关键差异：
//   - DeletePass：CAS isolated→deleting 改 pass.status；本期默认所有失败 pass 留 deleting 不回滚
//   - RefundPass：**完全不动 pass.status**；jifei 异步回 isolateResource(refund) 后由
//     现有 IsolatePass 路径自然推进 active→isolating→isolated + 写 expired_time = newDeadline
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
	modelfactory "ctl/pkg/model/factory"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/resource"

	"go.uber.org/zap"
)

// refundResourceTimeoutSeconds 是 trade.RefundResource 调用超时。
//
// 与 DeleteResource / RenewPassOrderUrl 走 trade 的 15s 同口径——OnlineRefund 是同步接口，
// jifei 内部完成资源退款 + 退款单生成，15s 给完整链路足够 budget；超时即返 5xx 让 admin 重试。
const refundResourceTimeoutSeconds = 15

// RefundResult 是 RefundPass 同步返回结果。
//
// jifei OnlineRefund 同步生成的退款单号（dealName / bigDealId）透传给调用方，
// admin 面板用于审计追账 + 后续 jifei 对账。
type RefundResult struct {
	// PassID 退款对应的 pass_id（透传入参，便于客户端记录）。
	PassID string

	// DealName jifei 退款小订单号（doc §5 data.dealNames[0]）。
	DealName string

	// BigDealID jifei 退款大订单号（doc §5 data.bigDealIds[0]）。
	BigDealID string

	// SubmittedAt 发起退款时刻（ctl 收 trade 成功响应的时间）。
	SubmittedAt time.Time
}

// RefundPass 详见 Logic 接口注释（设计稿 .tmp/trade-pass-refund-design.md v0.5 §3 + §11）。
//
// 主要流程：
//  1. 入参校验（passID 必填）
//  2. SELECT pass + 前置校验：
//     - status='active'（Q2=a 拍板）
//     - expired_time > NOW()（在保资源才能 jifei 退费）
//     - uin > 0 && app_id > 0（Q1=a 仅 admin 后台、试用 pass 不允许走 OnlineRefund）
//  3. 同步调 tradeAdapter.RefundResource(passID, uin, app_id, bundle_id, reason)
//  4. 收到 trade 返回 (dealName, bigDealId) 后构造 RefundResult 返回
//
// 关键不变量（Q3=b 拍板）：本接口**不写** pass.status / expired_time / isolated_time；
// 最终落地由 jifei 异步回 isolateResource(billingIsolateType=refund) 触发现有
// v1.7.30 BUG-35 退费分支 → trade IsolatePass logic 完成 active→isolating→isolated。
//
// 错误回滚：本接口 trade 调用失败时 pass.status 已经没动过，**无需任何回滚**——
// 这正是 Q3=b/Q8b=b 拍板的核心简化收益。
//
// 入参：
//   - passID：pass.pass_id（admin 后台传入；不要求 user_id 越权校验，Q1=a 仅 admin 入口）
//   - operatorUin：操作人 uin，仅用于 zap 日志留痕（Q4=a 不建审计表，靠日志兜底）
//   - reason：运营记录用文本，仅日志透传
//
// 返回：
//   - *RefundResult{PassID, DealName, BigDealID, SubmittedAt}（jifei 同步返成功后构造）
//   - 错误码：
//   - ErrPassInvalidParam：passID 缺失
//   - ErrPassNotFound：pass 不存在
//   - ErrPassNotActive：status ≠ active（含 isolated/deleting/refunding 等已变更态）
//   - ErrPassExpired：expired_time <= NOW()（已过期，jifei 不允许退在保资源）
//   - ErrPassTrialNotRefundable：试用 pass（uin/app_id=0）不走 jifei OnlineRefund
//   - 5xx：trade adapter 异常（含 jifei 业务错 / 上游 502 等）
//
// 调用方降级策略（Q7=a 拍板）：
//   - 同步返 5xx 时 admin 面板提示"退款失败请稍后重试"，不做自动 retry
//   - jifei 同步返成功后 ctl 持久化失败的极端场景由 jifei 异步回 isolateResource 兜底
func (l *logic) RefundPass(passID string, operatorUin int64, reason string) (*RefundResult, error) {
	passID = strings.TrimSpace(passID)
	if passID == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "passID is required")
	}

	logger := refundLogger().With(
		zap.String("pass_id", passID),
		zap.Int64("operator_uin", operatorUin),
		zap.String("reason", reason),
	)

	passDao := modelfactory.DefaultDaoFactory.PassDao(nil)

	// 步骤 1：反查 pass
	entity, err := passDao.GetByPassID(passID)
	if err != nil {
		if errors.Is(err, errcode.ErrPassNotFound) {
			return nil, errcode.ErrPassNotFound
		}
		return nil, errcode.Wrap(errcode.ErrPassNotFound, "get pass: %v", err)
	}

	// 步骤 2：前置校验
	//
	// 2a) 试用 pass 防御：uin=0 或 app_id=0 表示 bundle_free_trial_* 系列试用套餐
	//     （Q1=a 拍板，仅 admin 后台暴露；试用 pass 不走 jifei 协议层）。
	if entity.Uin <= 0 || entity.AppID <= 0 {
		logger.Info("RefundPass: free-trial pass cannot be refunded via jifei",
			zap.Int64("uin", entity.Uin),
			zap.Int64("app_id", entity.AppID))
		return nil, errcode.ErrPassTrialNotRefundable
	}

	// 2b) 状态校验：仅 active 起始态（Q2=a 拍板）
	if entity.Status != passmodel.StatusActive {
		logger.Info("RefundPass: pass status not active, reject",
			zap.String("status", entity.Status))
		return nil, errcode.ErrPassNotActive
	}

	// 2c) 过期校验：jifei OnlineRefund 仅允许在保资源退费（doc §1.1）
	if !entity.ExpiredTime.After(time.Now().UTC()) {
		logger.Info("RefundPass: pass already expired, reject",
			zap.Time("expired_time", entity.ExpiredTime))
		return nil, errcode.ErrPassExpired
	}

	// 步骤 3：同步调 trade.RefundResource
	//
	// DTO 3 字段最小集（与 DeleteResource 同款 Q27 拍板）：
	//   - UIN：pass.uin（int64 转 string；jifei 协议 uin 是字符串字面量）
	//   - AppID：pass.app_id
	//   - BundleID：pass.bundle_id（trade 内部反查 BundleDefinition.SubProductCode）
	//
	// **v0.6 路由切换 2026-06-23 撤回 OwnerUin 字段**：trade 端 OnlineRefund 从签名链路
	// (resource-center 入口) 切到非签名链路 (jifei-test 入口)，OwnerUin 不再需要。详见
	// trade/internal/jifeiclient/onlinerefund.go 头部 v0.6 注释。
	uinStr := strconv.FormatInt(entity.Uin, 10)
	tradeReq := &tradeadapter.RefundResourceRequest{
		UIN:      uinStr,
		AppID:    entity.AppID,
		BundleID: entity.BundleID,
	}
	ctx, cancel := context.WithTimeout(context.Background(), refundResourceTimeoutSeconds*time.Second)
	defer cancel()
	tradeResp, err := adapterfactory.DefaultAdapterFactory.TradeAdapter().RefundResource(ctx, passID, tradeReq)
	if err != nil {
		// Q3=b 拍板：pass.status 没动过，**无需回滚**；
		// Q7=a 拍板：透传错误码给 admin 面板，不做自动 retry。
		logger.Warn("RefundPass: trade.RefundResource failed",
			zap.Error(err))
		return nil, errcode.Wrap(errcode.ErrPassNotFound, "trade.RefundResource: %v", err)
	}

	logger.Info("RefundPass: trade.RefundResource accepted",
		zap.String("deal_name", tradeResp.DealName),
		zap.String("big_deal_id", tradeResp.BigDealID))

	// 步骤 4：构造 RefundResult 返回。本接口不读回 pass.status——
	// jifei 异步回 isolateResource(refund) 之前 pass.status 仍是 active 是预期行为
	// （v0.5 §10.2 联调 SOP step 4 关键不变量）。
	return &RefundResult{
		PassID:      passID,
		DealName:    tradeResp.DealName,
		BigDealID:   tradeResp.BigDealID,
		SubmittedAt: time.Now().UTC(),
	}, nil
}

// refundLogger 与 deleteLogger / isolateLogger 同款 helper，便于单测不依赖 resource.ZapLogger 全局。
func refundLogger() *zap.Logger {
	if resource.ZapLogger != nil {
		return resource.ZapLogger
	}
	return zap.NewNop()
}
