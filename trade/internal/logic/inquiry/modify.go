package inquiry

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/shadowclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 同 SP 变配（升配）询价。需求：TAPD 1010132091137784162 §4.1 / §5.1
//
// 与续费询价的三点差异：
//  1. 涉及两个 bundle：源套餐决定 goodsDetail 顶层的 sv_*，目标套餐决定 newConfig
//  2. goodsCategoryId 取 scene="modify"
//  3. 差价由 jifei 按 oldConfig/newConfig + curDeadline 剩余时长算，trade 不参与计算
//
// 同 SP 约束在这里体现为一条硬校验：源和目标的 subProductCode 必须一致。计费侧的变配
// 接入单是按 SP 配的，跨 SP 送进来只会拿到一个语义不明的报价。这个校验放 trade 而不放 CTL，
// 因为 SP 只存在于 trade_bundle_definition —— CTL 的 bundle 表没有这一列。
//
// 站点隔离：源、目标都从**当前部署**的 trade_bundle_definition 读。国内、国际可以共用
// bundle_id，但 SP / PID / CategoryID / SV 各站独立（§3），所以只要不跨站读表就天然正确。

// ErrModifyCrossSubProduct 源与目标 bundle 不属于同一个 SP。
// 本期只做同 SP 变配（§2.2），跨 SP 需要计费侧另开接入单。
var ErrModifyCrossSubProduct = errors.New("inquiry: modify across sub product codes is not supported")

// QuoteModifyRequest 是单次变配询价的入参。
//
// 不带 TimeSpan / TimeUnit：变配不改变到期时间，jifei 按 curDeadline 与当前时刻的
// 剩余时长算差价。GoodsNum 变配固定为 1（§5.3）。
type QuoteModifyRequest struct {
	ExternalUserID string
	Uin            string
	AppID          string
	// ResourceID 是变配目标 pass_id（jifei 协议 resourceId）。
	ResourceID string
	// SourceBundleID 是 pass 当前套餐；决定 goodsDetail 顶层 sv_* 与 oldConfig。
	SourceBundleID string
	// TargetBundleID 是升配目标套餐；决定 newConfig。
	TargetBundleID string
	// CurDeadline 是 pass.expired_time 的 jifei 字面值（"2006-01-02 15:04:05"）。
	// 与续费询价同源同格式：真源在 CTL，trade 只做非空校验和透传。
	CurDeadline string
	PayMode     int
}

