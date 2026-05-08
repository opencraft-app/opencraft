package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"ctl/pkg/errcode"
	bundlelogic "ctl/pkg/logic/bundle"
	"ctl/pkg/transport"
)

// bundleHandler 套餐管理 handler
type bundleHandler struct {
	logic bundlelogic.Logic
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
func (h *bundleHandler) describeBundles(w http.ResponseWriter, r *http.Request) {
	details, err := h.logic.DescribeBundles()
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	bundles := make([]*transport.UserBundleResponse, 0, len(details))
	for _, d := range details {
		bundles = append(bundles, detailToUserResponse(d))
	}
	writeSuccess(w, r, http.StatusOK, &transport.DescribeBundlesResponse{Bundles: bundles})
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

// detailToUserResponse 将 BundleDetail 转换为用户端响应（仅暴露用户可见字段）
func detailToUserResponse(d *bundlelogic.BundleDetail) *transport.UserBundleResponse {
	return &transport.UserBundleResponse{
		BundleID:         d.BundleID,
		BundleName:       d.BundleName,
		Description:      parseJSONDescription(d.Description),
		BundleState:      d.BundleState,
		AgentQuota:       d.AgentQuota,
		Credit:           d.Credit,
		BundleSalesState: d.BundleSalesState,
		// Price 本期 ctl 侧不调 trade 询价，固定 nil（前端按"暂无报价"展示）；
		// 联调期由 describeBundles handler 调 trade 询价 RPC 回填，详见设计稿 §10 Q-CGW-01。
		Price: nil,
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
