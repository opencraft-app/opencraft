package main

import (
	"net/http"
	"strconv"
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
	// v1.7.23 B18: 用户面响应使用 UserPassResponse（剥离 uin/app_id/deleted_time/renew_flag 内部字段）
	writeSuccess(w, r, http.StatusOK, detailToUserPassResponse(detail))
}

// getPasses GET /admin/api/ctl/passes — 后台管理
func (h *passHandler) getPasses(w http.ResponseWriter, r *http.Request) {
	const maxAdminPassPageSize = 100

	var userID *string
	var bundleID *string
	var status *string

	if uid := strings.TrimSpace(r.URL.Query().Get("user_id")); uid != "" {
		userID = &uid
	}
	if bid := strings.TrimSpace(r.URL.Query().Get("bundle_id")); bid != "" {
		bundleID = &bid
	}
	if st := strings.TrimSpace(r.URL.Query().Get("status")); st != "" && st != "all" {
		status = &st
	}

	page, pageSize, err := parsePagination(r)
	if err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}
	if pageSize > maxAdminPassPageSize {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam,
			"page_size %d exceeds max %d", pageSize, maxAdminPassPageSize))
		return
	}

	details, total, err := h.logic.GetPassesPage(userID, bundleID, status, page, pageSize)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	passes := make([]*transport.PassResponse, 0, len(details))
	for _, d := range details {
		passes = append(passes, detailToPassResponse(d))
	}
	writeSuccess(w, r, http.StatusOK, &transport.ListPassesResponse{
		Passes:   passes,
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	})
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

// handleAdminPassBillingMigration POST /admin/api/ctl/passes/billing-migration
func (h *passHandler) handleAdminPassBillingMigration(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	h.handlePassBillingMigration(w, r)
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

	// v1.7.23 B18: 用户面响应使用 UserPassResponse（剥离 uin/app_id/deleted_time/renew_flag 内部字段）
	passes := make([]*transport.UserPassResponse, 0, len(details))
	for _, d := range details {
		passes = append(passes, detailToUserPassResponse(d))
	}
	writeSuccess(w, r, http.StatusOK, &transport.ListUserPassesResponse{Passes: passes})
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
		UserID                           string `json:"user_id"`
		transport.CreatePassOrderRequest        // 内嵌：period / time_unit
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
		UserID                           string `json:"user_id"`
		transport.CreatePassOrderRequest        // 内嵌：period / time_unit
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

// handleUserPassesOrderUrl POST /v1/passes/order-url — 用户可见拉取支付 URL 入口（v1.7.31 接口拆分）
//
// 用途：前端拿到 deal_names 后调本接口获取支付页 URL。
func (h *passHandler) handleUserPassesOrderUrl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	var req transport.CreatePassOrderUrlRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	// v1.7.32 双模式鉴权（CodeBuddy AuthCode 模式，设计稿
	// .tmp/ctl-authcode-codebuddy-design.md §4.2）：
	//   - PC 端走 X-User-Id
	//   - 中转页（无 Bearer）走 req.AuthCode，凭 ticket 反查 user_id
	userID, err := resolveOrderUrlAuth(r, req.AuthCode, req.DealNames, "")
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	result, err := h.logic.CreatePassOrderUrl(userID, &req)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// handleAdminPassesOrderUrl POST /admin/api/ctl/passes/order-url — 后台拉取支付 URL（v1.7.31 接口拆分）
func (h *passHandler) handleAdminPassesOrderUrl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	var body struct {
		UserID string `json:"user_id"`
		transport.CreatePassOrderUrlRequest
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "user_id is required"))
		return
	}

	result, err := h.logic.CreatePassOrderUrl(body.UserID, &body.CreatePassOrderUrlRequest)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// handleInternalPasses 处理 /internal/ctl/passes 与 /internal/ctl/passes/* 内部反向回调路由
//
// 当前承载（v6 — billing-integration B3 + Q66 + Q69 + B11A 反查三件套 + trade-pass-isolate Q22-I-E）：
//   - GET  /internal/ctl/passes?external_user_id=xxx —
//     trade.checkCreate 反向调，按 user_id 查该用户**全部** pass 记录做互斥占用判定（Q69）
//   - POST /internal/ctl/passes/complete —
//     trade 反向调，完成付费 pass 发货
//   - POST /internal/ctl/passes/transfer —
//     trade.transferResource 反向调，把存量免费 pass 绑定为计费资源
//   - GET  /internal/ctl/passes/app-ids?bundle_ids=&page_no=&page_size= —
//     trade.getAllAppIds 反向调，反查 app_id 列表（B11A 新增）
//   - GET  /internal/ctl/passes/by-app?app_id=&bundle_ids=&page_no=&page_size= —
//     trade.getUserResources 反向调，按 app_id 反查 pass 列表（B11A 新增）
//   - POST /internal/ctl/passes/by-resource-ids body={app_id, pass_ids:[...]} —
//     trade.queryResource 反向调，按 pass_id 集合反查 pass 列表（B11A 新增）
//   - POST /internal/ctl/passes/{pass_id}/isolate —
//     trade.isolateResource 反向调，触发 pass 隔离（trade-pass-isolate §10 Q22-I-E）
//   - POST /internal/ctl/passes/{pass_id}/destroy —
//     trade.destroyResource 反向调，触发 pass 销毁主链（trade-pass-destroy §3.5 / §4.5.2 / §4.5.3）
//   - POST /internal/ctl/passes/{pass_id}/renew —
//     trade.renewResource 反向调，触发 pass 续费同步 / 异步双分支（trade-pass-renew §3.1 / §4.7 / §5.5 / R-D-2）
//
// 鉴权：CTL_INTERNAL_TOKEN（与 chatclaw runtime-bootstrap 一致）
//
// 后续生命周期接口（renew 等）按需加挂同一 mux。
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

	// 单段：/internal/ctl/passes/{action}
	// 双段：/internal/ctl/passes/{pass_id}/{action}
	parts := strings.Split(subPath, "/")
	if len(parts) == 1 {
		switch parts[0] {
		case "complete":
			h.completePass(w, r)
		case "transfer":
			h.transferPass(w, r)
		case "billing-migration":
			h.internalPassBillingMigration(w, r)
		case "app-ids":
			h.listInternalPassAppIDs(w, r)
		case "by-app":
			h.listInternalPassesByApp(w, r)
		case "by-resource-ids":
			h.listInternalPassesByResourceIDs(w, r)
		default:
			writeHTTPError(w, r, errcode.ErrNotFound)
		}
		return
	}
	if len(parts) == 2 {
		passID, action := parts[0], parts[1]
		switch action {
		case "isolate":
			h.isolatePass(w, r, passID)
		case "destroy":
			h.destroyPass(w, r, passID)
		case "renew":
			h.renewPass(w, r, passID)
		default:
			writeHTTPError(w, r, errcode.ErrNotFound)
		}
		return
	}

	writeHTTPError(w, r, errcode.ErrNotFound)
}

