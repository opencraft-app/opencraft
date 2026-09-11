package placeorder

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifei"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/shadowclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 同 SP 变配（升配）下单。需求：TAPD 1010132091137784162 §4.1 / §5.1 / §7.1
//
// 与续费下单的差异：
//   - 涉及源 + 目标两个 bundle；goodsDetail 走 jifei.BuildModifyGoodsDetail（含 oldConfig/newConfig）
//   - goodsCategoryId 取 scene="modify"
//   - trade_order.order_type='modify'，bundle_id 落**目标**套餐（订单卖的是"升到巡游"）
//   - 无 period / timeUnit：变配不改到期时间
//
// 两个变体与新购/续费同范式：
//   - PlaceModifyOrder       → generateDeals，落 pending_pay，调用方再取支付 URL（生产链路）
//   - PlaceModifyOrderAndPay → generateDealsAndPay，代金券自动扣完；同步发货成功落
//     provisioned，异步发货中落 paid_pending_provision（联调 / e2e 链路）

// ErrModifyCrossSubProduct 源与目标 bundle 不属于同一个 SP；本期只支持同 SP 变配（§2.2）。
var ErrModifyCrossSubProduct = errors.New("placeorder: modify across sub product codes is not supported")

// sceneModify 是 BundleDefinition.CategoryIDs 里变配场景的 scene 字面量。
const sceneModify = "modify"

// PlaceModifyOrderRequest 是变配下单入参。
//
// GoodsNum / Period / TimeUnit 都不在入参里：变配固定 goodsNum=1，且不改变到期时间。
// PayMode 缺省 1（与新购/续费一致）。
type PlaceModifyOrderRequest struct {
	ExternalUserID string
	Uin            string
	AppID          string
	// ResourceID 是变配目标 pass_id（jifei goodsDetail.resourceId）。
	ResourceID string
	// SourceBundleID 是 pass 当前套餐；决定 goodsDetail 顶层 sv_* 与 oldConfig。
	SourceBundleID string
	// TargetBundleID 是升配目标套餐；决定 newConfig，也是 trade_order.bundle_id。
	TargetBundleID string
	// CurDeadline 是 pass.expired_time 的 jifei 字面值，由调用方（CTL）透传。
	// 与续费同款：trade 只做非空校验，不解析、不计算。
	CurDeadline string
	PayMode     int
}

// modifyOrderContext 是两个变体共用的前置产物。
//
// 抽出来是因为"校验 → shadow 反查 → ctl bundle → 两份 BundleDefinition → categoryId →
// goodsDetail → appId"这一串在两个变体里必须完全一致；复制两遍迟早在某次改动里漂移，
// 而漂移的后果是询价与扣款不一致。
type modifyOrderContext struct {
	sourceDef   *store.BundleDefinition
	targetDef   *store.BundleDefinition
	categoryID  int64
	goodsDetail map[string]interface{}
	appID       int64
}

// PlaceModifyOrder 创建变配订单（两步式，生产链路）。
//
// 流程：校验 → shadow 反查 → ctl 目标 bundle 在售校验 → 两份 BundleDefinition + 同 SP 校验 →
// jifei generateDeals → 落 trade_order(order_type='modify', status='pending_pay') →
// 返 (DealName, BigOrderID)。
//
// 落库即返回，不等发货：付款后 jifei 会回调 checkModify / modifyResource，CTL 侧的
// 状态机在那条链路上推进。
func (s *Service) PlaceModifyOrder(ctx context.Context, req PlaceModifyOrderRequest) (*PlaceOrderResult, error) {
	oc, err := s.prepareModifyOrder(ctx, &req, "modify")
	if err != nil {
		return nil, err
	}

	dealsResp, err := s.deps.JifeiClient.GenerateDeals(ctx, &jifeiclient.GenerateDealsRequest{
		OwnerUin: req.Uin,
		Uin:      req.Uin,
		AppID:    oc.appID,
		Goods:    []jifeiclient.GoodsInfo{s.modifyGoodsInfo(oc, req.PayMode)},
	})
	if err != nil {
		return nil, fmt.Errorf("placeorder: jifei GenerateDeals (modify): %w", err)
	}
	if dealsResp == nil || dealsResp.BigDealID == "" || len(dealsResp.DealNames) == 0 || dealsResp.DealNames[0] == "" {
		return nil, fmt.Errorf("%w (modify): response missing bigDealId or dealNames", ErrJifeiResponseInvalid)
	}

	dealName := dealsResp.DealNames[0]
	if err := s.persistModifyOrder(ctx, req, oc, dealsResp.BigDealID, dealName, store.OrderStatusPendingPay); err != nil {
		return nil, err
	}
	return &PlaceOrderResult{DealName: dealName, BigOrderID: dealsResp.BigDealID}, nil
}

