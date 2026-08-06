package main

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"ctl/pkg/errcode"
	websitelogic "ctl/pkg/logic/website"
)

func hasValidWebsiteInternalToken(provided string) bool {
	expected := os.Getenv("WEBSITE_INTERNAL_API_TOKEN")
	if expected == "" || len(provided) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

// websiteHandler 静态建站 handler
type websiteHandler struct {
	logic websitelogic.Logic
}

// invalidWebsiteParamError 让参数校验的具体原因真正到达调用方。
//
// errcode.Wrap 只是把原因拼进 Go 错误串，而 writeHTTPError 回写的是错误码自带的
// 通用 message（"invalid website parameters"），原因整段被丢掉。建站 Skill 直接调
// 这些接口，缺哪个字段必须一眼可见，所以借用 writeHTTPError 已有的 details 通道
// 把原因带回去。
type invalidWebsiteParamError struct {
	reason string
}

func (e *invalidWebsiteParamError) Error() string { return e.reason }

// Unwrap 让 writeHTTPError 仍按 WEBSITE_INVALID_PARAM / 400 输出，错误码语义不变。
func (e *invalidWebsiteParamError) Unwrap() error { return errcode.ErrWebsiteInvalidParam }

func (e *invalidWebsiteParamError) ErrorDetail() any {
	return map[string]string{"reason": e.reason}
}

func invalidWebsiteParam(format string, args ...any) error {
	return &invalidWebsiteParamError{reason: fmt.Sprintf(format, args...)}
}

// handleWebsitesRoot 处理 /v1/websites
func (h *websiteHandler) handleWebsitesRoot(w http.ResponseWriter, r *http.Request) {
	// /v1/websites/capability 特殊处理
	if strings.HasPrefix(r.URL.Path, "/v1/websites/capability") {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
			return
		}
		h.handleCapability(w, r)
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.handleListSites(w, r)
	case http.MethodPost:
		h.handleCreateSite(w, r)
	default:
		w.Header().Set("Allow", strings.Join([]string{http.MethodGet, http.MethodPost}, ", "))
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
	}
}

// handleWebsitesByID 处理 /v1/websites/{siteId}/* 子路径
func (h *websiteHandler) handleWebsitesByID(w http.ResponseWriter, r *http.Request) {
	// 提取 siteId: /v1/websites/{siteId}/...
	path := strings.TrimPrefix(r.URL.Path, "/v1/websites/")
	parts := strings.SplitN(path, "/", 2)
	if len(parts) == 0 || parts[0] == "" {
		writeHTTPError(w, r, errcode.ErrWebsiteNotFound)
		return
	}
	siteID := parts[0]
	subPath := ""
	if len(parts) > 1 {
		subPath = parts[1]
	}

	// 特殊处理：/v1/websites/capability 被路由到这里（Go ServeMux 尾斜杠匹配）
	if siteID == "capability" && (subPath == "" || subPath == "/") {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
			return
		}
		h.handleCapability(w, r)
		return
	}

	// 路由分发
	switch {
	case subPath == "" || subPath == "/":
		switch r.Method {
		case http.MethodGet:
			h.handleGetSite(w, r, siteID)
		case http.MethodDelete:
			h.handleDeleteSite(w, r, siteID)
		default:
			writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		}

	case strings.HasPrefix(subPath, "releases"):
		h.handleReleases(w, r, siteID, subPath)

	case strings.HasPrefix(subPath, "operations/"):
		opID := strings.TrimPrefix(subPath, "operations/")
		h.handleGetOperation(w, r, opID)

	default:
		writeHTTPError(w, r, errcode.ErrWebsiteNotFound)
	}
}

