package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	instancelogic "ctl/pkg/instance"
	logfields "ctl/pkg/log"
	bundlelogic "ctl/pkg/logic/bundle"
	passlogic "ctl/pkg/logic/pass"
	"ctl/pkg/metric"
	"ctl/pkg/resource"
	"ctl/pkg/tracing"
	"ctl/pkg/transport"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.uber.org/zap"
)

const (
	headerUserID    = "X-User-Id"
	headerUserIDAlt = "X-Uin"
	headerRequestID = "X-Request-Id"
	headerTraceID   = "X-Trace-Id"
)

type apiServer struct {
	httpServer *http.Server
}

type instanceHandler struct {
	logic instancelogic.Logic
}

// errorResponse 错误响应
type errorResponse struct {
	// 错误码，例如 400, 404, 500
	Code string `json:"code" example:"400"`
	// 错误信息描述
	Message string `json:"message" example:"Bad Request"`
	// 请求追踪 ID，用于问题排查
	RequestID string `json:"request_id,omitempty" example:"req-2026032310301234567890"`
	// 建议重试等待秒数，仅限限流/保护类错误返回
	RetryAfterSeconds *int `json:"retry_after_seconds,omitempty" example:"60"`
	// 错误详情，用于透出上游命令失败上下文
	Details any `json:"details,omitempty"`
}

// successResponse 成功响应
type successResponse struct {
	// 成功码，通常为 "0" 或 "200"
	Code string `json:"code" example:"0"`
	// 成功信息，默认为 "OK"
	Message string `json:"message" example:"OK"`
	// 响应数据，具体格式取决于端点
	Data any `json:"data,omitempty"`
	// 请求追踪 ID，用于问题排查
	RequestID string `json:"request_id,omitempty" example:"req-2026032310301234567890"`
}

type retryAfterProvider interface {
	RetryAfterSeconds() int
}

type statusCapturingResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (w *statusCapturingResponseWriter) WriteHeader(statusCode int) {
	w.statusCode = statusCode
	w.ResponseWriter.WriteHeader(statusCode)
}

func (w *statusCapturingResponseWriter) Write(data []byte) (int, error) {
	if w.statusCode == 0 {
		w.statusCode = http.StatusOK
	}
	return w.ResponseWriter.Write(data)
}

func (w *statusCapturingResponseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusCapturingResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("response writer does not implement http.Hijacker")
	}
	return h.Hijack()
}

func (w *statusCapturingResponseWriter) Push(target string, opts *http.PushOptions) error {
	p, ok := w.ResponseWriter.(http.Pusher)
	if !ok {
		return http.ErrNotSupported
	}
	return p.Push(target, opts)
}

func (w *statusCapturingResponseWriter) ReadFrom(r io.Reader) (int64, error) {
	if rf, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		return rf.ReadFrom(r)
	}
	return io.Copy(w.ResponseWriter, r)
}

