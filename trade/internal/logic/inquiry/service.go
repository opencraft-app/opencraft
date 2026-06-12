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
	"strings"

	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/jifeiclient"
	"git.woa.com/wisp/mono/trade/internal/region"
	"git.woa.com/wisp/mono/trade/internal/shadowclient"
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

	// ErrBindingNotFound externalUserId 在 shadow 没有绑定记录（用户未实名 / 未绑云账号）
	// 上层应映射为引导用户实名 / 绑定的业务错，不上报 5xx
	ErrBindingNotFound = errors.New("inquiry: binding not found")
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
//   - RegionID：**Q41 修订 2026-05-11 已删除**。trade 内部固定 1（广州），ctl / 前端不再透传。
type QuoteRequest struct {
	ExternalUserID string
	Uin            string
	AppID          string
	BundleID       string
	TimeSpan       int
	TimeUnit       string
	GoodsNum       int
	PayMode        int
	// 注：Q41 修订删除 RegionID 字段
}

// trade 内部固定的 region/zone 常量已收敛到 trade/internal/region 包（11C 抽取 2026-05-12）。
// 历史上本文件、placeorder/service.go、jifei/adapter.go、resourcequery/install.go 各自声明
// 同值常量，11C 起统一引用 region.LighthouseRegionID / region.LighthouseZoneID。

// QuoteResult 是询价业务层返回的精简字段集（不暴露 jifei 协议字段）。
//
// 字段命名采用业务层语义（discount 对应 policyDetail.total）。
type QuoteResult struct {
	BundleID       string  `json:"bundle_id"`
	BundleName     string  `json:"bundle_name"`
	Price          string  `json:"price"`           // 单价（带小数字符串）
	TotalCost      string  `json:"total_cost"`      // 折扣前总价
	RealTotalCost  string  `json:"real_total_cost"` // 实付总价（折扣后）
	Currency       string  `json:"currency"`        // 通常 "CNY"
	Discount       float64 `json:"discount"`        // policyDetail.total 拍平
	TimeSpan       int     `json:"time_span"`
	TimeUnit       string  `json:"time_unit"`
	GoodsNum       int     `json:"goods_num"`
	ProductCode    string  `json:"product_code"`
	SubProductCode string  `json:"sub_product_code"`
	// Pid 是 jifei 协议层 pid。Q71 拍板（2026-05-13）：int 不是 string；DB 列 BIGINT，
	// jifei wire 层 GetPriceData.Pid 也是 int64（PDF §4.4 line 26/34 "pid": 1000000）。
	Pid int64 `json:"pid"`
}

// Deps 是 Service 的依赖注入。
//
// 必填项（构造期 New() 校验）：CTLClient / BundleStore / JifeiClient。
// 可选项：
//   - ShadowClient — 8B-1 后接入；非 nil 时 Quote 自动反查 externalUserId →
//     (uin, app_id) 回填；nil 时退化为"由调用方在 QuoteRequest 显式提供 Uin/AppID"
//     的 8A 行为，保持向后兼容（确保 8A 已有测试不受影响）。
//   - SiteKind — v1.7.x 国际站接入新增；trade 内部站点语义字面量（"cn" / "intl"）。
//     由 main.go 从 cfg.SiteKind 透传；空字符串或非法值由 region.Resolve 兜底为
//     "cn"。本字段决定出向 jifei envelope.resInfo 的 region/zone（A6.1）+
//     currency（A5）；jifeiclient.Options.SiteKind 在 A2/A3 切片独立生效，与本字段
//     在 main.go 同源同值。
//   - RegionOverride — 北京 2 预发布接入 2026-06-12 新增；腾讯云 region 字面量。
//     由 main.go 从 cfg.RegionOverride（LIGHTVELA_TRADE_REGION env）透传；非空且命中
//     region.regionTable 时优先于 SiteKind 兜底。空字符串 → 按 SiteKind 走。
type Deps struct {
	CTLClient    ctlclient.Client
	BundleStore  store.BundleDefinitionStore
	JifeiClient  jifeiclient.Client
	ShadowClient shadowclient.Client // 可选，nil 表示由调用方传 Uin/AppID
	SiteKind     string              // 可选，v1.7.x 国际站接入；"cn" / "intl"，缺省 cn 兜底

	// RegionOverride 是腾讯云 region 字面量 override（北京 2 预发布接入新增）。
	// 合法性已由 config.Load 在启动期 fail-fast 校验；本处只负责透透到 region.Resolve。
	RegionOverride string
}

