package devtunnel

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// reservedPrefix 是 agent 控制面（poll/reply）的路径前缀。
// 任何不以此开头的请求都被当作需要隧道回放的业务回调（ingest）。
const reservedPrefix = "/_tunnel/"

// Server 把 Hub 暴露成 HTTP：
//   - ingest：云梯把改派后的回调打到任意业务路径，Server 按 Host 分流、阻塞等 agent 应答
//   - GET  /_tunnel/poll?env=<host>       ：agent 长轮询取下一个请求
//   - POST /_tunnel/reply?rid=<rid>       ：agent 交回应答
//
// 除非 token 为空（仅本地自测），否则所有端点都要求 Authorization: Bearer <token>。
type Server struct {
	hub             *Hub
	token           string
	dispatchTimeout time.Duration
	pollTimeout     time.Duration
	maxBodyBytes    int64
	logger          *log.Logger
}

// ServerOptions 配置 Server；零值走安全默认。
type ServerOptions struct {
	Token           string
	DispatchTimeout time.Duration
	PollTimeout     time.Duration
	MaxBodyBytes    int64
	Logger          *log.Logger
}

// NewServer 构造 Server。
func NewServer(hub *Hub, opts ServerOptions) *Server {
	s := &Server{
		hub:             hub,
		token:           strings.TrimSpace(opts.Token),
		dispatchTimeout: opts.DispatchTimeout,
		pollTimeout:     opts.PollTimeout,
		maxBodyBytes:    opts.MaxBodyBytes,
		logger:          opts.Logger,
	}
	if s.dispatchTimeout <= 0 {
		s.dispatchTimeout = DefaultDispatchTimeout
	}
	if s.pollTimeout <= 0 {
		s.pollTimeout = DefaultPollTimeout
	}
	if s.maxBodyBytes <= 0 {
		s.maxBodyBytes = 1 << 20 // 1 MiB，回调体很小
	}
	if s.logger == nil {
		s.logger = log.Default()
	}
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// healthz 不鉴权，供探针使用。
	if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
		return
	}
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch {
	case r.URL.Path == reservedPrefix+"poll":
		s.handlePoll(w, r)
	case r.URL.Path == reservedPrefix+"reply":
		s.handleReply(w, r)
	case strings.HasPrefix(r.URL.Path, reservedPrefix):
		http.NotFound(w, r)
	default:
		s.handleIngest(w, r)
	}
}

// authorized 用常数时间比较，避免 token 被计时攻击。token 为空时放行（本地自测）。
func (s *Server) authorized(r *http.Request) bool {
	if s.token == "" {
		return true
	}
	got := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

// handleIngest 承接云梯改派来的回调：按 Host 分流、阻塞等 agent 回放的应答。
func (s *Server) handleIngest(w http.ResponseWriter, r *http.Request) {
	env := strings.TrimSpace(r.Host)
	if env == "" {
		http.Error(w, "missing Host for dispatch", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, s.maxBodyBytes))
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	req := TunneledRequest{
		RID:     newRID(),
		Method:  r.Method,
		Path:    r.URL.Path,
		Query:   r.URL.RawQuery,
		Headers: cloneHeader(r.Header),
		Body:    body,
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.dispatchTimeout)
	defer cancel()
	resp, err := s.hub.Dispatch(ctx, env, req)
	if err != nil {
		// 504：agent 没接住。云梯据此把这次改派记成失败，而不是静默成功。
		s.logger.Printf("[devtunnel] ingest env=%q rid=%s dispatch failed: %v", env, req.RID, err)
		http.Error(w, "tunnel dispatch failed: "+err.Error(), http.StatusGatewayTimeout)
		return
	}
	for k, vs := range resp.Headers {
		// 跳过逐跳 header，避免污染回给云梯的响应。
		if isHopByHop(k) {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	status := resp.Status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	_, _ = w.Write(resp.Body)
}

// handlePoll 让 agent 长轮询取下一个请求。空闲到点返 204。
func (s *Server) handlePoll(w http.ResponseWriter, r *http.Request) {
	env := strings.TrimSpace(r.URL.Query().Get("env"))
	if env == "" {
		http.Error(w, "missing env", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.pollTimeout)
	defer cancel()
	req, ok, err := s.hub.Poll(ctx, env)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(req)
}

// handleReply 让 agent 交回某个 rid 的应答。rid 已不存在（ingest 超时放弃）时返 410。
func (s *Server) handleReply(w http.ResponseWriter, r *http.Request) {
	rid := strings.TrimSpace(r.URL.Query().Get("rid"))
	if rid == "" {
		http.Error(w, "missing rid", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, s.maxBodyBytes))
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	var resp TunneledResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		http.Error(w, "decode reply: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !s.hub.Reply(rid, resp) {
		http.Error(w, "unknown or expired rid", http.StatusGone)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func cloneHeader(h http.Header) map[string][]string {
	out := make(map[string][]string, len(h))
	for k, vs := range h {
		if strings.EqualFold(k, "Authorization") {
			continue // 不把云梯→hub 的鉴权 header 透传给本地服务
		}
		cp := make([]string, len(vs))
		copy(cp, vs)
		out[k] = cp
	}
	return out
}

func isHopByHop(k string) bool {
	switch http.CanonicalHeaderKey(k) {
	case "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
		"Te", "Trailer", "Transfer-Encoding", "Upgrade", "Content-Length":
		return true
	}
	return false
}