func (w *statusCapturingResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func newAPIServer() (*apiServer, error) {
	addr := fmt.Sprintf("%s:%d", config.ServerConf.APIConfig.Host, config.ServerConf.APIConfig.Port)
	ih := &instanceHandler{logic: instancelogic.NewLogic()}
	bh := &bundleHandler{logic: bundlelogic.NewLogic()}
	ph := &passHandler{logic: passlogic.NewLogic()}
	server := &http.Server{
		Addr:              addr,
		Handler:           newRouter(ih, bh, ph),
		ReadHeaderTimeout: 5 * time.Second,
	}
	return &apiServer{httpServer: server}, nil
}

func newRouter(handler *instanceHandler, bh *bundleHandler, ph *passHandler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeSuccess(w, r, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/internal/bots", handler.handleInternalBots)
	mux.HandleFunc("/internal/bots/", handler.handleInternalBotSubresource)
	mux.HandleFunc("/internal/instances/", handler.handleInternalInstanceSubresource)
	mux.HandleFunc("/v1/instances", handler.handleInstances)
	mux.HandleFunc("/v1/instances/", handler.handleInstance)
	mux.HandleFunc("/v1/soul-templates", handler.handleSoulTemplates)
	mux.HandleFunc("/v1/me/usage", handler.handleMeUsage)

	// Bundle 路由
	mux.HandleFunc("/admin/api/ctl/bundles", bh.handleAdminBundles)
	mux.HandleFunc("/v1/bundles", bh.handleUserBundles)

	// Pass 路由
	mux.HandleFunc("/admin/api/ctl/passes", ph.handleAdminPasses)
	mux.HandleFunc("/v1/passes", ph.handleUserPasses)

	return requestMetadataMiddleware(metricsMiddleware(notFoundMiddleware(mux)))
}

func (gs *apiServer) run() error {
	// 启动后台定时任务
	cronDone := make(chan struct{})
	bundlelogic.StartDailyAvailCountRefresh(resource.ZapLogger, 10, cronDone) // 每天 10:00 (UTC+8)

	errCh := make(chan error, 1)
	go func() {
		resource.ZapLogger.Info("api server listening", zap.String("addr", gs.httpServer.Addr))
		if err := gs.httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		close(cronDone)
		return err
	case <-ch:
	}

	close(cronDone) // 停止后台定时任务

	shutdownTimeout := time.Duration(config.ServerConf.APIConfig.ShutdownTimeout) * time.Second
	if shutdownTimeout <= 0 {
		shutdownTimeout = 5 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	return gs.httpServer.Shutdown(ctx)
}

func requestMetadataMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := canonicalRequestID(r)
		userID := requestUserID(r)
		ctx := pctx.NewContext(r.Context()).WithRegion(config.ServerConf.MiscConfig.Region)
		ctx.SetAction(strings.TrimSpace(r.Method + " " + r.URL.Path))
		ctx.SetRequestId(requestID)
		if userID != "" {
			ctx = ctx.WithUserID(userID)
			ctx.SetSqlCommentUserID(userID)
		}
		ctx.SetLogger(buildRequestLogger(ctx, r, userID))
		ctx, span := tracing.StartTrace(ctx, fmt.Sprintf("HTTP %s %s", r.Method, normalizePath(r.URL.Path)))
		span.SetAttributes(
			attribute.String("http.method", r.Method),
			attribute.String("http.route", normalizePath(r.URL.Path)),
			attribute.String(logfields.FieldPath, r.URL.Path),
		)

		start := time.Now()
		writer := &statusCapturingResponseWriter{ResponseWriter: w}
		writer.Header().Set(headerRequestID, requestID)
		next.ServeHTTP(writer, r.WithContext(ctx))
		statusCode := writer.statusCode
		if statusCode == 0 {
			statusCode = http.StatusOK
		}
		span.SetAttributes(attribute.Int("http.status_code", statusCode))
		if statusCode >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, http.StatusText(statusCode))
		}
		span.End()

		ctx.Logger().Info("http request",
			zap.String("remote_addr", r.RemoteAddr),
			zap.Int(logfields.FieldStatusCode, statusCode),
			zap.Duration("latency", time.Since(start)),
		)
	})
}

// metricsMiddleware 记录 API 请求指标到 Prometheus
// 路径归一化以避免高基数标签（如 /v1/instances/ins-xxx → /v1/instances/{id}）
func metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		writer := &statusCapturingResponseWriter{ResponseWriter: w}
		next.ServeHTTP(writer, r)

		statusCode := writer.statusCode
		if statusCode == 0 {
			statusCode = http.StatusOK
		}

		normalizedPath := normalizePath(r.URL.Path)
		duration := time.Since(start).Seconds()

		metric.RecordAPIRequest(r.Method, normalizedPath, statusCode, duration)
	})
}