// isolatePass POST /internal/ctl/passes/{pass_id}/isolate
//
// 用途（trade-pass-isolate §10 Q22-I-E）：
//   - trade dispatcher 接到 jifei isolateResource 类回调后反向调本接口，
//     ctl 完成 pass.status active → isolating CAS 并派发后台 task 推进 instance pause + isolated
//   - 鉴权：requireInternalBearer（外层 handleInternalPasses 已校验）
//
// 错误语义：
//   - 200 + task_id：成功派发（含已经派发过但 trade 重试场景下幂等返同一个 task_id 的语义由 ctl 兜底）
//   - 404 PASS_NOT_FOUND：pass_id 不存在
//   - 403 PASS_ISOLATING：已经在隔离中（重入幂等保护，trade 不要再下发）
//   - 403 PASS_ISOLATED：已经隔离完毕（终态，trade 不要再下发）
//   - 5xx：DB / MQ 异常
func (h *passHandler) isolatePass(w http.ResponseWriter, r *http.Request, passID string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	passID = strings.TrimSpace(passID)
	if passID == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required"))
		return
	}
	// 解析 body：trade 端到端闭环（§10 Q22-I-E / 2026-05-15）会带 trade_flow_id；
	// v1.7.30 BUG-35 退费分支扩展：会同时带 new_deadline + deal_name；
	// 兼容 dev/test 等不带 body 的场景，ContentLength == 0 时按零值处理（ctl 父 task 终态不发 callback / 不动 expired_time）。
	var (
		tradeFlowID int64
		newDeadline *time.Time
		dealName    string
	)
	if r.ContentLength > 0 {
		var req transport.IsolatePassRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
			return
		}
		tradeFlowID = req.TradeFlowID
		newDeadline = req.NewDeadline
		dealName = req.DealName
	}

	taskID, err := h.logic.IsolatePass(passID, tradeFlowID, newDeadline, dealName)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, &transport.IsolatePassResponse{
		PassID: passID,
		TaskID: taskID,
	})
}

// destroyPass POST /internal/ctl/passes/{pass_id}/destroy
//
// 用途（trade-pass-destroy §3.5 / §4.5.2 / §4.5.3）：
//   - trade dispatcher 接到 jifei `destroyResource` 回调后反向调本接口；
//     入口 A（用户主动销毁）+ 入口 B（计费侧销毁回调）共享此入口（双源 from CAS）
//   - ctl 完成 pass.status (deleting∨isolated) → terminating CAS 并派发后台 task 推进
//     instance snapshot+销毁 + pass→history_pass 迁移 + trade.CompleteFlow 反向回调
//   - 鉴权：requireInternalBearer（外层 handleInternalPasses 已校验）
//
// 错误语义（与 Logic.DestroyPass 对齐）：
//   - 200 + task_id：成功派发
//   - 404 PASS_NOT_FOUND：pass_id 不存在
//   - 403 PASS_TERMINATING：销毁主链已启动（重投幂等保护，trade 视为 idempotent 成功）
//   - 400 PASS_INVALID_PARAM：当前 status 不在 {deleting, isolated} 集合
//   - 5xx：DB / MQ 异常
func (h *passHandler) destroyPass(w http.ResponseWriter, r *http.Request, passID string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	passID = strings.TrimSpace(passID)
	if passID == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required"))
		return
	}
	// 解析 body：trade 端到端闭环带 trade_flow_id + destroy_reason；
	// 兼容 dev/test 等不带 body 的场景，ContentLength == 0 时按零值处理（不发 callback / 空 reason）。
	var (
		tradeFlowID   int64
		destroyReason string
	)
	if r.ContentLength > 0 {
		var req transport.DestroyPassRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
			return
		}
		tradeFlowID = req.TradeFlowID
		destroyReason = req.DestroyReason
	}

	taskID, err := h.logic.DestroyPass(passID, tradeFlowID, destroyReason)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, &transport.DestroyPassResponse{
		PassID: passID,
		TaskID: taskID,
	})
}

