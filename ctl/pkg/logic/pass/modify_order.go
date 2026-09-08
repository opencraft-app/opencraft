package pass

import (
	"context"
	"fmt"
	"strings"
	"time"

	"go.uber.org/zap"

	adapterfactory "ctl/pkg/adapter/factory"
	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/errcode"
	bundlemodel "ctl/pkg/model/bundle"
	modelfactory "ctl/pkg/model/factory"
	"ctl/pkg/model/instancespec"
	passmodel "ctl/pkg/model/pass"
	"ctl/pkg/resource"
	"ctl/pkg/transport"
)

// 同 SP 升配的用户侧入口。需求：TAPD 1010132091137784162 §5.1
//
// 这一层只做"选目标 + 询价 + 下单"，不碰 pass 状态：真正的状态推进由
// jifei → trade.modifyResource → ctl.AcceptPassModify 链路触发（与新购 / 续费同范式）。
// 查询和下单都在服务端重新解析源套餐与合法目标，绝不信任前端带来的上下文。

// modifyInquiryTimeout 与新购 / 续费询价同口径。变配要逐个目标询价，超时给足以免
// jifei 慢响应把前端确认页拖成白屏。
const modifyInquiryTimeout = 15 * time.Second

// modifyOrderTimeout 下单侧超时，与续费下单一致。
const modifyOrderTimeout = 15 * time.Second

// ListPassModifyBundles 详见 Logic 接口注释。
func (l *logic) ListPassModifyBundles(userID, passID string) (*transport.ModifyBundleSetResult, error) {
	passEntity, logger, err := l.loadPassForModify(userID, passID, "list_pass_modify_bundles")
	if err != nil {
		return nil, err
	}

	result := &transport.ModifyBundleSetResult{
		SourceBundleID: passEntity.BundleID,
		// 非 nil 空切片：前端直接按长度判断有无升配路径，不必先做 null 检查。
		ModifyBundleSet: []transport.ModifyBundleOption{},
	}

	// 非 active 的 pass 不能发起变配（§6 前置校验）。响应结构里没有"为什么不能升配"
	// 的位置，所以只能如实返回空集合；把它当错误抛会让"套餐续费中"这种正常中间态
	// 在前端表现成报错。
	if passEntity.Status != passmodel.StatusActive {
		logger.Info("pass is not active, no modify target offered",
			zap.String("pass_status", passEntity.Status))
		return result, nil
	}

	targets := AllowedModifyTargets(passEntity.BundleID)
	if len(targets) == 0 {
		return result, nil
	}

	for _, targetBundleID := range targets {
		option, offered, err := l.quoteModifyTarget(passEntity, targetBundleID, logger)
		if err != nil {
			// 询价失败整条请求失败，不静默跳过：没有价格的升配项在确认页无法展示，
			// 而"跳过"会让用户看到"没有可升配套餐"——把一次故障说成了产品事实。
			return nil, err
		}
		if !offered {
			continue
		}
		result.ModifyBundleSet = append(result.ModifyBundleSet, *option)
	}

	logger.Info("list pass modify bundles succeeded", zap.Int("target_count", len(result.ModifyBundleSet)))
	return result, nil
}