// normalizePath 将路径中的动态 ID 替换为占位符，避免高基数标签
// 例如：/v1/instances/ins-xxx → /v1/instances/{id}
//
//	/v1/instances/ins-xxx/pause → /v1/instances/{id}/pause
//
// 未知路径归一到 /other catch-all 桶，防止高基数标签攻击
func normalizePath(path string) string {
	// 静态路径直接返回
	switch path {
	case "/health", "/metrics", "/internal/bots", "/v1/soul-templates", "/v1/me/usage",
		"/v1/bundles", "/v1/passes",
		"/admin/api/ctl/bundles", "/admin/api/ctl/passes":
		return path
	}
	if strings.HasPrefix(path, "/internal/instances/") && strings.HasSuffix(path, "/chatclaw/runtime-bootstrap") {
		return "/internal/instances/{id}/chatclaw/runtime-bootstrap"
	}
	if strings.HasPrefix(path, "/internal/bots/") && strings.HasSuffix(path, "/borncard") {
		return "/internal/bots/{id}/borncard"
	}

	parts := strings.Split(strings.Trim(path, "/"), "/")
	// 检查是否是 /v1/instances/{id}... 模式
	if len(parts) >= 3 && parts[0] == "v1" && parts[1] == "instances" {
		// 替换第三个部分（instance ID）为 {id}
		parts[2] = "{id}"
		return "/" + strings.Join(parts, "/")
	}

	// 未知路径归一到 /other catch-all 桶，防止高基数标签
	return "/other"
}

func (h *instanceHandler) handleInstances(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.CreateInstanceRequest
		if err := decodeOptionalJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.CreateInstance(ctx, &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusCreated, resp)
	case http.MethodGet:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		page, pageSize, err := parsePagination(r)
		if err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.ListInstances(ctx, page, pageSize)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	default:
		w.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
	}
}

func (h *instanceHandler) handleSoulTemplates(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
		return
	}
	resp, err := h.logic.ListSoulTemplates(ctx)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, resp)
}

func (h *instanceHandler) handleMeUsage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeHTTPError(w, r, errcode.ErrMethodNotAllowed)
		return
	}
	ctx, ok := newRequestContext(r)
	if !ok {
		writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
		return
	}
	resp, err := h.logic.GetUserUsage(ctx)
	if err != nil {
		writeHTTPError(w, r, err)
		return
	}
	writeSuccess(w, r, http.StatusOK, resp)
}