// renewPass POST /internal/ctl/passes/{pass_id}/renew
//
// 用途（trade-pass-renew 设计稿 §3.1 / §4.7 / §5.5 / R-D-2 反向回调入口）：
//   - trade dispatcher 接到 jifei `renewResource` 回调后反向调本接口；
//     ctl 内部双分支：pass.status=active 同步路径（提前续费，原子写 expired_time）/
//     pass.status=isolated 异步路径（CAS isolated→renewing + 派发 RenewPassTask 父 task）。
//   - 鉴权：requireInternalBearer（外层 handleInternalPasses 已校验）
//
// 错误语义（与 Logic.RenewPass 对齐）：
//   - 200 + task_id：异步分支派发成功（同步分支 task_id 为空）
//   - 400 PASS_INVALID_PARAM：pass_id 空 / time_span <= 0 / time_unit ∉ {y, m, d}
//   - 403 PASS_RENEWING：已有续费在跑（双单防御，trade 层据此返 returnCode=352014/DeliveryFailRefund）
//   - 403 PASS_ISOLATING：隔离进行中不能续费
//   - 403 PASS_NOT_RENEWABLE：pass 状态不在可续费集合（如 deleting/deleted）
//   - 404 PASS_NOT_FOUND：pass_id 不存在
//   - 5xx：DB / MQ 异常
//
// 字段语义（设计稿 §12 Q5/v3.6 拍板）：DealName 仅 audit log 留痕，ctl logic 不消费。
func (h *passHandler) renewPass(w http.ResponseWriter, r *http.Request, passID string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	passID = strings.TrimSpace(passID)
	if passID == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrPassInvalidParam, "pass_id is required"))
		return
	}

	// 解析 body：必带 time_span / time_unit；trade_flow_id / deal_name 可选。
	// 兼容 dev/test 不带 body 的场景（ContentLength == 0），由 logic 层校验 time_span > 0 拒收。
	var req transport.RenewPassRequest
	if r.ContentLength > 0 {
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
			return
		}
	}

	// dealName 不传给 logic（§12 Q5/v3.6 拍板：ctl 不消费 dealName，仅 trade 侧留档）；
	// 此处仅做存在性兼容，不做强校验。
	taskID, _, err := h.logic.RenewPass(passID, req.TradeFlowID, req.TimeSpan, req.TimeUnit)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, &transport.RenewPassResponse{
		PassID: passID,
		TaskID: taskID,
	})
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

// transferPass POST /internal/ctl/passes/transfer — trade 反向回调迁移既有 pass
func (h *passHandler) transferPass(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	var req transport.TransferPassRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	detail, err := h.logic.TransferPassFromBilling(&req)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, detailToPassResponse(detail))
}

// internalPassBillingMigration POST /internal/ctl/passes/billing-migration
func (h *passHandler) internalPassBillingMigration(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	h.handlePassBillingMigration(w, r)
}

func (h *passHandler) handlePassBillingMigration(w http.ResponseWriter, r *http.Request) {
	var req transport.PassBillingMigrationRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}
	result, err := h.logic.MigrateFreeTrialPassToBilling(&req)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// detailToPassResponse 将 PassDetail 转换为 admin / internal 接口响应（含 uin/app_id 等内部字段）
func detailToPassResponse(d *passlogic.PassDetail) *transport.PassResponse {
	return &transport.PassResponse{
		PassID:              d.PassID,
		UserID:              d.UserID,
		BundleID:            d.BundleID,
		BundleName:          d.BundleName,
		Uin:                 d.Uin,
		AppID:               d.AppID,
		CreatedTime:         d.CreatedTime,
		ExpiredTime:         d.ExpiredTime,
		IsolatedTime:        d.IsolatedTime,
		DeletedTime:         d.DeletedTime,
		UpdatedTime:         d.UpdatedTime,
		Status:              d.Status,
		CreditTotal:         d.CreditTotal,
		CreditAvailable:     d.CreditAvailable,
		AgentQuotaTotal:     d.AgentQuotaTotal,
		AgentQuotaAvailable: d.AgentQuotaAvailable,
		RenewFlag:           d.RenewFlag,
	}
}

// detailToUserPassResponse 将 PassDetail 转换为用户面 /v1/passes 响应（v1.7.23 B18）
//
// 与 detailToPassResponse 的关键差异（删除 lightclaw / 腾讯云内部概念字段）：
//   - 不返 uin / app_id（用户不感知腾讯云账号）
//   - 不返 deleted_time（DB 字段后期会删除）
//   - 不返 renew_flag（本期未启用自动续费，待支持自动续费时再加回）
func detailToUserPassResponse(d *passlogic.PassDetail) *transport.UserPassResponse {
	return &transport.UserPassResponse{
		PassID:              d.PassID,
		UserID:              d.UserID,
		BundleID:            d.BundleID,
		BundleName:          d.BundleName,
		CreatedTime:         d.CreatedTime,
		ExpiredTime:         d.ExpiredTime,
		IsolatedTime:        d.IsolatedTime,
		UpdatedTime:         d.UpdatedTime,
		Status:              d.Status,
		AgentQuotaTotal:     d.AgentQuotaTotal,
		AgentQuotaAvailable: d.AgentQuotaAvailable,
		CreditTotal:         d.CreditTotal,
		CreditAvailable:     d.CreditAvailable,
	}
}

// === jifei 反查接口三件套 handler（billing-integration B11A 新增）===
// 设计稿：.tmp/trade-resource-query-design.md §4.1
//
// 路由分发由 handleInternalPasses 完成（已经走过 requireInternalBearer 鉴权）。

// listInternalPassAppIDs GET /internal/ctl/passes/app-ids?bundle_ids=&page_no=&page_size=
//
// 用途（B11A 反查链路 — trade.getAllAppIds → 本接口）：
//   - 反查全平台范围内（或限定 bundle 集合内）持有 pass 的 app_id 去重列表
//   - bundle_ids 选填（Q2 拍板）：jifei 入参 subProductCode 为空时省略，ctl 不过滤 bundle_id
//   - page_size 上限 20000（jifei 协议要求）；超过返 400
//
// SLA：≤ 1.5s（§11 Q14 拍板）
const listInternalPassAppIDsPageSizeMax = 20000

