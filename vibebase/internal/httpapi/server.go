package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"git.woa.com/wisp/mono/vibebase/internal/store"
)

const (
	identityUserHeader = "X-Lightclaw-User-ID"
	maxListLimit       = 100
	buddyNamespace     = "agent-state"
	buddyKeyPrefix     = "buddy."
	maxBuddySouls      = 8
)

type Server struct {
	store                store.KVStore
	internalServiceToken string
	maxNameBytes         int
	maxValueBytes        int
}

type Options struct {
	Store                store.KVStore
	InternalServiceToken string
	MaxNameBytes         int
	MaxValueBytes        int
}

func New(opts Options) http.Handler {
	s := &Server{
		store:                opts.Store,
		internalServiceToken: opts.InternalServiceToken,
		maxNameBytes:         opts.MaxNameBytes,
		maxValueBytes:        opts.MaxValueBytes,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.healthz)
	mux.HandleFunc("/livez", s.livez)
	mux.HandleFunc("/v1/namespaces/", s.requireInternalAuth(s.handleKV))
	return mux
}

func (s *Server) livez(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 1500*time.Millisecond)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "redis_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) requireInternalAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		expected := "Bearer " + s.internalServiceToken
		got := strings.TrimSpace(r.Header.Get("Authorization"))
		if subtle.ConstantTimeCompare([]byte(got), []byte(expected)) != 1 {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if strings.TrimSpace(r.Header.Get(identityUserHeader)) == "" {
			writeError(w, http.StatusUnauthorized, "missing_user_identity")
			return
		}
		next(w, r)
	}
}

func (s *Server) handleKV(w http.ResponseWriter, r *http.Request) {
	ownerID := strings.TrimSpace(r.Header.Get(identityUserHeader))
	namespace, key, listMode, ok := parseKVPath(r.URL.EscapedPath())
	if !ok {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	if err := validateName("namespace", namespace, s.maxNameBytes); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if listMode {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		s.list(w, r, ownerID, namespace)
		return
	}

	if err := validateName("key", key, s.maxNameBytes); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	switch r.Method {
	case http.MethodPut:
		s.put(w, r, ownerID, namespace, key)
	case http.MethodGet:
		s.get(w, r, ownerID, namespace, key)
	case http.MethodDelete:
		s.delete(w, r, ownerID, namespace, key)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
	}
}

func (s *Server) put(w http.ResponseWriter, r *http.Request, ownerID string, namespace string, key string) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, int64(s.maxValueBytes+1)))
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "value_too_large")
			return
		}
		writeError(w, http.StatusBadRequest, "read_body_failed")
		return
	}
	if len(body) > s.maxValueBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "value_too_large")
		return
	}
	if err := validateValue(body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateBuddyStateValue(namespace, key, body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	entry, created, err := s.store.Put(r.Context(), ownerID, namespace, key, body)
	if errors.Is(err, store.ErrQuotaExceeded) {
		writeError(w, http.StatusConflict, "quota_exceeded")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error")
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{
		"namespace":  entry.Namespace,
		"key":        entry.Key,
		"size":       entry.Size,
		"updated_at": entry.UpdatedAt,
		"created":    created,
	})
}

func (s *Server) get(w http.ResponseWriter, r *http.Request, ownerID string, namespace string, key string) {
	entry, err := s.store.Get(r.Context(), ownerID, namespace, key)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error")
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (s *Server) delete(w http.ResponseWriter, r *http.Request, ownerID string, namespace string, key string) {
	deleted, err := s.store.Delete(r.Context(), ownerID, namespace, key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store_error")
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) list(w http.ResponseWriter, r *http.Request, ownerID string, namespace string) {
	limit := maxListLimit
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 || parsed > maxListLimit {
			writeError(w, http.StatusBadRequest, "invalid_limit")
			return
		}
		limit = parsed
	}
	page, err := s.store.List(r.Context(), ownerID, namespace, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		if strings.Contains(err.Error(), "invalid cursor") {
			writeError(w, http.StatusBadRequest, "invalid_cursor")
			return
		}
		writeError(w, http.StatusInternalServerError, "store_error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": page.Entries, "next_cursor": page.NextCursor})
}

func parseKVPath(escapedPath string) (string, string, bool, bool) {
	const prefix = "/v1/namespaces/"
	if !strings.HasPrefix(escapedPath, prefix) {
		return "", "", false, false
	}
	rest := strings.TrimPrefix(escapedPath, prefix)
	nsEsc, after, ok := strings.Cut(rest, "/kv")
	if !ok || nsEsc == "" {
		return "", "", false, false
	}
	if after == "" {
		ns, err := url.PathUnescape(nsEsc)
		return ns, "", true, err == nil
	}
	if !strings.HasPrefix(after, "/") {
		return "", "", false, false
	}
	keyEsc := strings.TrimPrefix(after, "/")
	if keyEsc == "" {
		return "", "", false, false
	}
	ns, err := url.PathUnescape(nsEsc)
	if err != nil {
		return "", "", false, false
	}
	key, err := url.PathUnescape(keyEsc)
	if err != nil {
		return "", "", false, false
	}
	return ns, key, false, true
}

func validateName(kind string, value string, maxBytes int) error {
	if value == "" {
		return fmt.Errorf("%s_required", kind)
	}
	if !utf8.ValidString(value) {
		return fmt.Errorf("%s_invalid_utf8", kind)
	}
	if len([]byte(value)) > maxBytes {
		return fmt.Errorf("%s_too_large", kind)
	}
	return nil
}

func validateValue(value []byte) error {
	if !utf8.Valid(value) {
		return fmt.Errorf("value_invalid_utf8")
	}
	return nil
}

func validateBuddyStateValue(namespace string, key string, value []byte) error {
	if namespace != buddyNamespace || !strings.HasPrefix(key, buddyKeyPrefix) {
		return nil
	}
	var payload struct {
		DrawnSouls []json.RawMessage `json:"drawnSouls"`
	}
	if err := json.Unmarshal(value, &payload); err != nil {
		return fmt.Errorf("buddy_state_invalid_json")
	}
	if len(payload.DrawnSouls) > maxBuddySouls {
		return fmt.Errorf("buddy_drawn_souls_too_many")
	}
	return nil
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
