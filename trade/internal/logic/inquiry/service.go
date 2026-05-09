// Package inquiry 实现 trade 服务对外暴露的"询价"业务能力（迭代 8）。
//
// 设计稿对齐（trade-purchase-flow-design.md §3.5.5 / Q42 / Q47 / Q48 / Q50）：
//   - 调 ctl 反查 bundle 业务规格（GetBundleByID）确认 bundle 存在 + 在售
//   - 调 trade 自家 BundleDefinitionStore 拿 jifei 协议层元数据（productCode / pid /
//     subProductCode / sv_list / categoryId(scene=purchase)）
//   - 拼装 jifeiclient.GetPriceRequest 调 jifei CGW 询价
//   - 把 jifei 出参拍平为业务层"价格快照"返回（去掉 partDetail / highPrecisionPrice 等
//     业务层不消费的协议字段；保留 totalCost / realTotalCost / discount / currency / pid
//     等核心字段）
//
// 错误分类：
//   - 入参缺失 → ErrInvalidInput
//   - bundle 不存在（ctl 或 trade_bundle_definition 任一返 NotFound）→ ErrBundleNotFound
//   - bundle 已下架（ctl bundle_state != ONLINE）→ ErrBundleOffline
//   - jifei CGW 协议错（returnCode != 0）→ wrap *jifeiclient.CGWError 透传
//   - jifei CGW 网络错 / 5xx → wrap raw error 透传
//
// 上层（HTTP RPC handler）负责把这些 logic 错误映射为 HTTP 状态码 / 错误响应体。
package inquiry

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/store"
)

// 业务错误哨兵（上层 errors.Is 判定）。
var (
	// ErrInvalidInput 入参校验失败（bundle_id 空 / time_span 非正 / time_unit 非法等）
	ErrInvalidInput = errors.New("inquiry: invalid input")

	// ErrBundleNotFound bundle 在 ctl 或 trade_bundle_definition 任一不存在
	ErrBundleNotFound = errors.New("inquiry: bundle not found")

	// ErrBundleOffline bundle 在 ctl 已下架（bundle_state != ONLINE）
	ErrBundleOffline = errors.New("inquiry: bundle offline")
)

// QuoteRequest 是单次询价的入参。
//
// 字段语义（与 ctl `DescribeBundles` 在迭代 8B 改造时的对接面对齐）：
//   - ExternalUserID：当前用户 ID（用于 jifei OwnerUin / Uin 字段；Q42 拍板复用 user 即 owner）
//   - Uin / AppID：shadow 已绑定的 jifei 协议层鉴权身份（jifei 询价 OwnerUin / Uin 都用 Uin）
//   - BundleID：要询价的 bundle
//   - TimeSpan / TimeUnit：购买时长（与 jifei goodsDetail.timeSpan / timeUnit 对应）
//   - GoodsNum：购买数量；本期 Lighthouse 始终 = 1（Q41）
//   - PayMode：jifei payMode（0/1/2），本期固定 1（Q42）
//   - RegionID：jifei regionId
type QuoteRequest struct {
	ExternalUserID string
	Uin            string
	AppID          string
	BundleID       string
	TimeSpan       int
	TimeUnit       string
	GoodsNum       int
	PayMode        int
	RegionID       int
}

// QuoteResult 是询价业务层返回的精简字段集（不暴露 jifei 协议字段）。
//
// 字段命名采用业务层语义（discount 对应 policyDetail.total）。
type QuoteResult struct {
	BundleID       string  `json:"bundle_id"`
	BundleName     string  `json:"bundle_name"`
	Price          string  `json:"price"`            // 单价（带小数字符串）
	TotalCost      string  `json:"total_cost"`       // 折扣前总价
	RealTotalCost  string  `json:"real_total_cost"`  // 实付总价（折扣后）
	Currency       string  `json:"currency"`         // 通常 "CNY"
	Discount       float64 `json:"discount"`         // policyDetail.total 拍平
	TimeSpan       int     `json:"time_span"`
	TimeUnit       string  `json:"time_unit"`
	GoodsNum       int     `json:"goods_num"`
	ProductCode    string  `json:"product_code"`
	SubProductCode string  `json:"sub_product_code"`
	Pid            string  `json:"pid"`
}

