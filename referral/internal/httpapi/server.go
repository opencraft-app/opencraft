package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"git.woa.com/wisp/mono/referral/internal/domain"
	"git.woa.com/wisp/mono/referral/internal/service"
)

type Server struct {
	enabled bool
	svc     *service.Service
}

func NewRouter(enabled bool, svc *service.Service) http.Handler {
	server := &Server{enabled: enabled, svc: svc}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", server.health)
	mux.HandleFunc("GET /v1/referrals/codes/{code}", server.resolveCode)
	mux.HandleFunc("POST /v1/referrals/me/code", server.issueCode)
	mux.HandleFunc("GET /v1/referrals/me", server.me)
	mux.HandleFunc("GET /v1/referrals/me/stats", server.stats)
	return mux
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": map[string]any{"status": "ok", "enabled": s.enabled}})
}

func (s *Server) resolveCode(w http.ResponseWriter, r *http.Request) {
	if !s.requireEnabled(w) {
		return
	}
	result, err := s.svc.ResolveCode(r.Context(), r.PathValue("code"))
	if errors.Is(err, domain.ErrCodeNotFound) {
		writeError(w, http.StatusNotFound, "referral_code_not_found", "返利码不存在或当前不可用。")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "返利码查询失败。")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": result})
}

func (s *Server) issueCode(w http.ResponseWriter, r *http.Request) {
	if !s.requireEnabled(w) {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	result, err := s.svc.IssueCode(r.Context(), userID)
	if errors.Is(err, domain.ErrNoActiveCampaign) {
		writeError(w, http.StatusConflict, "campaign_inactive", "当前没有可用的邀请返利活动。")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "返利码创建失败。")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": result})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	if !s.requireEnabled(w) {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	result, err := s.svc.Me(r.Context(), userID)
	if errors.Is(err, domain.ErrCodeNotFound) || errors.Is(err, domain.ErrNoActiveCampaign) {
		writeError(w, http.StatusNotFound, "referral_code_not_found", "尚未创建返利码。")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "邀请返利信息查询失败。")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": result})
}

func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	if !s.requireEnabled(w) {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	result, err := s.svc.Stats(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal_error", "邀请返利统计查询失败。")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "data": result})
}

func (s *Server) requireEnabled(w http.ResponseWriter) bool {
	if s.enabled {
		return true
	}
	writeError(w, http.StatusNotFound, "not_found", "not found")
	return false
}

func requireUserID(w http.ResponseWriter, r *http.Request) (string, bool) {
	userID := strings.TrimSpace(r.Header.Get("X-User-Id"))
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return "", false
	}
	return userID, true
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"success": false, "code": code, "message": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
