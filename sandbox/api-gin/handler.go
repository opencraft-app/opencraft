package main

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	api "cvm-mock-e2b/api-gin/gen"
	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/observability"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/route"
	"cvm-mock-e2b/internal/service"
)

// handler implements the generated ServerInterface.
type handler struct {
	svc                 *service.Service
	routes              route.Store
	commands            provider.CommandRunner
	invocations         provider.CommandInvoker
	terminals           provider.TerminalSessionStarter
	terminalCommands    provider.TerminalCommandStreamer
	cloud               provider.CloudProvider
	metrics             *observability.APIMetrics
	allowedTATCommandID string

	// cloudPauseResume controls Stop/Start based pause/resume semantics. It
	// defaults on because billing/pass lifecycle isolation needs real cloud
	// shutdown; tests and emergency rollback can set it false to restore legacy
	// release/no-op behavior.
	cloudPauseResume bool
}

const superPoolMaxAttempts = 10

type sandboxResolutionFields struct {
	TemplateClassID      *string
	ResolutionMode       *string
	ResolutionSource     *string
	ResolutionDivergence *string
}

// Helpers to map domain Instance + Sandbox to OpenAPI models.
func toSandbox(inst core.Instance, pool core.Pool, sb core.Sandbox) api.Sandbox {
	resolution := sandboxResolutionPointers(sb)
	return api.Sandbox{
		TemplateID:           pool.ID,
		TemplateClassID:      resolution.TemplateClassID,
		SandboxID:            sb.ID,
		ClientID:             pool.Name,
		EnvdVersion:          api.EnvdVersion("1.0.0"),
		EnvdAccessToken:      nil,
		Domain:               nil,
		ResolutionMode:       resolution.ResolutionMode,
		ResolutionSource:     resolution.ResolutionSource,
		ResolutionDivergence: resolution.ResolutionDivergence,
	}
}

func toSandboxDetail(inst core.Instance, pool core.Pool, sb core.Sandbox) api.SandboxDetail {
	state := mapInstanceState(inst.State)
	meta := api.SandboxMetadata{}
	resolution := sandboxResolutionPointers(sb)
	if sb.Metadata != nil {
		meta = sb.Metadata
	}
	return api.SandboxDetail{
		TemplateID:           pool.ID,
		TemplateClassID:      resolution.TemplateClassID,
		SandboxID:            sb.ID,
		CloudID:              stringPtr(inst.CloudID),
		Region:               stringPtr(sb.Region),
		Alias:                nil,
		ClientID:             pool.Name,
		StartedAt:            sb.CreatedAt,
		EndAt:                sb.CreatedAt.Add(time.Duration(sb.TimeoutSeconds) * time.Second),
		EnvdVersion:          api.EnvdVersion("1.0.0"),
		EnvdAccessToken:      nil,
		Domain:               nil,
		CpuCount:             api.CPUCount(1),
		MemoryMB:             api.MemoryMB(1024),
		DiskSizeMB:           api.DiskSizeMB(10240),
		Metadata:             &meta,
		State:                state,
		ResolutionMode:       resolution.ResolutionMode,
		ResolutionSource:     resolution.ResolutionSource,
		ResolutionDivergence: resolution.ResolutionDivergence,
	}
}

func toListedSandbox(inst core.Instance, pool core.Pool, sb core.Sandbox) api.ListedSandbox {
	d := toSandboxDetail(inst, pool, sb)
	return api.ListedSandbox{
		TemplateID:           d.TemplateID,
		TemplateClassID:      d.TemplateClassID,
		Alias:                d.Alias,
		SandboxID:            d.SandboxID,
		ClientID:             d.ClientID,
		StartedAt:            d.StartedAt,
		EndAt:                d.EndAt,
		CpuCount:             d.CpuCount,
		MemoryMB:             d.MemoryMB,
		DiskSizeMB:           d.DiskSizeMB,
		Metadata:             d.Metadata,
		State:                d.State,
		EnvdVersion:          d.EnvdVersion,
		ResolutionMode:       d.ResolutionMode,
		ResolutionSource:     d.ResolutionSource,
		ResolutionDivergence: d.ResolutionDivergence,
	}
}