func (h *instanceHandler) handleInstance(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/v1/instances/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeHTTPError(w, r, errcode.ErrNotFound)
		return
	}
	if len(parts) > 6 {
		writeHTTPError(w, r, errcode.ErrNotFound)
		return
	}
	instanceID := parts[0]

	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		resp, err := h.logic.GetInstance(ctx, instanceID)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 1 && r.Method == http.MethodDelete:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		resp, err := h.logic.DestroyInstance(ctx, instanceID)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 1 && r.Method == http.MethodPut:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.UpdateInstanceRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.UpdateInstance(ctx, instanceID, &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 2 && r.Method == http.MethodGet && parts[1] == "borncard":
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		resp, err := h.loadBotBornCard(r, instanceID, ctx.GetUserID())
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 2 && r.Method == http.MethodPost && parts[1] == "pause":
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		resp, err := h.logic.PauseInstance(ctx, instanceID)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 2 && r.Method == http.MethodPost && parts[1] == "resume":
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.ResumeInstanceRequest
		if err := decodeOptionalJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.ResumeInstance(ctx, instanceID, &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 2 && r.Method == http.MethodPost && parts[1] == "timeout":
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.SetTimeoutRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.SetInstanceTimeout(ctx, instanceID, &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 2 && r.Method == http.MethodGet && parts[1] == "operations":
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		page, pageSize, err := parsePagination(r)
		if err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.ListOperations(ctx, instanceID, page, pageSize)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 2 && r.Method == http.MethodGet && parts[1] == "logs":
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		start, limit := parseLogsParams(r)
		resp, err := h.logic.GetInstanceLogs(ctx, instanceID, start, limit)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 2 && parts[1] == "chatclaw" && r.Method == http.MethodGet:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		resp, err := h.logic.GetChatClawState(ctx, instanceID)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 3 && parts[1] == "chatclaw" && parts[2] == "sync" && r.Method == http.MethodPost:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		resp, err := h.logic.SyncChatClawState(ctx, instanceID)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 3 && parts[1] == "chatclaw" && parts[2] == "agents" && r.Method == http.MethodPost:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.CreateChatClawAgentRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.CreateChatClawAgent(ctx, instanceID, &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusCreated, resp)
	case len(parts) == 4 && parts[1] == "chatclaw" && parts[2] == "agents" && r.Method == http.MethodPatch:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.UpdateChatClawAgentRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.UpdateChatClawAgent(ctx, instanceID, parts[3], &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 4 && parts[1] == "chatclaw" && parts[2] == "agents" && r.Method == http.MethodDelete:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		if err := h.logic.DeleteChatClawAgent(ctx, instanceID, parts[3]); err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, map[string]bool{"deleted": true})
	case len(parts) == 3 && parts[1] == "chatclaw" && parts[2] == "teams" && r.Method == http.MethodPost:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.CreateChatClawTeamRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.CreateChatClawTeam(ctx, instanceID, &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusCreated, resp)
	case len(parts) == 4 && parts[1] == "chatclaw" && parts[2] == "teams" && r.Method == http.MethodPatch:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.UpdateChatClawTeamRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.UpdateChatClawTeam(ctx, instanceID, parts[3], &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 4 && parts[1] == "chatclaw" && parts[2] == "teams" && r.Method == http.MethodDelete:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		if err := h.logic.DeleteChatClawTeam(ctx, instanceID, parts[3]); err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, map[string]bool{"deleted": true})
	case len(parts) == 3 && parts[1] == "chatclaw" && parts[2] == "conversations" && r.Method == http.MethodPost:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.CreateChatClawConversationRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.CreateChatClawConversation(ctx, instanceID, &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusCreated, resp)
	case len(parts) == 4 && parts[1] == "chatclaw" && parts[2] == "conversations" && r.Method == http.MethodPatch:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.UpdateChatClawConversationRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.UpdateChatClawConversation(ctx, instanceID, parts[3], &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 4 && parts[1] == "chatclaw" && parts[2] == "conversations" && r.Method == http.MethodDelete:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		if err := h.logic.DeleteChatClawConversation(ctx, instanceID, parts[3]); err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, map[string]bool{"deleted": true})
	case len(parts) == 3 && parts[1] == "workspace" && parts[2] == "files" && r.Method == http.MethodGet:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		fileName := strings.TrimSpace(r.URL.Query().Get("name"))
		resp, err := h.logic.GetWorkspaceFiles(ctx, instanceID, fileName)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 3 && parts[1] == "workspace" && parts[2] == "uploads" && r.Method == http.MethodGet:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		limit := 50
		if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
			if parsed, err := strconv.Atoi(rawLimit); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		resp, err := h.logic.ListWorkspaceUploads(ctx, instanceID, &transport.ListWorkspaceUploadsRequest{
			OwnerType:      strings.TrimSpace(r.URL.Query().Get("owner_type")),
			OwnerID:        strings.TrimSpace(r.URL.Query().Get("owner_id")),
			ConversationID: strings.TrimSpace(r.URL.Query().Get("conversation_id")),
			Limit:          limit,
		})
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 4 && parts[1] == "workspace" && parts[2] == "uploads" && r.Method == http.MethodGet:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		resp, err := h.logic.GetWorkspaceUpload(ctx, instanceID, parts[3])
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 5 && parts[1] == "workspace" && parts[2] == "uploads" && parts[4] == "content" && r.Method == http.MethodGet:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		upload, content, err := h.logic.GetWorkspaceUploadContent(ctx, instanceID, parts[3])
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		setResponseRequestID(w, requestIDFromRequest(r))
		w.Header().Set("Content-Type", upload.MediaType)
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"`, upload.FileName))
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write(content); err != nil {
			requestLogger(r).Error("write upload content failed", zap.Error(err))
		}
	case len(parts) == 3 && parts[1] == "workspace" && parts[2] == "uploads" && r.Method == http.MethodPost:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		defer file.Close()
		content, err := io.ReadAll(file)
		if err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.UploadWorkspaceAttachment(ctx, instanceID, &transport.UploadWorkspaceAttachmentRequest{
			OwnerType:      strings.TrimSpace(r.FormValue("owner_type")),
			OwnerID:        strings.TrimSpace(r.FormValue("owner_id")),
			ConversationID: strings.TrimSpace(r.FormValue("conversation_id")),
			FileName:       header.Filename,
			MediaType:      header.Header.Get("Content-Type"),
			SizeBytes:      int64(len(content)),
			Content:        content,
		})
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusCreated, resp)
	case len(parts) == 3 && parts[1] == "automation" && parts[2] == "schedules" && r.Method == http.MethodGet:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		offset, _ := parseInt64Query(r, "offset")
		limit, _ := parseInt64Query(r, "limit")
		resp, err := h.logic.ListAutomationSchedules(ctx, instanceID, offset, limit)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 4 && parts[1] == "automation" && parts[2] == "schedules" && r.Method == http.MethodGet:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		resp, err := h.logic.GetAutomationSchedule(ctx, instanceID, parts[3])
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 3 && parts[1] == "automation" && parts[2] == "schedules" && r.Method == http.MethodPost:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.CreateAutomationScheduleRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.CreateAutomationSchedule(ctx, instanceID, &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusCreated, resp)
	case len(parts) == 4 && parts[1] == "automation" && parts[2] == "schedules" && r.Method == http.MethodPatch:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.UpdateAutomationScheduleRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.UpdateAutomationSchedule(ctx, instanceID, parts[3], &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 4 && parts[1] == "automation" && parts[2] == "schedules" && r.Method == http.MethodDelete:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		if err := h.logic.DeleteAutomationSchedule(ctx, instanceID, parts[3]); err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, map[string]bool{"deleted": true})
	case len(parts) == 5 && parts[1] == "automation" && parts[2] == "schedules" && parts[4] == "run" && r.Method == http.MethodPost:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		resp, err := h.logic.RunAutomationSchedule(ctx, instanceID, parts[3])
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 3 && parts[1] == "workspace" && parts[2] == "files" && r.Method == http.MethodPost:
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.UpdateWorkspaceFileRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.UpdateWorkspaceFile(ctx, instanceID, &req)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 3 && r.Method == http.MethodPost && parts[1] == "debug" && parts[2] == "exec":
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.ExecDebugCommandRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		if strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream") {
			h.streamDebugCommand(w, r, ctx, instanceID, &req)
			return
		}
		resp, err := h.logic.ExecDebugCommand(ctx, instanceID, req.Command, req.RunAsUser)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
	case len(parts) == 3 && r.Method == http.MethodPost && parts[1] == "channels" && parts[2] == "config":
		h.configureChannel(w, r, instanceID)
	case len(parts) == 4 && r.Method == http.MethodPost && parts[1] == "channels" && parts[2] == "weixin" && parts[3] == "login-sessions":
		h.createWeixinLoginSession(w, r, instanceID)
	case len(parts) == 5 && r.Method == http.MethodGet && parts[1] == "channels" && parts[2] == "weixin" && parts[3] == "login-sessions":
		h.getWeixinLoginSession(w, r, instanceID, parts[4])
	case len(parts) == 6 && r.Method == http.MethodGet && parts[1] == "channels" && parts[2] == "weixin" && parts[3] == "login-sessions" && parts[5] == "events":
		h.streamWeixinLoginSessionEvents(w, r, instanceID, parts[4])
	case len(parts) == 6 && r.Method == http.MethodPost && parts[1] == "channels" && parts[2] == "weixin" && parts[3] == "login-sessions" && parts[5] == "cancel":
		h.cancelWeixinLoginSession(w, r, instanceID, parts[4])
	default:
		writeHTTPError(w, r, errcode.ErrNotFound)
	}
}

