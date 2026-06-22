package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/errcode"
	bundlelogic "ctl/pkg/logic/bundle"
	"ctl/pkg/model/instancespec"
	"ctl/pkg/resource"
	"ctl/pkg/transport"

	"go.uber.org/zap"
)

// bundleHandler 套餐管理 handler
type bundleHandler struct {
	logic bundlelogic.Logic

	// trade 服务适配器，用于 describeBundles 调 trade 询价回填 user-facing
	// UserBundleResponse.Price（迭代 8C / 设计稿 §10 Q-CGW-01）。
	//
	// 允许为 nil（启动期未注入或 trade 配置缺失），此时 Price 字段统一返回 nil，
	// 不阻断 bundle 列表展示，与 8C 落地前的兼容行为保持一致。
	tradeAdapter tradeadapter.Adapter
}

// 询价透传给 trade 的 jifei 业务常量（v1.7.28 BUG-03 修复）：
//
// 与 ctl/pkg/logic/pass/logic.go 中 lighthousePassPayMode / lighthousePassGoodsNum
// 同源；都是 Q41 / Q42 拍板的 Lighthouse Pass 业务常量（pid 1059119 + sv 1059121
// 在 jifei 沙箱仅配置了 payMode=1 预付费月价）。本期 ctl 询价 / 下单两条链路必须
// 显式传这两个值，不依赖 trade 兜底（trade.inquiry.Service.Quote 当前透传不兜底，
// 见 BUG-03 root cause 五层定位）。
//
// 后续如需把这两个常量提升到 ctl 全局共享层，可考虑导出到 ctl/pkg/logic/pass
// 包或新建 ctl/pkg/billing/constants 包；本期最小变更范围保持本地声明。
const (
	bundlesQuotePayMode  = 1 // jifei payMode：1=预付费（与 pass.lighthousePassPayMode 同源）
	bundlesQuoteGoodsNum = 1 // jifei goodsNum：本期固定单件（与 pass.lighthousePassGoodsNum 同源）
)

// freeTrialBundleIDPrefix 免费试用 bundle 的 bundle_id 命名约定前缀。
//
// 设计语义：免费试用 bundle 走 ctl.CreateTrialPass 链路（不下单、不支付、不计费），
// 因此在 trade.trade_bundle_definition 表中**不录入**对应记录，trade 询价时会返回
// 404 BundleNotFound。describeBundles 询价回填时必须把这类 bundle 提前过滤掉，
// 避免它们污染批量 InquiryBatch 请求或触发整批降级。
//
// 该前缀约定与运营 seed SQL (.tmp/sp_lighthouse_lightvela_ai_mc/seed_*.sql) 以及
// ctl.bundle 表的真实 bundle_id 命名保持一致（如 bundle_free_trial_01）。
const freeTrialBundleIDPrefix = "bundle_free_trial"

// isFreeTrialBundleID 判断 bundle_id 是否属于免费试用类。免费试用 bundle 不参与 trade 询价。
func isFreeTrialBundleID(bundleID string) bool {
	return strings.HasPrefix(bundleID, freeTrialBundleIDPrefix)
}

// handleAdminBundles 处理后台管理接口 /admin/api/ctl/bundles
func (h *bundleHandler) handleAdminBundles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.importBundle(w, r)
	case http.MethodGet:
		h.getBundles(w, r)
	case http.MethodPut:
		h.modifyBundles(w, r)
	default:
		w.Header().Set("Allow", strings.Join([]string{http.MethodPost, http.MethodGet, http.MethodPut}, ", "))
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
	}
}

// handleUserBundles 处理用户可见接口 /v1/bundles
func (h *bundleHandler) handleUserBundles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	h.describeBundles(w, r)
}

// handleInternalBundleByID 处理内部 RPC 接口 GET /internal/ctl/bundles/{bundleId}
// 供 trade 服务在 checkCreate 阶段做 state / sales_state 自校验用（Q33 拍板）。
// 返回精简的 InternalBundleDetail 子集（不含 ai_gateway_plans / ai_gateway_plan_id /
// sub_product_code / time_span / time_unit），严格按 trade 当前用途精简。
func (h *bundleHandler) handleInternalBundleByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	const prefix = "/internal/ctl/bundles/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		writeHTTPError(w, r, errcode.ErrBundleNotFound)
		return
	}
	bundleID := strings.TrimPrefix(r.URL.Path, prefix)
	// 只接受 /internal/ctl/bundles/{bundleId} 这种单段路径，禁止 sub-resource
	if bundleID == "" || strings.Contains(bundleID, "/") {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "invalid bundle path"))
		return
	}

	detail, err := h.logic.GetBundleByID(bundleID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	writeSuccess(w, r, http.StatusOK, detailToInternalResponse(detail))
}