// PlaceModifyOrderAndPay 创建变配订单并同步支付（联调 / e2e 链路）。
//
// 与 PlaceRenewOrderAndPay 同范式：autoVoucher=1 自动扣测试代金券，一次调用把
// trade → jifei → checkModify → modifyResource → CTL 发货整条链路跑通，无需真人付款。
// 条件落库：jifei 同步发货成功（state="0" + resourceIds 非空）时写 provisioned；
// 已扣款但异步发货中（state="1"）先写 paid_pending_provision，等待 modifyResource
// 成功回调推进到 provisioned。明确失败和无法识别的状态不落库。
func (s *Service) PlaceModifyOrderAndPay(ctx context.Context, req PlaceModifyOrderRequest) (*PlaceOrderResult, error) {
	oc, err := s.prepareModifyOrder(ctx, &req, "modify-and-pay")
	if err != nil {
		return nil, err
	}

	autoVoucher := 1
	dealsResp, err := s.deps.JifeiClient.GenerateDealsAndPay(ctx, &jifeiclient.GenerateDealsAndPayRequest{
		OwnerUin:    req.Uin,
		Uin:         req.Uin,
		AppID:       oc.appID,
		AutoVoucher: &autoVoucher,
		Goods:       []jifeiclient.GoodsInfo{s.modifyGoodsInfo(oc, req.PayMode)},
	})
	if err != nil {
		return nil, fmt.Errorf("placeorder: jifei GenerateDealsAndPay (modify): %w", err)
	}
	if dealsResp == nil || len(dealsResp.BigDealIDs) == 0 || dealsResp.BigDealIDs[0] == "" ||
		len(dealsResp.DealNames) == 0 || dealsResp.DealNames[0] == "" {
		return nil, fmt.Errorf("%w (modify-and-pay): response missing bigDealIds or dealNames", ErrJifeiResponseInvalid)
	}

	dealName := dealsResp.DealNames[0]
	bigDealID := dealsResp.BigDealIDs[0]
	status := modifyOrderStatusAfterPay(dealsResp, dealName)
	if status != "" {
		if err := s.persistModifyOrder(ctx, req, oc, bigDealID, dealName, status); err != nil {
			return nil, err
		}
		if status == store.OrderStatusPaidPendingProvision {
			// A fast zero-instance parent task can complete before this one-shot
			// caller inserts trade_order. Re-read the flow after INSERT and promote
			// the order if the terminal callback won that race. This is best-effort;
			// the CTL parent task also retries its completion callback.
			s.promoteModifyOrderIfFlowCompleted(ctx, dealName, oc.appID, req.ResourceID)
		}
	}
	return &PlaceOrderResult{DealName: dealName, BigOrderID: bigDealID}, nil
}

func (s *Service) promoteModifyOrderIfFlowCompleted(
	ctx context.Context,
	dealName string,
	appID int64,
	resourceID string,
) {
	if s.deps.ModifyFlowReader == nil {
		return
	}
	flow, err := s.deps.ModifyFlowReader.GetFlow(
		ctx, dealName, store.FlowTypeModifyResource, strconv.FormatInt(appID, 10),
	)
	if err != nil || flow == nil || flow.Status != store.FlowStatusCompleted {
		return
	}
	if flow.ResourceID != nil && *flow.ResourceID != "" && *flow.ResourceID != resourceID {
		return
	}
	_ = s.deps.OrderWriter.MarkOrderProvisioned(ctx, dealName, resourceID)
}