// quoteModifyTarget 组装单个可升配目标：目标套餐规格 + 实时差价。
//
// offered=false 表示这个目标当前不该出现在列表里（套餐已下架），不是错误。
func (l *logic) quoteModifyTarget(
	passEntity *passmodel.Entity,
	targetBundleID string,
	logger *zap.Logger,
) (option *transport.ModifyBundleOption, offered bool, err error) {
	target, err := l.bundleLogic.GetBundleByID(targetBundleID)
	if err != nil {
		// 策略表里写着的目标套餐在 DB 里不存在，是配置错而不是用户错。
		return nil, false, fmt.Errorf("get modify target bundle %s: %w", targetBundleID, err)
	}
	// 下架套餐不能作为升配目标（trade 询价侧同样会拒）。这里提前过掉，让"运营下架了
	// 巡游"表现为列表里没有这一项，而不是整个查询报错——后者会连带把其它可升配目标也吞掉。
	if !strings.EqualFold(target.BundleState, bundlemodel.StateOnline) {
		logger.Info("modify target bundle is not online, skip",
			zap.String("target_bundle_id", targetBundleID),
			zap.String("bundle_state", target.BundleState))
		return nil, false, nil
	}
	spec, ok := instancespec.ResolveByID(target.InstanceSpecID)
	if !ok {
		return nil, false, fmt.Errorf("resolve instance spec %q of bundle %s", target.InstanceSpecID, targetBundleID)
	}

	inqCtx, cancel := context.WithTimeout(context.Background(), modifyInquiryTimeout)
	inqResp, inqErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().InquiryModify(
		inqCtx, l.buildModifyOrderRequest(passEntity, targetBundleID))
	cancel()
	if inqErr != nil {
		logger.Warn("trade.InquiryModify failed",
			zap.String("target_bundle_id", targetBundleID), zap.Error(inqErr))
		if mappedErr := tradeShadowBindingNotFoundError(inqErr); mappedErr != nil {
			return nil, false, mappedErr
		}
		return nil, false, fmt.Errorf("trade inquiry modify: %w", inqErr)
	}
	if inqResp == nil || len(inqResp.Prices) == 0 || inqResp.Prices[0] == nil {
		return nil, false, fmt.Errorf("trade inquiry modify: empty prices for %s", targetBundleID)
	}
	q := inqResp.Prices[0]

	return &transport.ModifyBundleOption{
		TargetBundleID: targetBundleID,
		Bundle: transport.ModifyBundleDetail{
			BundleID:       target.BundleID,
			BundleName:     target.BundleName,
			CPU:            spec.CPU,
			Memory:         spec.Memory,
			SystemDiskSize: spec.SystemDiskSize,
			Credit:         target.Credit,
		},
		ModifyPrice: transport.BundlePrice{
			Price:         parseQuotePrice(q.Price),
			TotalCost:     parseQuotePrice(q.TotalCost),
			TaxPrice:      parseQuotePrice(q.TaxPrice),
			RealTotalCost: parseQuotePrice(q.RealTotalCost),
			Currency:      q.Currency,
			Discount:      q.Discount,
		},
	}, true, nil
}

// ModifyPassOrder 详见 Logic 接口注释。
func (l *logic) ModifyPassOrder(
	userID, passID string,
	req *transport.ModifyPassOrderRequest,
) (*transport.ModifyPassOrderResult, error) {
	return l.placeModifyOrder(userID, passID, req, "modify_pass_order",
		adapterfactory.DefaultAdapterFactory.TradeAdapter().PlaceModifyOrder)
}

// ModifyPassOrderAndPay 详见 Logic 接口注释。
func (l *logic) ModifyPassOrderAndPay(
	userID, passID string,
	req *transport.ModifyPassOrderRequest,
) (*transport.ModifyPassOrderResult, error) {
	return l.placeModifyOrder(userID, passID, req, "modify_pass_order_and_pay",
		adapterfactory.DefaultAdapterFactory.TradeAdapter().PlaceModifyOrderAndPay)
}

// ModifyPassOrderUrl 详见 Logic 接口注释。
func (l *logic) ModifyPassOrderUrl(
	userID, passID string,
	req *transport.ModifyPassOrderRequest,
) (*transport.ModifyPassOrderUrlResult, error) {
	order, err := l.placeModifyOrder(userID, passID, req, "modify_pass_order_url",
		adapterfactory.DefaultAdapterFactory.TradeAdapter().PlaceModifyOrder)
	if err != nil {
		return nil, err
	}

	urlCtx, cancel := context.WithTimeout(context.Background(), payURLRequestTimeout)
	urlResp, urlErr := adapterfactory.DefaultAdapterFactory.TradeAdapter().
		GeneratePayURL(urlCtx, order.DealName, nil)
	cancel()
	if urlErr != nil {
		// 单已经建出来了，只是支付页没拉到。返错但把 deal_name 写进日志：用户重试
		// 会建第二张单，这里是排查"为什么有一张没付的变配单"的唯一线索。
		modifyOrderLogger(userID, passID, "modify_pass_order_url").Warn(
			"trade.GeneratePayURL failed after modify order placed",
			zap.String("deal_name", order.DealName), zap.Error(urlErr))
		return nil, fmt.Errorf("trade generate pay url: %w", urlErr)
	}
	if urlResp == nil {
		return nil, fmt.Errorf("trade generate pay url returned nil response")
	}

	return &transport.ModifyPassOrderUrlResult{
		DealName: order.DealName,
		PayURL:   urlResp.PayURL,
	}, nil
}