// importBundle POST /admin/api/ctl/bundles
func (h *bundleHandler) importBundle(w http.ResponseWriter, r *http.Request) {
	var req transport.ImportBundleRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	// 将 description 数组序列化为 JSON 字符串存储
	descJSON, err := json.Marshal(req.Description)
	if err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrBundleConfigInvalid, "invalid description"))
		return
	}

	detail, err := h.logic.ImportBundle(
		req.BundleID,
		req.BundleName,
		req.BundleType,
		string(descJSON),
		req.AgentQuota,
		req.Credit,
		req.TimeSpan,
		req.TimeUnit,
		req.AiGatewayPlanID,
		req.InstanceSpecID,
		req.StaticSoldOut,
		req.BundleSalesAvailCount,
		req.BundleSalesTotalCount,
	)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	writeSuccess(w, r, http.StatusOK, detailToAdminResponse(detail))
}

// getBundles GET /admin/api/ctl/bundles
func (h *bundleHandler) getBundles(w http.ResponseWriter, r *http.Request) {
	details, err := h.logic.GetBundles()
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	bundles := make([]*transport.BundleResponse, 0, len(details))
	for _, d := range details {
		bundles = append(bundles, detailToAdminResponse(d))
	}
	writeSuccess(w, r, http.StatusOK, &transport.ListBundlesResponse{Bundles: bundles})
}

// modifyBundles PUT /admin/api/ctl/bundles
func (h *bundleHandler) modifyBundles(w http.ResponseWriter, r *http.Request) {
	var req transport.ModifyBundlesRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	fields := &bundlelogic.ModifyBundleFields{
		BundleName:            req.BundleName,
		BundleType:            req.BundleType,
		Description:           req.Description,
		BundleState:           req.BundleState,
		AgentQuota:            req.AgentQuota,
		Credit:                req.Credit,
		TimeSpan:              req.TimeSpan,
		TimeUnit:              req.TimeUnit,
		AiGatewayPlanID:       req.AiGatewayPlanID,
		InstanceSpecID:        req.InstanceSpecID,
		StaticSoldOut:         req.StaticSoldOut,
		BundleSalesAvailCount: req.BundleSalesAvailCount,
		BundleSalesTotalCount: req.BundleSalesTotalCount,
	}

	affected, err := h.logic.ModifyBundles(req.BundleIDs, fields)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	writeSuccess(w, r, http.StatusOK, &transport.ModifyBundlesResponse{AffectedCount: affected})
}

// describeBundles GET /v1/bundles
//
// 响应组装顺序（迭代 8C / 设计稿 §10 Q-CGW-01 / Q24 / Q31）：
//  1. 从 ctl 本地 logic.DescribeBundles 拿用户可见 bundle 列表（不带价格）。
//  2. 解析 query 参数 time_span / time_unit；缺省 (1, "m")（Q24 拍板，
//     bundle 不再持有 time_span，询价 period/timeUnit 来自 HTTP 入参）。
//  3. 当 tradeAdapter 已注入且当前调用方携带 X-User-Id（已登录）时，
//     调 trade `/internal/trade/inquiry/batch` 批量询价，将 quote 回填到 Price 字段；
//     未登录公开页（无 X-User-Id，Q31 选项 b）或 trade 调用失败时，全部 bundle Price=nil，
//     前端按"暂无报价"分支展示，不阻断 bundle 列表（Q-CGW-01 降级语义）。
func (h *bundleHandler) describeBundles(w http.ResponseWriter, r *http.Request) {
	details, err := h.logic.DescribeBundles()
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	timeSpan, timeUnit := parseTimeSpanUnit(r)
	quoteMap := h.fetchBundleQuotes(r, details, timeSpan, timeUnit)

	bundles := make([]*transport.UserBundleResponse, 0, len(details))
	for _, d := range details {
		bundles = append(bundles, detailToUserResponse(d, quoteMap[d.BundleID]))
	}
	writeSuccess(w, r, http.StatusOK, &transport.DescribeBundlesResponse{Bundles: bundles})
}

