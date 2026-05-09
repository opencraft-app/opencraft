// Package placeorder 实现 trade 服务对外暴露的"下单"业务能力（迭代 8A）。
//
// 设计稿对齐（trade-purchase-flow-design.md §4.2.1 / §4.3 / Q41 / Q42 / Q47 / Q48）：
//   - 入参：externalUserId / bundleId / period / timeUnit / goodsNum / payMode / regionId
//     （**本期折中**：uin / appID 也作为显式入参，shadow 反查留作 8B 或后续迭代接入）
//   - 流程：
//     1) 校验入参
//     2) 反查 ctl bundle（确认存在 + 在售）
//     3) 反查 trade_bundle_definition（拿 jifei 协议元数据 + sv_list / product_info）
//     4) 调 jifei generateDeals 拿 BigDealID / DealName
//     5) 落 trade_order（status='pending_pay'）
//     6) 返回 (DealName, BigOrderID)
//
// 错误分类：
//   - 入参缺失 → ErrInvalidInput
//   - bundle 不存在（ctl 或 trade_bundle_definition 任一返 NotFound）→ ErrBundleNotFound
//   - bundle 已下架 → ErrBundleOffline
//   - jifei generateDeals 失败 → 透传 *jifeiclient.CGWError 或 raw error
//   - trade_order UNIQUE 冲突 → ErrDealNameDuplicate（理论不会发生，dealName 由 jifei 生成）
//
// 不做：
//   - 询价复算（信任入参 period/payMode 即业务层传入语义；如需"防价格不一致" reconcile，
//     由上层 ctl 在调用前自己询价并对比）
//   - 支付 url 生成：拆为独立的 GeneratePayURL 方法（本期返回 trade_order 缓存的 pay_url，
//     如未缓存则返 ErrPayURLUnavailable，由调用方决定降级策略；jifei 单独"生成支付 url"
//     SDK 调用留作后续迭代接入）
package placeorder

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/shadowclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 业务错误哨兵（上层 errors.Is 判定）。
var (
	// ErrInvalidInput 入参校验失败
	ErrInvalidInput = errors.New("placeorder: invalid input")

	// ErrBundleNotFound bundle 在 ctl 或 trade_bundle_definition 任一不存在
	ErrBundleNotFound = errors.New("placeorder: bundle not found")

	// ErrBundleOffline bundle 在 ctl 已下架（bundle_state != ONLINE）
	ErrBundleOffline = errors.New("placeorder: bundle offline")

	// ErrDealNameDuplicate trade_order UNIQUE 冲突（dealName 由 jifei 生成，理论不应发生）
	ErrDealNameDuplicate = errors.New("placeorder: deal_name already exists")

	// ErrJifeiResponseInvalid jifei generateDeals 响应缺失 BigDealID / DealNames
	ErrJifeiResponseInvalid = errors.New("placeorder: jifei generateDeals response invalid")

	// ErrPayURLUnavailable trade_order 中暂无 pay_url 缓存（GeneratePayURL 本期不主动调
	// jifei 生成支付 url，仅返回缓存值；缓存为空时返此错由上层降级）
	ErrPayURLUnavailable = errors.New("placeorder: pay url not available")

	// ErrBindingNotFound externalUserId 在 shadow 没有绑定记录（用户未实名 / 未绑云账号）
	// 上层应映射为引导用户实名 / 绑定的业务错，不上报 5xx
	ErrBindingNotFound = errors.New("placeorder: binding not found")
)

// PlaceOrderRequest 是 PlaceOrder 入参。
//
// 与 §4.2.1 内部 RPC 入参 schema 对齐；ExternalUserID / Uin / AppID 当前都作为显式入参，
// shadow 反查（externalUserId → uin/appId）留作 8B 或后续迭代接入。
type PlaceOrderRequest struct {
	ExternalUserID string
	Uin            string
	AppID          string
	BundleID       string
	Period         int
	TimeUnit       string
	GoodsNum       int
	PayMode        int
	RegionID       int
}

