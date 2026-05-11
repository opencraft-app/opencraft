package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	tradeadapter "ctl/pkg/adapter/trade"
	"ctl/pkg/errcode"
	bundlelogic "ctl/pkg/logic/bundle"
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
		string(descJSON),
		req.AgentQuota,
		req.Credit,
		req.TimeSpan,
		req.TimeUnit,
		req.AiGatewayPlanID,
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
		Description:           req.Description,
		BundleState:           req.BundleState,
		AgentQuota:            req.AgentQuota,
		Credit:                req.Credit,
		TimeSpan:              req.TimeSpan,
		TimeUnit:              req.TimeUnit,
		AiGatewayPlanID:       req.AiGatewayPlanID,
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

// fetchBundleQuotes 串行调 trade `InquiryBatch` 拿到 bundleId → quote 的映射。
// 任一前置条件不满足或 trade 调用失败，均降级返回空 map（Price 全部 nil，
// 前端按"暂无报价"展示，不阻断 bundle 列表）。具体降级条件：
//   - h.tradeAdapter 未注入（启动期未配置 trade）；
//   - r.Header.Get("X-User-Id") 为空（未登录公开页，Q31 选项 b）；
//   - details 为空（不必发起 RPC）；
//   - trade RPC 5xx / NotFound / 超时（Q-CGW-01 降级语义）。
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

	bundleIDs := make([]string, 0, len(details))
	for _, d := range details {
		if d == nil || d.BundleID == "" {
			continue
		}
		bundleIDs = append(bundleIDs, d.BundleID)
	}
	if len(bundleIDs) == 0 {
		return nil
	}

	// 给 trade RPC 5s 超时上限，避免拖慢 bundle 列表响应。
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	req := &tradeadapter.InquiryBatchRequest{
		ExternalUserID: userID,
		BundleIDs:      bundleIDs,
		Period:         timeSpan,
		TimeUnit:       timeUnit,
		// GoodsNum / PayMode / RegionID 由 trade 侧使用兜底默认值，不在 user-facing 透传。
	}
	resp, err := h.tradeAdapter.InquiryBatch(ctx, req)
	if err != nil {
		if resource.ZapLogger != nil {
			resource.ZapLogger.Warn("trade InquiryBatch failed, fallback to no-price bundle list",
				zap.Int("bundle_count", len(bundleIDs)),
				zap.Error(err),
			)
		}
		return nil
	}
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

// detailToAdminResponse 将 BundleDetail 转换为管理端响应
func detailToAdminResponse(d *bundlelogic.BundleDetail) *transport.BundleResponse {
	staticSoldOut := d.StaticSoldOut
	return &transport.BundleResponse{
		BundleID:              d.BundleID,
		BundleName:            d.BundleName,
		Description:           parseJSONDescription(d.Description),
		BundleState:           d.BundleState,
		AgentQuota:            d.AgentQuota,
		Credit:                d.Credit,
		TimeSpan:              d.TimeSpan,
		TimeUnit:              d.TimeUnit,
		AiGatewayPlanID:       d.AiGatewayPlanID,
		StaticSoldOut:         &staticSoldOut,
		BundleSalesAvailCount: d.BundleSalesAvailCount,
		BundleSalesTotalCount: d.BundleSalesTotalCount,
		BundleSalesState:      d.BundleSalesState,
		CreatedTime:           d.CreatedTime,
		UpdatedTime:           d.UpdatedTime,
	}
}

// detailToUserResponse 将 BundleDetail 转换为用户端响应（仅暴露用户可见字段）。
// quote 来自 trade `/internal/trade/inquiry/batch` 询价回填（迭代 8C），可为 nil；
// nil 时 Price 字段保持 nil，前端按"暂无报价"分支展示（Q-CGW-01 降级语义）。
func detailToUserResponse(d *bundlelogic.BundleDetail, quote *tradeadapter.BundleQuote) *transport.UserBundleResponse {
	resp := &transport.UserBundleResponse{
		BundleID:         d.BundleID,
		BundleName:       d.BundleName,
		Description:      parseJSONDescription(d.Description),
		BundleState:      d.BundleState,
		AgentQuota:       d.AgentQuota,
		Credit:           d.Credit,
		BundleSalesState: d.BundleSalesState,
		Price:            nil,
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
func detailToInternalResponse(d *bundlelogic.BundleDetail) *transport.InternalBundleDetail {
	return &transport.InternalBundleDetail{
		BundleID:              d.BundleID,
		BundleName:            d.BundleName,
		BundleState:           d.BundleState,
		AgentQuota:            d.AgentQuota,
		Credit:                d.Credit,
		BundleSalesAvailCount: d.BundleSalesAvailCount,
		BundleSalesTotalCount: d.BundleSalesTotalCount,
		BundleSalesState:      d.BundleSalesState,
	}
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