// parseTimeSpanUnit 解析 GET /v1/bundles 的 query 参数 time_span / time_unit，
// 缺省 (1, "m")（Q24 拍板）。time_span 非法或 <=0 时回退到 1。
// time_unit 不做白名单校验（透传给 trade 由 trade 侧决定，trade 当前接受 "m" / "y"）。
func parseTimeSpanUnit(r *http.Request) (int, string) {
	const (
		defaultTimeSpan = 1
		defaultTimeUnit = "m"
	)
	timeSpan := defaultTimeSpan
	if raw := strings.TrimSpace(r.URL.Query().Get("time_span")); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			timeSpan = v
		}
	}
	timeUnit := defaultTimeUnit
	if raw := strings.TrimSpace(r.URL.Query().Get("time_unit")); raw != "" {
		timeUnit = raw
	}
	return timeSpan, timeUnit
}

// fetchBundleQuotes 调 trade `InquiryBatch` 拿到 bundleId → quote 的映射，
// 提供"单 bundle 询价失败仅该 bundle 降级为 nil、不影响其它 bundle 价格展示"的细粒度容错。
//
// 前置过滤：免费试用 bundle（bundle_id 以 freeTrialBundleIDPrefix 开头）走 CreateTrialPass
// 链路，trade.trade_bundle_definition 不录入，必须从询价集合中剔除；否则 trade 会返
// 404 BundleNotFound（迭代 8C+ 询价回退兼容期实测样态）。
//
// 询价容错策略（fast path / slow path 双层）：
//
//	fast path：一次性 InquiryBatch(quotableIDs)。
//	  - 成功 → 直接返回 quoteMap，仅 1 次 RPC，性能最优；
//	  - 失败且错误是 *tradeadapter.Error 且 Status 在 4xx 业务错范围（404/409/422）→
//	    认为是"某一条 bundle 业务错"导致整批 fail-fast（trade inquiryBatchHandler 当前
//	    实现 = 串行 N 次 Quote，遇错立刻 return；见 trade/internal/httpapi/internalapi
//	    /handler.go L221 注释），进入 slow path 拆 1-by-1 隔离单条故障；
//	  - 失败且错误是 5xx / 超时 / 非 *Error 基础设施错 → 整批降级返 nil（避免拆 1-by-1
//	    引发 N 次串行超时雪崩，Q-CGW-01 降级语义）。
//
//	slow path：对 quotableIDs 逐个调 InquiryBatch([id])。
//	  - 单条成功 → 累计到 quoteMap；
//	  - 单条失败 → 记录 warn 日志，跳过该 bundle（其 Price 字段保持 nil，前端"暂无报价"），
//	    继续询下一个 bundle，不影响其它 bundle 价格展示。
//
// 其它降级前置条件（与历史行为保持一致）：
//   - h.tradeAdapter 未注入（启动期未配置 trade）；
//   - r.Header.Get("X-User-Id") 为空（未登录公开页，Q31 选项 b）；
//   - details 为空或 quotableIDs 过滤后为空（不必发起 RPC）。
func (h *bundleHandler) fetchBundleQuotes(
	r *http.Request,
	details []*bundlelogic.BundleDetail,
	timeSpan int,
	timeUnit string,
) map[string]*tradeadapter.BundleQuote {
	if h.tradeAdapter == nil || len(details) == 0 {
		return nil
	}
	userID := strings.TrimSpace(r.Header.Get("X-User-Id"))
	if userID == "" {
		// 未登录公开页：Q31 选项 b，不调 trade 询价，直接走"无价 bundle 列表"分支。
		return nil
	}

	// 过滤：剔除空 bundleID + 免费试用 bundle（不参与 trade 询价）。
	quotableIDs := make([]string, 0, len(details))
	for _, d := range details {
		if d == nil || d.BundleID == "" {
			continue
		}
		if isFreeTrialBundleID(d.BundleID) {
			continue
		}
		quotableIDs = append(quotableIDs, d.BundleID)
	}
	if len(quotableIDs) == 0 {
		return nil
	}

	// 给 trade RPC 5s 超时上限，避免拖慢 bundle 列表响应。fast path 与 slow path 共用同一
	// ctx：slow path N 次串行调用累计也不会超过这个上限，保证整体响应时间可控。
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	// ===== fast path：一次性批量询价 =====
	resp, err := h.tradeAdapter.InquiryBatch(ctx, buildInquiryBatchRequest(userID, quotableIDs, timeSpan, timeUnit))
	if err == nil {
		return collectBundleQuotes(resp)
	}

	// fast path 失败 — 分类决定是否进 slow path 拆 1-by-1。
	if !isPerBundleBusinessError(err) {
		// 基础设施错 / 5xx / 超时：整批降级。
		if resource.ZapLogger != nil {
			resource.ZapLogger.Warn("trade InquiryBatch batch failed, fallback to no-price bundle list",
				zap.Int("bundle_count", len(quotableIDs)),
				zap.Error(err),
			)
		}
		return nil
	}

	// ===== slow path：拆 1-by-1，单条失败仅降级该条 =====
	if resource.ZapLogger != nil {
		resource.ZapLogger.Warn("trade InquiryBatch batch failed with per-bundle business error, retry per-bundle",
			zap.Int("bundle_count", len(quotableIDs)),
			zap.Error(err),
		)
	}
	return h.fetchBundleQuotesPerBundle(ctx, userID, quotableIDs, timeSpan, timeUnit)
}