func (h *instanceHandler) streamDebugCommand(w http.ResponseWriter, r *http.Request, ctx pctx.Context, instanceID string, req *transport.ExecDebugCommandRequest) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeHTTPError(w, r, errcode.ErrInternalServer)
		return
	}

	started := false
	flushEvent := func(event transport.ExecDebugCommandStreamEvent) error {
		if !started {
			started = true
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")
		}
		writeSSE(w, event.Type, event)
		flusher.Flush()
		return nil
	}

	if err := h.logic.StreamDebugCommand(ctx, instanceID, req.Command, req.RunAsUser, flushEvent); err != nil {
		if !started {
			writeHTTPError(w, r, err)
			return
		}
		payload := transport.ExecDebugCommandStreamEvent{Type: "error"}
		if detailProvider, ok := err.(interface{ ErrorDetail() any }); ok {
			if resp, ok := detailProvider.ErrorDetail().(*transport.ExecDebugCommandResponse); ok {
				payload.Response = resp
				payload.InvocationID = resp.InvocationID
				payload.CommandID = resp.CommandID
				payload.RunAsUser = resp.RunAsUser
			}
		}
		writeSSE(w, "error", payload)
		flusher.Flush()
	}
}

func notFoundMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isStreamingRequest(r) {
			next.ServeHTTP(w, r)
			return
		}
		muxWriter := &bufferingResponseWriter{header: make(http.Header)}
		next.ServeHTTP(muxWriter, r)
		if muxWriter.statusCode == http.StatusNotFound {
			writeHTTPError(w, r, errcode.ErrNotFound)
			return
		}
		muxWriter.flushTo(w)
	})
}

