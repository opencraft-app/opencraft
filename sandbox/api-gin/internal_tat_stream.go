package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"cvm-mock-e2b/internal/provider"
)

const (
	internalTATExecStreamRoutePath = "/sandboxes/:sandboxID/tat/exec-stream"
	internalTATContentType         = "application/x-ndjson"
	internalTATUsername            = "agentuser"
	internalTATWorkingDirectory    = "/home/agentuser"
	maxInternalTATTimeoutSeconds   = 300
	maxInternalStreamErrorBytes    = 256
)

type internalTATExecStreamRequest struct {
	Command          string `json:"command"`
	Username         string `json:"username"`
	WorkingDirectory string `json:"working_directory"`
	TimeoutSeconds   int    `json:"timeout_seconds"`
}

type internalTATStartedEvent struct {
	Type        string `json:"type"`
	ExecutionID string `json:"execution_id"`
}

type internalTATOutputEvent struct {
	Type        string `json:"type"`
	ExecutionID string `json:"execution_id"`
	Index       int    `json:"index"`
	Chunk       string `json:"chunk"`
}

type internalTATFinishedEvent struct {
	Type        string `json:"type"`
	ExecutionID string `json:"execution_id"`
	Status      string `json:"status"`
	ExitCode    int    `json:"exit_code"`
}

type internalTATErrorEvent struct {
	Type        string `json:"type"`
	ExecutionID string `json:"execution_id"`
	Code        string `json:"code"`
	Message     string `json:"message"`
}

func registerInternalTATRoutes(r gin.IRouter, h *handler) {
	r.POST(internalTATExecStreamRoutePath, h.postInternalTATExecStream)
}

func (h *handler) postInternalTATExecStream(c *gin.Context) {
	if h.terminalCommands == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "tat command stream unavailable"})
		return
	}

	sandboxID := strings.TrimSpace(c.Param("sandboxID"))
	sb, inst, _, ok := h.resolveSandboxContext(c, sandboxID)
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

	var req internalTATExecStreamRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	if strings.TrimSpace(req.Command) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "command is required"})
		return
	}
	if len(req.Command) > maxTATScriptBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "command is too large"})
		return
	}
	if req.Username != internalTATUsername || req.WorkingDirectory != internalTATWorkingDirectory {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported terminal identity"})
		return
	}
	req.TimeoutSeconds = clampInternalTATTimeout(req.TimeoutSeconds)

	_ = http.NewResponseController(c.Writer).SetWriteDeadline(
		time.Now().Add(time.Duration(req.TimeoutSeconds+5) * time.Second),
	)

	encoder := json.NewEncoder(c.Writer)
	started := false
	terminal := false
	executionID := ""
	emitJSON := func(event any) error {
		if err := encoder.Encode(event); err != nil {
			return err
		}
		c.Writer.Flush()
		return nil
	}
	emit := func(event provider.TerminalCommandStreamEvent) error {
		if terminal {
			return errors.New("terminal event already emitted")
		}
		switch event.Type {
		case provider.TerminalCommandEventStarted:
			if started || strings.TrimSpace(event.ExecutionID) == "" {
				return errors.New("invalid started event")
			}
			started = true
			executionID = event.ExecutionID
			c.Header("Content-Type", internalTATContentType)
			c.Status(http.StatusOK)
			return emitJSON(internalTATStartedEvent{
				Type:        "started",
				ExecutionID: executionID,
			})
		case provider.TerminalCommandEventOutput:
			if !started || event.ExecutionID != executionID {
				return errors.New("output before matching started event")
			}
			return emitJSON(internalTATOutputEvent{
				Type:        "output",
				ExecutionID: executionID,
				Index:       event.Index,
				Chunk:       event.Chunk,
			})
		default:
			return errors.New("unsupported stream event")
		}
	}

	result, err := h.terminalCommands.StreamTerminalCommand(c.Request.Context(), provider.TerminalCommandStreamRequest{
		Region:           sb.Region,
		InstanceID:       inst.CloudID,
		Command:          req.Command,
		Username:         req.Username,
		WorkingDirectory: req.WorkingDirectory,
		TimeoutSeconds:   req.TimeoutSeconds,
	}, emit)
	if err != nil {
		if !started {
			status, message := internalStreamHTTPError(err)
			c.JSON(status, gin.H{"error": message})
			return
		}
		if c.Request.Context().Err() != nil {
			return
		}
		code, message := internalStreamEventError(err)
		terminal = true
		_ = emitJSON(internalTATErrorEvent{
			Type:        "error",
			ExecutionID: executionID,
			Code:        code,
			Message:     message,
		})
		return
	}
	if !started || result.ExecutionID != executionID {
		if !started {
			c.JSON(http.StatusBadGateway, gin.H{"error": "tat command stream protocol error"})
			return
		}
		terminal = true
		_ = emitJSON(internalTATErrorEvent{
			Type:        "error",
			ExecutionID: executionID,
			Code:        provider.TerminalCommandErrorProtocol,
			Message:     "tat command stream protocol error",
		})
		return
	}

	status := "FAILED"
	if result.ExitCode == 0 {
		status = "SUCCESS"
	}
	terminal = true
	_ = emitJSON(internalTATFinishedEvent{
		Type:        "finished",
		ExecutionID: executionID,
		Status:      status,
		ExitCode:    result.ExitCode,
	})
}

func clampInternalTATTimeout(timeoutSeconds int) int {
	if timeoutSeconds < 1 {
		return 1
	}
	if timeoutSeconds > maxInternalTATTimeoutSeconds {
		return maxInternalTATTimeoutSeconds
	}
	return timeoutSeconds
}

func internalStreamHTTPError(err error) (int, string) {
	var streamErr *provider.TerminalCommandStreamError
	if errors.As(err, &streamErr) {
		switch streamErr.Code {
		case provider.TerminalCommandErrorTimeout:
			return http.StatusGatewayTimeout, boundedStreamMessage(streamErr.Message)
		case provider.TerminalCommandErrorCanceled:
			return http.StatusRequestTimeout, boundedStreamMessage(streamErr.Message)
		}
	}
	return http.StatusBadGateway, "tat command stream protocol error"
}

func internalStreamEventError(err error) (string, string) {
	var streamErr *provider.TerminalCommandStreamError
	if errors.As(err, &streamErr) {
		switch streamErr.Code {
		case provider.TerminalCommandErrorTimeout, provider.TerminalCommandErrorCanceled, provider.TerminalCommandErrorProtocol:
			return streamErr.Code, boundedStreamMessage(streamErr.Message)
		}
	}
	return provider.TerminalCommandErrorProtocol, "tat command stream failed"
}

func boundedStreamMessage(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return "tat command stream failed"
	}
	if len(message) <= maxInternalStreamErrorBytes {
		return message
	}
	return message[:maxInternalStreamErrorBytes]
}