// fetchBundleQuotesPerBundle 串行对 bundleIDs 逐个调 InquiryBatch([id])，单条失败仅
// 跳过该条记录 warn 日志，其它继续；用于 fast path 出现"某一条 bundle 业务错"导致整批
// fail-fast 时的细粒度回退（A 方案：仅失败 bundle 降级，不影响其它 bundle 价格）。
func (h *bundleHandler) fetchBundleQuotesPerBundle(
	ctx context.Context,
	userID string,
	bundleIDs []string,
	timeSpan int,
	timeUnit string,
) map[string]*tradeadapter.BundleQuote {
	out := make(map[string]*tradeadapter.BundleQuote, len(bundleIDs))
	for _, bid := range bundleIDs {
		if ctx.Err() != nil {
			// ctx 已超时 / 取消：剩余 bundle 全部降级，与历史"整批 nil"行为对齐。
			if resource.ZapLogger != nil {
				resource.ZapLogger.Warn("trade InquiryBatch per-bundle aborted by ctx",
					zap.Int("remaining", len(bundleIDs)-len(out)),
					zap.Error(ctx.Err()),
				)
			}
			break
		}
		resp, err := h.tradeAdapter.InquiryBatch(ctx, buildInquiryBatchRequest(userID, []string{bid}, timeSpan, timeUnit))
		if err != nil {
			if resource.ZapLogger != nil {
				resource.ZapLogger.Warn("trade InquiryBatch per-bundle failed, degrade single bundle to no-price",
					zap.String("bundle_id", bid),
					zap.Error(err),
				)
			}
			continue
		}
		for _, q := range collectBundleQuotes(resp) {
			out[q.BundleID] = q
		}
	}
	return out
}

// buildInquiryBatchRequest 构造一次 trade InquiryBatch 请求；fast path 与 slow path 共用，
// 保证两条路径透传给 trade 的 PayMode / GoodsNum / TimeUnit / Period 等业务参数一致。
func buildInquiryBatchRequest(
	userID string,
	bundleIDs []string,
	timeSpan int,
	timeUnit string,
) *tradeadapter.InquiryBatchRequest {
	return &tradeadapter.InquiryBatchRequest{
		ExternalUserID: userID,
		BundleIDs:      bundleIDs,
		Period:         timeSpan,
		TimeUnit:       timeUnit,
		// GoodsNum / PayMode 显式传 Q41/Q42 业务常量（v1.7.28 BUG-03 修复 — 历史注释
		// 说"由 trade 侧兜底"但 trade.inquiry.Service.Quote L213 实际透传不兜底，
		// 不传则 jifei 收到 payMode=0 后付费导致 sv 1059121 no price found 371009）。
		// RegionID 仍由 trade 内部固定（Q41 修订 2026-05-11）。
		PayMode:  bundlesQuotePayMode,
		GoodsNum: bundlesQuoteGoodsNum,
	}
}