func isStreamingRequest(r *http.Request) bool {
	if strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream") {
		return true
	}
	return strings.HasSuffix(strings.TrimSpace(r.URL.Path), "/events")
}

type bufferingResponseWriter struct {
	header     http.Header
	body       bytes.Buffer
	statusCode int
}

func (w *bufferingResponseWriter) Header() http.Header {
	return w.header
}

func (w *bufferingResponseWriter) WriteHeader(statusCode int) {
	if w.statusCode == 0 {
		w.statusCode = statusCode
	}
}

func (w *bufferingResponseWriter) Write(data []byte) (int, error) {
	if w.statusCode == 0 {
		w.statusCode = http.StatusOK
	}
	return w.body.Write(data)
}

func (w *bufferingResponseWriter) flushTo(dst http.ResponseWriter) {
	for key, values := range w.header {
		dst.Header()[key] = append([]string(nil), values...)
	}
	statusCode := w.statusCode
	if statusCode == 0 {
		statusCode = http.StatusOK
	}
	dst.WriteHeader(statusCode)
	if w.body.Len() > 0 {
		_, _ = dst.Write(w.body.Bytes())
	}
}

func newRequestContext(r *http.Request) (pctx.Context, bool) {
	var ctx pctx.Context
	if existing, ok := requestContextFromRequest(r); ok {
		ctx = existing.WithContext(existing)
	} else {
		ctx = pctx.NewContext(r.Context()).WithRegion(config.ServerConf.MiscConfig.Region)
		ctx.SetAction(strings.TrimSpace(r.Method + " " + r.URL.Path))
		ctx.SetRequestId(canonicalRequestID(r))
	}

	userID := requestUserID(r)
	if userID == "" {
		return ctx, false
	}

	ctx = ctx.WithUserID(userID)
	ctx.SetSqlCommentUserID(userID)
	ctx.SetLogger(buildRequestLogger(ctx, r, userID))
	return ctx, true
}

func parsePagination(r *http.Request) (int, int, error) {
	page := 1
	pageSize := 20
	if raw := strings.TrimSpace(r.URL.Query().Get("page")); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v <= 0 {
			return 0, 0, fmt.Errorf("invalid page")
		}
		page = v
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("page_size")); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v <= 0 {
			return 0, 0, fmt.Errorf("invalid page_size")
		}
		pageSize = v
	}
	return page, pageSize, nil
}

func parseLogsParams(r *http.Request) (*int64, *int32) {
	var start *int64
	var limit *int32
	if raw := r.URL.Query().Get("start"); raw != "" {
		if v, err := strconv.ParseInt(raw, 10, 64); err == nil && v >= 0 {
			start = &v
		}
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v >= 1 && v <= 1000 {
			limit32 := int32(v)
			limit = &limit32
		}
	}
	if limit == nil {
		defaultLimit := int32(100)
		limit = &defaultLimit
	}
	return start, limit
}

func decodeJSONBody(r *http.Request, dst any) error {
	if r.Body == nil {
		return errors.New("missing request body")
	}
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		return fmt.Errorf("invalid json body")
	}
	return nil
}

func decodeOptionalJSONBody(r *http.Request, dst any) error {
	if r.Body == nil {
		return nil
	}
	defer r.Body.Close()
	if r.ContentLength == 0 {
		return nil
	}
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return fmt.Errorf("invalid json body")
	}
	return nil
}