// handleInternalSite 处理 /internal/ctl/websites/sites/{siteId}[/storage]
//
//	GET  {siteId}          站点网关的状态 + 额度门禁查询（网关侧有短 TTL 缓存）
//	POST {siteId}/storage  deployer 在发布/删除后回填站点存储用量
func (h *websiteHandler) handleInternalSite(w http.ResponseWriter, r *http.Request) {
	if !hasValidWebsiteInternalToken(r.Header.Get("X-Internal-Token")) {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/internal/ctl/websites/sites/")
	parts := strings.SplitN(path, "/", 2)
	siteID := parts[0]
	if siteID == "" {
		writeHTTPError(w, r, errcode.ErrWebsiteNotFound)
		return
	}

	if len(parts) == 2 && parts[1] != "" {
		if parts[1] != "storage" {
			writeHTTPError(w, r, errcode.ErrWebsiteNotFound)
			return
		}
		h.handleInternalSiteStorage(w, r, siteID)
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	site, err := h.logic.GetSiteInternal(siteID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, site)
}

// handleInternalSiteStorage 处理 POST /internal/ctl/websites/sites/{siteId}/storage
//
// 上报的是绝对值而不是增量：deployer 每次都重新列一遍该站点的全部对象，
// 所以覆盖式写入天然幂等，重试不会让用量翻倍——这一点和流量上报正好相反。
func (h *websiteHandler) handleInternalSiteStorage(w http.ResponseWriter, r *http.Request, siteID string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	var req struct {
		StorageBytes int64 `json:"storage_bytes"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "%s", err.Error()))
		return
	}
	if err := h.logic.UpdateSiteStorage(siteID, req.StorageBytes); err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, map[string]interface{}{
		"site_id":       siteID,
		"storage_bytes": req.StorageBytes,
	})
}

// handleInternalUsage 处理 POST /internal/ctl/websites/usage
//
// 站点网关每分钟调一次，一个请求带上该窗口内所有有流量的站点。
// 刻意做成批量而非逐请求上报：站点流量的量级远大于业务接口，逐请求上报会让
// ctl 承受站点的全部 QPS，而这个数字本来只需要分钟级精度。
func (h *websiteHandler) handleInternalUsage(w http.ResponseWriter, r *http.Request) {
	if !hasValidWebsiteInternalToken(r.Header.Get("X-Internal-Token")) {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}

	var req struct {
		// WindowID 只用于日志关联，服务端不拿它去重（累加语义无法幂等，
		// 取舍说明见 websitelogic.RecordTrafficUsage）。
		WindowID string                            `json:"window_id"`
		Reports  []websitelogic.TrafficUsageReport `json:"reports"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "%s", err.Error()))
		return
	}
	if len(req.Reports) > maxUsageReportsPerRequest {
		writeHTTPError(w, r, invalidWebsiteParam(
			"reports exceeds %d entries", maxUsageReportsPerRequest))
		return
	}

	accepted, err := h.logic.RecordTrafficUsage(req.Reports)
	if err != nil {
		// 部分失败也回非 2xx：网关据此把整批增量并回内存，下一个窗口重试。
		// 已入账的那部分会因此被重复计一次，这是明确接受的误差（不是计费凭据）。
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, map[string]interface{}{
		"accepted": accepted,
		"received": len(req.Reports),
	})
}

// maxUsageReportsPerRequest 限制单次上报的站点数，避免一个畸形请求让 ctl
// 在一个事务外做无上限的逐站点查询。网关侧的内存上界比这个值小一个量级。
const maxUsageReportsPerRequest = 5000

