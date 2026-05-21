package gateway

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Server struct {
	cfg Config
}

func Run(cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	server := &Server{cfg: cfg}
	mux := http.NewServeMux()
	server.routes(mux)
	log.Printf("mychat gateway listening on http://%s", cfg.Addr)
	return http.ListenAndServe(cfg.Addr, withCORS(mux))
}

func (s *Server) routes(mux *http.ServeMux) {
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/v1/", s.handleFileAPIProxy)
	mux.HandleFunc("/acp", s.handleRawACP)
	mux.HandleFunc("/ws", s.handleAppWS)
	if _, err := os.Stat(s.cfg.StaticDir); err == nil {
		mux.Handle("/", http.FileServer(http.Dir(s.cfg.StaticDir)))
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte("mychat gateway is running; build the frontend into " + filepath.Clean(s.cfg.StaticDir)))
		})
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-MyChat-Token, X-Tenant-ID, X-Project-ID")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleFileAPIProxy(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if strings.TrimSpace(s.cfg.FileAPIBaseURL) == "" {
		http.Error(w, "file api proxy is not configured", http.StatusBadGateway)
		return
	}
	target, err := url.Parse(s.cfg.FileAPIBaseURL)
	if err != nil {
		http.Error(w, "invalid file api proxy target", http.StatusBadGateway)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = target.Host
		req.URL.Path = singleJoiningSlash(target.Path, r.URL.Path)
		req.URL.RawQuery = r.URL.RawQuery
	}
	proxy.ServeHTTP(w, r)
}

func singleJoiningSlash(a, b string) string {
	aslash := strings.HasSuffix(a, "/")
	bslash := strings.HasPrefix(b, "/")
	switch {
	case aslash && bslash:
		return a + b[1:]
	case !aslash && !bslash:
		return a + "/" + b
	default:
		return a + b
	}
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{
		"ok":        true,
		"runtime":   "acp",
		"command":   s.cfg.Command,
		"strictACP": true,
		"time":      time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleRawACP(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !s.allowedWebSocketOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	ws, err := AcceptWebSocket(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.bridgeRaw(r.Context(), ws)
}

func (s *Server) handleAppWS(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !s.allowedWebSocketOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	ws, err := AcceptWebSocket(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.bridgeApp(r.Context(), ws)
}

func (s *Server) authorized(r *http.Request) bool {
	if s.cfg.Token == "" {
		return true
	}
	return r.URL.Query().Get("token") == s.cfg.Token || r.Header.Get("X-MyChat-Token") == s.cfg.Token
}

func (s *Server) allowedWebSocketOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if s.cfg.Token != "" && s.authorized(r) {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	return isLoopbackHost(host)
}

func (s *Server) bridgeRaw(parent context.Context, ws *WSConn) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer ws.Close()
	agent, err := StartAgent(ctx, s.cfg.Command)
	if err != nil {
		_ = ws.WriteText(mustJSON(ErrorEnvelope{Type: "error", Error: AppError{Code: "agent", Kind: "start_failed", Message: err.Error()}}))
		return
	}
	defer agent.Close()
	go func() {
		if err := agent.ReadStdoutLines(ctx, func(line []byte) { _ = ws.WriteText(line) }); err != nil {
			log.Printf("acp stdout error: %v", err)
		}
		cancel()
		_ = ws.Close()
	}()
	go func() {
		if err := agent.ReadStderrLines(ctx, func(line string) {
			log.Printf("acp stderr: %s", line)
		}); err != nil {
			log.Printf("acp stderr error: %v", err)
		}
	}()
	for {
		frame, err := ws.ReadText()
		if err != nil {
			return
		}
		if err := agent.WriteLine(frame); err != nil {
			return
		}
	}
}

type appEnvelope struct {
	Type    string          `json:"type"`
	Message json.RawMessage `json:"message,omitempty"`
}

func (s *Server) bridgeApp(parent context.Context, ws *WSConn) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer ws.Close()
	agent, err := StartAgent(ctx, s.cfg.Command)
	if err != nil {
		_ = ws.WriteText(mustJSON(ErrorEnvelope{Type: "error", Error: AppError{Code: "agent", Kind: "start_failed", Message: err.Error()}}))
		return
	}
	defer agent.Close()

	go func() {
		if err := agent.ReadStdoutLines(ctx, func(line []byte) {
			_ = ws.WriteText(mustJSON(map[string]any{
				"type":      "acp",
				"direction": "recv",
				"message":   json.RawMessage(line),
			}))
		}); err != nil {
			_ = ws.WriteText(mustJSON(ErrorEnvelope{Type: "error", Error: AppError{Code: "agent", Kind: "stdout_failed", Message: err.Error()}}))
		} else if ctx.Err() == nil {
			_ = ws.WriteText(mustJSON(ErrorEnvelope{Type: "error", Error: AppError{Code: "agent", Kind: "stdout_closed", Message: "ACP agent stdout closed"}}))
		}
		cancel()
		_ = ws.Close()
	}()
	go func() {
		if err := agent.ReadStderrLines(ctx, func(line string) {
			_ = ws.WriteText(mustJSON(map[string]any{"type": "stderr", "line": line}))
		}); err != nil {
			_ = ws.WriteText(mustJSON(ErrorEnvelope{Type: "error", Error: AppError{Code: "agent", Kind: "stderr_failed", Message: err.Error()}}))
		}
	}()

	_ = ws.WriteText(mustJSON(map[string]any{"type": "connection", "status": "connected"}))
	for {
		frame, err := ws.ReadText()
		if err != nil {
			return
		}
		payload := unwrapAppMessage(frame)
		if _, err := parseJSONRPC(payload); err != nil {
			_ = ws.WriteText(mustJSON(ErrorEnvelope{Type: "error", Error: AppError{Code: "bad_request", Kind: "invalid_jsonrpc", Message: err.Error()}}))
			continue
		}
		if err := agent.WriteLine(payload); err != nil {
			return
		}
		_ = ws.WriteText(mustJSON(map[string]any{
			"type":      "acp",
			"direction": "send",
			"message":   json.RawMessage(payload),
		}))
	}
}

func unwrapAppMessage(frame []byte) []byte {
	var env appEnvelope
	if err := json.Unmarshal(frame, &env); err == nil && env.Type == "acp" && len(env.Message) > 0 {
		return env.Message
	}
	return frame
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func mustJSON(value any) []byte {
	data, err := json.Marshal(value)
	if err != nil {
		return []byte(`{"type":"error","error":{"code":"internal","kind":"marshal_failed"}}`)
	}
	return data
}
