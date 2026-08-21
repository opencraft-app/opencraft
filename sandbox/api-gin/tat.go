package main

import (
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"cvm-mock-e2b/internal/core"
	"cvm-mock-e2b/internal/provider"
)

const (
	maxTATScriptBytes          = 64 * 1024
	defaultTATStatus           = "PENDING"
	defaultTATRegion           = ""
	tatCommandRoutePath        = "/sandboxes/:sandboxID/tat/commands"
	tatSessionRoutePath        = "/sandboxes/:sandboxID/tat/session"
	internalTATInvokeRoutePath = "/sandboxes/:sandboxID/tat/invocations"
	maxTATParameterCount       = 16
	maxTATParameterValueBytes  = 8 * 1024
)

var (
	tatCommandIDPattern     = regexp.MustCompile(`^cmd-[A-Za-z0-9]+$`)
	tatParameterNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
)

type postTATCommandRequest struct {
	Bash string `json:"bash"`
}

type postTATInvocationRequest struct {
	CommandID  string            `json:"command_id"`
	Parameters map[string]string `json:"parameters"`
}

type tatCommandResponse struct {
	SandboxID    string `json:"sandboxID"`
	PoolID       string `json:"poolID"`
	InstanceID   string `json:"instanceID"`
	Region       string `json:"region"`
	CommandID    string `json:"commandID"`
	InvocationID string `json:"invocationID"`
	Status       string `json:"status"`
}

type tatCommandResultResponse struct {
	tatCommandResponse
	ExitCode      int64  `json:"exitCode"`
	Output        string `json:"output"`
	ErrorInfo     string `json:"errorInfo,omitempty"`
	OutputURL     string `json:"outputURL,omitempty"`
	Dropped       int64  `json:"dropped,omitempty"`
	StartTime     string `json:"startTime,omitempty"`
	EndTime       string `json:"endTime,omitempty"`
	ExecutionTime string `json:"executionTime,omitempty"`
}

type tatCommandMetadataResponse struct {
	tatCommandResponse
	ExitCode      int64  `json:"exitCode"`
	StartTime     string `json:"startTime,omitempty"`
	EndTime       string `json:"endTime,omitempty"`
	ExecutionTime string `json:"executionTime,omitempty"`
}

