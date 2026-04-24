package main

import (
	"net/http"
	"strings"

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