func (h *passHandler) listInternalPassAppIDs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	bundleIDs := parseCSVQueryParam(r.URL.Query().Get("bundle_ids"))
	pageNo, pageSize, err := parsePageParams(r, listInternalPassAppIDsPageSizeMax)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	appIDs, total, err := h.logic.ListPassAppIDs(bundleIDs, pageNo, pageSize)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	if appIDs == nil {
		// 保证 JSON 序列化为空数组而非 null
		appIDs = []int64{}
	}
	writeSuccess(w, r, http.StatusOK, &transport.ListPassAppIDsResponse{
		AppIDs: appIDs,
		Total:  total,
	})
}

// listInternalPassesByApp GET /internal/ctl/passes/by-app?app_id=&bundle_ids=&page_no=&page_size=
//
// 用途（B11A 反查链路 — trade.getUserResources → 本接口）：
//   - 按 app_id 维度反查该 app 持有的 pass 列表，可选 bundle_ids 进一步过滤
//   - page_size 上限 1000（设计稿 §4.1.2）
const listInternalPassesByAppPageSizeMax = 1000

func (h *passHandler) listInternalPassesByApp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	appIDStr := strings.TrimSpace(r.URL.Query().Get("app_id"))
	if appIDStr == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "app_id is required"))
		return
	}
	appID, err := strconv.ParseInt(appIDStr, 10, 64)
	if err != nil || appID <= 0 {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "app_id must be a positive integer"))
		return
	}

	bundleIDs := parseCSVQueryParam(r.URL.Query().Get("bundle_ids"))
	pageNo, pageSize, parseErr := parsePageParams(r, listInternalPassesByAppPageSizeMax)
	if parseErr != nil {
		writeHTTPError(w, r, parseErr)
		return
	}

	details, total, err := h.logic.ListPassesByAppID(appID, bundleIDs, pageNo, pageSize)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	passes := make([]*transport.PassResponse, 0, len(details))
	for _, d := range details {
		passes = append(passes, detailToPassResponse(d))
	}
	writeSuccess(w, r, http.StatusOK, &transport.ListPassesWithTotalResponse{
		Passes: passes,
		Total:  total,
	})
}

// listInternalPassesByResourceIDs POST /internal/ctl/passes/by-resource-ids
//
// 用途（B11A 反查链路 — trade.queryResource → 本接口）：
//   - 按 pass_id 集合（业务 ID，等价于 jifei resourceId）+ app_id 反查 pass 列表
//   - pass_ids 上限 100（jifei PDF 协议要求 ≥100；超过返 400）
//   - HTTP 方法用 POST 而非 GET（§11 Q12 拍板）：URL 长度限制 + 与 lightpower / shadow 工程惯例一致
const listInternalPassesByResourceIDsMax = 100

func (h *passHandler) listInternalPassesByResourceIDs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	var req transport.ListPassesByResourceIDsRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}
	if req.AppID <= 0 {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "app_id must be > 0"))
		return
	}
	if len(req.PassIDs) == 0 {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "pass_ids must be non-empty"))
		return
	}
	if len(req.PassIDs) > listInternalPassesByResourceIDsMax {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam,
			"pass_ids size %d exceeds max %d", len(req.PassIDs), listInternalPassesByResourceIDsMax))
		return
	}

	details, err := h.logic.ListPassesByResourceIDs(req.AppID, req.PassIDs)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	passes := make([]*transport.PassResponse, 0, len(details))
	for _, d := range details {
		passes = append(passes, detailToPassResponse(d))
	}
	writeSuccess(w, r, http.StatusOK, &transport.ListPassesWithTotalResponse{
		Passes: passes,
		Total:  int64(len(passes)),
	})
}

