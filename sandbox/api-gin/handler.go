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
	svc       *service.Service
	routes    route.Store
	commands  provider.CommandRunner
	terminals provider.TerminalSessionStarter
	metrics   *observability.APIMetrics
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
		SKUID *string `json:"sku_id,omitempty"`
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
	// Release instance best-effort
	_, _ = h.svc.Release(c.Request.Context(), sb.InstanceID)
	_ = h.svc.DeleteSandbox(c.Request.Context(), sb.ID)
	if h.routes != nil {
		if err := h.routes.Delete(c.Request.Context(), sb.ID); err != nil {
			log.Printf("[api] route delete failed sandbox=%s err=%v", sb.ID, err)
		}
	}
	c.Status(http.StatusNoContent)
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

// Pause -> best-effort release
func (h *handler) PostSandboxesSandboxIDPause(c *gin.Context, sandboxID api.SandboxID) {
	sb, err := h.svc.GetSandbox(c.Request.Context(), string(sandboxID))
	if err == nil {
		_, _ = h.svc.Release(c.Request.Context(), sb.InstanceID)
	}
	c.Status(http.StatusNoContent)
}

// Refresh -> no-op 204
func (h *handler) PostSandboxesSandboxIDRefreshes(c *gin.Context, _ api.SandboxID) {
	c.Status(http.StatusNoContent)
}

// Resume -> return current sandbox
func (h *handler) PostSandboxesSandboxIDResume(c *gin.Context, sandboxID api.SandboxID) {
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
func mapInstanceState(s core.InstanceState) api.SandboxState {
	switch s {
	case core.StateDry:
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
