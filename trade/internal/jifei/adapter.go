// Package jifei 是 trade 服务内的 jifei 适配层 — 把"业务层入参（externalUserId / bundleId /
// period / timeUnit / goodsNum）"转换为"jifei CGW 协议层入参（resInfo[] / goodsInfos[]）"，
// 同时把 jifei 响应的 PascalCase / camelCase 字段拍平到业务层 snake_case 字段集。
//
// 设计稿引用：
//   - §3.5.5 jifei CGW 协议层契约（询价方向）：sv_list 展平 / productInfo 透传 / policyDetail.total → discount 拍平
//   - §4.2 / §4.3：下单 Step T2.5 反查 trade_bundle_definition、Step T3 调 jifei generateDeals
//   - Q25：sub_product_code / pid 归 trade 维护
//   - Q40：category_ids 按 scene = "purchase" 反查
//   - Q42：currency 不传，pay_mode 显式透传
//   - Q47 / Q48：协议层最小字段集
//   - Q50：价格字段不持久化（适配层只透传，持久化由调用方决定）
//
// 设计要点：
//
//  1. **职责单一**：本包不感知 HTTP / DB 连接 / shadow uin 换取 — 只做"业务字段 ↔ 协议字段"
//     的纯转换 + 调用 jifeiclient + 调用 BundleDefinitionStore；shadow 换 uin 由调用方在
//     入参时提供 (uin, appID)。
//
//  2. **不持久化**（Q50 协同）：本包不写 trade_order / trade_flow，由 handler 层（迭代 5/6）
//     用本包返回值后再做持久化决策。
//
//  3. **错误传播**：本包透传 ErrBundleDefinitionNotFound / *CGWError / ErrCGWHTTPNon200 等
//     原始错误，由 handler 层按 Q56 错误分类映射。
package jifei

