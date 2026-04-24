package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"

	"github.com/openclaw/openclaw/mono/nextgen-dashboard/internal/terminal"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(_ *http.Request) bool { return true },
}

func main() {
	addr := envOrDefault("NEXTGEN_RUNNER_ADDR", "127.0.0.1:19091")
	token := envOrDefault("NEXTGEN_RUNNER_TOKEN", envOrDefault("NEXTGEN_DASHBOARD_RUNNER_TOKEN", "nextgen-runner-token"))

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handleHealth)
	mux.HandleFunc("/ws/shell", func(w http.ResponseWriter, r *http.Request) {
		handleShell(w, r, token)
	})

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	slog.Info("nextgen-dashboard ops-runner listening", "addr", addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("nextgen-dashboard ops-runner exited", "err", err)
		os.Exit(1)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/healthz" {
		http.NotFound(w, r)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func handleShell(w http.ResponseWriter, r *http.Request, expectedToken string) {
	if !authorized(r, expectedToken) {
		http.Error(w, http.StatusText(http.StatusUnauthorized), http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	shell := envOrDefault("NEXTGEN_RUNNER_SHELL", "/bin/bash")
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	cmd := exec.CommandContext(ctx, shell, "-l")
	cmd.Env = shellEnvironment(shell, r)
	ptmx, err := pty.Start(cmd)
	if err != nil {
		_ = conn.WriteJSON(terminal.Frame{Type: "error", Message: err.Error()})
		return
	}
	defer func() { _ = ptmx.Close() }()

	writer := &lockedWS{conn: conn}
	go func() {
		err := cmd.Wait()
		_ = writer.WriteJSON(terminal.Frame{Type: "exit", Code: exitCode(err)})
		_ = conn.Close()
	}()
	go func() {
		buffer := make([]byte, 4096)
		for {
			n, readErr := ptmx.Read(buffer)
			if n > 0 {
				_ = writer.WriteJSON(terminal.Frame{Type: "output", Data: string(buffer[:n])})
			}
			if readErr != nil {
				return
			}
		}
	}()

	for {
		var frame terminal.Frame
		if err := conn.ReadJSON(&frame); err != nil {
			_ = cmd.Process.Kill()
			return
		}
		switch frame.Type {
		case "input":
			if _, err := ptmx.Write([]byte(frame.Data)); err != nil {
				_ = writer.WriteJSON(terminal.Frame{Type: "error", Message: err.Error()})
			}
		case "resize":
			_ = pty.Setsize(ptmx, &pty.Winsize{
				Cols: uint16(frame.Cols),
				Rows: uint16(frame.Rows),
			})
		}
	}
}

func authorized(r *http.Request, expectedToken string) bool {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if expectedToken == "" {
		return true
	}
	return auth == "Bearer "+expectedToken
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

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func shellEnvironment(shell string, r *http.Request) []string {
	env := []string{
		"SHELL=" + strings.TrimSpace(shell),
		"PATH=" + envOrDefault("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
		"HOME=" + envOrDefault("HOME", "/root"),
		"USER=" + envOrDefault("USER", "root"),
		"LOGNAME=" + envOrDefault("LOGNAME", "root"),
		"TERM=" + envOrDefault("TERM", "xterm-256color"),
		"LANG=" + envOrDefault("LANG", "C.UTF-8"),
	}

	if hostname := strings.TrimSpace(os.Getenv("HOSTNAME")); hostname != "" {
		env = append(env, "HOSTNAME="+hostname)
	}

	if proxyURL := strings.TrimSpace(r.Header.Get("X-Nextgen-Proxy-URL")); proxyURL != "" {
		env = append(env, "NEXTGEN_PROXY_URL="+proxyURL)
	}
	if proxyToken := strings.TrimSpace(r.Header.Get("X-Nextgen-Proxy-Token")); proxyToken != "" {
		env = append(env, "NEXTGEN_PROXY_TOKEN="+proxyToken)
	}
	if proxyUsername := strings.TrimSpace(r.Header.Get("X-Nextgen-Proxy-Username")); proxyUsername != "" {
		env = append(env, "NEXTGEN_PROXY_USERNAME="+proxyUsername)
	}
	return env
}

func errorsAs(err error, target any) bool {
	switch typed := target.(type) {
	case **exec.ExitError:
		exitErr, ok := err.(*exec.ExitError)
		if !ok {
			return false
		}
		*typed = exitErr
		return true
	default:
		return false
	}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errorsAs(err, &exitErr) {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok {
			return status.ExitStatus()
		}
	}
	return 1
}