// modifyOrderStatusAfterPay 把一体化变配下单的发货状态映射为本地订单状态。
//
// 变配的 resource_id 在下单前就是既有 pass_id，因此 state="1" 即使没有
// resourceIds 也能安全落已支付中态；后续 modifyResource 用 dealName 幂等收口。
func modifyOrderStatusAfterPay(resp *jifeiclient.GenerateDealsAndPayResponse, dealName string) string {
	if shouldPersistOrderAfterPay(resp, dealName) {
		return store.OrderStatusProvisioned
	}
	if resp == nil {
		return ""
	}
	deliver, ok := resp.DealDeliverResults[dealName]
	if !ok {
		return ""
	}
	state, _ := deliver["state"].(string)
	if state == "1" {
		return store.OrderStatusPaidPendingProvision
	}
	return ""
}

func (s *Service) modifyGoodsInfo(oc *modifyOrderContext, payMode int) jifeiclient.GoodsInfo {
	return jifeiclient.GoodsInfo{
		GoodsCategoryID: oc.categoryID,
		RegionID:        s.region.RegionID,
		ZoneID:          s.region.ZoneID,
		GoodsNum:        jifei.ModifyGoodsNum,
		PayMode:         payMode,
		GoodsDetail:     oc.goodsDetail,
	}
}

