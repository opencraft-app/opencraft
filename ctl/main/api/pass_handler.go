package main

import (
	"net/http"
	"strings"
	"time"

	"ctl/pkg/errcode"
	passlogic "ctl/pkg/logic/pass"
	"ctl/pkg/transport"
)

// passHandler 用户权益 handler
type passHandler struct {
	logic passlogic.Logic
}

// handleAdminPasses 处理后台管理接口 /admin/api/ctl/passes
func (h *passHandler) handleAdminPasses(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.createTrialPassAdmin(w, r)
	case http.MethodGet:
		h.getPasses(w, r)
	case http.MethodPut:
		h.modifyPass(w, r)
	default:
		w.Header().Set("Allow", strings.Join([]string{http.MethodPost, http.MethodGet, http.MethodPut}, ", "))
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
	}
}

// handleUserPasses 处理用户可见接口 /v1/passes
func (h *passHandler) handleUserPasses(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.createTrialPassUser(w, r)
	case http.MethodGet:
		h.describePasses(w, r)
	default:
		w.Header().Set("Allow", strings.Join([]string{http.MethodPost, http.MethodGet}, ", "))
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
	}
}

// createTrialPassAdmin POST /admin/api/ctl/passes — 后台管理
func (h *passHandler) createTrialPassAdmin(w http.ResponseWriter, r *http.Request) {
	var req transport.CreateTrialPassRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	if req.UserID == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required for admin"))
		return
	}

	detail, err := h.logic.CreateTrialPass(req.UserID, req.BundleID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, detailToPassResponse(detail))
}

// createTrialPassUser POST /v1/passes — 用户可见
func (h *passHandler) createTrialPassUser(w http.ResponseWriter, r *http.Request) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}

	var req transport.CreateTrialPassRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	// 用户接口自动取当前登录用户
	userID := ctx.GetUserID()

	detail, err := h.logic.CreateTrialPass(userID, req.BundleID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, detailToPassResponse(detail))
}

// getPasses GET /admin/api/ctl/passes — 后台管理
func (h *passHandler) getPasses(w http.ResponseWriter, r *http.Request) {
	var userID *string
	var bundleID *string

	if uid := strings.TrimSpace(r.URL.Query().Get("user_id")); uid != "" {
		userID = &uid
	}
	if bid := strings.TrimSpace(r.URL.Query().Get("bundle_id")); bid != "" {
		bundleID = &bid
	}

	details, err := h.logic.GetPasses(userID, bundleID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	passes := make([]*transport.PassResponse, 0, len(details))
	for _, d := range details {
		passes = append(passes, detailToPassResponse(d))
	}
	writeSuccess(w, r, http.StatusOK, &transport.ListPassesResponse{Passes: passes})
}

// modifyPass PUT /admin/api/ctl/passes — 后台管理
func (h *passHandler) modifyPass(w http.ResponseWriter, r *http.Request) {
	var req transport.ModifyPassRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	if req.PassID == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required"))
		return
	}

	fields := &passlogic.ModifyPassFields{
		BundleID:    req.BundleID,
		ExpiredTime: req.ExpiredTime,
	}

	detail, err := h.logic.ModifyPass(req.PassID, fields)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, detailToPassResponse(detail))
}

// describePasses GET /v1/passes — 用户可见
func (h *passHandler) describePasses(w http.ResponseWriter, r *http.Request) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}

	userID := ctx.GetUserID()
	details, err := h.logic.DescribePasses(userID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	passes := make([]*transport.PassResponse, 0, len(details))
	for _, d := range details {
		passes = append(passes, detailToPassResponse(d))
	}
	writeSuccess(w, r, http.StatusOK, &transport.ListPassesResponse{Passes: passes})
}