// GET /sandboxes
func (h *handler) GetSandboxes(c *gin.Context, _ api.GetSandboxesParams) {
	sandboxes, err := h.svc.ListSandboxes(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]api.ListedSandbox, 0, len(sandboxes))
	for _, sb := range sandboxes {
		inst, err := h.svc.GetInstance(c.Request.Context(), sb.InstanceID)
		if err != nil {
			continue // skip broken mapping
		}
		pool, err := h.svc.GetPool(c.Request.Context(), sb.PoolID)
		if err != nil {
			continue
		}
		out = append(out, toListedSandbox(inst, pool, sb))
	}
	c.JSON(http.StatusOK, out)
}

// POST /sandboxes
func (h *handler) PostSandboxes(c *gin.Context) {
	var req struct {
		api.NewSandbox
		TemplateClassIDSnake *string `json:"template_class_id,omitempty"`
		SKUID                *string `json:"sku_id,omitempty"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	var (
		pool       core.Pool
		inst       core.Instance
		err        error
		resolution service.AllocationResolution
	)
	templateID := ""
	templateClassID := ""
	skuID := ""
	if req.TemplateID != nil {
		templateID = strings.TrimSpace(*req.TemplateID)
	}
	if req.TemplateClassID != nil {
		templateClassID = strings.TrimSpace(*req.TemplateClassID)
	}
	if templateClassID == "" && req.TemplateClassIDSnake != nil {
		templateClassID = strings.TrimSpace(*req.TemplateClassIDSnake)
	}
	if req.SKUID != nil {
		skuID = strings.TrimSpace(*req.SKUID)
	}
	resolution, err = h.svc.AllocateForRequest(c.Request.Context(), templateClassID, templateID, skuID)
	pool = resolution.Pool
	inst = resolution.Instance
	if err != nil {
		if errors.Is(err, core.ErrPoolNotFound) || errors.Is(err, core.ErrTemplateClassNotFound) || errors.Is(err, core.ErrSKUNotFound) {
			if h.metrics != nil {
				h.metrics.ObserveSandboxCreate(sandboxCreateTarget(templateClassID, templateID), "pool_not_found")
			}
			c.JSON(http.StatusNotFound, gin.H{"error": "template, template class, or sku not found"})
			return
		}
		if err == core.ErrNoCleanInstance {
			if h.metrics != nil {
				h.metrics.ObserveSandboxCreate(observedPoolID(pool), "no_capacity")
			}
			c.JSON(http.StatusConflict, gin.H{"error": "no capacity"})
			return
		}
		if h.metrics != nil {
			h.metrics.ObserveSandboxCreate(observedPoolID(pool), "error")
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	sb := core.Sandbox{
		ID:                   uuid.NewString(),
		InstanceID:           inst.ID,
		PoolID:               pool.ID,
		TemplateClassID:      resolution.TemplateClassID,
		ResolutionMode:       resolution.ResolutionMode,
		ResolutionSource:     resolution.ResolutionSource,
		ResolutionDivergence: resolution.Divergence,
		Region:               regionFromPool(pool),
		Metadata:             mapMetadata(req.Metadata),
		EnvVars:              mapEnvVars(req.EnvVars),
		TimeoutSeconds:       defaultTimeout(req.Timeout),
		AutoPause:            boolOr(req.AutoPause, false),
		Secure:               boolOr(req.Secure, false),
		AllowInternetAccess:  boolOr(req.AllowInternetAccess, false),
	}
	sb, err = h.svc.CreateSandbox(c.Request.Context(), sb)
	if err != nil {
		if h.metrics != nil {
			h.metrics.ObserveSandboxCreate(pool.ID, "error")
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.routes != nil && inst.Address != "" {
		if err := h.routes.Set(c.Request.Context(), route.Rule{
			SandboxID:  sb.ID,
			InstanceID: inst.ID,
			Address:    inst.Address,
		}); err != nil {
			log.Printf("[api] route write failed sandbox=%s instance=%s addr=%s err=%v", sb.ID, inst.ID, inst.Address, err)
		}
	}
	log.Printf("[api] sandbox created id=%s pool=%s instance=%s metadata=%d envvars=%d timeout=%ds autopause=%t secure=%t internet=%t",
		sb.ID, pool.ID, inst.ID, len(sb.Metadata), len(sb.EnvVars), sb.TimeoutSeconds, sb.AutoPause, sb.Secure, sb.AllowInternetAccess)
	if h.metrics != nil {
		h.metrics.ObserveSandboxCreate(pool.ID, "success")
	}
	c.JSON(http.StatusCreated, toSandbox(inst, pool, sb))
}

// DELETE /sandboxes/{sandboxID}
//
// Best-effort release + delete. Release is intentionally non-fatal because the
// caller already considers the sandbox terminated; however we must surface
// release failures via logs so leftover instances (e.g. stuck in CREATING /
// RESETTING / PAUSING) are visible in operational dashboards. Release now
// accepts ALLOCATED → DRY, PAUSED → DRY (trade pass destroy on an isolated
// sandbox) and DRY (idempotent retry); see service.Release for the full
// transition matrix.
func (h *handler) DeleteSandboxesSandboxID(c *gin.Context, sandboxID api.SandboxID) {
	sb, err := h.svc.GetSandbox(c.Request.Context(), string(sandboxID))
	if err != nil {
		if err == core.ErrSandboxNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Release instance back to DRY so the reset worker can reinstall it. If the
	// instance is in a state Release does not accept (e.g. CREATING / RESETTING
	// / PAUSING), we log a warning so it shows up in operational dashboards but
	// still continue to delete the sandbox row, matching the historical
	// best-effort contract that DELETE always returns 204 once the sandbox row
	// itself is gone.
	if _, err := h.svc.Release(c.Request.Context(), sb.InstanceID); err != nil {
		log.Printf("[api] sandbox delete: release instance failed sandbox=%s instance=%s err=%v (instance may leak; reset worker won't pick it up unless it reaches DRY/RESETTING)", sb.ID, sb.InstanceID, err)
	}
	if err := h.svc.DeleteSandbox(c.Request.Context(), sb.ID); err != nil {
		log.Printf("[api] sandbox delete: delete sandbox row failed sandbox=%s err=%v", sb.ID, err)
	}
	if h.routes != nil {
		if err := h.routes.Delete(c.Request.Context(), sb.ID); err != nil {
			log.Printf("[api] route delete failed sandbox=%s err=%v", sb.ID, err)
		}
	}
	c.Status(http.StatusNoContent)
}

// POST /sandboxes/{sandboxID}/snapshot
//
// trade pass destroy flow (sec5.2 of .tmp/trade-pass-destroy-design.md, Q4/Q9/Q25 ✅ 拍板).
// Resolve sandbox → instance → cvm CloudID, then call CloudProvider.CreateInstanceSnapshot.
//
// Error mapping:
//   - sandbox not found / instance not found    → 404
//   - request body validation failed             → 400
//   - provider returns ErrInstanceNoSystemDisk   → 422 with code=INSTANCE_NO_SYSTEM_DISK
//     (Q10 + Q25 联动: ctl child-task skips snapshot stages)
//   - all other provider errors                  → 502 (cbs upstream)
//   - cloud provider not wired (e.g. mock-only test) → 501
func (h *handler) PostSandboxesSandboxIDSnapshot(c *gin.Context, sandboxID api.SandboxID) {
	ctx := c.Request.Context()

	var body api.CreateSandboxSnapshotRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body: " + err.Error()})
		return
	}
	if strings.TrimSpace(body.InstanceID) == "" || strings.TrimSpace(body.PassID) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "instanceID and passID are required"})
		return
	}
	if body.RetentionSeconds <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "retentionSeconds must be > 0"})
		return
	}

	sb, err := h.svc.GetSandbox(ctx, string(sandboxID))
	if err != nil {
		if err == core.ErrSandboxNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	inst, err := h.svc.GetInstance(ctx, sb.InstanceID)
	if err != nil {
		if err == core.ErrInstanceNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "instance not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.cloud == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "snapshot endpoint requires a cloud provider"})
		return
	}
	if strings.TrimSpace(inst.CloudID) == "" {
		// No cloud-side instance allocated for this sandbox; treat as no system disk
		// so ctl child-task gracefully skips stages 1+2 per Q10 联动.
		c.JSON(http.StatusUnprocessableEntity, gin.H{
			"code":  "INSTANCE_NO_SYSTEM_DISK",
			"error": "instance has no cloud-side allocation; snapshot skipped",
		})
		return
	}

	deadline := time.Now().Add(time.Duration(body.RetentionSeconds) * time.Second)
	snapshotID, err := h.cloud.CreateInstanceSnapshot(ctx, provider.CreateInstanceSnapshotRequest{
		CloudID:    inst.CloudID,
		PassID:     body.PassID,
		InstanceID: body.InstanceID,
		UserID:     body.UserID,
		Deadline:   deadline,
	})
	if err != nil {
		if errors.Is(err, provider.ErrInstanceNoSystemDisk) {
			c.JSON(http.StatusUnprocessableEntity, gin.H{
				"code":  "INSTANCE_NO_SYSTEM_DISK",
				"error": "instance has no system disk",
			})
			return
		}
		log.Printf("[api] snapshot create failed sandbox=%s instance=%s cloud=%s err=%v",
			sb.ID, sb.InstanceID, inst.CloudID, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, api.CreateSandboxSnapshotResponse{SnapshotID: snapshotID})
}

// GET /sandboxes/{sandboxID}/snapshot-status
//
// trade pass destroy flow (sec5.2 of .tmp/trade-pass-destroy-design.md, Q4/Q9 ✅ 拍板).
// Maps cbs SnapshotState into the abstract status:
//
//	CREATING → in_progress / NORMAL → ready / others → failed.
//
// Error mapping:
//   - missing snapshotID query param           → 400
//   - sandbox not found                         → 404
//   - provider returns ErrSnapshotNotFound      → 404
//   - cloud provider not wired                  → 501
//   - other provider errors                     → 502
func (h *handler) GetSandboxesSandboxIDSnapshotStatus(c *gin.Context, sandboxID api.SandboxID, params api.GetSandboxesSandboxIDSnapshotStatusParams) {
	ctx := c.Request.Context()

	if strings.TrimSpace(params.SnapshotID) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "snapshotID query parameter is required"})
		return
	}
	if _, err := h.svc.GetSandbox(ctx, string(sandboxID)); err != nil {
		if err == core.ErrSandboxNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.cloud == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "snapshot-status endpoint requires a cloud provider"})
		return
	}
	status, reason, err := h.cloud.DescribeInstanceSnapshot(ctx, params.SnapshotID)
	if err != nil {
		if errors.Is(err, provider.ErrSnapshotNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "snapshot not found"})
			return
		}
		log.Printf("[api] snapshot-status failed sandbox=%s snap=%s err=%v",
			string(sandboxID), params.SnapshotID, err)
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	resp := api.GetSandboxSnapshotStatusResponse{
		Status: api.GetSandboxSnapshotStatusResponseStatus(status),
	}
	if reason != "" {
		resp.Reason = &reason
	}
	c.JSON(http.StatusOK, resp)
}

// GET /sandboxes/{sandboxID}
func (h *handler) GetSandboxesSandboxID(c *gin.Context, sandboxID api.SandboxID) {
	sb, err := h.svc.GetSandbox(c.Request.Context(), string(sandboxID))
	if err != nil {
		if err == core.ErrSandboxNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	inst, err := h.svc.GetInstance(c.Request.Context(), sb.InstanceID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	pool, err := h.svc.GetPool(c.Request.Context(), sb.PoolID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, toSandboxDetail(inst, pool, sb))
}

// Logs
func (h *handler) GetSandboxesSandboxIDLogs(c *gin.Context, _ api.SandboxID, _ api.GetSandboxesSandboxIDLogsParams) {
	empty := api.SandboxLogs{Logs: []api.SandboxLog{}, LogEntries: []api.SandboxLogEntry{}}
	c.JSON(http.StatusOK, empty)
}

// Pause -> shut down the underlying instance while preserving disk data.
//
// Implements Q26-D 修订版 + Q29=E5 + Q33=a 拍板（2026-05-14）：
//   - 旧实现是 best-effort Release（ALLOCATED→DRY），会让 worker 立刻把数据盘
//     重装清空，对应 trade pass isolation 是错误语义（用户付费暂停期希望保留数据）。
//   - 新实现走"关机保留数据"路径：CAS ALLOCATED→PAUSING → 同步调
//     cp.StopInstance（cvm StopInstances + StoppedMode=STOP_CHARGING） →
//     CAS PAUSING→PAUSED → 204。
//   - 同步范式（Q37）：HTTP 层阻塞最多 ~3min 等 cvm STOPPED；超时/失败回滚到
//     ALLOCATED 并返回 5xx，由上游 ctl 子 task 走 1h 重试窗口（Q22-I-D / Q36=a）。
func (h *handler) PostSandboxesSandboxIDPause(c *gin.Context, sandboxID api.SandboxID) {
	if !h.cloudPauseResume {
		sb, err := h.svc.GetSandbox(c.Request.Context(), string(sandboxID))
		if err == nil {
			_, _ = h.svc.Release(c.Request.Context(), sb.InstanceID)
		}
		c.Status(http.StatusNoContent)
		return
	}

	ctx := c.Request.Context()
	sb, err := h.svc.GetSandbox(ctx, string(sandboxID))
	if err != nil {
		if errors.Is(err, core.ErrSandboxNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	inst, err := h.svc.GetInstance(ctx, sb.InstanceID)
	if err != nil {
		if errors.Is(err, core.ErrInstanceNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox instance not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Re-entry short-circuit: already paused → 204 (idempotent).
	if inst.State == core.StatePaused {
		c.Status(http.StatusNoContent)
		return
	}
	// CAS ALLOCATED → PAUSING (idempotent for PAUSING/PAUSED).
	pausing, err := h.svc.Pause(ctx, sb.InstanceID)
	if err != nil {
		if errors.Is(err, core.ErrInvalidTransition) {
			c.JSON(http.StatusConflict, gin.H{"error": "instance not allocated; cannot pause"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if pausing.State == core.StatePaused {
		c.Status(http.StatusNoContent)
		return
	}
	// Sync stop the cloud instance. cp may be nil in unit tests; treat as no-op.
	if h.cloud != nil && strings.TrimSpace(pausing.CloudID) != "" {
		if err := h.cloud.StopInstance(ctx, pausing.CloudID); err != nil {
			// Roll back to ALLOCATED so upstream ctl child-task can retry.
			if _, rbErr := h.svc.RollbackPausing(ctx, sb.InstanceID); rbErr != nil {
				log.Printf("[api] pause rollback failed sandbox=%s instance=%s err=%v rollback_err=%v",
					sb.ID, sb.InstanceID, err, rbErr)
			}
			c.JSON(http.StatusBadGateway, gin.H{"error": "stop instance failed: " + err.Error()})
			return
		}
	}
	// CAS PAUSING → PAUSED.
	if _, err := h.svc.MarkPaused(ctx, sb.InstanceID); err != nil {
		// Rare: state drifted between StopInstance ack and MarkPaused (e.g. concurrent rollback).
		c.JSON(http.StatusInternalServerError, gin.H{"error": "mark paused failed: " + err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

// Refresh -> no-op 204
func (h *handler) PostSandboxesSandboxIDRefreshes(c *gin.Context, _ api.SandboxID) {
	c.Status(http.StatusNoContent)
}

// Resume -> start the underlying instance back up while preserving disk data.
//
// Implements R-F（2026-05-15，对偶 Pause 侧 Q26-D 修订版）：
//   - 旧实现是 noop（仅读 sandbox + 201 返回，不调任何 cloud 接口），
//     等价于 trade pass renew DB 翻牌但 CVM 不开机 → P0 资金损失级缺口。
//   - 新实现走"开机恢复数据"路径：CAS PAUSED→RESUMING → 同步调
//     cp.StartInstance（cvm StartInstances + 轮询 RUNNING 180s deadline） →
//     CAS RESUMING→ALLOCATED → 201 + Sandbox JSON body（保留协议契约）。
//   - 协议契约（与 Pause 的 204 No Content 不同）：返回 201 + ResumedSandbox body，
//     ctl 侧 instance/logic.go 的 resumeSandbox 期望此契约（含 idempotent
//     "sandbox already running" 走 expectedResumeConflictMessages 兜底）。
//   - 失败回滚（Q4 / R-F）：cp.StartInstance 失败 → RollbackResuming RESUMING→PAUSED
//     → 502，由上游 ctl 子 task 走 1h 重试窗口。
//   - Idempotent 路径：inst.State 已是 ALLOCATED → 直接 201 + body 不调 cp（重投兜底）。
//   - State 既非 PAUSED 也非 ALLOCATED/RESUMING → 409，避免误开机污染状态机。
func (h *handler) PostSandboxesSandboxIDResume(c *gin.Context, sandboxID api.SandboxID) {
	if !h.cloudPauseResume {
		sb, err := h.svc.GetSandbox(c.Request.Context(), string(sandboxID))
		if err != nil {
			if err == core.ErrSandboxNotFound {
				c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		inst, err := h.svc.GetInstance(c.Request.Context(), sb.InstanceID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		pool, err := h.svc.GetPool(c.Request.Context(), sb.PoolID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusCreated, toSandbox(inst, pool, sb))
		return
	}

	ctx := c.Request.Context()
	sb, err := h.svc.GetSandbox(ctx, string(sandboxID))
	if err != nil {
		if errors.Is(err, core.ErrSandboxNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	inst, err := h.svc.GetInstance(ctx, sb.InstanceID)
	if err != nil {
		if errors.Is(err, core.ErrInstanceNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox instance not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	pool, err := h.svc.GetPool(ctx, sb.PoolID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Re-entry short-circuit: already allocated → 201 + body (idempotent;
	// upstream ctl's expectedResumeConflictMessages also treats this as success).
	if inst.State == core.StateAllocated {
		c.JSON(http.StatusCreated, toSandbox(inst, pool, sb))
		return
	}
	// CAS PAUSED → RESUMING (idempotent for RESUMING/ALLOCATED).
	resuming, err := h.svc.Resume(ctx, sb.InstanceID)
	if err != nil {
		if errors.Is(err, core.ErrInvalidTransition) {
			c.JSON(http.StatusConflict, gin.H{"error": "instance not paused; cannot resume"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if resuming.State == core.StateAllocated {
		c.JSON(http.StatusCreated, toSandbox(resuming, pool, sb))
		return
	}
	// Sync start the cloud instance. cp may be nil in unit tests; treat as no-op.
	if h.cloud != nil && strings.TrimSpace(resuming.CloudID) != "" {
		if err := h.cloud.StartInstance(ctx, resuming.CloudID); err != nil {
			// Roll back to PAUSED so upstream ctl child-task can retry within the 1h window.
			if _, rbErr := h.svc.RollbackResuming(ctx, sb.InstanceID); rbErr != nil {
				log.Printf("[api] resume rollback failed sandbox=%s instance=%s err=%v rollback_err=%v",
					sb.ID, sb.InstanceID, err, rbErr)
			}
			c.JSON(http.StatusBadGateway, gin.H{"error": "start instance failed: " + err.Error()})
			return
		}
	}
	// CAS RESUMING → ALLOCATED.
	allocated, err := h.svc.MarkResumed(ctx, sb.InstanceID)
	if err != nil {
		// Rare: state drifted between StartInstance ack and MarkResumed (e.g. concurrent rollback).
		c.JSON(http.StatusInternalServerError, gin.H{"error": "mark resumed failed: " + err.Error()})
		return
	}
	c.JSON(http.StatusCreated, toSandbox(allocated, pool, sb))
}

// Timeout -> 204
func (h *handler) PostSandboxesSandboxIDTimeout(c *gin.Context, _ api.SandboxID) {
	c.Status(http.StatusNoContent)
}

// GET /v2/sandboxes with simple state filter + optional limit
func (h *handler) GetV2Sandboxes(c *gin.Context, params api.GetV2SandboxesParams) {
	sandboxes, err := h.svc.ListSandboxes(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	stateFilter := mapSandboxStates(params.State)
	out := make([]api.ListedSandbox, 0, len(sandboxes))
	for _, sb := range sandboxes {
		inst, err := h.svc.GetInstance(c.Request.Context(), sb.InstanceID)
		if err != nil {
			continue
		}
		pool, err := h.svc.GetPool(c.Request.Context(), sb.PoolID)
		if err != nil {
			continue
		}
		if len(stateFilter) > 0 && !stateFilter[mapInstanceState(inst.State)] {
			continue
		}
		out = append(out, toListedSandbox(inst, pool, sb))
		if params.Limit != nil && len(out) >= int(*params.Limit) {
			c.JSON(http.StatusOK, out)
			return
		}
	}
	c.JSON(http.StatusOK, out)
}

// mapInstanceState converts domain state to openapi SandboxState.
//
// StateDry remains mapped to api.Paused for backward compatibility with
// existing clients that observed "paused" while a release-then-reinstall
// was in flight on the legacy path. The new pause path goes through
// StatePausing/StatePaused which both surface as api.Paused (Q26-D 修订版 +
// Q29=E5 + Q32=b 拍板 2026-05-14).
func mapInstanceState(s core.InstanceState) api.SandboxState {
	switch s {
	case core.StateDry, core.StatePausing, core.StatePaused:
		return api.Paused
	default:
		return api.Running
	}
}

// mapSandboxStates builds a lookup map for filters.
func mapSandboxStates(states *[]api.SandboxState) map[api.SandboxState]bool {
	res := map[api.SandboxState]bool{}
	if states == nil {
		return res
	}
	for _, st := range *states {
		res[st] = true
	}
	return res
}

func boolOr(b *bool, def bool) bool {
	if b == nil {
		return def
	}
	return *b
}

func defaultTimeout(t *int32) int32 {
	if t == nil || *t == 0 {
		return 15
	}
	return *t
}

func mapMetadata(m *api.SandboxMetadata) map[string]string {
	if m == nil {
		return nil
	}
	res := make(map[string]string, len(*m))
	for k, v := range *m {
		res[k] = v
	}
	return res
}

func stringPtr(v string) *string {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return &v
}

func sandboxResolutionPointers(sb core.Sandbox) sandboxResolutionFields {
	return sandboxResolutionFields{
		TemplateClassID:      stringPtr(sb.TemplateClassID),
		ResolutionMode:       stringPtr(string(sb.ResolutionMode)),
		ResolutionSource:     stringPtr(sb.ResolutionSource),
		ResolutionDivergence: stringPtr(sb.ResolutionDivergence),
	}
}

func observedPoolID(pool core.Pool) string {
	if pool.ID != "" {
		return pool.ID
	}
	return "super-pool"
}

func sandboxCreateTarget(templateClassID, templateID string) string {
	if templateClassID != "" {
		return templateClassID
	}
	if templateID != "" {
		return templateID
	}
	return "super-pool"
}

func mapEnvVars(m *api.EnvVars) map[string]string {
	if m == nil {
		return nil
	}
	res := make(map[string]string, len(*m))
	for k, v := range *m {
		res[k] = v
	}
	return res
}