// parseCSVQueryParam 解析逗号分隔的 query 参数；空字符串返 nil（DAO 层据此省略 IN 子句）
func parseCSVQueryParam(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

// parsePageParams 解析 page_no / page_size 参数并校验上限
//
// 校验规则：
//   - page_no：必填，>= 0
//   - page_size：必填，1..pageSizeMax
//
// 返回 errcode.ErrInvalidParam（已 Wrap 上下文）便于前端定位
func parsePageParams(r *http.Request, pageSizeMax int) (int, int, error) {
	q := r.URL.Query()
	pageNoStr := strings.TrimSpace(q.Get("page_no"))
	pageSizeStr := strings.TrimSpace(q.Get("page_size"))
	if pageNoStr == "" {
		return 0, 0, errcode.Wrap(errcode.ErrInvalidParam, "page_no is required")
	}
	if pageSizeStr == "" {
		return 0, 0, errcode.Wrap(errcode.ErrInvalidParam, "page_size is required")
	}
	pageNo, err := strconv.Atoi(pageNoStr)
	if err != nil || pageNo < 0 {
		return 0, 0, errcode.Wrap(errcode.ErrInvalidParam, "page_no must be a non-negative integer")
	}
	pageSize, err := strconv.Atoi(pageSizeStr)
	if err != nil || pageSize <= 0 {
		return 0, 0, errcode.Wrap(errcode.ErrInvalidParam, "page_size must be a positive integer")
	}
	if pageSize > pageSizeMax {
		return 0, 0, errcode.Wrap(errcode.ErrInvalidParam,
			"page_size %d exceeds max %d", pageSize, pageSizeMax)
	}
	return pageNo, pageSize, nil
}

// ============================================================================
// R-D-5b 续费下单 + 拉支付 URL 对外路由（trade-pass-renew §3.3 / §4.4）
//
// 路径设计（与 CreatePassOrder 对偶 + 走对外 prefix）：
//   - 前端：POST /v1/passes/{pass_id}/renew/order-url             — 鉴权 X-User-Id
//   - 后台：POST /admin/api/ctl/passes/{pass_id}/renew/order-url  — 鉴权 admin
//
// 入参：transport.RenewPassOrderUrlRequest (period + time_unit; bundle_id 由 ctl 内部从 pass 取, v1.7.22 B17)
// 出参：transport.RenewPassOrderUrlResult  (deal_name + pay_url)
//
// pass_id 走 path param（与 isolatePass POST /internal/ctl/passes/{pass_id}/isolate 同范式）；
// 鉴权 transport 层校验：前端走 newRequestContext 取 X-User-Id；后台 body 显式带 user_id。
//
// 由于 http.ServeMux 不原生支持 path param，本期用 trailing-slash prefix 注册 + 路径解析
// 的范式（与 handleInternalPasses 同范式）。子路径：
//   /v1/passes/{pass_id}/renew/order-url
//   /admin/api/ctl/passes/{pass_id}/renew/order-url
// 其他子路径返 404。
// ============================================================================

// handleUserPassesByID 处理 /v1/passes/{pass_id}/... 子路径路由（前端入口）。
//
// 当前承载：
//   - R-D-5b 续费支付 URL：{pass_id}/renew/order-url
//   - R-D-7c 续费一体化下单+支付（测试用）：{pass_id}/renew/order-and-pay
//   - D-2.3 主动销毁触发：{pass_id}/delete（trade-pass-destroy §4.5.1）
//
// 未来如新增其他 per-pass 用户侧动作（如 cancel / transfer 等），在本 handler 内
// switch action 字段扩展。
func (h *passHandler) handleUserPassesByID(w http.ResponseWriter, r *http.Request) {
	subPath := strings.Trim(strings.TrimPrefix(r.URL.Path, "/v1/passes"), "/")
	if subPath == "" {
		// 裸 /v1/passes 已由 handleUserPasses 注册，理论不会进到这里；防御性返 404
		writeHTTPError(w, r, errcode.ErrNotFound)
		return
	}
	parts := strings.Split(subPath, "/")
	// 2 段路径：{pass_id}/delete（trade-pass-destroy §4.5.1）
	if len(parts) == 2 && parts[1] == "delete" {
		h.userDeletePass(w, r, parts[0])
		return
	}
	// 3 段路径：{pass_id}/renew/{order | order-url | order-and-pay | price}
	if len(parts) == 3 && parts[1] == "renew" {
		switch parts[2] {
		case "order":
			h.userRenewPassOrder(w, r, parts[0])
			return
		case "order-url":
			h.userRenewPassOrderUrl(w, r, parts[0])
			return
		case "order-and-pay":
			h.userRenewPassOrderAndPay(w, r, parts[0])
			return
		case "price":
			h.userRenewPassPrice(w, r, parts[0])
			return
		}
	}
	writeHTTPError(w, r, errcode.ErrNotFound)
}

// handleAdminPassesByID 处理 /admin/api/ctl/passes/{pass_id}/... 子路径路由（后台入口）。
//
// 当前承载（与 handleUserPassesByID 对偶）：
//   - R-D-5b 续费支付 URL：{pass_id}/renew/order-url
//   - R-D-7c 续费一体化下单+支付（测试用）：{pass_id}/renew/order-and-pay
//   - D-2.3 后台代销毁触发：{pass_id}/delete（trade-pass-destroy §4.5.1）
//   - trade-pass-refund v0.5 后台代退款触发：{pass_id}/refund
func (h *passHandler) handleAdminPassesByID(w http.ResponseWriter, r *http.Request) {
	subPath := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/api/ctl/passes"), "/")
	if subPath == "" {
		writeHTTPError(w, r, errcode.ErrNotFound)
		return
	}
	parts := strings.Split(subPath, "/")
	// 2 段路径：{pass_id}/delete（trade-pass-destroy §4.5.1）、{pass_id}/refund（trade-pass-refund v0.5）
	if len(parts) == 2 {
		switch parts[1] {
		case "delete":
			h.adminDeletePass(w, r, parts[0])
			return
		case "refund":
			h.adminRefundPass(w, r, parts[0])
			return
		}
	}
	// 3 段路径：{pass_id}/renew/{order | order-url | order-and-pay | price}
	if len(parts) == 3 && parts[1] == "renew" {
		switch parts[2] {
		case "order":
			h.adminRenewPassOrder(w, r, parts[0])
			return
		case "order-url":
			h.adminRenewPassOrderUrl(w, r, parts[0])
			return
		case "order-and-pay":
			h.adminRenewPassOrderAndPay(w, r, parts[0])
			return
		case "price":
			h.adminRenewPassPrice(w, r, parts[0])
			return
		}
	}
	writeHTTPError(w, r, errcode.ErrNotFound)
}

// userRenewPassOrder POST /v1/passes/{pass_id}/renew/order — 用户可见续费纯下单入口（v1.7.31 接口拆分）
//
// 用途：用户点击"续费"按钮后调本接口仅下单，返回 deal_names。
func (h *passHandler) userRenewPassOrder(w http.ResponseWriter, r *http.Request, passID string) {
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

	var req transport.RenewPassOrderRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	result, err := h.logic.RenewPassOrder(ctx.GetUserID(), passID, &req)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// adminRenewPassOrder POST /admin/api/ctl/passes/{pass_id}/renew/order — 后台代续费纯下单（v1.7.31 接口拆分）
func (h *passHandler) adminRenewPassOrder(w http.ResponseWriter, r *http.Request, passID string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	var body struct {
		UserID string `json:"user_id"`
		transport.RenewPassOrderRequest
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "user_id is required"))
		return
	}

	result, err := h.logic.RenewPassOrder(body.UserID, passID, &body.RenewPassOrderRequest)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// userRenewPassOrderUrl POST /v1/passes/{pass_id}/renew/order-url — 用户可见续费下单入口（R-D-5b）
//
// 用途（trade-pass-renew §3.3 / §4.4）：
//   - 用户在控制台点击"续费"按钮后，由前端调本接口拿支付 URL 并跳转完成付款
//   - user_id 自动取当前登录用户（请求 header X-User-Id）
//   - 入参：period + time_unit（v1.7.22 B17：bundle_id 由 ctl 内部从 pass 取，前端不传）
//   - 出参：deal_name + pay_url
//
// 错误语义：
//   - 200 + result：成功
//   - 400 PASS_INVALID_PARAM：缺 pass_id / period / time_unit 或 time_unit ∉ {m,d,y}
//   - 401 UNAUTHORIZED：缺 X-User-Id
//   - 404 PASS_NOT_FOUND：pass_id 不存在或不属于当前用户（防越权续费）
//   - 422 PASS_SHADOW_BINDING_NOT_FOUND：用户尚未实名 / 未绑云账号
//   - 5xx：trade / shadow / DB 异常
//
// 注：v1.7.22 B17 后已废弃 409 PASS_BUNDLE_OFFLINE（套餐下架不阻断续费，仅阻断新购）
func (h *passHandler) userRenewPassOrderUrl(w http.ResponseWriter, r *http.Request, passID string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	var req transport.RenewPassOrderUrlRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	// v1.7.32 双模式鉴权：与 handleUserPassesOrderUrl 同范式，额外传 passID 让 ticket
	// 反查走 A3 不变量（ticket.PassID == path 上的 pass_id，防跨 pass 撞 ticket）。
	userID, err := resolveOrderUrlAuth(r, req.AuthCode, req.DealNames, passID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}

	result, err := h.logic.RenewPassOrderUrl(userID, passID, &req)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// adminRenewPassOrderUrl POST /admin/api/ctl/passes/{pass_id}/renew/order-url — 后台代续费下单（R-D-5b）
//
// 用途（与 handleAdminPassesOrder 对偶）：
//   - 后台管理员代用户触发续费下单流程，便于联调 / 客服补单
//   - body 中 user_id 必填；与 handleAdminPassesOrder 入参结构对齐
//
// 鉴权：复用 admin 路由所在的 admin 鉴权（与 handleAdminPasses 一致；当前 mux 注册
// 在同一前缀下，未来如有 admin 中间件可统一加挂）。
func (h *passHandler) adminRenewPassOrderUrl(w http.ResponseWriter, r *http.Request, passID string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	// 后台路径：必须显式带 user_id；与 handleAdminPassesOrder 入参结构对齐
	var body struct {
		UserID                             string `json:"user_id"`
		transport.RenewPassOrderUrlRequest        // 内嵌：deal_names / platform / wx_open_id
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "user_id is required"))
		return
	}

	result, err := h.logic.RenewPassOrderUrl(body.UserID, passID, &body.RenewPassOrderUrlRequest)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// ============================================================================
// 续费询价对外路由（v1.7.21 B16 / R-C-4）
//
// 路径设计（与 R-D-5b RenewPassOrderUrl 同 prefix + 后缀 /price）：
//   - 前端：POST /v1/passes/{pass_id}/renew/price             鉴权 X-User-Id
//   - 后台：POST /admin/api/ctl/passes/{pass_id}/renew/price  鉴权 admin
//
// 入参：transport.RenewPassPriceRequest (period + time_unit; pass_id 走 path param)
// 出参：transport.RenewPassPriceResult (与新购询价 BundlePrice 字段集对齐)
//
// 关键约束（用户 2026-05-20 拍板 b）：
//   - **不允许换 bundle**：续费只能续当前 pass.bundle_id，body 不带 bundle_id
//   - 询价无副作用：不下单、不付款、不写本地 pass，前端确认价格后再调 RenewPassOrderUrl
// ============================================================================

// userRenewPassPrice POST /v1/passes/{pass_id}/renew/price — 用户可见续费询价入口（v1.7.21 B16 / R-C-4）
//
// 用途（trade-pass-renew §3.5 / §14）：
//   - 用户在控制台续费页选择续费时长（如 1 个月 / 3 个月）后，由前端调本接口拿当前 bundle
//     的续费价格用于展示，不下单不付款
//
// 入参 / 出参：
//   - 入参：transport.RenewPassPriceRequest (period + time_unit；pass_id 走 path param)
//   - 出参：transport.RenewPassPriceResult (price/total_cost/real_total_cost/discount/currency 等)
//
// 错误语义：
//   - 200 + result：成功
//   - 400 PASS_INVALID_PARAM：缺 period / time_unit 或 time_unit ∉ {m,d,y}
//   - 401 UNAUTHORIZED：缺 X-User-Id
//   - 404 PASS_NOT_FOUND：pass_id 不存在或不属于当前用户（防越权）
//   - 5xx：trade / DB 异常
//
// 注：v1.7.22 B17 后已废弃 409 PASS_BUNDLE_OFFLINE（套餐下架不阻断续费询价，仅阻断新购询价）
func (h *passHandler) userRenewPassPrice(w http.ResponseWriter, r *http.Request, passID string) {
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

	var req transport.RenewPassPriceRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	result, err := h.logic.RenewPassPrice(ctx.GetUserID(), passID, &req)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// adminRenewPassPrice POST /admin/api/ctl/passes/{pass_id}/renew/price — 后台代用户续费询价
//
// 用途（与 adminRenewPassOrderUrl 对偶）：
//   - 后台管理员代用户拿续费报价，便于客服支持 / 联调
//   - body 中 user_id 必填，与 handleAdminPassesOrder 入参结构对齐
func (h *passHandler) adminRenewPassPrice(w http.ResponseWriter, r *http.Request, passID string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	var body struct {
		UserID                          string `json:"user_id"`
		transport.RenewPassPriceRequest        // 内嵌：period / time_unit
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "user_id is required"))
		return
	}

	result, err := h.logic.RenewPassPrice(body.UserID, passID, &body.RenewPassPriceRequest)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// ============================================================================
// R-D-7c 续费一体化下单+支付对外路由（trade-pass-renew §3.3 / §4.4 / R-D-7）
//
// **仅用于联调测试 / 自动化 e2e，现网控制台禁止暴露此入口给真实用户。**
//
// 路径设计（与 R-D-5b RenewPassOrderUrl 同 prefix + 与 CreatePassOrderAndPay 对偶后缀）：
//   - 前端：POST /v1/passes/{pass_id}/renew/order-and-pay             鉴权 X-User-Id
//   - 后台：POST /admin/api/ctl/passes/{pass_id}/renew/order-and-pay  鉴权 admin
//
// 入参：transport.RenewPassOrderUrlRequest 复用（与 R-D-5b 同 schema：period + time_unit；
//       pass_id 走 path param；v1.7.22 B17 起 bundle_id 不在 body 中，由 ctl 内部从 pass 取）
// 出参：transport.RenewPassOrderAndPayResult (deal_name + big_order_id; 不返 pay_url)
//
// 与 R-D-5b 的差异（与 CreatePassOrderAndPay vs CreatePassOrder 同范式）：
//   - R-D-5b 调 trade.PlaceRenewOrder + trade.GeneratePayURL 双段返支付 URL
//   - R-D-7c 调 trade.PlaceRenewOrderAndPay 一次完成下单+支付，跳过支付 URL
// ============================================================================

// userRenewPassOrderAndPay POST /v1/passes/{pass_id}/renew/order-and-pay — 用户侧续费一体化下单+支付（R-D-7c）
//
// ⚠️ **仅用于联调测试 / 自动化 e2e，现网控制台禁止暴露此入口给真实用户。**
// 现网用户续费链路：userRenewPassOrderUrl → 拿支付 URL → 跳转计费支付页 → 计费回调推进续费。
//
// 用途（R-D-7）：
//   - e2e 测试时直接以"当前登录用户"身份触发 jifei 一体化续费下单+支付，不走支付 URL
//   - user_id 自动取当前登录用户（请求 header X-User-Id）
//   - 入参：period + time_unit（v1.7.22 B17：bundle_id 由 ctl 内部从 pass 取，前端不传）
//   - 出参：deal_name + big_order_id
//
// 错误语义（与 userRenewPassOrderUrl 一致）：
//   - 200 + result：成功
//   - 400 PASS_INVALID_PARAM：缺 period / time_unit 或 time_unit ∉ {m,d,y}
//   - 401 UNAUTHORIZED：缺 X-User-Id
//   - 404 PASS_NOT_FOUND：pass_id 不存在或不属于当前用户（防越权续费）
//   - 422 PASS_SHADOW_BINDING_NOT_FOUND：用户尚未实名 / 未绑云账号
//   - 5xx：trade / shadow / DB 异常
//
// 注：v1.7.22 B17 后已废弃 409 PASS_BUNDLE_OFFLINE（套餐下架不阻断续费，仅阻断新购）
func (h *passHandler) userRenewPassOrderAndPay(w http.ResponseWriter, r *http.Request, passID string) {
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

	var req transport.RenewPassOrderRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}

	result, err := h.logic.RenewPassOrderAndPay(ctx.GetUserID(), passID, &req)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// adminRenewPassOrderAndPay POST /admin/api/ctl/passes/{pass_id}/renew/order-and-pay — 后台代续费一体化下单+支付（R-D-7c）
//
// ⚠️ **仅用于联调测试 / 自动化 e2e，现网控制台禁止暴露此入口给真实用户。**
//
// 用途（与 adminRenewPassOrderUrl 对偶 + 一体化区分）：
//   - 后台管理员代用户触发续费一体化下单+支付，便于联调 / 客服 e2e 验证
//   - body 中 user_id 必填；与 adminRenewPassOrderUrl 入参结构对齐
//
// 鉴权：复用 admin 路由（与 handleAdminPasses 一致；当前 mux 注册在同一前缀下，
// 未来如有 admin 中间件可统一加挂）。
func (h *passHandler) adminRenewPassOrderAndPay(w http.ResponseWriter, r *http.Request, passID string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	// 后台路径：必须显式带 user_id；与 adminRenewPassOrderUrl 入参结构对齐
	var body struct {
		UserID                          string `json:"user_id"`
		transport.RenewPassOrderRequest        // 内嵌：period / time_unit
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
		return
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "user_id is required"))
		return
	}

	result, err := h.logic.RenewPassOrderAndPay(body.UserID, passID, &body.RenewPassOrderRequest)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// ============================================================================
