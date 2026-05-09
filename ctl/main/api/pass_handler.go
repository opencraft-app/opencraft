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

// handleAdminPassesOrder POST /admin/api/ctl/passes/order — 后台管理触发付费 pass 下单
//
// 用途（billing-integration B2 新增）：
//   - 后台管理员代用户触发付费 pass 下单流程，便于联调 / 客服补单
//   - 入参：user_id（必填，后台必须显式指定）+ bundle_id + period + time_unit
//   - 出参：deal_name + pay_url
//
// 鉴权：复用 admin 路由所在的 admin 鉴权（与 handleAdminPasses 一致；当前 mux 注册
// 在同一前缀下，未来如有 admin 中间件可统一加挂）。
func (h *passHandler) handleAdminPassesOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	// 后台路径：必须显式带 user_id；这里把 user_id 当作 body 字段一起接（与
	// CreateTrialPassRequest 的 admin 流程保持一致）。
	var body struct {
		UserID                            string `json:"user_id"`
		transport.CreatePassOrderRequest         // 内嵌：bundle_id / period / time_unit
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}
	if body.UserID == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required for admin"))
		return
	}

	result, err := h.logic.CreatePassOrder(body.UserID, &body.CreatePassOrderRequest)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// handleUserPassesOrder POST /v1/passes/order — 用户可见付费 pass 下单入口
//
// 用途（billing-integration B2 新增）：
//   - 用户在控制台选择付费 bundle 后，由前端调本接口拿支付页 URL
//   - user_id 自动取当前登录用户（请求 header X-User-Id）
//   - 入参：bundle_id + period + time_unit
//   - 出参：deal_name + pay_url
func (h *passHandler) handleUserPassesOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}

	var req transport.CreatePassOrderRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	result, err := h.logic.CreatePassOrder(ctx.GetUserID(), &req)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// handleAdminPassesOrderAndPay POST /admin/api/ctl/passes/order-and-pay — 后台触发"下单并支付"一体化（仅用于联调测试）
//
// ⚠️ **仅用于联调测试 / 自动化 e2e，现网控制台禁止暴露此入口给真实用户。**
//
// 用途（billing-integration B2 新增）：
//   - 直接触发 jifei `qcloud.Deal.generateDealsAndPay` 一体化接口，跳过支付 URL 引导，
//     用于 e2e 验证完整链路（含 jifei → trade.checkCreate → trade.createResource → ctl.CompletePass 回调）
//   - 入参：user_id（必填）+ bundle_id + period + time_unit（与 CreatePassOrder 一致）
//   - 出参：deal_name + big_order_id（不返 pay_url）
//
// 鉴权：复用 admin 路由（与 handleAdminPassesOrder 一致）；现网应通过运维网关 ACL 进一步收敛。
func (h *passHandler) handleAdminPassesOrderAndPay(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	// 后台路径：必须显式带 user_id；与 handleAdminPassesOrder 入参结构对齐。
	var body struct {
		UserID                            string `json:"user_id"`
		transport.CreatePassOrderRequest         // 内嵌：bundle_id / period / time_unit
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}
	if body.UserID == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrPassInvalidParam, "user_id is required for admin"))
		return
	}

	result, err := h.logic.CreatePassOrderAndPay(body.UserID, &body.CreatePassOrderRequest)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// handleUserPassesOrderAndPay POST /v1/passes/order-and-pay — 用户侧触发"下单并支付"一体化（仅用于联调测试）
//
// ⚠️ **仅用于联调测试 / 自动化 e2e，现网控制台禁止暴露此入口给真实用户。**
// 现网用户支付链路：handleUserPassesOrder → 拿支付 URL → 跳转计费支付页 → 计费回调发货。
//
// 用途（billing-integration B2 新增）：
//   - e2e 测试时直接以"当前登录用户"身份触发 jifei 一体化下单+支付，不走支付 URL
//   - user_id 自动取当前登录用户（请求 header X-User-Id）
//   - 入参：bundle_id + period + time_unit
//   - 出参：deal_name + big_order_id
func (h *passHandler) handleUserPassesOrderAndPay(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}

	var req transport.CreatePassOrderRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	result, err := h.logic.CreatePassOrderAndPay(ctx.GetUserID(), &req)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// handleInternalPasses 处理 /internal/ctl/passes 与 /internal/ctl/passes/* 内部反向回调路由
//
// 当前承载（v5 收敛 — billing-integration B3 + Q66 修订 + Q69 互斥占用规则）：
//   - GET  /internal/ctl/passes?external_user_id=xxx —
//     trade.checkCreate 反向调，按 user_id 查该用户**全部** pass 记录做互斥占用判定（Q69）
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

// listInternalPasses GET /internal/ctl/passes?external_user_id=xxx
//
// 用途（Q66 修订 + Q69 拍板，2026-05-09）：
//   - trade.checkCreate 在创建 jifei 订单前调本接口，查 user 是否有任何 pass 记录；
//     **只要存在任意一条记录（不论是否过期 / 隔离 / 删除），即报互斥占用，阻断重复下单**。
//   - 业务规则（Q69）：过期的 pass 走续费路径，不走新购；所以新购流程下"用户曾经
//     拥有过 pass" 这个事实本身就是互斥占用信号。
//
// 鉴权：requireInternalBearer（外层 handleInternalPasses 已校验）
//
// 实现说明：直接复用 `Logic.DescribePasses(userID)`，**handler 层不做任何状态过滤**，
// 把 DAO 查到的全部 pass 原样透传给 trade。trade 业务层只关心数组长度即可：
//   - len == 0 → 用户从未持有 pass，可以下新单
//   - len > 0 → 互斥占用，拒绝下新单
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

	details, err := h.logic.DescribePasses(externalUserID)
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