// collectBundleQuotes 把 trade InquiryBatch 响应中的 Prices[] 按 bundleId 收敛成 map。
func collectBundleQuotes(resp *tradeadapter.InquiryBatchResult) map[string]*tradeadapter.BundleQuote {
	if resp == nil || len(resp.Prices) == 0 {
		return nil
	}
	out := make(map[string]*tradeadapter.BundleQuote, len(resp.Prices))
	for _, q := range resp.Prices {
		if q == nil || q.BundleID == "" {
			continue
		}
		out[q.BundleID] = q
	}
	return out
}

// isPerBundleBusinessError 判断 trade InquiryBatch 错误是否属于"某一条 bundle 业务错"
// 导致的整批 fail-fast——这类错误适合 slow path 拆 1-by-1 隔离故障 bundle。
//
// 命中条件：err 可 unwrap 成 *tradeadapter.Error 且 Status 为 4xx 业务错码（404/409/422）。
// 这三个状态码来自 trade classifyInquiryError（handler.go::classifyInquiryError）：
//   - 404 BundleNotFound（trade.trade_bundle_definition 未录入对应 bundle）
//   - 409 BundleOffline（bundle 已下架）
//   - 422 BindingNotFound（externalUserId 在 shadow 没绑定记录）
//
// 5xx / 超时 / 网络错 / 非 *Error 走"整批降级"分支（避免拆 1-by-1 引发 N 次串行雪崩）。
func isPerBundleBusinessError(err error) bool {
	var te *tradeadapter.Error
	if !errors.As(err, &te) {
		return false
	}
	switch te.Status {
	case http.StatusNotFound, http.StatusConflict, http.StatusUnprocessableEntity:
		return true
	default:
		return false
	}
}

// detailToAdminResponse 将 BundleDetail 转换为管理端响应。
//
// admin DTO 暴露完整规格信息（设计稿 Q5=b）：
//   - instance_spec_id（运营内部 ID）
//   - instance_spec_display（运营展示名，如 "4案8G 80G系统盘"）
//   - cpu / memory / system_disk_size（3 个量化字段）
func detailToAdminResponse(d *bundlelogic.BundleDetail) *transport.BundleResponse {
	staticSoldOut := d.StaticSoldOut
	resp := &transport.BundleResponse{
		BundleID:              d.BundleID,
		BundleName:            d.BundleName,
		BundleType:            d.BundleType,
		Description:           parseJSONDescription(d.Description),
		BundleState:           d.BundleState,
		AgentQuota:            d.AgentQuota,
		Credit:                d.Credit,
		TimeSpan:              d.TimeSpan,
		TimeUnit:              d.TimeUnit,
		AiGatewayPlanID:       d.AiGatewayPlanID,
		InstanceSpecID:        d.InstanceSpecID,
		StaticSoldOut:         &staticSoldOut,
		BundleSalesAvailCount: d.BundleSalesAvailCount,
		BundleSalesTotalCount: d.BundleSalesTotalCount,
		BundleSalesState:      d.BundleSalesState,
		CreatedTime:           d.CreatedTime,
		UpdatedTime:           d.UpdatedTime,
	}
	if spec, ok := instancespec.ResolveByID(d.InstanceSpecID); ok {
		resp.InstanceSpecDisplay = spec.DisplayName
		resp.CPU = spec.CPU
		resp.Memory = spec.Memory
		resp.SystemDiskSize = spec.SystemDiskSize
	}
	return resp
}

// detailToUserResponse 将 BundleDetail 转换为用户端响应（仅暴露用户可见字段）。
// quote 来自 trade `/internal/trade/inquiry/batch` 询价回填（迭代 8C），可为 nil；
// nil 时 Price 字段保持 nil，前端按"暂无报价"分支展示（Q-CGW-01 降级语义）。
//
// 设计稿 Q-FRONT-1=b：user-facing 结构化暴露 cpu / memory / system_disk_size 3 个量化字段。
func detailToUserResponse(d *bundlelogic.BundleDetail, quote *tradeadapter.BundleQuote) *transport.UserBundleResponse {
	resp := &transport.UserBundleResponse{
		BundleID:         d.BundleID,
		BundleName:       d.BundleName,
		BundleType:       d.BundleType,
		Description:      parseJSONDescription(d.Description),
		BundleState:      d.BundleState,
		AgentQuota:       d.AgentQuota,
		Credit:           d.Credit,
		BundleSalesState: d.BundleSalesState,
		Price:            nil,
	}
	if spec, ok := instancespec.ResolveByID(d.InstanceSpecID); ok {
		resp.CPU = spec.CPU
		resp.Memory = spec.Memory
		resp.SystemDiskSize = spec.SystemDiskSize
	}
	if quote != nil {
		resp.Price = bundleQuoteToPrice(quote)
	}
	return resp
}