// QuoteModify 执行单次变配询价。
//
// 流程：
//  1. 校验入参（含 resource_id / source / target / cur_deadline 必填，source != target）
//     1.5. Uin 空时从 shadow 反查回填
//  2. 反查 ctl 目标 bundle（确认存在 + 在售；下架的套餐不能作为升配目标）
//  3. 反查两份 trade_bundle_definition，校验同 SP，取 scene="modify" 的 categoryId
//  4. 拼装 goodsDetail：源套餐字段集 + resourceId + curDeadline + oldConfig/newConfig
//  5. 调 jifei GetPrice
//  6. 拍平为 QuoteResult（BundleID 回显**目标** bundle —— 调用方问的是"升到巡游要多少钱"）
func (s *Service) QuoteModify(ctx context.Context, req QuoteModifyRequest) (*QuoteResult, error) {
	if err := s.validateQuoteModifyRequest(&req); err != nil {
		return nil, err
	}

	if strings.TrimSpace(req.Uin) == "" && s.deps.ShadowClient != nil {
		if strings.TrimSpace(req.ExternalUserID) == "" {
			return nil, fmt.Errorf("%w: external_user_id is required when uin is missing", ErrInvalidInput)
		}
		binding, err := s.deps.ShadowClient.GetBindingByExternalUserID(ctx, req.ExternalUserID)
		if err != nil {
			if errors.Is(err, shadowclient.ErrBindingNotFound) {
				return nil, fmt.Errorf("%w: externalUserId=%s", ErrBindingNotFound, req.ExternalUserID)
			}
			return nil, fmt.Errorf("inquiry: shadow GetBindingByExternalUserID (modify): %w", err)
		}
		if strings.TrimSpace(binding.Uin) == "" {
			return nil, fmt.Errorf("%w: shadow returned empty uin for externalUserId=%s",
				ErrBindingNotFound, req.ExternalUserID)
		}
		req.Uin = binding.Uin
		if req.AppID == "" {
			req.AppID = binding.AppID
		}
	}

	// 只校验目标 bundle 在售：源套餐用户已经持有，它下架与否不影响能否升配走掉。
	targetBundle, err := s.deps.CTLClient.GetBundleByID(ctx, req.TargetBundleID)
	if err != nil {
		if errors.Is(err, ctlclient.ErrNotFound) {
			return nil, fmt.Errorf("%w: ctl bundleId=%s", ErrBundleNotFound, req.TargetBundleID)
		}
		return nil, fmt.Errorf("inquiry: ctl GetBundleByID (modify target): %w", err)
	}
	if !strings.EqualFold(targetBundle.BundleState, "ONLINE") {
		return nil, fmt.Errorf("%w: bundleId=%s state=%s",
			ErrBundleOffline, req.TargetBundleID, targetBundle.BundleState)
	}

	sourceDef, targetDef, categoryID, err := s.resolveModifyDefs(ctx, req.SourceBundleID, req.TargetBundleID)
	if err != nil {
		return nil, err
	}

	goodsDetail := s.buildModifyGoodsDetail(sourceDef, targetDef, req.ResourceID, req.CurDeadline)

	priceReq := &jifeiclient.GetPriceRequest{
		OwnerUin: req.Uin,
		Uin:      req.Uin,
		ResInfo: []jifeiclient.GetPriceItem{
			{
				GoodsCategoryID: categoryID,
				Currency:        s.currency,
				RegionID:        s.region.RegionID,
				ZoneID:          s.region.ZoneID,
				GoodsNum:        modifyGoodsNum,
				PayMode:         req.PayMode,
				// Action 不传：场景由 categoryId[scene=modify] 反查（与 purchase/renew 同款）。
				GoodsDetail: goodsDetail,
			},
		},
	}
	priceResp, err := s.deps.JifeiClient.GetPrice(ctx, priceReq)
	if err != nil {
		return nil, fmt.Errorf("inquiry: jifei GetPrice (modify): %w", err)
	}
	if priceResp == nil || len(priceResp.Data) == 0 {
		return nil, fmt.Errorf("inquiry: jifei GetPrice (modify) returned empty data")
	}

	d := priceResp.Data[0]
	price, totalCost, taxPrice, realTotalCost, err := s.quoteAmountFields(d)
	if err != nil {
		return nil, err
	}
	result := &QuoteResult{
		// 回显目标 bundle：调用方（CTL 的可变配列表）按 target_bundle_id 归位报价。
		BundleID:       req.TargetBundleID,
		BundleName:     targetBundle.BundleName,
		Price:          price,
		TotalCost:      totalCost,
		TaxPrice:       taxPrice,
		RealTotalCost:  realTotalCost,
		Currency:       d.Currency,
		TimeSpan:       float64(d.TimeSpan),
		TimeUnit:       d.TimeUnit,
		GoodsNum:       d.GoodsNum,
		ProductCode:    d.ProductCode,
		SubProductCode: d.SubProductCode,
		Pid:            d.Pid,
	}
	if d.PolicyDetail != nil {
		result.Discount = d.PolicyDetail.Total
	}
	// jifei 返空字段时回填 BundleDefinition 值（与新购/续费同款兜底）。
	if result.ProductCode == "" {
		result.ProductCode = targetDef.ProductCode
	}
	if result.SubProductCode == "" {
		result.SubProductCode = targetDef.SubProductCode
	}
	if result.Pid == 0 {
		result.Pid = targetDef.Pid
	}
	if result.Currency == "" {
		result.Currency = s.currency
	}
	if result.GoodsNum == 0 {
		result.GoodsNum = modifyGoodsNum
	}
	return result, nil
}

// modifyGoodsNum 是变配的 goodsNum，协议固定 1（§5.3）。
const modifyGoodsNum = jifei.ModifyGoodsNum