// Deps 是 Service 的依赖注入。
//
// 全部必填（构造期 New() 校验）；nil 视为编程错。
type Deps struct {
	CTLClient   ctlclient.Client
	BundleStore store.BundleDefinitionStore
	JifeiClient jifeiclient.Client
}

// Service 实现"业务层询价"能力。
type Service struct {
	deps Deps
}

// New 构造 Service；依赖 nil 时 panic（启动期暴露编程错）。
func New(deps Deps) *Service {
	if deps.CTLClient == nil {
		panic("inquiry.New: CTLClient is required")
	}
	if deps.BundleStore == nil {
		panic("inquiry.New: BundleStore is required")
	}
	if deps.JifeiClient == nil {
		panic("inquiry.New: JifeiClient is required")
	}
	return &Service{deps: deps}
}

// Quote 执行单次询价。
//
// 流程：
//  1. 校验入参
//  2. 反查 ctl bundle（确认存在 + 在售）
//  3. 反查 trade_bundle_definition（拿 jifei 协议元数据 + sv_* + category）
//  4. 拼装 jifei GetPriceRequest（goodsDetail 中展平 sv_*、写 productCode / subProductCode /
//     pid / timeSpan / timeUnit / goodsNum）
//  5. 调 jifei CGW GetPrice
//  6. 拍平为 QuoteResult 返回（首条 data 项；本期 GoodsNum=1，data 始终长度 1）
func (s *Service) Quote(ctx context.Context, req QuoteRequest) (*QuoteResult, error) {
	if err := validateQuoteRequest(req); err != nil {
		return nil, err
	}

	// 2. 反查 ctl bundle
	bundle, err := s.deps.CTLClient.GetBundleByID(ctx, req.BundleID)
	if err != nil {
		if errors.Is(err, ctlclient.ErrNotFound) {
			return nil, fmt.Errorf("%w: ctl bundleId=%s", ErrBundleNotFound, req.BundleID)
		}
		return nil, fmt.Errorf("inquiry: ctl GetBundleByID: %w", err)
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
		return nil, fmt.Errorf("inquiry: get bundle definition: %w", err)
	}

	categoryID := def.CategoryIDForScene("purchase")
	if categoryID == "" {
		return nil, fmt.Errorf("inquiry: bundle definition missing category_ids[scene=purchase]: bundleId=%s",
			req.BundleID)
	}

	// 4. 拼装 jifei goodsDetail
	goodsDetail := buildGoodsDetail(def, req)

	// 5. 调 jifei GetPrice
	priceReq := &jifeiclient.GetPriceRequest{
		OwnerUin: req.Uin,
		Uin:      req.Uin,
		ResInfo: []jifeiclient.GetPriceItem{
			{
				GoodsCategoryID: categoryID,
				Currency:        "CNY", // 与下单接口对齐
				RegionID:        req.RegionID,
				GoodsNum:        req.GoodsNum,
				PayMode:         req.PayMode,
				Action:          "purchase",
				GoodsDetail:     goodsDetail,
			},
		},
	}
	priceResp, err := s.deps.JifeiClient.GetPrice(ctx, priceReq)
	if err != nil {
		return nil, fmt.Errorf("inquiry: jifei GetPrice: %w", err)
	}
	if priceResp == nil || len(priceResp.Data) == 0 {
		return nil, fmt.Errorf("inquiry: jifei GetPrice returned empty data")
	}

	// 6. 拍平 QuoteResult（取首条 data）
	d := priceResp.Data[0]
	result := &QuoteResult{
		BundleID:       req.BundleID,
		BundleName:     bundle.BundleName,
		Price:          d.Price,
		TotalCost:      d.TotalCost,
		RealTotalCost:  d.RealTotalCost,
		Currency:       d.Currency,
		TimeSpan:       d.TimeSpan,
		TimeUnit:       d.TimeUnit,
		GoodsNum:       d.GoodsNum,
		ProductCode:    d.ProductCode,
		SubProductCode: d.SubProductCode,
		Pid:            d.Pid,
	}
	if d.PolicyDetail != nil {
		result.Discount = d.PolicyDetail.Total
	}
	// 当 jifei 返回的 productCode / subProductCode / pid 为空时，回填 trade_bundle_definition 值
	// （避免业务层依赖空字段；jifei 默认会回显但有兜底场景）
	if result.ProductCode == "" {
		result.ProductCode = def.ProductCode
	}
	if result.SubProductCode == "" {
		result.SubProductCode = def.SubProductCode
	}
	if result.Pid == "" {
		result.Pid = def.Pid
	}
	if result.TimeSpan == 0 {
		result.TimeSpan = req.TimeSpan
	}
	if result.TimeUnit == "" {
		result.TimeUnit = req.TimeUnit
	}
	if result.GoodsNum == 0 {
		result.GoodsNum = req.GoodsNum
	}
	return result, nil
}

