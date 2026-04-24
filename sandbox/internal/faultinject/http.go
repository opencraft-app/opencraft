package faultinject

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type Handler struct {
	injector interface {
		InjectSGLimit(context.Context, SGLimitRequest) (SGLimitResult, error)
	}
	token   string
	timeout time.Duration
}

func NewHandler(injector *Injector, token string) *Handler {
	return &Handler{
		injector: injector,
		token:    strings.TrimSpace(token),
		timeout:  15 * time.Minute,
	}
}

func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/inject/sg-limit", h.handleInjectSGLimit)
	return mux
}

func (h *Handler) handleInjectSGLimit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if h.token != "" && strings.TrimSpace(r.Header.Get("X-Faultinject-Token")) != h.token {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	var req SGLimitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if !req.AutoCleanup {
		req.AutoCleanup = true
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	result, err := h.injector.InjectSGLimit(ctx, req)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}