// D-2.3 主动销毁触发对外路由（trade-pass-destroy §4.5.1）
//
// 路径设计（与 R-D-5b 续费同 prefix + 单段动词后缀；动词命名"delete"为前端入口语义）：
//   - 前端：POST /v1/passes/{pass_id}/delete             鉴权 X-User-Id
//   - 后台：POST /admin/api/ctl/passes/{pass_id}/delete  鉴权 admin（body.user_id）
//
// 入参：路径 pass_id（前端鉴权由 X-User-Id 隐含；后台 body 显式带 user_id）
// 出参：transport.PassResponse（含 status='deleting' 的最新快照）
//
// 与续费链路的差异：DeletePass 不入队 task —— ctl 仅做 CAS isolated→deleting + 同步调
// trade.DeleteResource，销毁主链由 jifei 异步回调 trade.destroyResource → ctl.DestroyPass
// 启动（设计稿 §1 / §4.2 / §11-A Q1/Q2）。
// ============================================================================

// userDeletePass POST /v1/passes/{pass_id}/delete — 用户主动销毁触发（D-2.3）
//
// 响应语义（用户拍板：删除接口仅返回同步调用成功 / 失败信号，pass 详情由前端后续
// 调 GET /v1/passes 查询）：
//   - 200 + 空 data envelope：销毁链路启动成功（pass.status 已 CAS isolated → deleting，
//     trade.DeleteResource 已同步触发；pass 实际从列表消失为异步过程，前端轮询 GET /v1/passes
//     检测 pass 是否消失即可）
//   - 400 PASS_INVALID_PARAM：缺 pass_id
//   - 401 UNAUTHORIZED：缺 X-User-Id
//   - 403 PASS_DELETING：当前 pass 已经在销毁中（幂等保护）
//   - 403 PASS_TERMINATING：当前 pass 已经在终态销毁中（不可逆）
//   - 404 PASS_NOT_FOUND：pass_id 不存在或不属于当前用户（防越权销毁）
//   - 409 PASS_NOT_ISOLATED：pass 状态非 isolated（必须先隔离再销毁）
//   - 5xx：trade / DB 异常
func (h *passHandler) userDeletePass(w http.ResponseWriter, r *http.Request, passID string) {
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

	if _, err := h.logic.DeletePass(ctx.GetUserID(), passID); err != nil {
		writeHTTPError(w, r, err)
		return
	}
	// 仅返回同步调用成功信号 (pass.status 已 CAS isolated → deleting + trade.DeleteResource
	// 已同步触发). pass 实际是否物理销毁是异步链路 (jifei 回调 → 后台 task → snapshot/cleanup
	// 一般 1~3min), 前端需轮询 GET /v1/passes 看 pass 是否从列表消失.
	writeSuccess(w, r, http.StatusOK, &transport.DeletePassUserResponse{Deleted: true})
}