type tatSessionResponse struct {
	SandboxID      string `json:"sandboxID"`
	PoolID         string `json:"poolID"`
	SessionID      string `json:"sessionId"`
	Region         string `json:"region"`
	InstanceID     string `json:"instanceId"`
	OwnerUin       string `json:"ownerUin"`
	LoginUin       string `json:"loginUin"`
	AppID          int64  `json:"appId"`
	WsURL          string `json:"wsUrl"`
	Cols           int    `json:"cols"`
	Rows           int    `json:"rows"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	Username       string `json:"username,omitempty"`
	WorkingDir     string `json:"workingDirectory,omitempty"`
}

func registerTATRoutes(r gin.IRouter, h *handler) {
	r.POST(tatSessionRoutePath, h.postSandboxTATSession)
	r.POST(tatCommandRoutePath, h.postSandboxTATCommand)
	r.GET(tatCommandRoutePath+"/:invocationID", h.getSandboxTATCommand)
}

func (h *handler) postSandboxTATSession(c *gin.Context) {
	if h.terminals == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "tat terminal unavailable"})
		return
	}

	sandboxID := strings.TrimSpace(c.Param("sandboxID"))
	sb, inst, pool, ok := h.resolveSandboxContext(c, sandboxID)
	if !ok {
		return
	}
	if strings.TrimSpace(inst.CloudID) == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "sandbox instance missing cloud id"})
		return
	}
	if strings.TrimSpace(sb.Region) == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "sandbox region missing"})
		return
	}

	session, err := h.terminals.StartTerminalSession(c.Request.Context(), sb.Region, inst.CloudID)
	if err != nil {
		log.Printf("[api] tat session start failed sandbox=%s pool=%s instance=%s cloud=%s region=%s err=%v",
			sb.ID, pool.ID, inst.ID, inst.CloudID, sb.Region, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(session.Region) == "" {
		session.Region = sb.Region
	}
	if strings.TrimSpace(session.InstanceID) == "" {
		session.InstanceID = inst.CloudID
	}
	if session.TimeoutSeconds <= 0 {
		session.TimeoutSeconds = provider.DefaultTerminalTimeoutSeconds
	}

	c.JSON(http.StatusOK, tatSessionResponse{
		SandboxID:      sb.ID,
		PoolID:         pool.ID,
		SessionID:      session.SessionID,
		Region:         session.Region,
		InstanceID:     session.InstanceID,
		OwnerUin:       session.OwnerUin,
		LoginUin:       session.LoginUin,
		AppID:          session.AppID,
		WsURL:          session.WsURL,
		Cols:           session.Cols,
		Rows:           session.Rows,
		TimeoutSeconds: session.TimeoutSeconds,
		Username:       session.Username,
		WorkingDir:     session.WorkingDir,
	})
}

func (h *handler) postSandboxTATCommand(c *gin.Context) {
	if h.commands == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "tat command execution unavailable"})
		return
	}

	sandboxID := strings.TrimSpace(c.Param("sandboxID"))
	sb, inst, pool, ok := h.resolveSandboxContext(c, sandboxID)
	if !ok {
		return
	}
	if strings.TrimSpace(inst.CloudID) == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "sandbox instance missing cloud id"})
		return
	}

	var req postTATCommandRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	script := strings.TrimSpace(req.Bash)
	if script == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bash is required"})
		return
	}
	if len(script) > maxTATScriptBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bash is too large"})
		return
	}
	if strings.TrimSpace(sb.Region) == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "sandbox region missing"})
		return
	}

	inv, err := h.commands.RunCommand(c.Request.Context(), sb.Region, inst.CloudID, script)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(inv.Status) == "" {
		inv.Status = defaultTATStatus
	}
	if strings.TrimSpace(inv.Region) == "" {
		inv.Region = sb.Region
	}
	if strings.TrimSpace(inv.InstanceID) == "" {
		inv.InstanceID = inst.CloudID
	}
	c.JSON(http.StatusAccepted, tatCommandResponse{
		SandboxID:    sb.ID,
		PoolID:       pool.ID,
		InstanceID:   inv.InstanceID,
		Region:       inv.Region,
		CommandID:    inv.CommandID,
		InvocationID: inv.InvocationID,
		Status:       inv.Status,
	})
}

func (h *handler) postInternalTATInvoke(c *gin.Context) {
	if h.invocations == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "tat command invocation unavailable"})
		return
	}

	sandboxID := strings.TrimSpace(c.Param("sandboxID"))
	sb, inst, pool, ok := h.resolveSandboxContext(c, sandboxID)
	if !ok {
		return
	}
	if strings.TrimSpace(inst.CloudID) == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "sandbox instance missing cloud id"})
		return
	}
	if strings.TrimSpace(sb.Region) == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "sandbox region missing"})
		return
	}

	var req postTATInvocationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	req.CommandID = strings.TrimSpace(req.CommandID)
	if !tatCommandIDPattern.MatchString(req.CommandID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid command_id"})
		return
	}
	if h.allowedTATCommandID == "" || req.CommandID != h.allowedTATCommandID {
		c.JSON(http.StatusForbidden, gin.H{"error": "command_id is not allowed"})
		return
	}
	if len(req.Parameters) == 0 || len(req.Parameters) > maxTATParameterCount {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid parameters"})
		return
	}
	for name, value := range req.Parameters {
		if !tatParameterNamePattern.MatchString(name) || value == "" || len(value) > maxTATParameterValueBytes {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid parameters"})
			return
		}
	}

	inv, err := h.invocations.InvokeCommand(c.Request.Context(), sb.Region, inst.CloudID, req.CommandID, req.Parameters)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "tat command invocation failed"})
		return
	}
	if strings.TrimSpace(inv.InvocationID) == "" {
		c.JSON(http.StatusBadGateway, gin.H{"error": "tat command invocation returned empty invocation id"})
		return
	}
	if strings.TrimSpace(inv.Status) == "" {
		inv.Status = defaultTATStatus
	}
	if strings.TrimSpace(inv.Region) == "" {
		inv.Region = sb.Region
	}
	if strings.TrimSpace(inv.InstanceID) == "" {
		inv.InstanceID = inst.CloudID
	}
	c.JSON(http.StatusAccepted, tatCommandResponse{
		SandboxID:    sb.ID,
		PoolID:       pool.ID,
		InstanceID:   inv.InstanceID,
		Region:       inv.Region,
		CommandID:    firstNonEmptyTAT(inv.CommandID, req.CommandID),
		InvocationID: inv.InvocationID,
		Status:       inv.Status,
	})
}

func (h *handler) getInternalTATInvocation(c *gin.Context) {
	if h.invocations == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "tat command invocation unavailable"})
		return
	}

	sandboxID := strings.TrimSpace(c.Param("sandboxID"))
	invocationID := strings.TrimSpace(c.Param("invocationID"))
	if invocationID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invocationID is required"})
		return
	}
	sb, inst, pool, ok := h.resolveSandboxContext(c, sandboxID)
	if !ok {
		return
	}
	if strings.TrimSpace(inst.CloudID) == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "sandbox instance missing cloud id"})
		return
	}
	if strings.TrimSpace(sb.Region) == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "sandbox region missing"})
		return
	}

	result, err := h.invocations.GetCommandInvocationMetadata(c.Request.Context(), sb.Region, invocationID, inst.CloudID)
	if err != nil {
		if err == provider.ErrInvocationNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "invocation not found"})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": "tat command invocation query failed"})
		return
	}
	if strings.TrimSpace(result.Region) == "" {
		result.Region = sb.Region
	}
	if strings.TrimSpace(result.InstanceID) == "" {
		result.InstanceID = inst.CloudID
	}

	c.JSON(http.StatusOK, tatCommandMetadataResponse{
		tatCommandResponse: tatCommandResponse{
			SandboxID:    sb.ID,
			PoolID:       pool.ID,
			InstanceID:   result.InstanceID,
			Region:       result.Region,
			CommandID:    result.CommandID,
			InvocationID: result.InvocationID,
			Status:       result.Status,
		},
		ExitCode:      result.ExitCode,
		StartTime:     result.StartTime,
		EndTime:       result.EndTime,
		ExecutionTime: result.ExecutionTime,
	})
}

func firstNonEmptyTAT(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func (h *handler) getSandboxTATCommand(c *gin.Context) {
	if h.commands == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "tat command execution unavailable"})
		return
	}

	sandboxID := strings.TrimSpace(c.Param("sandboxID"))
	invocationID := strings.TrimSpace(c.Param("invocationID"))
	if invocationID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invocationID is required"})
		return
	}
	sb, inst, pool, ok := h.resolveSandboxContext(c, sandboxID)
	if !ok {
		return
	}
	if strings.TrimSpace(inst.CloudID) == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "sandbox instance missing cloud id"})
		return
	}
	if strings.TrimSpace(sb.Region) == "" {
		c.JSON(http.StatusConflict, gin.H{"error": "sandbox region missing"})
		return
	}

	result, err := h.commands.GetCommandInvocation(c.Request.Context(), sb.Region, invocationID, inst.CloudID)
	if err != nil {
		if err == provider.ErrInvocationNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "invocation not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(result.Region) == "" {
		result.Region = sb.Region
	}
	if strings.TrimSpace(result.InstanceID) == "" {
		result.InstanceID = inst.CloudID
	}

	c.JSON(http.StatusOK, tatCommandResultResponse{
		tatCommandResponse: tatCommandResponse{
			SandboxID:    sb.ID,
			PoolID:       pool.ID,
			InstanceID:   result.InstanceID,
			Region:       result.Region,
			CommandID:    result.CommandID,
			InvocationID: result.InvocationID,
			Status:       result.Status,
		},
		ExitCode:      result.ExitCode,
		Output:        result.Output,
		ErrorInfo:     result.ErrorInfo,
		OutputURL:     result.OutputURL,
		Dropped:       result.Dropped,
		StartTime:     result.StartTime,
		EndTime:       result.EndTime,
		ExecutionTime: result.ExecutionTime,
	})
}

func (h *handler) resolveSandboxContext(c *gin.Context, sandboxID string) (core.Sandbox, core.Instance, core.Pool, bool) {
	sb, err := h.svc.GetSandbox(c.Request.Context(), sandboxID)
	if err != nil {
		if err == core.ErrSandboxNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
			return core.Sandbox{}, core.Instance{}, core.Pool{}, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return core.Sandbox{}, core.Instance{}, core.Pool{}, false
	}
	inst, err := h.svc.GetInstance(c.Request.Context(), sb.InstanceID)
	if err != nil {
		if err == core.ErrInstanceNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox instance not found"})
			return core.Sandbox{}, core.Instance{}, core.Pool{}, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return core.Sandbox{}, core.Instance{}, core.Pool{}, false
	}
	pool, err := h.svc.GetPool(c.Request.Context(), sb.PoolID)
	if err != nil {
		if err == core.ErrPoolNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox pool not found"})
			return core.Sandbox{}, core.Instance{}, core.Pool{}, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return core.Sandbox{}, core.Instance{}, core.Pool{}, false
	}
	return sb, inst, pool, true
}

func regionFromPool(pool core.Pool) string {
	zone := strings.TrimSpace(pool.Zone)
	if zone == "" {
		return defaultTATRegion
	}
	if idx := strings.LastIndex(zone, "-"); idx > 0 {
		if _, err := strconv.Atoi(zone[idx+1:]); err == nil {
			return zone[:idx]
		}
	}
	return zone
}