// handleInternalOperations 处理 /internal/ctl/websites/operations[/{opId}/claim|complete|fail]
func (h *websiteHandler) handleInternalOperations(w http.ResponseWriter, r *http.Request) {
	// Internal operation mutation is fail-closed. A misconfigured worker must
	// not gain access simply because its shared token was omitted.
	if !hasValidWebsiteInternalToken(r.Header.Get("X-Internal-Token")) {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	// GET /internal/ctl/websites/operations?status=created — worker 轮询待执行操作
	if r.Method == http.MethodGet && (r.URL.Path == "/internal/ctl/websites/operations" || r.URL.Path == "/internal/ctl/websites/operations/") {
		h.handleListPendingOperations(w, r)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/internal/ctl/websites/operations/")
	if path == "" {
		writeHTTPError(w, r, errcode.ErrWebsiteOperationNotFound)
		return
	}
	parts := strings.SplitN(path, "/", 2)
	opID := parts[0]

	// GET /internal/ctl/websites/operations/{opId} — deployer BLPOP 后查单条
	if len(parts) == 1 && r.Method == http.MethodGet {
		op, err := h.logic.GetOperationInternal(opID)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, op)
		return
	}
	if len(parts) < 2 {
		writeHTTPError(w, r, errcode.ErrWebsiteOperationNotFound)
		return
	}
	action := parts[1]

	switch {
	case action == "claim" && r.Method == http.MethodPost:
		var req struct {
			WorkerID     string `json:"worker_id"`
			LeaseSeconds int    `json:"lease_seconds"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "%s", err.Error()))
			return
		}
		leaseTTL := time.Duration(req.LeaseSeconds) * time.Second
		if leaseTTL <= 0 {
			leaseTTL = 15 * time.Minute
		}
		if leaseTTL > time.Hour {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "lease_seconds exceeds 3600"))
			return
		}
		op, claimed, err := h.logic.ClaimOperation(opID, req.WorkerID, leaseTTL)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, map[string]interface{}{"claimed": claimed, "operation": op})

	case action == "complete" && r.Method == http.MethodPost:
		var req struct {
			CloudPath  string `json:"cloud_path"`
			PublicURL  string `json:"public_url"`
			LeaseToken string `json:"lease_token"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "%s", err.Error()))
			return
		}
		if err := h.logic.CompleteOperation(opID, req.LeaseToken, req.CloudPath, req.PublicURL); err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, map[string]string{"status": "completed"})

	case action == "fail" && r.Method == http.MethodPost:
		var req struct {
			ErrorMessage string `json:"error_message"`
			LeaseToken   string `json:"lease_token"`
		}
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "%s", err.Error()))
			return
		}
		if err := h.logic.FailOperation(opID, req.LeaseToken, req.ErrorMessage); err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, map[string]string{"status": "failed"})

	// POST /internal/ctl/websites/operations/{opId}/revive — 运维把 dead 操作重新投入执行。
	//
	// 与 claim/complete/fail 同为「对某个操作施加一个动作」，所以沿用同样的
	// {opId}/{action} 形状和同一把 X-Internal-Token。故意不开放成用户接口：
	// 复活的前提是运维已经确认根因修好，用户自助重放只会把同一个失败再跑一遍。
	case action == "revive" && r.Method == http.MethodPost:
		op, err := h.logic.ReviveOperation(opID)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, map[string]interface{}{"status": "revived", "operation": op})

	default:
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
	}
}

// ---- GET /v1/websites/capability ----

func (h *websiteHandler) handleCapability(w http.ResponseWriter, r *http.Request) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	userID := ctx.GetUserID()

	cap, err := h.logic.GetCapability(userID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, cap)
}

// ---- POST /v1/websites ----

