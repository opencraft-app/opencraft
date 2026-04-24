package ingressproxy

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"

	"cvm-mock-e2b/internal/serverstate"
)

func HealthHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func ReadyHandler(drain *serverstate.DrainState) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if drain != nil && drain.IsDraining() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "draining"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	}
}

func DrainHandler(drain *serverstate.DrainState) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRemoteAddr(r.RemoteAddr) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if drain != nil {
			drain.BeginDraining()
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "draining"})
	}
}

func isLoopbackRemoteAddr(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(remoteAddr))
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