// resolveModifyDefs 反查源、目标 BundleDefinition，校验同 SP 并取 modify categoryId。
//
// 三条硬失败（都 fail-closed，不猜不兜底）：
//   - 任一 bundle 在 trade_bundle_definition 缺失 → ErrBundleNotFound
//   - subProductCode 不一致 → ErrModifyCrossSubProduct
//   - 目标 bundle 没配 category_ids[scene=modify] → 明确报错
//
// 最后一条是刻意的 fail-closed：本需求四个 SP 的 Modify CategoryID 都要以计费接入单最终
// 配置为准（§3），仓库里那个 2025048 只是国内通用 SP 的既有 seed。缺配置时报错让联调
// 立刻暴露，比拿一个猜的 categoryId 去询价安全得多——后者会拿到一个看似合理的错误价格。
func (s *Service) resolveModifyDefs(
	ctx context.Context,
	sourceBundleID, targetBundleID string,
) (sourceDef, targetDef *store.BundleDefinition, categoryID int64, err error) {
	defs, err := s.deps.BundleStore.GetBundleDefinitionsByIDs(ctx, []string{sourceBundleID, targetBundleID})
	if err != nil {
		return nil, nil, 0, fmt.Errorf("inquiry: get bundle definitions (modify): %w", err)
	}
	sourceDef = defs[sourceBundleID]
	if sourceDef == nil {
		return nil, nil, 0, fmt.Errorf("%w: trade_bundle_definition source bundleId=%s",
			ErrBundleNotFound, sourceBundleID)
	}
	targetDef = defs[targetBundleID]
	if targetDef == nil {
		return nil, nil, 0, fmt.Errorf("%w: trade_bundle_definition target bundleId=%s",
			ErrBundleNotFound, targetBundleID)
	}

	if sourceDef.SubProductCode != targetDef.SubProductCode {
		return nil, nil, 0, fmt.Errorf("%w: source=%s(sp=%s) target=%s(sp=%s)",
			ErrModifyCrossSubProduct,
			sourceBundleID, sourceDef.SubProductCode,
			targetBundleID, targetDef.SubProductCode)
	}

	// categoryId 取目标 bundle 的：同 SP 下源和目标共用同一个 modify category，
	// 但以目标为准语义更清楚——"往哪儿变"决定计费场景。
	categoryID = targetDef.CategoryIDForScene(sceneModify)
	if categoryID == 0 {
		return nil, nil, 0, fmt.Errorf(
			"inquiry: bundle definition missing category_ids[scene=%s]: bundleId=%s subProductCode=%s"+
				" (每个站点/SP 的 Modify CategoryID 需按计费接入单配置后写入 BundleDefinition)",
			sceneModify, targetBundleID, targetDef.SubProductCode)
	}
	return sourceDef, targetDef, categoryID, nil
}

// sceneModify 是 BundleDefinition.CategoryIDs 里变配场景的 scene 字面量。
const sceneModify = "modify"

// buildModifyGoodsDetail 委托给协议层的共享构造器。
//
// 询价和下单必须送出完全一致的 goodsDetail，否则确认页差价与实际扣款不一致，
// 所以字段拼装只有 jifei.BuildModifyGoodsDetail 一个实现。
func (s *Service) buildModifyGoodsDetail(
	sourceDef, targetDef *store.BundleDefinition,
	resourceID, curDeadline string,
) map[string]interface{} {
	return jifei.BuildModifyGoodsDetail(jifei.ModifyGoodsDetailInput{
		ProductCode:     sourceDef.ProductCode,
		SubProductCode:  sourceDef.SubProductCode,
		Pid:             sourceDef.Pid,
		ResourceID:      resourceID,
		CurDeadline:     curDeadline,
		SourceBundleID:  sourceDef.BundleID,
		TargetBundleID:  targetDef.BundleID,
		SourceSVList:    sourceDef.SVList,
		TargetSVList:    targetDef.SVList,
		ProductInfo:     sourceDef.ProductInfo,
		IntlPointOfSale: strings.EqualFold(strings.TrimSpace(s.deps.SiteKind), "intl"),
	})
}

// validateQuoteModifyRequest 校验必填字段。
//
// source == target 在这里就拒：它会让 jifei 算出 0 元差价，用户付了钱什么也没变。
// "能否从 A 升到 B"的业务策略由 CTL 判定（§7.2），trade 只拦这种一眼可见的无效输入。
func (s *Service) validateQuoteModifyRequest(req *QuoteModifyRequest) error {
	if strings.TrimSpace(req.ResourceID) == "" {
		return fmt.Errorf("%w: resource_id is required for modify", ErrInvalidInput)
	}
	if strings.TrimSpace(req.SourceBundleID) == "" {
		return fmt.Errorf("%w: source_bundle_id is required for modify", ErrInvalidInput)
	}
	if strings.TrimSpace(req.TargetBundleID) == "" {
		return fmt.Errorf("%w: target_bundle_id is required for modify", ErrInvalidInput)
	}
	if req.SourceBundleID == req.TargetBundleID {
		return fmt.Errorf("%w: source_bundle_id and target_bundle_id must differ, got %q",
			ErrInvalidInput, req.SourceBundleID)
	}
	if strings.TrimSpace(req.CurDeadline) == "" {
		return fmt.Errorf("%w: cur_deadline is required for modify", ErrInvalidInput)
	}
	if s.deps.ShadowClient == nil {
		if strings.TrimSpace(req.Uin) == "" {
			return fmt.Errorf("%w: uin is required", ErrInvalidInput)
		}
	} else if strings.TrimSpace(req.Uin) == "" && strings.TrimSpace(req.ExternalUserID) == "" {
		return fmt.Errorf("%w: external_user_id or uin is required", ErrInvalidInput)
	}
	if req.PayMode <= 0 {
		req.PayMode = 1
	}
	return nil
}