// bundleQuoteToPrice 把 trade adapter 的 BundleQuote（字符串价格 + 折扣率）
// 转成 ctl user-facing 的 BundlePrice（float64）。字符串解析失败时降级为 0，
// 单字段失败不影响其它字段（避免整条 quote 因为某个 CGW 极少数返 NaN 而整条丢弃）。
func bundleQuoteToPrice(q *tradeadapter.BundleQuote) *transport.BundlePrice {
	parse := func(s string) float64 {
		if s == "" {
			return 0
		}
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0
		}
		return v
	}
	return &transport.BundlePrice{
		Price:         parse(q.Price),
		TotalCost:     parse(q.TotalCost),
		RealTotalCost: parse(q.RealTotalCost),
		Currency:      q.Currency,
		Discount:      q.Discount,
	}
}

// detailToInternalResponse 将 BundleDetail 转换为内部 RPC 响应（trade.checkCreate 用）。
// 严格剥离 ai_gateway_plans / ai_gateway_plan_id / sub_product_code / time_span / time_unit
// （Q33 / Q25 / Q37 拍板，2026-05-08 v3 校正）。
//
// 例外（bundle-instance-spec-design.md v9 / Q-FRONT-1 补充拍板）：
//   - 补上 cpu / memory / system_disk_size 三字段（user-facing / internal-facing / admin
//     三处出参一律暴露）；仍不含 instance_spec_id。
func detailToInternalResponse(d *bundlelogic.BundleDetail) *transport.InternalBundleDetail {
	resp := &transport.InternalBundleDetail{
		BundleID:              d.BundleID,
		BundleName:            d.BundleName,
		BundleType:            d.BundleType,
		BundleState:           d.BundleState,
		AgentQuota:            d.AgentQuota,
		Credit:                d.Credit,
		BundleSalesAvailCount: d.BundleSalesAvailCount,
		BundleSalesTotalCount: d.BundleSalesTotalCount,
		BundleSalesState:      d.BundleSalesState,
	}
	if spec, ok := instancespec.ResolveByID(d.InstanceSpecID); ok {
		resp.CPU = spec.CPU
		resp.Memory = spec.Memory
		resp.SystemDiskSize = spec.SystemDiskSize
	}
	return resp
}

// parseJSONDescription 尝试将 description JSON 字符串解析为结构化数据
func parseJSONDescription(desc string) interface{} {
	if desc == "" {
		return []interface{}{}
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(desc), &parsed); err != nil {
		return desc // 解析失败则返回原始字符串
	}
	return parsed
}

// handleAdminInstanceSpecs 处理 GET /admin/api/ctl/instance-specs（设计稿 §10 Q8=a）。
//
// 只读返回 ctl 本地 instancespec.KnownSpecs 字典中的全部规格（spec_id + display_name +
// cpu + memory + system_disk_size），供运营 bundle 编辑页 spec 下拉框使用。无 CRUD —
// 新增 / 下线规格走代码常量字典发版（Q1=a 拍板）。
func (h *bundleHandler) handleAdminInstanceSpecs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	specs := instancespec.ListAll()
	resp := &transport.ListInstanceSpecsResponse{
		Specs: make([]*transport.InstanceSpecResponse, 0, len(specs)),
	}
	for _, s := range specs {
		resp.Specs = append(resp.Specs, &transport.InstanceSpecResponse{
			SpecID:         s.SpecID,
			DisplayName:    s.DisplayName,
			CPU:            s.CPU,
			Memory:         s.Memory,
			SystemDiskSize: s.SystemDiskSize,
		})
	}
	writeSuccess(w, r, http.StatusOK, resp)
}