// Service 实现"业务层询价"能力。
type Service struct {
	deps Deps

	// region / currency 在 New() 期按 deps.SiteKind 解析一次后缓存，避免每次询价
	// 都走 region.Resolve 函数调用（虽然代价极小，但语义上更清晰：站点决策只在
	// 启动期发生一次，运行期不再变化）。
	region   region.LighthouseRegion
	currency string
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
	return &Service{
		deps:     deps,
		region:   region.Resolve(deps.SiteKind, deps.RegionOverride),
		currency: resolveCurrency(deps.SiteKind),
	}
}

// resolveCurrency 按 site 维度返回 jifei envelope.resInfo.currency 协议字面量。
//
// 国内站 = "CNY"，国际站 = "USD"（v1.7.x 国际站接入 A5；用户 2026-06-02 拍板）。
// 与 region.Resolve 的兜底逻辑对齐：siteKind != "intl" 一律视为 cn。
//
// 该 helper 不放 region 包是因为 currency 不属于 region/zone 三元组语义，且只被
// inquiry / placeorder 两处出向装配点引用，作用域窄。adapter 包删除后（v1.7.x
// 重构）原 jifei.adapter.resolveCurrency 的等价逻辑被并入本 helper。
func resolveCurrency(siteKind string) string {
	if siteKind == "intl" {
		return "USD"
	}
	return "CNY"
}