// placeModifyOrder 是三个下单变体的共同主体：校验 → 解析源/目标 → 调 trade。
//
// **不写本地 pass** — 状态推进由 jifei 回调链路负责，这里提前改 pass 会让未支付的
// 订单也把用户的套餐锁在 modifying。
func (l *logic) placeModifyOrder(
	userID, passID string,
	req *transport.ModifyPassOrderRequest,
	flow string,
	place func(context.Context, *tradeadapter.ModifyOrderRequest) (*tradeadapter.PlaceOrderResult, error),
) (*transport.ModifyPassOrderResult, error) {
	if req == nil || strings.TrimSpace(req.TargetBundleID) == "" {
		return nil, errcode.Wrap(errcode.ErrPassInvalidParam, "target_bundle_id is required")
	}
	targetBundleID := strings.TrimSpace(req.TargetBundleID)

	passEntity, logger, err := l.loadPassForModify(userID, passID, flow)
	if err != nil {
		return nil, err
	}
	logger = logger.With(zap.String("target_bundle_id", targetBundleID))

	// 服务端重新校验，不信任查询时的旧结果（§5.1）：从查询到下单之间用户可能已经
	// 续费、隔离，或运营调整了升配关系。
	if passEntity.Status != passmodel.StatusActive {
		return nil, classifyModifyStatusError(passEntity.Status)
	}
	if !ModifyAllowed(passEntity.BundleID, targetBundleID) {
		return nil, errcode.Wrap(errcode.ErrPassModifyTargetNotAllowed,
			"modify %s -> %s is not allowed", passEntity.BundleID, targetBundleID)
	}
	if _, err := l.bundleLogic.GetBundleByID(targetBundleID); err != nil {
		return nil, err
	}

	placeCtx, cancel := context.WithTimeout(context.Background(), modifyOrderTimeout)
	resp, placeErr := place(placeCtx, l.buildModifyOrderRequest(passEntity, targetBundleID))
	cancel()
	if placeErr != nil {
		logger.Warn("trade place modify order failed", zap.Error(placeErr))
		if mappedErr := tradeShadowBindingNotFoundError(placeErr); mappedErr != nil {
			return nil, mappedErr
		}
		return nil, fmt.Errorf("trade place modify order: %w", placeErr)
	}
	if resp == nil || resp.DealName == "" {
		return nil, fmt.Errorf("trade place modify order returned empty dealName")
	}

	logger.Info("place modify order succeeded",
		zap.String("deal_name", resp.DealName),
		zap.String("big_order_id", resp.BigOrderID),
	)
	return &transport.ModifyPassOrderResult{
		DealName:   resp.DealName,
		BigOrderID: resp.BigOrderID,
	}, nil
}

// buildModifyOrderRequest 收敛询价和下单的入参构造。
//
// 询价与下单必须送出**同一组**入参，否则用户在确认页看到的差价可以和实际扣款不一致；
// 共用一个构造点是这条不变量唯一的保证。CurDeadline 取 pass.expired_time，
// uin / appId 留空由 trade 侧 shadow 反查（与续费同范式）。
func (l *logic) buildModifyOrderRequest(
	passEntity *passmodel.Entity,
	targetBundleID string,
) *tradeadapter.ModifyOrderRequest {
	return &tradeadapter.ModifyOrderRequest{
		ExternalUserID: passEntity.UserID,
		ResourceID:     passEntity.PassID,
		SourceBundleID: passEntity.BundleID,
		TargetBundleID: targetBundleID,
		CurDeadline:    formatCurDeadlineForJifei(passEntity.ExpiredTime),
		PayMode:        lighthousePassPayMode,
	}
}

// loadPassForModify 是四个入口共用的前置：入参校验 + 反查 pass + 持有人校验。
func (l *logic) loadPassForModify(userID, passID, flow string) (*passmodel.Entity, *zap.Logger, error) {
	if strings.TrimSpace(userID) == "" {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required")
	}
	passID = strings.TrimSpace(passID)
	if passID == "" {
		return nil, nil, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required")
	}

	passEntity, err := modelfactory.DefaultDaoFactory.PassDao(nil).GetByPassID(passID)
	if err != nil {
		return nil, nil, errcode.Wrap(errcode.ErrPassNotFound, "get pass: %v", err)
	}
	// 归属不匹配按 NotFound 返回而不是 Forbidden：不向调用方泄漏"这个 pass 存在"。
	if passEntity.UserID != userID {
		return nil, nil, errcode.Wrap(errcode.ErrPassNotFound, "pass not owned by user")
	}
	return passEntity, modifyOrderLogger(userID, passID, flow), nil
}

func modifyOrderLogger(userID, passID, flow string) *zap.Logger {
	return resource.ZapLogger.With(
		zap.String("flow", flow),
		zap.String("user_id", userID),
		zap.String("pass_id", passID),
	)
}