// handleInternalPasses 处理 /internal/ctl/passes 与 /internal/ctl/passes/* 内部反向回调路由
//
// 当前承载（v4 收敛 — billing-integration B3 + Q66 互斥占用查询）：
//   - GET  /internal/ctl/passes?external_user_id=xxx&state=in_service —
//     trade.checkCreate 反向调，按 user_id 查在期 pass 做互斥占用判定
//   - POST /internal/ctl/passes/complete —
//     trade 反向调，完成付费 pass 发货
//
// 鉴权：CTL_INTERNAL_TOKEN（与 chatclaw runtime-bootstrap 一致）
//
// 后续生命周期接口（renew / isolate / destroy）等 Q49 拍板的生命周期子需求再加挂同一 mux。
func (h *passHandler) handleInternalPasses(w http.ResponseWriter, r *http.Request) {
	if !requireInternalBearer(r) {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}

	// 裸路径 /internal/ctl/passes（无尾斜杠或仅尾斜杠）— 列表查询
	subPath := strings.Trim(strings.TrimPrefix(r.URL.Path, "/internal/ctl/passes"), "/")
	if subPath == "" {
		h.listInternalPasses(w, r)
		return
	}

	// 子路径 /internal/ctl/passes/{action}
	switch subPath {
	case "complete":
		h.completePass(w, r)
	default:
		writeHTTPError(w, r, errcode.ErrNotFound)
	}
}

// listInternalPasses GET /internal/ctl/passes?external_user_id=xxx&state=in_service
//
// 用途（Q66 拍板，2026-05-08）：
//   - trade.checkCreate 在创建 jifei 订单前调本接口，查 user 是否已有"在期"pass，
//     存在即报互斥占用，阻断重复下单 / 互斥套餐冲突。
//
// 当前 state 语义：
//   - "in_service"：expired_time > now() AND isolated_time IS NULL AND deleted_time IS NULL
//   - 其它取值（"expired" / "isolated" / "deleted"）本期保留契约，未实现，命中即报 ErrInvalidParam
//   - 缺省 state（不传）等价于 in_service（高频默认场景，简化 trade 调用方）
//
// 鉴权：requireInternalBearer（外层 handleInternalPasses 已校验）
func (h *passHandler) listInternalPasses(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	externalUserID := strings.TrimSpace(r.URL.Query().Get("external_user_id"))
	if externalUserID == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "external_user_id is required"))
		return
	}

	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" {
		state = "in_service"
	}
	if state != "in_service" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam,
			"state %q not supported, only 'in_service' is implemented", state))
		return
	}

	details, err := h.logic.DescribePasses(externalUserID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	now := time.Now().UTC()
	passes := make([]*transport.PassResponse, 0, len(details))
	for _, d := range details {
		if !isInServicePass(d, now) {
			continue
		}
		passes = append(passes, detailToPassResponse(d))
	}
	writeSuccess(w, r, http.StatusOK, &transport.ListPassesResponse{Passes: passes})
}

// isInServicePass 判定 pass 是否处于"在期"状态：
//   - expired_time > now（未到期）
//   - isolated_time IS NULL（未隔离）
//   - deleted_time IS NULL（未删除）
func isInServicePass(d *passlogic.PassDetail, now time.Time) bool {
	if d == nil {
		return false
	}
	if d.IsolatedTime != nil {
		return false
	}
	if d.DeletedTime != nil {
		return false
	}
	if !d.ExpiredTime.After(now) {
		return false
	}
	return true
}

// completePass POST /internal/ctl/passes/complete — trade 反向回调发货付费 pass
func (h *passHandler) completePass(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	var req transport.CompletePassRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	detail, err := h.logic.CompletePass(&req)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, detailToPassResponse(detail))
}

// detailToPassResponse 将 PassDetail 转换为响应
func detailToPassResponse(d *passlogic.PassDetail) *transport.PassResponse {
	return &transport.PassResponse{
		PassID:          d.PassID,
		UserID:          d.UserID,
		BundleID:        d.BundleID,
		BundleName:      d.BundleName,
		Uin:             d.Uin,
		AppID:           d.AppID,
		CreatedTime:     d.CreatedTime,
		ExpiredTime:     d.ExpiredTime,
		IsolatedTime:    d.IsolatedTime,
		DeletedTime:     d.DeletedTime,
		UpdatedTime:     d.UpdatedTime,
		CreditTotal:     d.CreditTotal,
		CreditAvailable: d.CreditAvailable,
	}
}