// adminDeletePass POST /admin/api/ctl/passes/{pass_id}/delete — 后台代销毁触发（D-2.3）
//
// 用途（与 userDeletePass 对偶）：
//   - 后台管理员代用户触发销毁流程，便于联调 / 客服补单
//   - body 中 user_id 必填；与 adminRenewPassOrderUrl 入参结构对齐
//
// 鉴权：复用 admin 路由所在的 admin 鉴权（与 handleAdminPasses 一致）。
func (h *passHandler) adminDeletePass(w http.ResponseWriter, r *http.Request, passID string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	// 后台路径：body 必须显式带 user_id；与 adminRenewPassOrderUrl 入参结构对齐
	var body struct {
		UserID string `json:"user_id"`
	}
	// body 可能为空（admin 也允许只走 path param），ContentLength == 0 时跳过 decode
	if r.ContentLength > 0 {
		if err := decodeJSONBody(r, &body); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
			return
		}
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "user_id is required"))
		return
	}

	if _, err := h.logic.DeletePass(body.UserID, passID); err != nil {
		writeHTTPError(w, r, err)
		return
	}
	// 与 userDeletePass 对偶: 仅返回同步调用成功信号, pass 实体异步销毁需轮询查询.
	writeSuccess(w, r, http.StatusOK, &transport.DeletePassUserResponse{Deleted: true})
}