// PlaceOrderResult 是 PlaceOrder 出参（与 trade_order.deal_name / big_order_id 字段对齐）。
//
// PayURL 字段：generateDeals 通常不返回 payUrl（设计稿 §4.2.2 解释了 jifei SDK 拆分 SDK 的
// 设计动机）；本期 PlaceOrder 完成时 PayURL 留空，由 ctl 后续调 GeneratePayURL 单独获取。
type PlaceOrderResult struct {
	DealName   string `json:"deal_name"`
	BigOrderID string `json:"big_order_id"`
	PayURL     string `json:"pay_url,omitempty"` // 本期始终为空字符串，留作向后兼容
	ExpireAt   string `json:"expire_at,omitempty"`
}

// Deps 是 Service 的依赖注入。
//
// 必填项（构造期 New() 校验）：CTLClient / BundleStore / JifeiClient / OrderWriter / OrderStore。
// 可选项：ShadowClient — 8B-1 后接入；非 nil 时 PlaceOrder 自动反查 externalUserId →
// (uin, app_id) 回填；nil 时退化为"由调用方在 PlaceOrderRequest 显式提供 Uin/AppID"
// 的 8A 行为，保持向后兼容。
type Deps struct {
	CTLClient    ctlclient.Client
	BundleStore  store.BundleDefinitionStore
	JifeiClient  jifeiclient.Client
	OrderWriter  store.OrderWriter
	OrderStore   store.OrderStore // GeneratePayURL 反查 trade_order.pay_url 用
	ShadowClient shadowclient.Client // 可选，nil 表示由调用方传 Uin/AppID
}

// Service 实现"业务层下单"能力。
type Service struct {
	deps Deps
}

// New 构造 Service；依赖 nil 时 panic（启动期暴露编程错）。
func New(deps Deps) *Service {
	if deps.CTLClient == nil {
		panic("placeorder.New: CTLClient is required")
	}
	if deps.BundleStore == nil {
		panic("placeorder.New: BundleStore is required")
	}
	if deps.JifeiClient == nil {
		panic("placeorder.New: JifeiClient is required")
	}
	if deps.OrderWriter == nil {
		panic("placeorder.New: OrderWriter is required")
	}
	if deps.OrderStore == nil {
		panic("placeorder.New: OrderStore is required")
	}
	return &Service{deps: deps}
}