// prepareModifyOrder 做两个变体共用的全部前置：校验、身份反查、bundle 反查、goodsDetail 装配。
//
// label 只进错误串，用来区分两步式和一体化路径的排障日志。
func (s *Service) prepareModifyOrder(
	ctx context.Context,
	req *PlaceModifyOrderRequest,
	label string,
) (*modifyOrderContext, error) {
	if err := validatePlaceModifyOrderRequest(req); err != nil {
		return nil, err
	}

	// 变配是付费链路，与新购/续费一致：不走 inquiry 的兜底身份，shadow binding 缺失直接拒。
	if strings.TrimSpace(req.Uin) == "" && s.deps.ShadowClient != nil {
		if strings.TrimSpace(req.ExternalUserID) == "" {
			return nil, fmt.Errorf("%w: external_user_id is required when uin is missing", ErrInvalidInput)
		}
		binding, err := s.deps.ShadowClient.GetBindingByExternalUserID(ctx, req.ExternalUserID)
		if err != nil {
			if errors.Is(err, shadowclient.ErrBindingNotFound) {
				return nil, fmt.Errorf("%w: externalUserId=%s", ErrBindingNotFound, req.ExternalUserID)
			}
			return nil, fmt.Errorf("placeorder: shadow GetBindingByExternalUserID (%s): %w", label, err)
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

	// 只校验目标 bundle 在售：源套餐用户已持有，它下架与否不影响能否升配走掉。
	targetBundle, err := s.deps.CTLClient.GetBundleByID(ctx, req.TargetBundleID)
	if err != nil {
		if errors.Is(err, ctlclient.ErrNotFound) {
			return nil, fmt.Errorf("%w: ctl bundleId=%s", ErrBundleNotFound, req.TargetBundleID)
		}
		return nil, fmt.Errorf("placeorder: ctl GetBundleByID (%s): %w", label, err)
	}
	if !strings.EqualFold(targetBundle.BundleState, "ONLINE") {
		return nil, fmt.Errorf("%w: bundleId=%s state=%s",
			ErrBundleOffline, req.TargetBundleID, targetBundle.BundleState)
	}

	sourceDef, err := s.deps.BundleStore.GetBundleDefinitionByID(ctx, req.SourceBundleID)
	if err != nil {
		if errors.Is(err, store.ErrBundleDefinitionNotFound) {
			return nil, fmt.Errorf("%w: trade_bundle_definition source bundleId=%s",
				ErrBundleNotFound, req.SourceBundleID)
		}
		return nil, fmt.Errorf("placeorder: get source bundle definition (%s): %w", label, err)
	}
	targetDef, err := s.deps.BundleStore.GetBundleDefinitionByID(ctx, req.TargetBundleID)
	if err != nil {
		if errors.Is(err, store.ErrBundleDefinitionNotFound) {
			return nil, fmt.Errorf("%w: trade_bundle_definition target bundleId=%s",
				ErrBundleNotFound, req.TargetBundleID)
		}
		return nil, fmt.Errorf("placeorder: get target bundle definition (%s): %w", label, err)
	}
	if sourceDef.SubProductCode != targetDef.SubProductCode {
		return nil, fmt.Errorf("%w: source=%s(sp=%s) target=%s(sp=%s)",
			ErrModifyCrossSubProduct,
			req.SourceBundleID, sourceDef.SubProductCode,
			req.TargetBundleID, targetDef.SubProductCode)
	}

	// fail-closed：Modify CategoryID 要按各站点/SP 的计费接入单配置后写入 BundleDefinition（§3）。
	// 缺配置时报错，比拿一个猜的 categoryId 去下单安全——后者会创建一笔语义错误的真实订单。
	categoryID := targetDef.CategoryIDForScene(sceneModify)
	if categoryID == 0 {
		return nil, fmt.Errorf(
			"placeorder: bundle definition missing category_ids[scene=%s]: bundleId=%s subProductCode=%s",
			sceneModify, req.TargetBundleID, targetDef.SubProductCode)
	}

	appIDInt, err := parseAppIDForJifei(req.AppID)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid appId=%q: %v", ErrInvalidInput, req.AppID, err)
	}

	return &modifyOrderContext{
		sourceDef:  sourceDef,
		targetDef:  targetDef,
		categoryID: categoryID,
		goodsDetail: jifei.BuildModifyGoodsDetail(jifei.ModifyGoodsDetailInput{
			ProductCode:     sourceDef.ProductCode,
			SubProductCode:  sourceDef.SubProductCode,
			Pid:             sourceDef.Pid,
			ResourceID:      req.ResourceID,
			CurDeadline:     req.CurDeadline,
			SourceBundleID:  req.SourceBundleID,
			TargetBundleID:  req.TargetBundleID,
			SourceSVList:    sourceDef.SVList,
			TargetSVList:    targetDef.SVList,
			ProductInfo:     sourceDef.ProductInfo,
			IntlPointOfSale: isIntlSite(s.deps.SiteKind),
		}),
		appID: appIDInt,
	}, nil
}

// persistModifyOrder 落 trade_order。
//
// bundle_id 写**目标**套餐：订单卖的是"升到巡游"，按 bundle_id 反查对账时应该看到目标；
// 源套餐已在 goods_detail 快照的顶层 sv_* / oldConfig 里完整留痕。
// period / time_unit 留空（变配不改到期时间），resource_id = pass_id（下单时即已知，与续费同源）。
func (s *Service) persistModifyOrder(
	ctx context.Context,
	req PlaceModifyOrderRequest,
	oc *modifyOrderContext,
	bigOrderID, dealName, status string,
) error {
	in := store.CreateOrderInput{
		BigOrderID:     bigOrderID,
		DealName:       dealName,
		ExternalUserID: req.ExternalUserID,
		Uin:            req.Uin,
		AppID:          req.AppID,
		SubProductCode: oc.targetDef.SubProductCode,
		BundleID:       req.TargetBundleID,
		OrderType:      store.OrderTypeModify,
		GoodsNum:       jifei.ModifyGoodsNum,
		RegionID:       s.region.RegionID,
		PayMode:        req.PayMode,
		GoodsDetail:    oc.goodsDetail,
		Status:         status,
		ResourceType:   "pass",
		ResourceID:     req.ResourceID,
	}
	if err := s.deps.OrderWriter.CreateOrder(ctx, in); err != nil {
		if errors.Is(err, store.ErrTradeOrderDuplicate) {
			return fmt.Errorf("%w (modify): dealName=%s", ErrDealNameDuplicate, dealName)
		}
		return fmt.Errorf("placeorder: persist trade_order (modify dealName=%s passID=%s status=%s): %w",
			dealName, req.ResourceID, status, err)
	}
	return nil
}

// validatePlaceModifyOrderRequest 校验必填字段并补 PayMode 缺省值。
//
// source == target 在这里就拒：它会让 jifei 算出 0 元差价，用户付了钱什么也不会变。
// "能否从 A 升到 B"的业务策略由 CTL 判定（§7.2），trade 只拦一眼可见的无效输入。
func validatePlaceModifyOrderRequest(req *PlaceModifyOrderRequest) error {
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
	if strings.TrimSpace(req.Uin) == "" && strings.TrimSpace(req.ExternalUserID) == "" {
		return fmt.Errorf("%w: external_user_id or uin is required", ErrInvalidInput)
	}
	if req.PayMode <= 0 {
		req.PayMode = 1
	}
	return nil
}