func (h *websiteHandler) handleCreateSite(w http.ResponseWriter, r *http.Request) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	userID := ctx.GetUserID()

	var req struct {
		Name           string `json:"name"`
		BundleID       string `json:"bundle_id"`
		PassID         string `json:"pass_id"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if err := decodeJSONBody(r, &req); err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "%s", err.Error()))
		return
	}
	if req.Name == "" {
		writeHTTPError(w, r, invalidWebsiteParam("name is required"))
		return
	}
	if len(req.Name) > 100 {
		writeHTTPError(w, r, invalidWebsiteParam("name too long (max 100 chars), got %d", len(req.Name)))
		return
	}
	// bundle_id 必填。缺失时 CreateSite 会拿空串去比当前 Pass 的 bundle_id，
	// 报出「bundle_id does not match current pass」——调用方（建站 Skill）看到这句
	// 会以为自己传错了套餐，而真实原因是根本没传。
	if req.BundleID == "" {
		writeHTTPError(w, r, invalidWebsiteParam(
			"bundle_id is required and must match the bundle_id of the current active pass"))
		return
	}

	result, err := h.logic.CreateSite(userID, req.BundleID, req.Name, req.IdempotencyKey)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusCreated, result)
}

// ---- GET /v1/websites ----

func (h *websiteHandler) handleListSites(w http.ResponseWriter, r *http.Request) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	userID := ctx.GetUserID()

	page, pageSize, err := parsePagination(r)
	if err != nil {
		writeHTTPError(w, r, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "%s", err.Error()))
		return
	}

	sites, total, err := h.logic.ListSites(userID, page, pageSize)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, map[string]interface{}{
		"sites":     sites,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	})
}

// ---- GET /v1/websites/{siteId} ----

func (h *websiteHandler) handleGetSite(w http.ResponseWriter, r *http.Request, siteID string) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	userID := ctx.GetUserID()

	site, err := h.logic.GetSite(userID, siteID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, site)
}

// ---- DELETE /v1/websites/{siteId} ----

func (h *websiteHandler) handleDeleteSite(w http.ResponseWriter, r *http.Request, siteID string) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	userID := ctx.GetUserID()

	result, err := h.logic.DeleteSite(userID, siteID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, result)
}

// ---- POST /v1/websites/{siteId}/releases ----

func (h *websiteHandler) handleReleases(w http.ResponseWriter, r *http.Request, siteID, subPath string) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	userID := ctx.GetUserID()

	// /v1/websites/{siteId}/releases  or /v1/websites/{siteId}/releases/{releaseId}
	switch subPath {
	case "releases", "releases/":
		switch r.Method {
		case http.MethodPost:
			var req websitelogic.CreateReleaseRequest
			if err := decodeJSONBody(r, &req); err != nil {
				writeHTTPError(w, r, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "%s", err.Error()))
				return
			}
			result, err := h.logic.CreateRelease(userID, siteID, req)
			if err != nil {
				writeHTTPError(w, r, err)
				return
			}
			writeSuccess(w, r, http.StatusCreated, result)

		case http.MethodGet:
			page, pageSize, err := parsePagination(r)
			if err != nil {
				writeHTTPError(w, r, errcode.Wrap(errcode.ErrWebsiteInvalidParam, "%s", err.Error()))
				return
			}
			releases, total, err := h.logic.ListReleases(userID, siteID, page, pageSize)
			if err != nil {
				writeHTTPError(w, r, err)
				return
			}
			writeSuccess(w, r, http.StatusOK, map[string]interface{}{
				"releases":  releases,
				"total":     total,
				"page":      page,
				"page_size": pageSize,
			})

		default:
			writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		}

	default:
		writeHTTPError(w, r, errcode.ErrWebsiteReleaseNotFound)
	}
}

// handleListPendingOperations GET /internal/ctl/websites/operations?status=created
func (h *websiteHandler) handleListPendingOperations(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "created"
	}
	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if v, err := strconv.Atoi(l); err == nil && v > 0 && v <= 100 {
			limit = v
		}
	}

	ops, err := h.logic.ListPendingOperations(status, limit)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, map[string]interface{}{
		"operations": ops,
		"count":      len(ops),
	})
}

// ---- GET /v1/websites/{siteId}/operations/{opId} ----

func (h *websiteHandler) handleGetOperation(w http.ResponseWriter, r *http.Request, operationID string) {
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrUnauthorized)
		return
	}
	userID := ctx.GetUserID()

	if r.Method != http.MethodGet {
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	op, err := h.logic.GetOperation(userID, operationID)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, op)
}