// PlaceOrder 执行单次下单。
func (s *Service) PlaceOrder(ctx context.Context, req PlaceOrderRequest) (*PlaceOrderResult, error) {
	if err := s.validatePlaceOrderRequest(&req); err != nil {
		return nil, err
	}

	// 1.5 shadow 反查（8B-1）：当 Uin 未由调用方显式提供时，从 externalUserId 反查云账号身份。
	if strings.TrimSpace(req.Uin) == "" && s.deps.ShadowClient != nil {
		if strings.TrimSpace(req.ExternalUserID) == "" {
			return nil, fmt.Errorf("%w: external_user_id is required when uin is missing", ErrInvalidInput)
		}
		binding, err := s.deps.ShadowClient.GetBindingByExternalUserID(ctx, req.ExternalUserID)
		if err != nil {
			if errors.Is(err, shadowclient.ErrBindingNotFound) {
				return nil, fmt.Errorf("%w: externalUserId=%s", ErrBindingNotFound, req.ExternalUserID)
			}
			return nil, fmt.Errorf("placeorder: shadow GetBindingByExternalUserID: %w", err)
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

	// 2. 反查 ctl bundle
	bundle, err := s.deps.CTLClient.GetBundleByID(ctx, req.BundleID)
	if err != nil {
		if errors.Is(err, ctlclient.ErrNotFound) {
			return nil, fmt.Errorf("%w: ctl bundleId=%s", ErrBundleNotFound, req.BundleID)
		}
		return nil, fmt.Errorf("placeorder: ctl GetBundleByID: %w", err)
	}
	if !strings.EqualFold(bundle.BundleState, "ONLINE") {
		return nil, fmt.Errorf("%w: bundleId=%s state=%s",
			ErrBundleOffline, req.BundleID, bundle.BundleState)
	}

	// 3. 反查 trade_bundle_definition
	def, err := s.deps.BundleStore.GetBundleDefinitionByID(ctx, req.BundleID)
	if err != nil {
		if errors.Is(err, store.ErrBundleDefinitionNotFound) {
			return nil, fmt.Errorf("%w: trade_bundle_definition bundleId=%s",
				ErrBundleNotFound, req.BundleID)
		}
		return nil, fmt.Errorf("placeorder: get bundle definition: %w", err)
	}

	categoryID := def.CategoryIDForScene("purchase")
	if categoryID == "" {
		return nil, fmt.Errorf("placeorder: bundle definition missing category_ids[scene=purchase]: bundleId=%s",
			req.BundleID)
	}

	// 4. 拼装 jifei generateDeals 入参
	goodsDetail := buildGoodsDetail(def, req)
	dealsReq := &jifeiclient.GenerateDealsRequest{
		OwnerUin: req.Uin,
		Uin:      req.Uin,
		GoodsInfos: []jifeiclient.GoodsInfo{
			{
				GoodsCategoryID: categoryID,
				RegionID:        req.RegionID,
				GoodsNum:        req.GoodsNum,
				PayMode:         req.PayMode,
				GoodsDetail:     goodsDetail,
			},
		},
	}
	dealsResp, err := s.deps.JifeiClient.GenerateDeals(ctx, dealsReq)
	if err != nil {
		return nil, fmt.Errorf("placeorder: jifei GenerateDeals: %w", err)
	}
	if dealsResp == nil || dealsResp.BigDealID == "" || len(dealsResp.DealNames) == 0 || dealsResp.DealNames[0] == "" {
		return nil, fmt.Errorf("%w: BigDealID=%q DealNames=%v",
			ErrJifeiResponseInvalid,
			func() string {
				if dealsResp == nil {
					return ""
				}
				return dealsResp.BigDealID
			}(),
			func() []string {
				if dealsResp == nil {
					return nil
				}
				return dealsResp.DealNames
			}(),
		)
	}

	dealName := dealsResp.DealNames[0]

	// 5. 落 trade_order（status='pending_pay'）
	in := store.CreateOrderInput{
		BigOrderID:     dealsResp.BigDealID,
		DealName:       dealName,
		ExternalUserID: req.ExternalUserID,
		Uin:            req.Uin,
		AppID:          req.AppID,
		SubProductCode: def.SubProductCode,
		BundleID:       req.BundleID,
		Period:         req.Period,
		TimeUnit:       req.TimeUnit,
		GoodsNum:       req.GoodsNum,
		RegionID:       req.RegionID,
		PayMode:        req.PayMode,
		GoodsDetail:    goodsDetail,
		Status:         "pending_pay",
		ResourceType:   "pass",
		// ExpireTime 由 jifei 控制订单失效（本期 trade 不主动设置；列允许 NULL 但
		// migration 0001 默认为零值 time.Time → MySQL 落 1970-01-01 占位）
		ExpireTime: time.Time{},
	}
	if err := s.deps.OrderWriter.CreateOrder(ctx, in); err != nil {
		if errors.Is(err, store.ErrTradeOrderDuplicate) {
			// dealName 由 jifei 生成、理论唯一；冲突说明状态不一致 — 透传错误，不掩盖
			return nil, fmt.Errorf("%w: dealName=%s", ErrDealNameDuplicate, dealName)
		}
		return nil, fmt.Errorf("placeorder: persist trade_order dealName=%s: %w", dealName, err)
	}

	return &PlaceOrderResult{
		DealName:   dealName,
		BigOrderID: dealsResp.BigDealID,
	}, nil
}

// GeneratePayURL 生成 / 反查支付页 url（设计稿 §4.2.2 接口）。
//
// **本期实现策略**（迭代 8A 简化）：
//
//	1) 反查 trade_order 取 pay_url
//	2) 命中 → 返回缓存值
//	3) 未命中 → 返 ErrPayURLUnavailable，由调用方判定降级
//
// **未来扩展**：jifei "生成支付 url" SDK 调用接入后，未命中时主动调 jifei 生成 url
// 并回写 trade_order.pay_url；调用顺序：
//
//	jifei.GeneratePayURL → UPDATE trade_order SET pay_url=?, expire_time=? WHERE deal_name=?
//
// 预留接口：当前不暴露 jifeiclient.GeneratePayURL（PDF 第 9 页 SDK 文档未明确，
// 联调期与 jifei 同事确认接口名 / 入参后再补）。
func (s *Service) GeneratePayURL(ctx context.Context, dealName string) (string, error) {
	dealName = strings.TrimSpace(dealName)
	if dealName == "" {
		return "", fmt.Errorf("%w: deal_name is required", ErrInvalidInput)
	}

	order, err := s.deps.OrderStore.GetOrderByDealName(ctx, dealName)
	if err != nil {
		if errors.Is(err, store.ErrTradeOrderNotFound) {
			return "", fmt.Errorf("placeorder: trade_order not found: dealName=%s: %w",
				dealName, err)
		}
		return "", fmt.Errorf("placeorder: get trade_order dealName=%s: %w", dealName, err)
	}
	if order.PayURL == "" {
		return "", fmt.Errorf("%w: dealName=%s", ErrPayURLUnavailable, dealName)
	}
	return order.PayURL, nil
}

// validatePlaceOrderRequest 校验 PlaceOrderRequest 必填字段。
//
// Uin / ExternalUserID 校验策略（8B-1）：
//   - ShadowClient 已注入：Uin 允许为空（后续从 shadow 反查回填）；ExternalUserID 必填
//   - ShadowClient 未注入（8A 行为）：ExternalUserID + Uin 双必填，与原行为完全一致
func (s *Service) validatePlaceOrderRequest(req *PlaceOrderRequest) error {
	if strings.TrimSpace(req.BundleID) == "" {
		return fmt.Errorf("%w: bundle_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(req.ExternalUserID) == "" {
		return fmt.Errorf("%w: external_user_id is required", ErrInvalidInput)
	}
	if s.deps.ShadowClient == nil {
		// 8A 行为：Uin 必填
		if strings.TrimSpace(req.Uin) == "" {
			return fmt.Errorf("%w: uin is required", ErrInvalidInput)
		}
	}
	if req.Period <= 0 {
		return fmt.Errorf("%w: period must be > 0", ErrInvalidInput)
	}
	if strings.TrimSpace(req.TimeUnit) == "" {
		return fmt.Errorf("%w: time_unit is required", ErrInvalidInput)
	}
	if req.GoodsNum <= 0 {
		req.GoodsNum = 1 // Q41 协同：本期固定 1
	}
	if req.PayMode != 0 && req.PayMode != 1 && req.PayMode != 2 {
		return fmt.Errorf("%w: pay_mode must be 0/1/2, got %d", ErrInvalidInput, req.PayMode)
	}
	return nil
}

// buildGoodsDetail 把 BundleDefinition + 用户入参展平成 jifei goodsDetail map。
//
// 字段集与 inquiry.buildGoodsDetail 共享语义（设计稿 §3.5.5 (4) / §4.3 Step T3）：
//   - productCode / subProductCode / pid（来自 BundleDefinition）
//   - timeSpan / timeUnit / goodsNum（来自 PlaceOrderRequest）
//   - sv_*（来自 BundleDefinition.SVList，加 "sv_" 前缀，值原样保留）
//   - productInfo（直接透传）
//
// 与 inquiry buildGoodsDetail 不同点：本函数 sv_* 值不做 stringify，因为 generateDeals
// 协议层 GoodsDetail 是 map[string]interface{}，jifei 端按字段类型解析；询价侧 stringify
// 是为了与 checkCreate 入参对账保持类型一致（Q54 协议契约）。
func buildGoodsDetail(def *store.BundleDefinition, req PlaceOrderRequest) map[string]interface{} {
	out := map[string]interface{}{
		"productCode":    def.ProductCode,
		"subProductCode": def.SubProductCode,
		"pid":            def.Pid,
		"timeSpan":       req.Period,
		"timeUnit":       req.TimeUnit,
		"goodsNum":       req.GoodsNum,
	}
	for k, v := range def.SVList {
		out["sv_"+k] = v
	}
	if len(def.ProductInfo) > 0 {
		out["productInfo"] = def.ProductInfo
	}
	return out
}