// validateQuoteRequest 校验 QuoteRequest 必填字段。
func validateQuoteRequest(req QuoteRequest) error {
	if strings.TrimSpace(req.BundleID) == "" {
		return fmt.Errorf("%w: bundle_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(req.Uin) == "" {
		return fmt.Errorf("%w: uin is required", ErrInvalidInput)
	}
	if req.TimeSpan <= 0 {
		return fmt.Errorf("%w: time_span must be > 0", ErrInvalidInput)
	}
	if req.TimeUnit == "" {
		return fmt.Errorf("%w: time_unit is required", ErrInvalidInput)
	}
	if req.GoodsNum <= 0 {
		req.GoodsNum = 1
	}
	return nil
}

// buildGoodsDetail 把 BundleDefinition 的元数据 + 用户入参展平成 jifei goodsDetail map。
//
// 字段集（与设计稿 §3.5.5 (4) 对齐）：
//   - productCode / subProductCode / pid（来自 BundleDefinition）
//   - timeSpan / timeUnit / goodsNum（来自 QuoteRequest）
//   - sv_*（来自 BundleDefinition.SVList，展平时加 "sv_" 前缀，值统一字符串化）
//   - productInfo（直接透传）
//
// 不持有 trade 内部隐式字段（如 region_id / app_id），那些是 ResInfo 顶层字段，不在 goodsDetail 内。
func buildGoodsDetail(def *store.BundleDefinition, req QuoteRequest) map[string]interface{} {
	goodsDetail := map[string]interface{}{
		"productCode":    def.ProductCode,
		"subProductCode": def.SubProductCode,
		"pid":            def.Pid,
		"timeSpan":       req.TimeSpan,
		"timeUnit":       req.TimeUnit,
		"goodsNum":       req.GoodsNum,
	}
	// sv_* 展平（运营录入 key 不带 sv_ 前缀，这里加上前缀；值统一字符串化与 checkCreate 对账保持一致）
	for key, value := range def.SVList {
		goodsDetail["sv_"+key] = stringify(value)
	}
	if len(def.ProductInfo) > 0 {
		goodsDetail["productInfo"] = def.ProductInfo
	}
	return goodsDetail
}

// stringify 把任意 interface{} 转成字符串（与 checkCreate handler verifyGoodsDetail
// 的 stringify 行为一致：number / bool / string 都拍成字符串供下游对账）。
func stringify(v interface{}) string {
	if v == nil {
		return ""
	}
	switch val := v.(type) {
	case string:
		return val
	case float64:
		// JSON unmarshal 默认数字走 float64；如果是整数（小数部分为 0）输出整数形态
		if val == float64(int64(val)) {
			return strconv.FormatInt(int64(val), 10)
		}
		return strconv.FormatFloat(val, 'f', -1, 64)
	case int:
		return strconv.Itoa(val)
	case int64:
		return strconv.FormatInt(val, 10)
	case bool:
		if val {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprintf("%v", v)
	}
}