// adminRefundPass POST /admin/api/ctl/passes/{pass_id}/refund — 后台代退款触发
// （trade-pass-refund-design.md v0.5 §3.3 + §11 拍板项汇总）
//
// 用途（Q1=a 仅 admin 后台暴露，不对外开用户面）：
//   - 运营 / 客服为指定 pass 发起 jifei OnlineRefund 同步退款
//   - body 可选 operator_uin / reason（仅日志留痕用，Q4=a 不建审计表）
//   - 后台路径**不要求** user_id 透传：Q1=a 拍板 admin 直接以 pass_id 为粒度操作，
//     越权风险由 admin 路由所在的 admin 鉴权层兜底，不在 handler 层做 user_id 校验
//
// 关键不变量（Q3=b 拍板）：本接口同步返成功后 pass.status **仍是 `active`**；
// 最终状态由 jifei 异步回 isolateResource(billingIsolateType=refund) 推进到 isolated。
// 详见 logic/pass/refund.go::RefundPass 注释。
//
// 错误响应（与 logic.RefundPass 错误码 1:1 对偶）：
//   - 400 PASS_INVALID_PARAM         缺 pass_id（path 段为空）
//   - 400 PASS_NOT_ACTIVE            pass.status ≠ active
//   - 400 PASS_TRIAL_NOT_REFUNDABLE  试用 pass（uin/app_id=0）
//   - 403 PASS_EXPIRED               pass.expired_time <= NOW()
//   - 404 PASS_NOT_FOUND             pass_id 不存在
//   - 5xx：trade 调用异常 / jifei 业务错（透传 trade adapter *Error）
//
// 鉴权：复用 admin 路由所在的 admin 鉴权（与 handleAdminPasses 一致）。
func (h *passHandler) adminRefundPass(w http.ResponseWriter, r *http.Request, passID string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	// body 可选 — Q4=a 拍板：仅 operator_uin / reason 两个透传字段。ContentLength == 0 时跳过 decode。
	var req transport.RefundPassRequest
	if r.ContentLength > 0 {
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInvalidParam, "%s", err.Error()))
			return
		}
	}

	result, err := h.logic.RefundPass(passID, req.OperatorUin, req.Reason)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, &transport.RefundPassResponse{
		PassID:      result.PassID,
		DealName:    result.DealName,
		BigDealID:   result.BigDealID,
		SubmittedAt: result.SubmittedAt,
	})
}