// Quote 执行单次询价。
//
// 流程：
//  1. 校验入参
//     1.5. 如果 ShadowClient 已注入且 Uin 空 → 反查 externalUserId 回填 Uin/AppID
//  2. 反查 ctl bundle（确认存在 + 在售）
//  3. 反查 trade_bundle_definition（拿 jifei 协议元数据 + sv_* + category）
//  4. 拼装 jifei GetPriceRequest（goodsDetail 中透传 sv_*、写 productCode / subProductCode /
//     pid / timeSpan / timeUnit / goodsNum）
//  5. 调 jifei CGW GetPrice
//  6. 拍平为 QuoteResult 返回（首条 data 项；本期 GoodsNum=1，data 始终长度 1）
func (s *Service) Quote(ctx context.Context, req QuoteRequest) (*QuoteResult, error) {
	if err := s.validateQuoteRequest(&req); err != nil {
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
			return nil, fmt.Errorf("inquiry: shadow GetBindingByExternalUserID: %w", err)
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

	// Q71 2026-05-13：CategoryIDForScene 返回 int64，未命中场景返 0
	//   （jifei 协议层 goodsCategoryId 是 int，PDF §4.1 line 14 "goodsCategoryId Integer"）。
	categoryID := def.CategoryIDForScene("purchase")
	if categoryID == 0 {
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
				// v1.7.x 国际站接入 A5：currency 按 deps.SiteKind 决定（cn=CNY / intl=USD）
				Currency: s.currency,
				// Q41 修订 2026-05-11 + v1.7.x A6.1：region/zone 在 New() 期按 site 解析一次缓存
				// （cn=1/100001 广州 / intl=9/900001 新加坡，合规要求国际站资源落海外地域）
				RegionID:    s.region.RegionID,
				ZoneID:      s.region.ZoneID,
				GoodsNum:    req.GoodsNum,
				PayMode:     req.PayMode,
				Action:      "purchase",
				GoodsDetail: goodsDetail,
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
		Price:          string(d.Price),
		TotalCost:      string(d.TotalCost),
		RealTotalCost:  string(d.RealTotalCost),
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
	if result.Pid == 0 {
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

// QuoteRenewRequest 是单次"续费询价"的入参。
//
// 与 QuoteRequest 的关键差异（设计稿 .tmp/trade-pass-renew-design.md §3.5 / §4.3）：
//   - ResourceID（pass_id）必填：续费针对已有 pass，与新购无关
//   - jifei action 固定 "renew"（与 GetPriceItem.Action="renew" 对齐）
//   - jifei goodsCategoryId 取 BundleDefinition.CategoryIDForScene("renew")
//
// 字段语义其余与 QuoteRequest 对齐；本期 PayMode 同样固定 1，GoodsNum 同样固定 1。
type QuoteRenewRequest struct {
	ExternalUserID string
	Uin            string
	AppID          string
	BundleID       string
	ResourceID     string // 续费目标 pass_id（必填）
	// CurDeadline 是 jifei goodsDetail.curDeadline 字段（PDF §4.3 续费必填）。
	//
	// 真源在 ctl pass.expired_time 列；调用方（ctl 续费询价 logic）从 DB 读出后按
	// "2006-01-02 15:04:05" 格式拼字符串透传给 trade，trade 不做反查、不计算、不解析、
	// 不校验业务语义，仅做透传 + 必填非空校验，jifei 拼装时直接放入 goodsDetail map。
	//
	// 与续费下单 PlaceRenewOrderRequest.CurDeadline 同源同格式（v1.7.21 B16 落地）。
	CurDeadline string
	TimeSpan    int
	TimeUnit    string
	GoodsNum    int
	PayMode     int
}

// QuoteRenew 执行单次续费询价。
//
// 流程（与 Quote 对偶；设计稿 §3.5）：
//  1. 校验入参（含 ResourceID 必填）
//     1.5. 如果 ShadowClient 已注入且 Uin 空 → 反查 externalUserId 回填 Uin/AppID
//  2. 反查 ctl bundle（确认存在 + 在售 — 续费同样需要 bundle 仍在售；下架的 bundle 不可续费）
//  3. 反查 trade_bundle_definition（拿 jifei 协议元数据 + sv_* + category[scene=renew]）
//  4. 拼装 jifei GetPriceRequest（goodsDetail 透传 sv_*；Action="renew"；resourceId 注入到
//     ResInfo[0].GoodsDetail["resourceId"]，与 createResource/renewResource 协议字段一致）
//  5. 调 jifei CGW GetPrice
//  6. 拍平为 QuoteResult 返回
//
// 错误分类与 Quote 一致；ErrInvalidInput 增加 ResourceID 必填校验。
func (s *Service) QuoteRenew(ctx context.Context, req QuoteRenewRequest) (*QuoteResult, error) {
	if err := s.validateQuoteRenewRequest(&req); err != nil {
		return nil, err
	}

	// 1.5 shadow 反查（与 Quote 对齐）
	if strings.TrimSpace(req.Uin) == "" && s.deps.ShadowClient != nil {
		if strings.TrimSpace(req.ExternalUserID) == "" {
			return nil, fmt.Errorf("%w: external_user_id is required when uin is missing", ErrInvalidInput)
		}
		binding, err := s.deps.ShadowClient.GetBindingByExternalUserID(ctx, req.ExternalUserID)
		if err != nil {
			if errors.Is(err, shadowclient.ErrBindingNotFound) {
				return nil, fmt.Errorf("%w: externalUserId=%s", ErrBindingNotFound, req.ExternalUserID)
			}
			return nil, fmt.Errorf("inquiry: shadow GetBindingByExternalUserID: %w", err)
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

	// scene="renew" 取 categoryId（与 Q71 对齐：未命中返 0）
	categoryID := def.CategoryIDForScene("renew")
	if categoryID == 0 {
		return nil, fmt.Errorf("inquiry: bundle definition missing category_ids[scene=renew]: bundleId=%s",
			req.BundleID)
	}

	// 4. 拼装 jifei goodsDetail（基于 buildGoodsDetail，附加 resourceId）
	goodsDetail := buildGoodsDetail(def, QuoteRequest{
		TimeSpan: req.TimeSpan,
		TimeUnit: req.TimeUnit,
		GoodsNum: req.GoodsNum,
	})
	goodsDetail["resourceId"] = req.ResourceID
	// v1.7.21 B16: 续费询价同样注入 curDeadline (PDF §4.3 续费必填; 与 PlaceRenewOrder 共享同一字段集)
	goodsDetail["curDeadline"] = req.CurDeadline

	// 5. 调 jifei GetPrice（Action="renew"）
	priceReq := &jifeiclient.GetPriceRequest{
		OwnerUin: req.Uin,
		Uin:      req.Uin,
		ResInfo: []jifeiclient.GetPriceItem{
			{
				GoodsCategoryID: categoryID,
				// v1.7.x A5 + A6.1：currency / region 同 Quote 装配点，按 deps.SiteKind 决定
				Currency:    s.currency,
				RegionID:    s.region.RegionID,
				ZoneID:      s.region.ZoneID,
				GoodsNum:    req.GoodsNum,
				PayMode:     req.PayMode,
				Action:      "renew",
				GoodsDetail: goodsDetail,
			},
		},
	}
	priceResp, err := s.deps.JifeiClient.GetPrice(ctx, priceReq)
	if err != nil {
		return nil, fmt.Errorf("inquiry: jifei GetPrice (renew): %w", err)
	}
	if priceResp == nil || len(priceResp.Data) == 0 {
		return nil, fmt.Errorf("inquiry: jifei GetPrice (renew) returned empty data")
	}

	// 6. 拍平 QuoteResult
	d := priceResp.Data[0]
	result := &QuoteResult{
		BundleID:       req.BundleID,
		BundleName:     bundle.BundleName,
		Price:          string(d.Price),
		TotalCost:      string(d.TotalCost),
		RealTotalCost:  string(d.RealTotalCost),
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
	if result.ProductCode == "" {
		result.ProductCode = def.ProductCode
	}
	if result.SubProductCode == "" {
		result.SubProductCode = def.SubProductCode
	}
	if result.Pid == 0 {
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

// validateQuoteRenewRequest 校验 QuoteRenewRequest 必填字段。
//
// 与 validateQuoteRequest 对偶，附加 ResourceID 必填校验。
func (s *Service) validateQuoteRenewRequest(req *QuoteRenewRequest) error {
	if strings.TrimSpace(req.BundleID) == "" {
		return fmt.Errorf("%w: bundle_id is required", ErrInvalidInput)
	}
	if strings.TrimSpace(req.ResourceID) == "" {
		return fmt.Errorf("%w: resource_id is required for renew", ErrInvalidInput)
	}
	// v1.7.21 B16: jifei goodsDetail.curDeadline 必填 (PDF §4.3); 由 ctl 调用方从
	// pass.expired_time 拼字符串透传, trade 仅做必填校验, 不做格式 parseTime —
	// 调用方按规范拼错时由 jifei 返 100001 兜底 (调用方编程错, 非用户错, 归 ErrInvalidInput 400).
	if strings.TrimSpace(req.CurDeadline) == "" {
		return fmt.Errorf("%w: cur_deadline is required for renew", ErrInvalidInput)
	}
	if s.deps.ShadowClient == nil {
		if strings.TrimSpace(req.Uin) == "" {
			return fmt.Errorf("%w: uin is required", ErrInvalidInput)
		}
	} else {
		if strings.TrimSpace(req.Uin) == "" && strings.TrimSpace(req.ExternalUserID) == "" {
			return fmt.Errorf("%w: external_user_id or uin is required", ErrInvalidInput)
		}
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

// validateQuoteRequest 校验 QuoteRequest 必填字段。
//
// Uin 校验策略（8B-1）：
//   - ShadowClient 已注入：Uin 允许为空（后续从 shadow 反查回填）；但 ExternalUserID 必填
//   - ShadowClient 未注入（8A 行为）：Uin 必填，与原行为完全一致
//
// 接收指针是为了兼容 GoodsNum 默认值兜底（GoodsNum<=0 时改写为 1）。
func (s *Service) validateQuoteRequest(req *QuoteRequest) error {
	if strings.TrimSpace(req.BundleID) == "" {
		return fmt.Errorf("%w: bundle_id is required", ErrInvalidInput)
	}
	if s.deps.ShadowClient == nil {
		// 8A 行为：Uin 必填
		if strings.TrimSpace(req.Uin) == "" {
			return fmt.Errorf("%w: uin is required", ErrInvalidInput)
		}
	} else {
		// 8B-1 行为：Uin 允许从 shadow 反查；但至少要有一个身份锚点
		if strings.TrimSpace(req.Uin) == "" && strings.TrimSpace(req.ExternalUserID) == "" {
			return fmt.Errorf("%w: external_user_id or uin is required", ErrInvalidInput)
		}
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
//   - productCode / subProductCode / pid（来自 BundleDefinition；pid 是 int64，Q71 拍板 2026-05-13）
//   - timeSpan / timeUnit / goodsNum（来自 QuoteRequest）
//   - sv_*（来自 BundleDefinition.SVList，key **直接透传**为 goodsDetail key；值是 int64，
//     直接透传为 number 进入 jifei wire — Q71 推翻 Q66：sv_* 协议层是 int，
//     PDF §4.4 line 30/38 "sv_cvm_cpu_s1": 1 / §4.4.1.1.2 line 23 "sv_cbs_memspace_premium": 60）
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
	// sv_* 展平：2026-05-13 起契约变更（Q70）运营录入 key **必须**已带 sv_ 前缀；
	// Q71 进一步推翻 Q66 把值改回 int64 直接透传（不再 stringify），与 jifei 协议层一致。
	for key, value := range def.SVList {
		goodsDetail[key] = value
	}
	if len(def.ProductInfo) > 0 {
		goodsDetail["productInfo"] = def.ProductInfo
	}
	return goodsDetail
}