func writeHTTPError(w http.ResponseWriter, r *http.Request, err error) {
	requestID := requestIDFromRequest(r)
	setResponseRequestID(w, requestID)
	var details any
	var detailProvider interface{ ErrorDetail() any }
	if errors.As(err, &detailProvider) {
		details = detailProvider.ErrorDetail()
	}
	var retryAfterHeader *int
	var retryProvider retryAfterProvider
	if errors.As(err, &retryProvider) {
		retrySeconds := retryProvider.RetryAfterSeconds()
		if retrySeconds > 0 {
			retryAfterHeader = &retrySeconds
			w.Header().Set("Retry-After", strconv.Itoa(retrySeconds))
		}
	}

	var bizErr *errcode.Error
	if errors.As(err, &bizErr) {
		writeJSONWithStatus(w, r, bizErr.HTTPStatus, errorResponse{
			Code:              bizErr.Code,
			Message:           bizErr.Message,
			RequestID:         requestID,
			RetryAfterSeconds: retryAfterHeader,
			Details:           details,
		})
		return
	}

	requestLogger(r).Error("unhandled api error", zap.Error(err))
	writeJSONWithStatus(w, r, http.StatusInternalServerError, errorResponse{
		Code:      errcode.ErrInternalServer.Code,
		Message:   errcode.ErrInternalServer.Message,
		RequestID: requestID,
		Details:   details,
	})
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, payload any) {
	writeJSONWithStatus(w, r, status, payload)
}

func writeSuccess(w http.ResponseWriter, r *http.Request, status int, data any) {
	requestID := requestIDFromRequest(r)
	setResponseRequestID(w, requestID)

	writeJSON(w, r, status, successResponse{
		Code:      "OK",
		Message:   "success",
		Data:      data,
		RequestID: requestID,
	})
}

func writeJSONWithStatus(w http.ResponseWriter, r *http.Request, status int, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		requestLogger(r).Error("encode json response failed",
			zap.Error(err),
			zap.Int("status", status),
		)
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(append(data, '\n')); err != nil {
		requestLogger(r).Error("write json response failed",
			zap.Error(err),
			zap.Int("status", status),
		)
	}
}

func canonicalRequestID(r *http.Request) string {
	if r == nil {
		return pctx.NewContext(nil).GetRequestId()
	}
	requestID := strings.TrimSpace(r.Header.Get(headerRequestID))
	if requestID != "" {
		return requestID
	}
	traceID := strings.TrimSpace(r.Header.Get(headerTraceID))
	if traceID != "" {
		return traceID
	}
	return pctx.NewContext(r.Context()).GetRequestId()
}

func requestUserID(r *http.Request) string {
	if r == nil {
		return ""
	}
	userID := strings.TrimSpace(r.Header.Get(headerUserID))
	if userID == "" {
		userID = strings.TrimSpace(r.Header.Get(headerUserIDAlt))
	}
	return userID
}

func requestContextFromRequest(r *http.Request) (pctx.Context, bool) {
	if r == nil || r.Context() == nil {
		return nil, false
	}
	ctx, ok := r.Context().(pctx.Context)
	return ctx, ok && ctx != nil
}

func requestIDFromRequest(r *http.Request) string {
	if ctx, ok := requestContextFromRequest(r); ok {
		return ctx.GetRequestId()
	}
	return canonicalRequestID(r)
}

func requestLogger(r *http.Request) *zap.Logger {
	if ctx, ok := requestContextFromRequest(r); ok {
		return ctx.Logger()
	}
	return apiLogger()
}

func buildRequestLogger(ctx pctx.Context, r *http.Request, userID string) *zap.Logger {
	logger := apiLogger().With(
		zap.String(logfields.FieldTraceID, ctx.GetRequestId()),
		zap.String(logfields.FieldMethod, r.Method),
		zap.String(logfields.FieldPath, r.URL.Path),
	)
	if action := ctx.Action(); action != "" {
		logger = logger.With(zap.String(logfields.FieldAction, action))
	}
	if userID != "" {
		logger = logger.With(zap.String(logfields.FieldUserID, userID))
	}
	return logger
}

func setResponseRequestID(w http.ResponseWriter, requestID string) {
	if w == nil || strings.TrimSpace(requestID) == "" {
		return
	}
	w.Header().Set(headerRequestID, requestID)
}

func apiLogger() *zap.Logger {
	if resource.ZapLogger == nil {
		return zap.NewNop()
	}
	return resource.ZapLogger
}

func parseInt64Query(r *http.Request, key string) (int64, bool) {
	if r == nil {
		return 0, false
	}
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return 0, false
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}
