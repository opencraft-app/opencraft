package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/authz"
	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/command"
	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/proxyauth"
	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/runner"
	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/terminal"
)

type Config struct {
	Username         string
	Password         string
	Registry         *command.Registry
	RunnerWS         string
	RunnerToken      string
	ProxyTokenSecret string
	ProxyURL         string
}

type Server struct {
	handler     http.Handler
	registry    *command.Registry
	runnerWS    string
	runnerToken string
	proxyAuth   *proxyauth.Authenticator
	proxyURL    string
}

func NewServer(config Config) *Server {
	server := &Server{
		registry:    config.Registry,
		runnerWS:    strings.TrimSpace(config.RunnerWS),
		runnerToken: strings.TrimSpace(config.RunnerToken),
		proxyAuth:   proxyauth.New(strings.TrimSpace(config.ProxyTokenSecret)),
		proxyURL:    strings.TrimSpace(config.ProxyURL),
	}

	protectedMux := http.NewServeMux()
	protectedMux.HandleFunc("/admin/api/session", server.handleSession)
	protectedMux.HandleFunc("/admin/api/commands/execute", server.handleExecute)
	protectedMux.HandleFunc("/admin/ws/terminal", server.handleTerminal)
	protectedMux.HandleFunc("/admin", server.handleIndex)
	protectedMux.HandleFunc("/admin/", server.handleIndex)
	protected := authz.BasicAuth(strings.TrimSpace(config.Username), strings.TrimSpace(config.Password), protectedMux)

	rootMux := http.NewServeMux()
	rootMux.HandleFunc("/healthz", server.handleHealth)
	rootMux.HandleFunc("/admin/api/commands/proxy", server.handleProxyExecute)
	rootMux.Handle("/", protected)

	return &Server{
		handler:     rootMux,
		registry:    config.Registry,
		runnerWS:    server.runnerWS,
		runnerToken: server.runnerToken,
		proxyAuth:   server.proxyAuth,
		proxyURL:    server.proxyURL,
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	username, _, _ := r.BasicAuth()
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"username":      username,
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}

	var request struct {
		Command string `json:"command"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	result, err := s.registry.Execute(r.Context(), request.Command)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleProxyExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}

	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if _, err := s.proxyAuth.Validate(token); err != nil {
		http.Error(w, http.StatusText(http.StatusUnauthorized), http.StatusUnauthorized)
		return
	}

	var request struct {
		Command string `json:"command"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	result, err := s.registry.Execute(r.Context(), request.Command)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if result.Mode != command.ModeCommand {
		http.Error(w, "proxy only supports command-mode operations", http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(_ *http.Request) bool { return true },
}

func (s *Server) handleTerminal(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	writer := &lockedWS{conn: conn}
	username, _, _ := r.BasicAuth()
	proxyToken, err := s.proxyAuth.Mint(username, 8*time.Hour)
	if err != nil {
		_ = writer.WriteJSON(terminal.Frame{Type: "error", Message: "failed to mint shell proxy token"})
		return
	}

	headers := http.Header{}
	headers.Set("X-Nextgen-Proxy-URL", s.proxyURL)
	headers.Set("X-Nextgen-Proxy-Token", proxyToken)
	headers.Set("X-Nextgen-Proxy-Username", username)

	shellClient, err := runner.DialWithHeaders(s.runnerWS, s.runnerToken, headers)
	if err != nil {
		_ = writer.WriteJSON(terminal.Frame{Type: "error", Message: "shell runner unavailable: " + err.Error()})
		return
	}
	defer shellClient.Close()

	var shellMu sync.Mutex
	shellEnded := false

	_ = writer.WriteJSON(terminal.Frame{
		Type: "ready",
		Mode: string(command.ModeShell),
	})

	go func() {
		for {
			var frame terminal.Frame
			if err := shellClient.ReadJSON(&frame); err != nil {
				shellMu.Lock()
				ended := shellEnded
				shellEnded = true
				shellMu.Unlock()
				if !ended {
					_ = writer.WriteJSON(terminal.Frame{Type: "error", Message: "shell runner disconnected"})
				}
				return
			}
			if frame.Type == "exit" {
				frame.Mode = string(command.ModeShell)
				shellMu.Lock()
				shellEnded = true
				shellMu.Unlock()
			}
			_ = writer.WriteJSON(frame)
			if frame.Type == "exit" {
				return
			}
		}
	}()

	for {
		var message terminal.Frame
		if err := conn.ReadJSON(&message); err != nil {
			return
		}

		shellMu.Lock()
		ended := shellEnded
		shellMu.Unlock()
		if ended {
			_ = writer.WriteJSON(terminal.Frame{Type: "error", Message: "shell session has ended; refresh to reconnect"})
			continue
		}

		if message.Type != "input" && message.Type != "resize" {
			_ = writer.WriteJSON(terminal.Frame{Type: "error", Message: "unsupported message type"})
			continue
		}
		if err := shellClient.WriteJSON(message); err != nil {
			shellMu.Lock()
			shellEnded = true
			shellMu.Unlock()
			_ = writer.WriteJSON(terminal.Frame{Type: "error", Message: "shell runner unavailable: " + err.Error()})
		}
	}
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>nextgen-dashboard</title></head><body><main><h1>nextgen-dashboard</h1><p>The bundled web frontend has been retired. Use the admin APIs and terminal websocket endpoints exposed by this service.</p></main></body></html>`))
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

type lockedWS struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (w *lockedWS) WriteJSON(payload any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.WriteJSON(payload)
}