import (
	"context"
	"errors"
	"fmt"

	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 业务层 / 协议层硬编码常量（与 Q41 / Q42 / Q47 / Q48 拍板一致）。
const (
	// fixedRegionID 是 Lighthouse SaaS 场景的"其他地域"兜底（Q41）。
	fixedRegionID = 47
	// fixedZoneID 是 Lighthouse SaaS 场景固定 zone（Q41）。
	fixedZoneID = 470004
	// scenePurchase 是 Q49 / Q40 协同：本期仅支持新购场景。
	scenePurchase = "purchase"
)

// InquiryItem 是询价响应的业务层 PriceItem（与设计稿 §3.3 业务层 camelCase 对齐）。
//
// 字段命名遵循 trade 业务层 snake_case 风格（与 ctl/pkg/trade.PriceItem 对齐 — 实际接线由
// handler 层把 InquiryItem 序列化为 HTTP 响应时再做大小写映射）。
type InquiryItem struct {
	BundleID      string  `json:"bundle_id"`
	Price         string  `json:"price"`           // 标价（原始 string，避免精度损失）
	TotalCost     string  `json:"total_cost"`      // 成本价
	RealTotalCost string  `json:"real_total_cost"` // 实付价
	Currency      string  `json:"currency"`
	Discount      float64 `json:"discount"` // 总折扣率（policyDetail.total 拍平），1.0 = 无折扣
}

// InquiryRequest 是询价适配层入参。
//
// (uin, appID) 由调用方提供（在 handler 层先调 shadow client 换取，再调本包）。
type InquiryRequest struct {
	OwnerUin  string   // jifei 协议层 ownerUin（= 终端用户 uin，与 Q40 / Q30 协同）
	Uin       string   // jifei 协议层 uin（payer = owner，与 Q40 一致）
	BundleIDs []string // 待询价 bundle ID 列表（已去重，由调用方保证）
	Period    int      // 购买时长数值
	TimeUnit  string   // 购买时长单位 "m" / "y"
	GoodsNum  int      // 购买数量，Lighthouse 本期固定 1（由调用方传入便于未来扩展）
	Currency  string   // 询价币种（CGW res 级 currency 字段，trade 当前显式传 CNY）
}

// PlaceOrderRequest 是下单适配层入参。
type PlaceOrderRequest struct {
	OwnerUin string // = 终端用户 uin
	Uin      string // = OwnerUin（payer = owner，Q40）
	BundleID string // 单次下单 1 个 bundle，与 Q41 GoodsNum=1 一致
	Period   int
	TimeUnit string
	GoodsNum int
	PayMode  int // jifei 协议层 payMode：0 后付 / 1 预付（Lighthouse 本期 1，Q42）
}

// PlaceOrderResult 是下单适配层响应（与 trade_order 表 big_order_id / deal_name 字段对齐）。
type PlaceOrderResult struct {
	BigOrderID string // jifei 大订单号（generateDeals 响应 BigDealId）
	DealName   string // jifei 子订单号（generateDeals 响应 DealNames[0]，Lighthouse 本期一笔下单 1 个 deal）
}

// Adapter 是 jifei 适配层对外接口（便于 mock）。
type Adapter interface {
	// InquiryBatch 批量询价，bundleIDs[N] 一次调用 jifei → 返回 [N]InquiryItem。
	InquiryBatch(ctx context.Context, req *InquiryRequest) ([]InquiryItem, error)

	// PlaceOrder 下单，返回 (BigOrderID, DealName)。
	PlaceOrder(ctx context.Context, req *PlaceOrderRequest) (*PlaceOrderResult, error)
}

type adapter struct {
	jifei     jifeiclient.Client
	bundleDef store.BundleDefinitionStore
}

// New 构造 jifei 适配层。
//
// 依赖注入：
//   - jifei：jifeiclient.Client（出向 jifei CGW HTTP 客户端）
//   - bundleDef：BundleDefinitionStore（trade_bundle_definition DAO）
//
// shadow 换 uin 不在本包负责（设计稿 §4.3 Step T2 由 handler 层调 shadow client）。
func New(jifei jifeiclient.Client, bundleDef store.BundleDefinitionStore) Adapter {
	return &adapter{
		jifei:     jifei,
		bundleDef: bundleDef,
	}
}

// InquiryBatch 批量询价。
//
// 流程（设计稿 §3.5 / §3.5.5）：
//  1. 校验入参基本字段
//  2. 对每个 bundleID 反查 trade_bundle_definition 拿 (productCode, subProductCode, pid,
//     categoryIDs[scene=purchase], svList, productInfo)
//  3. 把 svList 展平为 goodsDetail.sv_*；productInfo 透传到 goodsDetail.productInfo
//  4. 调 jifeiclient.GetPrice
//  5. 把 CGW 响应字段映射到业务层 InquiryItem（policyDetail.total → discount 拍平）
//
// 返回的 InquiryItem 数组与 bundleIDs 输入顺序 1:1 对应；某个 bundle 反查失败或对应 jifei
// 响应缺失时**整体返错**（**与设计稿 §3.7 c 方案"分页子批失败省略" 不同 — 设计稿 §3.7 是
// trade 顶层"对外内部 RPC"那一层的降级语义，本包 InquiryBatch 是 trade 内部更底层的协议
// 适配，单批失败上抛即可，由 handler 层决定降级策略**）。
//
// 业务字段不直接持久化（Q50）。
func (a *adapter) InquiryBatch(ctx context.Context, req *InquiryRequest) ([]InquiryItem, error) {
	if req == nil {
		return nil, errors.New("jifei.InquiryBatch: nil request")
	}
	if len(req.BundleIDs) == 0 {
		return nil, errors.New("jifei.InquiryBatch: bundleIDs is empty")
	}
	if req.OwnerUin == "" || req.Uin == "" {
		return nil, errors.New("jifei.InquiryBatch: ownerUin / uin is required")
	}
	if req.Period <= 0 {
		return nil, errors.New("jifei.InquiryBatch: period must be > 0")
	}
	if req.TimeUnit == "" {
		return nil, errors.New("jifei.InquiryBatch: timeUnit is required")
	}
	if req.GoodsNum <= 0 {
		return nil, errors.New("jifei.InquiryBatch: goodsNum must be > 0")
	}

	// Step 1: 反查 trade_bundle_definition，拼 resInfo[]
	resInfos := make([]jifeiclient.GetPriceItem, 0, len(req.BundleIDs))
	defs := make([]*store.BundleDefinition, 0, len(req.BundleIDs))
	for _, bID := range req.BundleIDs {
		def, err := a.bundleDef.GetBundleDefinitionByID(ctx, bID)
		if err != nil {
			return nil, fmt.Errorf("jifei.InquiryBatch: lookup bundleID=%s: %w", bID, err)
		}
		categoryID := def.CategoryIDForScene(scenePurchase)
		if categoryID == "" {
			return nil, fmt.Errorf("jifei.InquiryBatch: bundleID=%s missing category for scene=%s", bID, scenePurchase)
		}

		goodsDetail := buildGoodsDetail(def, req.Period, req.TimeUnit)
		resInfos = append(resInfos, jifeiclient.GetPriceItem{
			GoodsCategoryID: categoryID,
			Currency:        req.Currency,
			RegionID:        fixedRegionID,
			ZoneID:          fixedZoneID,
			GoodsNum:        req.GoodsNum,
			PayMode:         1, // 询价场景 Lighthouse 全部预付费（Q42）
			Action:          scenePurchase,
			GoodsDetail:     goodsDetail,
		})
		defs = append(defs, def)
	}

	// Step 2: 调 jifei CGW
	resp, err := a.jifei.GetPrice(ctx, &jifeiclient.GetPriceRequest{
		OwnerUin: req.OwnerUin,
		Uin:      req.Uin,
		ResInfo:  resInfos,
	})
	if err != nil {
		return nil, fmt.Errorf("jifei.InquiryBatch: getPrice: %w", err)
	}
	if resp == nil || len(resp.Data) != len(req.BundleIDs) {
		return nil, fmt.Errorf("jifei.InquiryBatch: getPrice response size mismatch: got %d want %d",
			lenSafe(resp), len(req.BundleIDs))
	}

	// Step 3: 映射 CGW data[] → InquiryItem[]，policyDetail.total 拍平为 discount
	out := make([]InquiryItem, 0, len(req.BundleIDs))
	for i, d := range resp.Data {
		var discount float64
		if d.PolicyDetail != nil {
			discount = d.PolicyDetail.Total
		}
		out = append(out, InquiryItem{
			BundleID:      defs[i].BundleID,
			Price:         d.Price,
			TotalCost:     d.TotalCost,
			RealTotalCost: d.RealTotalCost,
			Currency:      d.Currency,
			Discount:      discount,
		})
	}
	return out, nil
}

// PlaceOrder 下单。
//
// 流程（设计稿 §4.3 Step T2.5 / T3）：
//  1. 反查 trade_bundle_definition
//  2. 拼 GoodsInfos[0]（GoodsCategoryId / RegionId / ZoneId / GoodsNum / PayMode / GoodsDetail）
//  3. 调 jifeiclient.GenerateDeals
//  4. 提取 BigDealId / DealNames[0] 返回
func (a *adapter) PlaceOrder(ctx context.Context, req *PlaceOrderRequest) (*PlaceOrderResult, error) {
	if req == nil {
		return nil, errors.New("jifei.PlaceOrder: nil request")
	}
	if req.OwnerUin == "" || req.Uin == "" {
		return nil, errors.New("jifei.PlaceOrder: ownerUin / uin is required")
	}
	if req.BundleID == "" {
		return nil, errors.New("jifei.PlaceOrder: bundleID is required")
	}
	if req.Period <= 0 {
		return nil, errors.New("jifei.PlaceOrder: period must be > 0")
	}
	if req.TimeUnit == "" {
		return nil, errors.New("jifei.PlaceOrder: timeUnit is required")
	}
	if req.GoodsNum <= 0 {
		return nil, errors.New("jifei.PlaceOrder: goodsNum must be > 0")
	}
	if req.PayMode != 0 && req.PayMode != 1 && req.PayMode != 2 {
		return nil, fmt.Errorf("jifei.PlaceOrder: payMode must be 0/1/2, got %d", req.PayMode)
	}

	// Step 1: 反查 bundle 定义
	def, err := a.bundleDef.GetBundleDefinitionByID(ctx, req.BundleID)
	if err != nil {
		return nil, fmt.Errorf("jifei.PlaceOrder: lookup bundleID=%s: %w", req.BundleID, err)
	}
	categoryID := def.CategoryIDForScene(scenePurchase)
	if categoryID == "" {
		return nil, fmt.Errorf("jifei.PlaceOrder: bundleID=%s missing category for scene=%s",
			req.BundleID, scenePurchase)
	}

	// Step 2: 拼 GoodsInfos[0]
	goodsDetail := buildGoodsDetail(def, req.Period, req.TimeUnit)
	dealsReq := &jifeiclient.GenerateDealsRequest{
		OwnerUin: req.OwnerUin,
		Uin:      req.Uin,
		GoodsInfos: []jifeiclient.GoodsInfo{
			{
				GoodsCategoryID: categoryID,
				RegionID:        fixedRegionID,
				ZoneID:          fixedZoneID,
				GoodsNum:        req.GoodsNum,
				PayMode:         req.PayMode,
				GoodsDetail:     goodsDetail,
			},
		},
	}

	// Step 3: 调 jifei CGW
	resp, err := a.jifei.GenerateDeals(ctx, dealsReq)
	if err != nil {
		return nil, fmt.Errorf("jifei.PlaceOrder: generateDeals: %w", err)
	}
	if resp == nil || resp.BigDealID == "" || len(resp.DealNames) == 0 || resp.DealNames[0] == "" {
		return nil, fmt.Errorf("jifei.PlaceOrder: generateDeals response missing BigDealId / DealNames")
	}

	return &PlaceOrderResult{
		BigOrderID: resp.BigDealID,
		DealName:   resp.DealNames[0],
	}, nil
}

// buildGoodsDetail 把 BundleDefinition + (period, timeUnit) 拼成 jifei goodsDetail map。
//
// 拼装规则（与设计稿 §3.5.5 (4) / §4.3 Step T3 一致）：
//   - 基础字段：productCode / subProductCode / pid / timeSpan / timeUnit
//   - sv_* 系列字段：从 def.SVList 展平注入（key 加 "sv_" 前缀）
//   - productInfo 数组：def.ProductInfo 透传到 goodsDetail.productInfo
//
// 询价 / 下单两个方向共用同一个 goodsDetail 构造逻辑（PDF 上 GoodsDetail 字段虽然 PascalCase
// 但内部 key 仍是协议字段名，jifei 端解析方式相同）。
func buildGoodsDetail(def *store.BundleDefinition, period int, timeUnit string) map[string]interface{} {
	out := map[string]interface{}{
		"productCode":    def.ProductCode,
		"subProductCode": def.SubProductCode,
		"pid":            def.Pid,
		"timeSpan":       period,
		"timeUnit":       timeUnit,
	}
	// sv_* 展平
	for k, v := range def.SVList {
		out["sv_"+k] = v
	}
	// productInfo 透传（注意：jifei 协议字段名是 productInfo，与 sv_list 是 sv_* 严格区分语义）
	if len(def.ProductInfo) > 0 {
		out["productInfo"] = def.ProductInfo
	}
	return out
}

// lenSafe 返回 *GetPriceResponse.Data 长度（resp 为 nil 时返 0），用于错误信息。
func lenSafe(resp *jifeiclient.GetPriceResponse) int {
	if resp == nil {
		return 0
	}
	return len(resp.Data)
}
