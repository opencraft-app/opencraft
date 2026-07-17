package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
	"git.woa.com/wisp/mono2/llmgateway/internal/lifecycle"
)

const adminSessionCookieName = "llmgateway_admin_token"
const consoleProxyPrefix = "/_llmgateway_console/"

type Config struct {
	AdminUsername                  string
	AdminPassword                  string
	AdminToken                     string
	InternalToken                  string
	ConsoleDist                    string
	TrafficBaseURL                 string
	TrafficProbeClient             *http.Client
	TrafficProbeTimeout            time.Duration
	LegacySubscriptionClientCompat bool
	Lifecycle                      *lifecycle.State
	E2EHooks                       bool
}

type Server struct {
	mux         *http.ServeMux
	svc         *gateway.Service
	config      Config
	e2eInFlight atomic.Int64
}

func NewServer(svc *gateway.Service, config Config) http.Handler {
	server := newControlServer(svc, config)
	server.routes()
	return server
}

func NewControlServer(svc *gateway.Service, config Config) http.Handler {
	server := newControlServer(svc, config)
	server.controlRoutes(true)
	return server
}

func newControlServer(svc *gateway.Service, config Config) *Server {
	if config.AdminUsername == "" {
		config.AdminUsername = "cluster-admin"
	}
	server := &Server{
		mux:    http.NewServeMux(),
		svc:    svc,
		config: config,
	}
	return server
}

func NewTrafficServer(svc *gateway.Service, config Config) http.Handler {
	server := &Server{
		mux:    http.NewServeMux(),
		svc:    svc,
		config: config,
	}
	server.trafficRoutes()
	return server
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.isDraining() {
		w.Header().Set("Connection", "close")
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) commonRoutes() {
	s.mux.HandleFunc("/healthz", s.health)
	s.mux.HandleFunc("/readyz", s.ready)
	s.mux.HandleFunc("/metrics", s.metrics)
	if s.config.E2EHooks {
		s.mux.HandleFunc("/_llmgateway_e2e/inflight", s.e2eInflight)
		s.mux.HandleFunc("/_llmgateway_e2e/sleep", s.e2eSleep)
	}
}

func (s *Server) routes() {
	s.controlRoutes(false)
	s.mux.Handle("/v1/", s.trafficHandler())
}

func (s *Server) controlRoutes(blockTraffic bool) {
	s.commonRoutes()
	s.mux.HandleFunc("/", s.requireAdminPage(s.root))
	s.mux.HandleFunc("/admin", s.requireAdminPage(s.adminShell))
	s.mux.HandleFunc("/admin/", s.requireAdminPage(s.adminShell))
	s.mux.HandleFunc("/admin/login", s.adminLoginPage)
	s.mux.HandleFunc("/assets/", s.requireAdminPage(s.consoleAsset))
	s.mux.HandleFunc("/console-sw.js", s.requireAdminPage(s.consoleServiceWorker))
	s.mux.HandleFunc(consoleProxyPrefix, s.requireAdminPage(s.consoleProxy))
	s.mux.HandleFunc("/api/admin/login", s.adminLogin)
	s.mux.HandleFunc("/api/admin/logout", s.adminLogout)
	s.mux.HandleFunc("/api/admin/overview", s.requireAdmin(s.adminOverview))
	s.mux.HandleFunc("/api/admin/background-jobs", s.requireAdmin(s.adminBackgroundJobs))
	s.mux.HandleFunc("/api/admin/traffic-probe", s.requireAdmin(s.adminTrafficProbe))
	s.mux.HandleFunc("/api/admin/jobs", s.requireAdmin(s.adminJobs))
	s.mux.HandleFunc("/api/admin/jobs/", s.requireAdmin(s.adminJobAction))
	s.mux.HandleFunc("/api/admin/byok-sync/retry", s.requireAdmin(s.adminRetryBYOKSync))
	s.mux.HandleFunc("/api/admin/shard-expansions", s.requireAdmin(s.adminShardExpansions))
	s.mux.HandleFunc("/api/admin/shard-expansions/", s.requireAdmin(s.adminShardExpansionAction))
	s.mux.HandleFunc("/api/admin/shards", s.requireAdmin(s.adminShards))
	s.mux.HandleFunc("/api/admin/shards/", s.requireAdmin(s.adminShardAction))
	s.mux.HandleFunc("/api/admin/set-reconcile-facts", s.requireAdmin(s.adminSetReconcileFacts))
	s.mux.HandleFunc("/api/admin/set-reconcile-facts/reconcile", s.requireAdmin(s.adminSetReconcileFactsReconcile))
	s.mux.HandleFunc("/api/admin/set-capacity/reconcile", s.requireAdmin(s.adminSetCapacityReconcile))
	s.mux.HandleFunc("/api/admin/set-provision-requests", s.requireAdmin(s.adminSetProvisionRequests))
	s.mux.HandleFunc("/api/admin/set-provision-requests/", s.requireAdmin(s.adminSetProvisionRequestAction))
	s.mux.HandleFunc("/api/admin/resources", s.requireAdmin(s.adminResources))
	s.mux.HandleFunc("/api/admin/resources/", s.requireAdmin(s.adminResourceAction))
	s.mux.HandleFunc("/api/admin/tenants", s.requireAdmin(s.adminTenants))
	s.mux.HandleFunc("/api/admin/tenant-statistics", s.requireAdmin(s.adminTenantStatistics))
	s.mux.HandleFunc("/api/admin/tenant-deletions", s.requireAdmin(s.adminTenantDeletions))
	s.mux.HandleFunc("/api/admin/tenant-deletions/", s.requireAdmin(s.adminTenantDeletionAction))
	s.mux.HandleFunc("/api/admin/set-decommissions", s.requireAdmin(s.adminSetDecommissions))
	s.mux.HandleFunc("/api/admin/set-decommissions/", s.requireAdmin(s.adminSetDecommissionAction))
	s.mux.HandleFunc("/api/admin/set-upgrades", s.requireAdmin(s.adminSetUpgrades))
	s.mux.HandleFunc("/api/admin/set-upgrades/", s.requireAdmin(s.adminSetUpgradeAction))
	s.mux.HandleFunc("/api/admin/set-upgrade-runs", s.requireAdmin(s.adminSetUpgradeRuns))
	s.mux.HandleFunc("/api/admin/newapi-releases", s.requireAdmin(s.adminNewAPIReleases))
	s.mux.HandleFunc("/api/admin/release-rings", s.requireAdmin(s.adminReleaseRings))
	s.mux.HandleFunc("/api/admin/release-rollouts", s.requireAdmin(s.adminReleaseRollouts))
	s.mux.HandleFunc("/api/admin/release-rollouts/", s.requireAdmin(s.adminReleaseRolloutAction))
	s.mux.HandleFunc("/api/admin/set-upgrade-runs/", s.requireAdmin(s.adminSetUpgradeRunAction))
	s.mux.HandleFunc("/api/admin/tenants/", s.requireAdmin(s.adminTenantAction))
	s.mux.HandleFunc("/api/admin/users/", s.requireAdmin(s.adminUserAction))
	s.mux.HandleFunc("/api/admin/api-keys/", s.requireAdmin(s.adminAPIKeyAction))
	s.mux.HandleFunc("/api/sets", s.requireAdmin(s.sets))
	s.mux.HandleFunc("/api/sets/", s.requireAdmin(s.setAction))
	s.mux.HandleFunc("/api/channel-bundles", s.requireAdmin(s.channelBundles))
	s.mux.HandleFunc("/api/channel-bundles/", s.requireAdmin(s.channelBundleAction))
	s.mux.HandleFunc("/api/channel-bundle-releases/", s.requireAdmin(s.channelBundleReleaseAction))
	s.mux.HandleFunc("/api/desired-config/export", s.requireAdmin(s.desiredConfigExport))
	s.mux.HandleFunc("/api/desired-config/import", s.requireAdmin(s.desiredConfigImport))
	s.mux.HandleFunc("/api/plans", s.requireAdmin(s.plans))
	s.mux.HandleFunc("/api/plans/", s.requireAdmin(s.planAction))
	s.mux.HandleFunc("/api/users/", s.requireAdmin(s.userAction))
	// Cleanup authorization is protected by a short-lived, payload-bound capability.
	s.mux.HandleFunc("/api/internal/runtime-cleanups/authorize", s.internalAuthorizeRuntimeCleanup)
	s.mux.HandleFunc("/api/internal/", s.requireInternal(s.internalAction))
	s.mux.HandleFunc("/api/", s.requireAdminPage(s.consoleFallbackProxy))
	s.mux.HandleFunc("/static/", s.requireAdminPage(s.consoleFallbackProxy))
	s.mux.HandleFunc("/oauth/", s.requireAdminPage(s.consoleFallbackProxy))
	s.mux.HandleFunc("/logo.png", s.requireAdminPage(s.consoleFallbackProxy))
	s.mux.HandleFunc("/favicon.ico", s.requireAdminPage(s.consoleFallbackProxy))
	s.mux.HandleFunc("/manifest.json", s.requireAdminPage(s.consoleFallbackProxy))
	if blockTraffic {
		s.mux.HandleFunc("/v1/", http.NotFound)
	}
}

func (s *Server) trafficRoutes() {
	s.commonRoutes()
	s.mux.Handle("/v1/", s.trafficHandler())
}

func (s *Server) trafficHandler() http.Handler {
	return http.HandlerFunc(s.svc.ProxyHTTP)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, response{Success: true, Data: map[string]string{"status": "ok"}})
}

func (s *Server) ready(w http.ResponseWriter, _ *http.Request) {
	if s.isDraining() {
		writeJSON(w, http.StatusServiceUnavailable, response{Success: false, Message: "draining"})
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: map[string]string{"status": "ready"}})
}

func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = w.Write([]byte(s.svc.PrometheusMetrics()))
}

func (s *Server) isDraining() bool {
	return s.config.Lifecycle != nil && s.config.Lifecycle.IsDraining()
}

func (s *Server) e2eInflight(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(strconv.FormatInt(s.e2eInFlight.Load(), 10)))
}

func (s *Server) e2eSleep(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	duration := 2 * time.Second
	if raw := strings.TrimSpace(r.URL.Query().Get("duration")); raw != "" {
		parsed, err := time.ParseDuration(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "invalid duration")
			return
		}
		duration = parsed
	}
	if duration > 10*time.Second {
		duration = 10 * time.Second
	}

	s.e2eInFlight.Add(1)
	defer s.e2eInFlight.Add(-1)

	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("done"))
	case <-r.Context().Done():
		return
	}
}

func (s *Server) root(w http.ResponseWriter, r *http.Request) {
	if setID := strings.TrimSpace(r.URL.Query().Get("llmgateway_console_set")); setID != "" {
		query := r.URL.Query()
		query.Del("llmgateway_console_set")
		target := consoleProxyPrefix + url.PathEscape(setID) + r.URL.Path
		if rawQuery := query.Encode(); rawQuery != "" {
			target += "?" + rawQuery
		}
		http.Redirect(w, r, target, http.StatusTemporaryRedirect)
		return
	}
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

func (s *Server) adminShell(w http.ResponseWriter, r *http.Request) {
	if s.config.ConsoleDist != "" {
		indexPath := filepath.Join(s.config.ConsoleDist, "index.html")
		if _, err := os.Stat(indexPath); err == nil {
			http.ServeFile(w, r, indexPath)
			return
		}
	}
	writeError(w, http.StatusInternalServerError, "LLMGateway console is not built or LLMGATEWAY_CONSOLE_DIST is not configured")
}

func (s *Server) adminLoginPage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.isAdminAuthenticated(r) {
		http.Redirect(w, r, "/admin", http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(adminLoginHTML))
}

func (s *Server) consoleAsset(w http.ResponseWriter, r *http.Request) {
	if s.config.ConsoleDist == "" {
		http.NotFound(w, r)
		return
	}
	http.StripPrefix("/", http.FileServer(http.Dir(s.config.ConsoleDist))).ServeHTTP(w, r)
}

func (s *Server) adminLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Username != s.config.AdminUsername || req.Password != s.config.AdminPassword {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	s.setAdminSessionCookie(w, r)
	writeJSON(w, http.StatusOK, response{Success: true, Data: map[string]string{"token": s.config.AdminToken}})
}

func (s *Server) adminLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	s.clearAdminSessionCookie(w, r)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, response{Success: true})
}

func (s *Server) adminOverview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	overview, err := s.svc.GetOperationalOverview(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: overview})
}

func (s *Server) adminBackgroundJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	overview, err := s.svc.GetBackgroundJobsOverview(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: overview})
}

func (s *Server) adminJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	jobs, err := s.svc.ListWorkerJobs(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: jobs})
}

func (s *Server) adminJobAction(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/jobs/"), "/")
	parts := strings.Split(trimmed, "/")
	if len(parts) != 2 || parts[1] != "run" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	name, err := url.PathUnescape(parts[0])
	if err != nil || strings.TrimSpace(name) == "" {
		writeError(w, http.StatusBadRequest, "invalid job name")
		return
	}
	run, err := s.svc.QueueWorkerJobNow(r.Context(), name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: run})
}

func (s *Server) adminRetryBYOKSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	requeued, err := s.svc.RetryFailedBYOKSyncTasks(r.Context(), 1000)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: map[string]int{"requeued": requeued}})
}

func (s *Server) consoleServiceWorker(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(consoleServiceWorkerJS))
}

func (s *Server) consoleProxy(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, consoleProxyPrefix)
	parts := strings.SplitN(trimmed, "/", 2)
	if len(parts) == 0 || parts[0] == "" {
		writeError(w, http.StatusNotFound, "set id is required")
		return
	}
	setID, err := url.PathUnescape(parts[0])
	if err != nil || strings.TrimSpace(setID) == "" {
		writeError(w, http.StatusBadRequest, "invalid set id")
		return
	}
	upstreamPath := "/"
	if len(parts) == 2 {
		upstreamPath = "/" + parts[1]
	}
	logConsoleRoute("prefixed", r, setID, upstreamPath)
	s.svc.ProxyConsoleHTTP(w, r, setID, upstreamPath)
}

func (s *Server) consoleFallbackProxy(w http.ResponseWriter, r *http.Request) {
	setID, source, conflict := consoleSetIDFromRequestWithSource(r)
	if conflict {
		log.Printf("[llmgateway] console fallback conflicting set identities: method=%s path=%s header=%q query=%q referer=%q",
			r.Method,
			r.URL.RequestURI(),
			r.Header.Get("X-LLMGateway-Set"),
			r.URL.Query().Get("llmgateway_console_set"),
			r.Header.Get("Referer"),
		)
		writeError(w, http.StatusConflict, "conflicting console set identities")
		return
	}
	if setID == "" {
		log.Printf("[llmgateway] console fallback missing set: method=%s path=%s referer=%q has_query=%t has_x_set=%t",
			r.Method,
			r.URL.RequestURI(),
			r.Header.Get("Referer"),
			strings.TrimSpace(r.URL.Query().Get("llmgateway_console_set")) != "",
			strings.TrimSpace(r.Header.Get("X-LLMGateway-Set")) != "",
		)
		http.NotFound(w, r)
		return
	}
	logConsoleRoute(source, r, setID, r.URL.Path)
	s.svc.ProxyConsoleHTTP(w, r, setID, r.URL.Path)
}

func (s *Server) adminShards(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		shards, err := s.svc.ListShardDetails(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: shards})
	case http.MethodPost:
		writeError(w, http.StatusMethodNotAllowed, "Shard 由 LLMFleet 投影，请通过扩容流程创建")
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) adminShardExpansions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		expansions, err := s.svc.ListShardExpansions(r.Context(), gateway.ShardExpansionListOptions{Limit: queryInt(r, "limit", 100)})
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: expansions})
	case http.MethodPost:
		var input gateway.CreateShardExpansionInput
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		expansion, err := s.svc.CreateShardExpansion(r.Context(), input)
		if err != nil {
			if errors.Is(err, gateway.ErrShardExpansionIdempotencyConflict) {
				writeError(w, http.StatusConflict, err.Error())
				return
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, response{Success: true, Data: expansion})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) adminShardExpansionAction(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/shard-expansions/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || strings.TrimSpace(parts[0]) == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	id, err := url.PathUnescape(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid expansion id")
		return
	}
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		expansion, err := s.svc.GetShardExpansion(r.Context(), id)
		if err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: expansion})
	case len(parts) == 2 && parts[1] == "infrastructure" && r.Method == http.MethodPost:
		var input gateway.RecordShardExpansionInfrastructureInput
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		expansion, err := s.svc.RecordShardExpansionInfrastructure(r.Context(), id, input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: expansion})
	case len(parts) == 2 && parts[1] == "verification" && r.Method == http.MethodPost:
		var input gateway.RecordShardExpansionVerificationInput
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		expansion, err := s.svc.RecordShardExpansionVerification(r.Context(), id, input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: expansion})
	case len(parts) == 2 && parts[1] == "retry" && r.Method == http.MethodPost:
		expansion, err := s.svc.RetryShardExpansion(r.Context(), id)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: expansion})
	case len(parts) == 2 && parts[1] == "cancel" && r.Method == http.MethodPost:
		expansion, err := s.svc.CancelShardExpansion(r.Context(), id)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: expansion})
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) adminShardAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/shards/"), "/")
	if id == "" || strings.Contains(id, "/") {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	detail, err := s.svc.GetShardDetail(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: detail})
}

func (s *Server) sets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		sets, err := s.svc.ListSets(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: sets})
	case http.MethodPost:
		var req gateway.RegisterSetInput
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := s.svc.RegisterSet(r.Context(), req); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) setAction(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/sets/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) != 2 || parts[1] != "bootstrap" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	set, err := s.svc.BootstrapSet(r.Context(), parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: set})
}

func (s *Server) adminSetReconcileFacts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		opts := gateway.SetReconcileFactListOptions{
			Source:    strings.TrimSpace(r.URL.Query().Get("source")),
			Namespace: strings.TrimSpace(r.URL.Query().Get("namespace")),
			Fleet:     strings.TrimSpace(r.URL.Query().Get("fleet")),
			Status:    strings.TrimSpace(r.URL.Query().Get("status")),
		}
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid limit")
				return
			}
			opts.Limit = parsed
		}
		facts, err := s.svc.ListSetReconcileFacts(r.Context(), opts)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: facts})
	case http.MethodPost:
		var req gateway.RecordSetReconcileFactsInput
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		result, err := s.svc.RecordSetReconcileFacts(r.Context(), req)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: result})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) adminSetReconcileFactsReconcile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req gateway.ReconcileSetReconcileFactsInput
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
	}
	result, err := s.svc.ReconcileSetReconcileFacts(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: result})
}

func (s *Server) adminSetCapacityReconcile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req gateway.SetCapacityPolicy
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	result, err := s.svc.ReconcileSetCapacity(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: result})
}

func (s *Server) adminSetProvisionRequests(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	opts := gateway.SetProvisionRequestListOptions{
		Source:    strings.TrimSpace(r.URL.Query().Get("source")),
		Namespace: strings.TrimSpace(r.URL.Query().Get("namespace")),
		Fleet:     strings.TrimSpace(r.URL.Query().Get("fleet")),
		Status:    strings.TrimSpace(r.URL.Query().Get("status")),
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid limit")
			return
		}
		opts.Limit = parsed
	}
	requests, err := s.svc.ListSetProvisionRequests(r.Context(), opts)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: requests})
}

func (s *Server) adminSetProvisionRequestAction(w http.ResponseWriter, r *http.Request) {
	s.setProvisionRequestAction(w, r, "/api/admin/set-provision-requests/")
}

func (s *Server) setProvisionRequestAction(w http.ResponseWriter, r *http.Request, prefix string) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	suffix := strings.Trim(strings.TrimPrefix(r.URL.Path, prefix), "/")
	if !strings.HasSuffix(suffix, "/status") {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	rawID := strings.TrimSuffix(suffix, "/status")
	id, err := url.PathUnescape(strings.Trim(rawID, "/"))
	if err != nil || strings.TrimSpace(id) == "" {
		writeError(w, http.StatusBadRequest, "invalid request id")
		return
	}
	var req struct {
		Status    string `json:"status"`
		LastError string `json:"last_error,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	request, err := s.svc.UpdateSetProvisionRequestStatus(r.Context(), id, req.Status, req.LastError)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: request})
}

func (s *Server) userAction(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/users/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) != 2 || parts[1] != "keys" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	key, command, err := s.svc.CreateExternalKeyManaged(r.Context(), parts[0], "")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if command != nil {
		writeJSON(w, http.StatusAccepted, response{Success: true, Data: command})
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: map[string]any{
		"external_key":    key.ExternalKey,
		"external_key_id": key.ExternalKeyID,
		"set_id":          key.SetID,
		"upstream_key_id": key.UpstreamKeyID,
	}})
}

func (s *Server) adminResources(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/admin/resources" {
		s.adminResourceAction(w, r)
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: s.svc.ListResourceDefinitions()})
}

func (s *Server) adminResourceAction(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/resources/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) < 2 || strings.TrimSpace(parts[0]) == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	resourceID := parts[0]
	switch {
	case len(parts) == 2 && parts[1] == "rows" && r.Method == http.MethodGet:
		opts := gateway.ResourceListOptions{}
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil {
				opts.Limit = parsed
			}
		}
		if raw := strings.TrimSpace(r.URL.Query().Get("offset")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil {
				opts.Offset = parsed
			}
		}
		result, err := s.svc.ListResourceRows(r.Context(), resourceID, opts)
		if err != nil {
			writeResourceAdminError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: result})
	case len(parts) == 3 && parts[1] == "rows" && r.Method == http.MethodGet:
		rowID, err := url.PathUnescape(parts[2])
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid row id")
			return
		}
		result, err := s.svc.GetResourceRow(r.Context(), resourceID, rowID)
		if err != nil {
			writeResourceAdminError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: result})
	case len(parts) == 3 && parts[1] == "rows" && r.Method == http.MethodPatch:
		rowID, err := url.PathUnescape(parts[2])
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid row id")
			return
		}
		var req struct {
			Values map[string]any `json:"values"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		result, err := s.svc.PatchResourceRow(r.Context(), resourceID, rowID, req.Values)
		if err != nil {
			writeResourceAdminError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: result})
	case len(parts) == 3 && parts[1] == "actions" && r.Method == http.MethodPost:
		var req struct {
			ID     string         `json:"id"`
			Params map[string]any `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		result, err := s.svc.RunResourceAction(r.Context(), resourceID, parts[2], req.ID, req.Params)
		if err != nil {
			writeResourceAdminError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: result})
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) adminTenants(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	opts := gateway.TenantListOptions{
		Keyword: r.URL.Query().Get("keyword"),
		Backend: r.URL.Query().Get("backend"),
		SetID:   r.URL.Query().Get("set_id"),
		Status:  r.URL.Query().Get("status"),
		Cursor:  r.URL.Query().Get("cursor"),
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			opts.Limit = parsed
		}
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("offset")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			opts.Offset = parsed
		}
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("include_total")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid include_total")
			return
		}
		opts.IncludeTotal = parsed
	}
	result, err := s.svc.ListTenants(r.Context(), opts)
	if err != nil {
		if errors.Is(err, gateway.ErrInvalidTenantCursor) || errors.Is(err, gateway.ErrInvalidTenantListOptions) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: result})
}

func (s *Server) adminTenantDeletions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	limit := queryInt(r, "limit", 100)
	jobs, err := s.svc.ListTenantDeletions(r.Context(), gateway.TenantDeletionJobListOptions{
		Status: strings.TrimSpace(r.URL.Query().Get("status")),
		Limit:  limit,
	})
	if err != nil {
		writeDeletionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: jobs})
}

func (s *Server) adminTenantDeletionAction(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/tenant-deletions/"), "/")
	if path == "preview" {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var input gateway.TenantDeletionPreviewInput
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		job, err := s.svc.PreviewTenantDeletion(r.Context(), input)
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, response{Success: true, Data: job})
		return
	}
	parts := strings.Split(path, "/")
	if len(parts) == 0 || strings.TrimSpace(parts[0]) == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	jobID, err := url.PathUnescape(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid job id")
		return
	}
	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		job, err := s.svc.GetTenantDeletion(r.Context(), jobID)
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: job})
	case len(parts) == 2 && parts[1] == "start" && r.Method == http.MethodPost:
		var input gateway.TenantDeletionStartInput
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		job, err := s.svc.StartTenantDeletion(r.Context(), jobID, input)
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, response{Success: true, Data: job})
	case len(parts) == 2 && parts[1] == "failures" && r.Method == http.MethodGet:
		targets, err := s.svc.ListTenantDeletionFailures(r.Context(), jobID, queryInt(r, "limit", 100))
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: targets})
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) adminSetDecommissions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		jobs, err := s.svc.ListSetDecommissions(r.Context(), gateway.SetDecommissionJobListOptions{
			Status: strings.TrimSpace(r.URL.Query().Get("status")),
			Limit:  queryInt(r, "limit", 100),
		})
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: jobs})
	case http.MethodPost:
		var input gateway.SetDecommissionStartInput
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		job, err := s.svc.StartSetDecommission(r.Context(), input)
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, response{Success: true, Data: job})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) adminSetDecommissionAction(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/set-decommissions/"), "/")
	if path == "preview" {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var input struct {
			SetID string `json:"set_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		preview, err := s.svc.PreviewSetDecommission(r.Context(), input.SetID)
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: preview})
		return
	}
	if strings.HasSuffix(path, "/cancel") {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		jobID := strings.TrimSuffix(path, "/cancel")
		var input gateway.SetDecommissionCancelInput
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		input.JobID = jobID
		job, err := s.svc.CancelSetDecommission(r.Context(), input)
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: job})
		return
	}
	if strings.HasSuffix(path, "/retry") {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		jobID := strings.TrimSuffix(path, "/retry")
		var input gateway.SetDecommissionRetryInput
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		input.JobID = jobID
		job, err := s.svc.RetrySetDecommission(r.Context(), input)
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, response{Success: true, Data: job})
		return
	}
	if r.Method != http.MethodGet || strings.Contains(path, "/") {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	job, err := s.svc.GetSetDecommission(r.Context(), path)
	if err != nil {
		writeDeletionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: job})
}

func (s *Server) adminSetUpgrades(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input struct {
		SetIDs                []string `json:"set_ids"`
		TargetImage           string   `json:"target_image"`
		Source                string   `json:"source"`
		Namespace             string   `json:"namespace"`
		Fleet                 string   `json:"fleet"`
		MaxParallel           int      `json:"max_parallel"`
		StopOnFailure         *bool    `json:"stop_on_failure"`
		DrainTimeoutSeconds   int      `json:"drain_timeout_seconds"`
		RollbackWindowSeconds int      `json:"rollback_window_seconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	stopOnFailure := true
	if input.StopOnFailure != nil {
		stopOnFailure = *input.StopOnFailure
	}
	batch, err := s.svc.CreateSetUpgradeBatch(r.Context(), gateway.CreateSetUpgradeBatchInput{
		SetIDs: input.SetIDs, TargetImage: input.TargetImage, Source: input.Source,
		Namespace: input.Namespace, Fleet: input.Fleet, MaxParallel: input.MaxParallel,
		StopOnFailure:  stopOnFailure,
		DrainTimeout:   time.Duration(input.DrainTimeoutSeconds) * time.Second,
		RollbackWindow: time.Duration(input.RollbackWindowSeconds) * time.Second,
	})
	if err != nil {
		writeSetUpgradeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, response{Success: true, Data: batch})
}

func (s *Server) adminNewAPIReleases(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		releases, err := s.svc.ListNewAPIReleases(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: releases})
	case http.MethodPost:
		var input gateway.CreateNewAPIReleaseInput
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		release, err := s.svc.CreateNewAPIRelease(r.Context(), input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, response{Success: true, Data: release})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) adminReleaseRings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rings, err := s.svc.ListReleaseRings(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: rings})
	case http.MethodPost:
		var input struct {
			gateway.UpsertReleaseRingInput
			SoakSeconds int `json:"soak_seconds"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		input.UpsertReleaseRingInput.SoakDuration = time.Duration(input.SoakSeconds) * time.Second
		ring, err := s.svc.UpsertReleaseRing(r.Context(), input.UpsertReleaseRingInput)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: ring})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) adminReleaseRollouts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rollouts, err := s.svc.ListReleaseRollouts(r.Context(), r.URL.Query().Get("ring_id"), queryInt(r, "limit", 50))
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: rollouts})
	case http.MethodPost:
		var input struct {
			RingID                string `json:"ring_id"`
			TargetReleaseID       string `json:"target_release_id"`
			DrainTimeoutSeconds   int    `json:"drain_timeout_seconds"`
			RollbackWindowSeconds int    `json:"rollback_window_seconds"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		rollout, err := s.svc.CreateReleaseRollout(r.Context(), gateway.CreateReleaseRolloutInput{
			RingID: input.RingID, TargetReleaseID: input.TargetReleaseID,
			DrainTimeout:   time.Duration(input.DrainTimeoutSeconds) * time.Second,
			RollbackWindow: time.Duration(input.RollbackWindowSeconds) * time.Second,
		})
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusAccepted, response{Success: true, Data: rollout})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) adminReleaseRolloutAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	id, err := url.PathUnescape(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/release-rollouts/"), "/"))
	if err != nil || id == "" || strings.Contains(id, "/") {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	rollout, ok, err := s.svc.GetReleaseRollout(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "release rollout not found")
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: rollout})
}

func (s *Server) adminSetUpgradeAction(w http.ResponseWriter, r *http.Request) {
	id, err := url.PathUnescape(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/set-upgrades/"), "/"))
	if err != nil || id == "" || strings.Contains(id, "/") {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	batch, ok, err := s.svc.GetSetUpgradeBatch(r.Context(), id)
	if err != nil {
		writeSetUpgradeError(w, err)
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "set upgrade batch not found")
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: batch})
}

func (s *Server) adminSetUpgradeRunAction(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/set-upgrade-runs/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || r.Method != http.MethodPost {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	id, err := url.PathUnescape(parts[0])
	if err != nil || strings.TrimSpace(id) == "" {
		writeError(w, http.StatusBadRequest, "invalid run id")
		return
	}
	var run gateway.SetUpgradeRun
	switch parts[1] {
	case "rollback":
		var input struct {
			Reason string `json:"reason"`
		}
		if r.Body != nil && r.ContentLength != 0 {
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				writeError(w, http.StatusBadRequest, "invalid json")
				return
			}
		}
		run, err = s.svc.RequestSetUpgradeRollback(r.Context(), id, input.Reason)
	case "retry":
		run, err = s.svc.RetrySetUpgradeRun(r.Context(), id)
	default:
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeSetUpgradeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, response{Success: true, Data: run})
}

func (s *Server) adminSetUpgradeRuns(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	runs, err := s.svc.ListSetUpgradeRuns(r.Context(), r.URL.Query().Get("set_id"), queryInt(r, "limit", 50))
	if err != nil {
		writeSetUpgradeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: runs})
}

func writeSetUpgradeError(w http.ResponseWriter, err error) {
	message := err.Error()
	status := http.StatusBadRequest
	if strings.Contains(message, "not found") {
		status = http.StatusNotFound
	} else if errors.Is(err, gateway.ErrSetUpgradeAlreadyActive) || strings.Contains(message, "not rollbackable") ||
		strings.Contains(message, "window expired") || strings.Contains(message, "not retryable") || strings.Contains(message, "inconsistent") {
		status = http.StatusConflict
	} else if strings.Contains(message, "lease is busy") {
		status = http.StatusConflict
	}
	writeError(w, status, message)
}

func queryInt(r *http.Request, key string, fallback int) int {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func writeDeletionError(w http.ResponseWriter, err error) {
	message := err.Error()
	status := http.StatusBadRequest
	if strings.Contains(message, "not found") {
		status = http.StatusNotFound
	} else if strings.Contains(message, "changed") || strings.Contains(message, "not empty") || strings.Contains(message, "already") ||
		strings.Contains(message, "cannot be") || strings.Contains(message, "conflicting operations") ||
		strings.Contains(message, "runtime lease") || strings.Contains(message, "must be disabled") || strings.Contains(message, "requires cascade") {
		status = http.StatusConflict
	}
	writeError(w, status, message)
}

func (s *Server) adminTenantStatistics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	stats, err := s.svc.GetTenantStatisticsSnapshot(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: stats})
}

func (s *Server) adminTenantAction(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/tenants/"), "/")
	if trimmed == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	parts := strings.Split(trimmed, "/")
	userID, err := url.PathUnescape(parts[0])
	if err != nil || strings.TrimSpace(userID) == "" {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		detail, err := s.svc.GetTenantDetail(r.Context(), userID)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: detail})
		return
	}
	if len(parts) != 3 || parts[1] != "actions" || r.Method != http.MethodPost {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	switch parts[2] {
	case "observe":
		observation, err := s.svc.ObserveTenant(r.Context(), userID)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: observation})
	case "disable":
		detail, err := s.svc.DisableTenant(r.Context(), userID)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: detail})
	case "sync-byok", "sync_byok":
		result, err := s.svc.EnqueueUserLLMSettingsSync(r.Context(), userID)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: result})
	case "create-key", "create_key":
		key, err := s.svc.CreateExternalKey(r.Context(), userID)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: key})
	case "migrate", "migrate-dry-run", "migrate_dry_run":
		var req gateway.MigrationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		req.UserID = userID
		if parts[2] == "migrate-dry-run" || parts[2] == "migrate_dry_run" {
			req.DryRun = true
		}
		result, err := s.svc.MigrateUser(r.Context(), req)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: result})
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) adminUserAction(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/api/admin/users/")
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) != 2 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	userID, err := url.PathUnescape(parts[0])
	if err != nil || strings.TrimSpace(userID) == "" {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	switch {
	case parts[1] == "api-keys" && r.Method == http.MethodPost:
		s.adminCreateAPIKey(w, r, userID)
	case parts[1] == "state" && r.Method == http.MethodGet:
		s.adminGetUserState(w, r, userID)
	case parts[1] == "observe" && r.Method == http.MethodPost:
		s.adminObserveTenant(w, r, userID)
	case parts[1] == "usage" && r.Method == http.MethodGet:
		s.adminGetUserUsage(w, r, userID)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) adminCreateAPIKey(w http.ResponseWriter, r *http.Request, userID string) {
	var req struct {
		Name string `json:"name,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "default"
	}
	key, command, err := s.svc.CreateExternalKeyManaged(r.Context(), userID, name)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if command != nil {
		writeJSON(w, http.StatusAccepted, response{Success: true, Data: command})
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: map[string]any{
		"api_key":    key.ExternalKey,
		"key_id":     key.ExternalKeyID,
		"key_prefix": keyPrefix(key.ExternalKey),
		"name":       name,
		"created_at": key.CreatedAt.Format(time.RFC3339Nano),
	}})
}

func (s *Server) adminGetUserState(w http.ResponseWriter, r *http.Request, userID string) {
	state, err := s.svc.GetUserState(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: state})
}

func (s *Server) adminObserveTenant(w http.ResponseWriter, r *http.Request, userID string) {
	observation, err := s.svc.ObserveTenant(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: observation})
}

func (s *Server) adminGetUserUsage(w http.ResponseWriter, r *http.Request, userID string) {
	days := 30
	if raw := strings.TrimSpace(r.URL.Query().Get("days")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			days = parsed
		}
	}
	writeJSON(w, http.StatusOK, struct {
		UserID        string `json:"user_id"`
		Days          int    `json:"days"`
		TotalTokens   int64  `json:"total_tokens"`
		TotalRequests int64  `json:"total_requests"`
	}{
		UserID: userID,
		Days:   days,
	})
}

func (s *Server) adminAPIKeyAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	keyID, err := url.PathUnescape(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/admin/api-keys/"), "/"))
	if err != nil || strings.TrimSpace(keyID) == "" {
		writeError(w, http.StatusBadRequest, "invalid key id")
		return
	}
	if err := s.svc.RevokeExternalKey(r.Context(), keyID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: map[string]string{"status": "ok"}})
}

func (s *Server) plans(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		plans, err := s.svc.ListPlans(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: plans})
	case http.MethodPost:
		req, err := decodePlanRequest(r)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		generatedID := strings.TrimSpace(req.ID) == ""
		plan, err := s.svc.CreatePlan(r.Context(), req)
		if err != nil {
			if errors.Is(err, gateway.ErrPlanImmutableConflict) {
				writeError(w, http.StatusConflict, err.Error())
				return
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		status := http.StatusOK
		if generatedID {
			status = http.StatusCreated
		}
		writeJSON(w, status, response{Success: true, Data: plan})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func decodePlanRequest(r *http.Request) (gateway.Plan, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return gateway.Plan{}, err
	}
	var req gateway.Plan
	if err := json.Unmarshal(raw, &req); err != nil {
		return gateway.Plan{}, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return gateway.Plan{}, err
	}
	if _, ok := fields["is_active"]; !ok {
		req.IsActive = true
	}
	return req, nil
}

func (s *Server) planAction(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/plans/"), "/")
	parts := strings.Split(path, "/")
	planID := strings.TrimSpace(parts[0])
	if planID == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if len(parts) == 2 && parts[1] == "sets" {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		states, err := s.svc.ListPlanSets(r.Context(), planID)
		if err != nil {
			if errors.Is(err, gateway.ErrPlanNotFound) {
				writeError(w, http.StatusNotFound, "plan not found")
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: states})
		return
	}
	if len(parts) == 2 && parts[1] == "periods" {
		switch r.Method {
		case http.MethodGet:
			periods, err := s.svc.ListPlanPeriods(r.Context(), planID)
			if err != nil {
				if errors.Is(err, gateway.ErrPlanNotFound) {
					writeError(w, http.StatusNotFound, "plan not found")
					return
				}
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, response{Success: true, Data: periods})
		case http.MethodPost:
			var req gateway.PlanPeriod
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeError(w, http.StatusBadRequest, "invalid json")
				return
			}
			req.PlanID = planID
			if err := s.svc.RegisterPlanPeriod(r.Context(), req); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, response{Success: true})
		default:
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
		return
	}
	if len(parts) == 3 && parts[1] == "periods" && parts[2] == "sets" {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		states, err := s.svc.ListPlanPeriodSets(r.Context(), planID)
		if err != nil {
			if errors.Is(err, gateway.ErrPlanNotFound) {
				writeError(w, http.StatusNotFound, "plan not found")
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: states})
		return
	}
	if len(parts) == 2 && parts[1] == "sync" {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req struct {
			SetIDs []string `json:"set_ids"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		states, err := s.svc.QueuePlanSync(r.Context(), planID, req.SetIDs)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusAccepted, response{Success: true, Data: states})
		return
	}
	if len(parts) != 1 || r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	plan, err := s.svc.GetPlan(r.Context(), planID)
	if err != nil {
		if errors.Is(err, gateway.ErrPlanNotFound) {
			writeError(w, http.StatusNotFound, "plan not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: plan})
}

func (s *Server) channelBundles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		bundles, err := s.svc.ListChannelBundles(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: bundles})
	case http.MethodPost:
		var req channelBundleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		bundle, err := s.svc.UpsertChannelBundle(r.Context(), req.toGatewayBundle())
		if err != nil {
			writeChannelBundleError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: bundle})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

type channelBundleRequest struct {
	ID          string                   `json:"id"`
	Name        string                   `json:"name"`
	Description string                   `json:"description"`
	SourceSetID string                   `json:"source_set_id"`
	Spec        channelBundleSpecRequest `json:"spec"`
}

type channelBundleSpecRequest struct {
	Version  int                           `json:"version"`
	Kind     string                        `json:"kind"`
	Options  []channelBundleOptionRequest  `json:"options"`
	Channels []channelBundleChannelRequest `json:"channels"`
}

type channelBundleOptionRequest struct {
	Key   string `json:"key"`
	Value any    `json:"value"`
}

type channelBundleChannelRequest struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Type           int    `json:"type"`
	Key            string `json:"key"`
	BaseURL        string `json:"base_url"`
	Models         string `json:"models"`
	Group          string `json:"group"`
	ModelMapping   string `json:"model_mapping"`
	Priority       int64  `json:"priority"`
	Weight         uint   `json:"weight"`
	Status         string `json:"status"`
	Setting        string `json:"setting"`
	ParamOverride  string `json:"param_override"`
	HeaderOverride string `json:"header_override"`
	Remark         string `json:"remark"`
}

func (r channelBundleRequest) toGatewayBundle() gateway.ChannelBundle {
	options := make([]gateway.ChannelBundleOption, 0, len(r.Spec.Options))
	for _, option := range r.Spec.Options {
		options = append(options, gateway.ChannelBundleOption{
			Key:   option.Key,
			Value: option.Value,
		})
	}
	channels := make([]gateway.ChannelBundleChannel, 0, len(r.Spec.Channels))
	for _, channel := range r.Spec.Channels {
		channels = append(channels, gateway.ChannelBundleChannel{
			ID:             channel.ID,
			Name:           channel.Name,
			Type:           channel.Type,
			Key:            channel.Key,
			BaseURL:        channel.BaseURL,
			Models:         channel.Models,
			Group:          channel.Group,
			ModelMapping:   channel.ModelMapping,
			Priority:       channel.Priority,
			Weight:         channel.Weight,
			Status:         channel.Status,
			Setting:        channel.Setting,
			ParamOverride:  channel.ParamOverride,
			HeaderOverride: channel.HeaderOverride,
			Remark:         channel.Remark,
		})
	}
	return gateway.ChannelBundle{
		ID:          r.ID,
		Name:        r.Name,
		Description: r.Description,
		SourceSetID: r.SourceSetID,
		Spec: gateway.ChannelBundleSpec{
			Version:  r.Spec.Version,
			Kind:     r.Spec.Kind,
			Options:  options,
			Channels: channels,
		},
	}
}

func (s *Server) channelBundleAction(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/channel-bundles/"), "/")
	if trimmed == "import" {
		s.channelBundleImport(w, r)
		return
	}
	parts := strings.Split(trimmed, "/")
	if len(parts) != 2 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	bundleID, err := url.PathUnescape(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid bundle id")
		return
	}
	switch parts[1] {
	case "plan":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		req, ok := s.decodeChannelBundleSetRequest(w, r)
		if !ok {
			return
		}
		plan, err := s.svc.PlanChannelBundleForSet(r.Context(), bundleID, req.SetID, gateway.ChannelBundlePlanOptions{ForceDrift: req.ForceDrift})
		if err != nil {
			writeChannelBundleError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: plan})
	case "apply":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		req, ok := s.decodeChannelBundleSetRequest(w, r)
		if !ok {
			return
		}
		state, err := s.svc.ApplyChannelBundleToSet(r.Context(), bundleID, req.SetID, gateway.ChannelBundleApplyOptions{ForceDrift: req.ForceDrift})
		if err != nil {
			writeChannelBundleError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: state})
	case "revisions":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		revisions, err := s.svc.ListChannelBundleRevisions(r.Context(), bundleID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: revisions})
	case "delivery-status":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		status, err := s.svc.GetChannelBundleDeliveryStatus(r.Context(), bundleID)
		if err != nil {
			writeChannelBundleError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: status})
	case "releases":
		switch r.Method {
		case http.MethodGet:
			runs, err := s.svc.ListChannelBundleReleases(r.Context(), bundleID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, response{Success: true, Data: runs})
		case http.MethodPost:
			input, ok := s.decodeChannelBundleReleaseRequest(w, r)
			if !ok {
				return
			}
			input.BundleID = bundleID
			run, err := s.svc.CreateChannelBundleRelease(r.Context(), input)
			if err != nil {
				writeChannelBundleError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, response{Success: true, Data: run})
		default:
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case "rollback":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req struct {
			RevisionID string `json:"revision_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		bundle, err := s.svc.RollbackChannelBundleToRevision(r.Context(), bundleID, req.RevisionID)
		if err != nil {
			writeChannelBundleError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: bundle})
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

type channelBundleSetRequest struct {
	SetID      string `json:"set_id"`
	ForceDrift bool   `json:"force_drift"`
}

func (s *Server) decodeChannelBundleSetRequest(w http.ResponseWriter, r *http.Request) (channelBundleSetRequest, bool) {
	var req channelBundleSetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid json")
		return req, false
	}
	if strings.TrimSpace(req.SetID) == "" {
		writeError(w, http.StatusBadRequest, "set_id is required")
		return req, false
	}
	return req, true
}

func (s *Server) decodeChannelBundleReleaseRequest(w http.ResponseWriter, r *http.Request) (gateway.ChannelBundleReleaseInput, bool) {
	var req struct {
		RevisionID    string   `json:"revision_id"`
		SetIDs        []string `json:"set_ids"`
		ForceDrift    bool     `json:"force_drift"`
		StopOnFailure *bool    `json:"stop_on_failure"`
		TriggeredBy   string   `json:"triggered_by"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid json")
		return gateway.ChannelBundleReleaseInput{}, false
	}
	stopOnFailure := true
	if req.StopOnFailure != nil {
		stopOnFailure = *req.StopOnFailure
	}
	return gateway.ChannelBundleReleaseInput{
		RevisionID:    req.RevisionID,
		SetIDs:        req.SetIDs,
		ForceDrift:    req.ForceDrift,
		StopOnFailure: stopOnFailure,
		TriggeredBy:   req.TriggeredBy,
	}, true
}

func (s *Server) channelBundleReleaseAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	runID, err := url.PathUnescape(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/channel-bundle-releases/"), "/"))
	if err != nil || strings.TrimSpace(runID) == "" {
		writeError(w, http.StatusBadRequest, "invalid release id")
		return
	}
	run, err := s.svc.GetChannelBundleRelease(r.Context(), runID)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: run})
}

func (s *Server) channelBundleImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req gateway.ImportChannelBundleInput
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	bundle, err := s.svc.ImportChannelBundleFromSet(r.Context(), req)
	if err != nil {
		writeChannelBundleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: bundle})
}

func (s *Server) desiredConfigExport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var req gateway.ImportChannelBundleInput
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	config, err := s.svc.ExportDesiredConfigFromSet(r.Context(), req)
	if err != nil {
		writeChannelBundleError(w, err)
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="llmgateway-desired-config-%s.json"`, safeDownloadName(req.ID)))
	writeJSON(w, http.StatusOK, config)
}

func (s *Server) desiredConfigImport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var config gateway.DesiredConfig
	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
	if err := json.NewDecoder(r.Body).Decode(&config); err != nil {
		writeError(w, http.StatusBadRequest, "invalid desired config json")
		return
	}
	imported, err := s.svc.ImportDesiredConfig(r.Context(), config)
	if err != nil {
		writeChannelBundleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: imported})
}

func safeDownloadName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "backup"
	}
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	value = strings.Trim(b.String(), "-")
	if value == "" {
		return "backup"
	}
	return value
}

func (s *Server) internalAction(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/internal/"), "/")
	switch {
	case strings.HasPrefix(path, "set-manager/set-decommissions"):
		s.internalSetDecommissions(w, r, strings.TrimPrefix(path, "set-manager/set-decommissions"))
	case strings.HasPrefix(path, "set-manager/set-upgrade-runs"):
		s.internalSetUpgradeRuns(w, r, strings.TrimPrefix(path, "set-manager/set-upgrade-runs"))
	case path == "set-manager/shards":
		s.internalSetManagerShard(w, r)
	case path == "set-manager/set-provision-requests":
		s.adminSetProvisionRequests(w, r)
	case strings.HasPrefix(path, "set-manager/set-provision-requests/"):
		s.setProvisionRequestAction(w, r, "/api/internal/set-manager/set-provision-requests/")
	case path == "set-manager/set-reconcile-facts":
		s.adminSetReconcileFacts(w, r)
	case path == "set-manager/set-reconcile-facts/reconcile":
		s.adminSetReconcileFactsReconcile(w, r)
	case r.Method == http.MethodPost && path == "runtime-cleanups/authorize":
		s.internalAuthorizeRuntimeCleanup(w, r)
	case r.Method == http.MethodPost && path == "users/ensure":
		s.internalEnsureUser(w, r)
	case r.Method == http.MethodPost && strings.HasPrefix(path, "migrations/users/"):
		s.internalMigrateUser(w, r, strings.TrimPrefix(path, "migrations/users/"))
	case (r.Method == http.MethodGet || r.Method == http.MethodPost) && strings.HasPrefix(path, "users/") && strings.HasSuffix(path, "/assignment"):
		userID := strings.TrimSuffix(strings.TrimPrefix(path, "users/"), "/assignment")
		s.internalUserAssignment(w, r, userID)
	case (r.Method == http.MethodGet || r.Method == http.MethodPut || r.Method == http.MethodPost) && strings.HasPrefix(path, "users/") && strings.Contains(path, "/llm-settings"):
		s.internalUserLLMSettings(w, r, strings.TrimPrefix(path, "users/"))
	case r.Method == http.MethodGet && strings.HasPrefix(path, "users/") && strings.HasSuffix(path, "/credit"):
		userID := strings.TrimSuffix(strings.TrimPrefix(path, "users/"), "/credit")
		s.internalGetUserCredit(w, r, userID)
	case r.Method == http.MethodGet && strings.HasPrefix(path, "plans/"):
		planID := strings.Trim(strings.TrimPrefix(path, "plans/"), "/")
		s.internalGetPlan(w, r, planID)
	case r.Method == http.MethodPost && path == "subscriptions/apply":
		s.internalApplySubscription(w, r)
	case r.Method == http.MethodPost && path == "subscriptions/cancel":
		s.internalCancelSubscription(w, r)
	case r.Method == http.MethodPost && path == "subscriptions/extend":
		s.internalExtendSubscription(w, r)
	case r.Method == http.MethodGet && strings.HasPrefix(path, "admin-commands/"):
		s.internalGetAdminCommand(w, r, strings.TrimPrefix(path, "admin-commands/"))
	case r.Method == http.MethodGet && strings.HasPrefix(path, "users/") && strings.HasSuffix(path, "/subscriptions"):
		userID := strings.TrimSuffix(strings.TrimPrefix(path, "users/"), "/subscriptions")
		s.internalGetActiveSubscription(w, r, userID)
	default:
		writeOpenAIError(w, http.StatusNotFound, "not_found_error", "not_found", "not found")
	}
}

func (s *Server) internalSetManagerShard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input gateway.UpsertShardInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if err := s.svc.UpsertShard(r.Context(), input); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true})
}

func (s *Server) internalSetUpgradeRuns(w http.ResponseWriter, r *http.Request, suffix string) {
	suffix = strings.Trim(suffix, "/")
	if suffix == "" {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		runs, err := s.svc.ListActiveSetUpgradeRuns(r.Context(), queryInt(r, "limit", 20))
		if err != nil {
			writeSetUpgradeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: runs})
		return
	}
	parts := strings.Split(suffix, "/")
	if len(parts) != 2 || r.Method != http.MethodPost {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	id, err := url.PathUnescape(parts[0])
	if err != nil || strings.TrimSpace(id) == "" {
		writeError(w, http.StatusBadRequest, "invalid run id")
		return
	}
	var input struct {
		Owner          string `json:"owner"`
		LeaseSeconds   int    `json:"lease_seconds"`
		TrafficBaseURL string `json:"traffic_base_url"`
		Success        bool   `json:"success"`
		LastError      string `json:"last_error"`
		Reason         string `json:"reason"`
	}
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
	}
	var run gateway.SetUpgradeRun
	switch parts[1] {
	case "claim":
		if input.LeaseSeconds <= 0 || input.LeaseSeconds > 1800 {
			input.LeaseSeconds = 900
		}
		var claimed bool
		run, claimed, err = s.svc.ClaimSetUpgradeRun(r.Context(), id, input.Owner, time.Duration(input.LeaseSeconds)*time.Second)
		if err == nil && !claimed {
			err = fmt.Errorf("set upgrade run lease is busy")
		}
	case "candidate":
		run, err = s.svc.PrepareSetUpgradeCandidate(r.Context(), id, input.Owner, input.TrafficBaseURL)
	case "compatibility-complete":
		run, err = s.svc.CompleteSetUpgradeCompatibility(r.Context(), id, input.Owner, input.Success, input.LastError)
	case "probe":
		run, err = s.svc.RecordSetUpgradeProbe(r.Context(), id, input.Owner, input.Success, input.LastError)
	case "probe-credential":
		var credential gateway.SetUpgradeProbeCredential
		credential, err = s.svc.GetOrCreateSetUpgradeProbeCredential(r.Context(), id, input.Owner)
		if err == nil {
			writeJSON(w, http.StatusOK, response{Success: true, Data: credential})
			return
		}
	case "switch":
		run, err = s.svc.SwitchSetUpgradeRun(r.Context(), id, input.Owner)
	case "rollback":
		run, err = s.svc.RollbackSetUpgradeRun(r.Context(), id, input.Owner, input.Reason)
	case "drain-complete":
		run, err = s.svc.AdvanceSetUpgradeAfterDrain(r.Context(), id, input.Owner)
	case "master-complete":
		run, err = s.svc.CompleteSetUpgradeMaster(r.Context(), id, input.Owner, input.Success, input.LastError)
	default:
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeSetUpgradeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: run})
}

func (s *Server) internalSetDecommissions(w http.ResponseWriter, r *http.Request, suffix string) {
	suffix = strings.Trim(suffix, "/")
	if suffix == "" {
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		jobs, err := s.svc.ListSetDecommissions(r.Context(), gateway.SetDecommissionJobListOptions{RuntimeOnly: true, Limit: queryInt(r, "limit", 1)})
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: jobs})
		return
	}
	parts := strings.Split(suffix, "/")
	if len(parts) != 2 || r.Method != http.MethodPost {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	jobID, err := url.PathUnescape(parts[0])
	if err != nil || strings.TrimSpace(jobID) == "" {
		writeError(w, http.StatusBadRequest, "invalid job id")
		return
	}
	switch parts[1] {
	case "claim":
		var input struct {
			Owner        string `json:"owner"`
			LeaseSeconds int    `json:"lease_seconds"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if input.LeaseSeconds <= 0 || input.LeaseSeconds > 1800 {
			input.LeaseSeconds = 900
		}
		job, cleanup, err := s.svc.ClaimSetDecommission(r.Context(), jobID, input.Owner, time.Duration(input.LeaseSeconds)*time.Second)
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: map[string]any{"job": job, "cleanup": cleanup}})
	case "finalize":
		var input gateway.SetDecommissionFinalizeInput
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		input.JobID = jobID
		job, err := s.svc.FinalizeSetDecommission(r.Context(), input)
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: job})
	case "fail":
		var input gateway.SetDecommissionFailInput
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		input.JobID = jobID
		job, err := s.svc.FailSetDecommission(r.Context(), input)
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: job})
	case "ack":
		var input struct {
			Attempt int `json:"attempt"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		job, err := s.svc.AcknowledgeSetDecommission(r.Context(), jobID, input.Attempt)
		if err != nil {
			writeDeletionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: job})
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) internalAuthorizeRuntimeCleanup(w http.ResponseWriter, r *http.Request) {
	var input gateway.RuntimeCleanupAuthorizationInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	authorization, err := s.svc.AuthorizeRuntimeCleanup(r.Context(), input)
	if err != nil {
		writeDeletionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: authorization})
}

func (s *Server) internalEnsureUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UserID   string `json:"user_id"`
		Nickname string `json:"nickname,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.UserID) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "Missing required field: user_id")
		return
	}
	existed, err := s.svc.HasUserBinding(r.Context(), req.UserID)
	if err != nil {
		writeInternalServiceError(w, err)
		return
	}
	binding, err := s.svc.EnsureUserBinding(r.Context(), req.UserID)
	if err != nil {
		writeInternalServiceError(w, err)
		return
	}
	result := "created"
	if existed {
		result = "existing"
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: map[string]string{"result": result, "user_id": binding.ExternalUserID}})
}

func (s *Server) internalUserAssignment(w http.ResponseWriter, r *http.Request, userID string) {
	userID, err := url.PathUnescape(strings.TrimSpace(userID))
	if err != nil || userID == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "Missing required field: user_id")
		return
	}
	switch r.Method {
	case http.MethodGet:
		assignment, err := s.svc.GetUserAssignment(r.Context(), userID)
		if err != nil {
			writeInternalServiceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: assignment})
	case http.MethodPost:
		var req struct {
			Backend string `json:"backend"`
			SetID   string `json:"set_id,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "Missing required field: backend")
			return
		}
		assignment, err := s.svc.SetUserAssignment(r.Context(), gateway.UserAssignment{
			ExternalUserID: userID,
			Backend:        req.Backend,
			SetID:          req.SetID,
		})
		if err != nil {
			writeInternalServiceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: assignment})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "invalid_request_error", "method_not_allowed", "method not allowed")
	}
}

func (s *Server) internalUserLLMSettings(w http.ResponseWriter, r *http.Request, suffix string) {
	suffix = strings.Trim(suffix, "/")
	sync := false
	if strings.HasSuffix(suffix, "/llm-settings/sync") {
		sync = true
		suffix = strings.TrimSuffix(suffix, "/llm-settings/sync")
	} else {
		suffix = strings.TrimSuffix(suffix, "/llm-settings")
	}
	userID, err := url.PathUnescape(strings.Trim(suffix, "/"))
	if err != nil || strings.TrimSpace(userID) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "Missing required field: user_id")
		return
	}
	if sync {
		if r.Method != http.MethodPost {
			writeOpenAIError(w, http.StatusMethodNotAllowed, "invalid_request_error", "method_not_allowed", "method not allowed")
			return
		}
		result, err := s.svc.EnqueueUserLLMSettingsSync(r.Context(), userID)
		if err != nil {
			writeInternalServiceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: result})
		return
	}
	switch r.Method {
	case http.MethodGet:
		settings, err := s.svc.GetUserLLMSettings(r.Context(), userID)
		if err != nil {
			writeInternalServiceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: settings})
	case http.MethodPut:
		var req gateway.UserLLMSettings
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "invalid json")
			return
		}
		settings, err := s.svc.SaveUserLLMSettings(r.Context(), userID, req)
		if err != nil {
			writeInternalServiceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, response{Success: true, Data: settings})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "invalid_request_error", "method_not_allowed", "method not allowed")
	}
}

func (s *Server) internalMigrateUser(w http.ResponseWriter, r *http.Request, suffix string) {
	suffix = strings.Trim(suffix, "/")
	dryRun := false
	if strings.HasSuffix(suffix, "/dry-run") {
		dryRun = true
		suffix = strings.TrimSuffix(suffix, "/dry-run")
	}
	userID, err := url.PathUnescape(strings.Trim(suffix, "/"))
	if err != nil || strings.TrimSpace(userID) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "Missing required field: user_id")
		return
	}
	var req struct {
		SetID    string `json:"set_id"`
		PlanID   string `json:"plan_id"`
		IssueKey bool   `json:"issue_key,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "Missing required fields: set_id, plan_id")
		return
	}
	result, err := s.svc.MigrateUser(r.Context(), gateway.MigrationRequest{
		UserID:   userID,
		SetID:    req.SetID,
		PlanID:   req.PlanID,
		IssueKey: req.IssueKey,
		DryRun:   dryRun,
	})
	if err != nil {
		writeInternalServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: result})
}

func (s *Server) internalGetPlan(w http.ResponseWriter, r *http.Request, planID string) {
	plan, err := s.svc.GetPlan(r.Context(), planID)
	if err != nil {
		if errors.Is(err, gateway.ErrPlanNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "not_found_error", "not_found", "Plan not found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, "server_error", "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: plan})
}

func (s *Server) internalApplySubscription(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "invalid request body")
		return
	}
	var req gateway.ApplySubscriptionRequest
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "Missing required fields: user_id, plan_id")
		return
	}
	sub, command, err := s.svc.ApplySubscriptionManaged(r.Context(), req)
	if err != nil {
		writeInternalServiceError(w, err)
		return
	}
	if command != nil {
		w.Header().Set("Location", "/api/internal/admin-commands/"+url.PathEscape(command.ID))
		writeJSON(w, http.StatusAccepted, response{Success: true, Data: command})
		return
	}
	if s.shouldReturnLegacyNakedSubscription(r) {
		writeJSON(w, http.StatusOK, sub)
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: sub})
}

func (s *Server) internalGetAdminCommand(w http.ResponseWriter, r *http.Request, id string) {
	id, err := url.PathUnescape(strings.Trim(id, "/"))
	if err != nil || strings.TrimSpace(id) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "invalid command id")
		return
	}
	command, err := s.svc.GetAdminCommand(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusNotFound, "not_found_error", "not_found", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: command})
}

func (s *Server) internalCancelSubscription(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "invalid request body")
		return
	}
	var req gateway.CancelSubscriptionRequest
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&req); err != nil || strings.TrimSpace(req.UserID) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "Missing required field: user_id")
		return
	}
	command, err := s.svc.CancelSubscriptionManaged(r.Context(), req.UserID)
	if err != nil {
		writeInternalServiceError(w, err)
		return
	}
	if command != nil {
		w.Header().Set("Location", "/api/internal/admin-commands/"+url.PathEscape(command.ID))
		writeJSON(w, http.StatusAccepted, response{Success: true, Data: command})
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: map[string]string{"status": "ok"}})
}

func (s *Server) internalExtendSubscription(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "invalid request body")
		return
	}
	var req gateway.ExtendSubscriptionRequest
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "Missing required fields: user_id, new_period_end")
		return
	}
	result, command, err := s.svc.ExtendSubscriptionManaged(r.Context(), req)
	if err != nil {
		writeInternalServiceError(w, err)
		return
	}
	if command != nil {
		w.Header().Set("Location", "/api/internal/admin-commands/"+url.PathEscape(command.ID))
		writeJSON(w, http.StatusAccepted, response{Success: true, Data: command})
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: result})
}

func (s *Server) internalGetActiveSubscription(w http.ResponseWriter, r *http.Request, userID string) {
	sub, err := s.svc.GetActiveSubscription(r.Context(), userID)
	if err != nil {
		writeInternalServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: sub})
}

func (s *Server) internalGetUserCredit(w http.ResponseWriter, r *http.Request, userID string) {
	userID, err := url.PathUnescape(strings.TrimSpace(userID))
	if err != nil || userID == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", "Missing required field: user_id")
		return
	}
	credit, err := s.svc.GetUserCredit(r.Context(), userID)
	if err != nil {
		writeInternalServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response{Success: true, Data: credit})
}

func (s *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.isAdminAuthenticated(r) {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func (s *Server) requireAdminPage(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.isAdminAuthenticated(r) {
			next(w, r)
			return
		}
		nextPath := r.URL.RequestURI()
		if nextPath == "" {
			nextPath = "/admin"
		}
		http.Redirect(w, r, "/admin/login?next="+url.QueryEscape(nextPath), http.StatusFound)
	}
}

func (s *Server) isAdminAuthenticated(r *http.Request) bool {
	adminToken := strings.TrimSpace(s.config.AdminToken)
	if adminToken == "" {
		return true
	}
	if bearer(r.Header.Get("Authorization")) == adminToken {
		return true
	}
	cookie, err := r.Cookie(adminSessionCookieName)
	if err != nil {
		return false
	}
	return cookie.Value == adminToken
}

func (s *Server) setAdminSessionCookie(w http.ResponseWriter, r *http.Request) {
	adminToken := strings.TrimSpace(s.config.AdminToken)
	if adminToken == "" {
		return
	}
	cookie := &http.Cookie{
		Name:     adminSessionCookieName,
		Value:    adminToken,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int((12 * time.Hour).Seconds()),
	}
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		cookie.Secure = true
	}
	http.SetCookie(w, cookie)
}

func (s *Server) clearAdminSessionCookie(w http.ResponseWriter, r *http.Request) {
	cookie := &http.Cookie{
		Name:     adminSessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
		Expires:  time.Unix(1, 0),
	}
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		cookie.Secure = true
	}
	http.SetCookie(w, cookie)
}

func (s *Server) requireInternal(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authToken := bearer(r.Header.Get("Authorization"))
		if s.allowLegacySubscriptionClient(r, authToken) {
			next(w, r)
			return
		}
		internalToken := strings.TrimSpace(s.config.InternalToken)
		if internalToken == "" {
			internalToken = strings.TrimSpace(s.config.AdminToken)
		}
		if internalToken == "" {
			next(w, r)
			return
		}
		if authToken != internalToken {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func (s *Server) allowLegacySubscriptionClient(r *http.Request, authToken string) bool {
	if !s.config.LegacySubscriptionClientCompat || strings.TrimSpace(authToken) != "" {
		return false
	}
	if r.Method != http.MethodPost {
		return false
	}
	switch r.URL.Path {
	case "/api/internal/subscriptions/apply", "/api/internal/subscriptions/cancel":
		return true
	default:
		return false
	}
}

func (s *Server) shouldReturnLegacyNakedSubscription(r *http.Request) bool {
	return s.config.LegacySubscriptionClientCompat &&
		bearer(r.Header.Get("Authorization")) == "" &&
		strings.TrimSpace(r.Header.Get("Accept")) == ""
}

func bearer(header string) string {
	header = strings.TrimSpace(header)
	if strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return strings.TrimSpace(header[7:])
	}
	return header
}

func consoleSetIDFromRequestWithSource(r *http.Request) (string, string, bool) {
	refererSetID, refererConflict := consoleSetIDFromURL(r.Header.Get("Referer"))
	if refererConflict {
		return "", "", true
	}
	candidates := []struct {
		setID  string
		source string
	}{
		{setID: strings.TrimSpace(r.Header.Get("X-LLMGateway-Set")), source: "header"},
		{setID: strings.TrimSpace(r.URL.Query().Get("llmgateway_console_set")), source: "query"},
		{setID: refererSetID, source: "referer"},
	}
	setID := ""
	source := ""
	for _, candidate := range candidates {
		if candidate.setID == "" {
			continue
		}
		if setID == "" {
			setID = candidate.setID
			source = candidate.source
			continue
		}
		if candidate.setID != setID {
			return "", "", true
		}
	}
	return setID, source, false
}

func consoleSetIDFromURL(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", false
	}
	querySetID := strings.TrimSpace(parsed.Query().Get("llmgateway_console_set"))
	path := parsed.Path
	if path == "" && strings.HasPrefix(value, "/") {
		path = value
	}
	if !strings.HasPrefix(path, consoleProxyPrefix) {
		return querySetID, false
	}
	trimmed := strings.TrimPrefix(path, consoleProxyPrefix)
	parts := strings.SplitN(trimmed, "/", 2)
	if len(parts) == 0 {
		return querySetID, false
	}
	pathSetID, err := url.PathUnescape(parts[0])
	if err != nil {
		return querySetID, false
	}
	pathSetID = strings.TrimSpace(pathSetID)
	if querySetID != "" && pathSetID != "" && querySetID != pathSetID {
		return "", true
	}
	if pathSetID != "" {
		return pathSetID, false
	}
	return querySetID, false
}

func logConsoleRoute(source string, r *http.Request, setID string, upstreamPath string) {
	if !shouldLogConsoleRoute(r.Method) {
		return
	}
	log.Printf("[llmgateway] console route: method=%s path=%s set=%s source=%s upstream=%s referer=%q",
		r.Method,
		r.URL.RequestURI(),
		setID,
		source,
		upstreamPath,
		r.Header.Get("Referer"),
	)
}

func shouldLogConsoleRoute(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func keyPrefix(key string) string {
	if len(key) <= 12 {
		return key
	}
	return key[:12]
}

type response struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
	Data    any    `json:"data,omitempty"`
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, response{Success: false, Message: message})
}

func writeInternalServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, gateway.ErrPlanNotFound):
		writeOpenAIError(w, http.StatusNotFound, "not_found_error", "not_found", "Plan not found")
	case errors.Is(err, gateway.ErrSubscriptionNotFound):
		writeOpenAIError(w, http.StatusNotFound, "not_found_error", "not_found", "no active subscription")
	case errors.Is(err, gateway.ErrTenantPending):
		writeOpenAIError(w, http.StatusConflict, "invalid_request_error", "tenant_pending", err.Error())
	case errors.Is(err, gateway.ErrTenantInactive):
		writeOpenAIError(w, http.StatusForbidden, "invalid_request_error", "tenant_inactive", err.Error())
	case errors.Is(err, gateway.ErrSubscriptionIdempotencyConflict):
		writeOpenAIError(w, http.StatusConflict, "invalid_request_error", "idempotency_conflict", err.Error())
	case errors.Is(err, gateway.ErrSubscriptionIdempotencyPending):
		writeOpenAIError(w, http.StatusConflict, "invalid_request_error", "idempotency_in_progress", err.Error())
	case errors.Is(err, gateway.ErrSubscriptionOutcomeUnknown):
		writeOpenAIError(w, http.StatusServiceUnavailable, "server_error", "delivery_outcome_unknown", err.Error())
	case errors.Is(err, gateway.ErrAdminCommandConflict):
		writeOpenAIError(w, http.StatusConflict, "invalid_request_error", "idempotency_conflict", err.Error())
	default:
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "bad_request", err.Error())
	}
}

func writeResourceAdminError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, gateway.ErrResourceNotFound), errors.Is(err, gateway.ErrResourceRowNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, gateway.ErrResourceActionNotFound), errors.Is(err, gateway.ErrResourceFieldReadonly):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusBadRequest, err.Error())
	}
}

func writeChannelBundleError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, gateway.ErrChannelBundleLocked):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, gateway.ErrChannelBundleNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	default:
		writeError(w, http.StatusBadRequest, err.Error())
	}
}

func writeOpenAIError(w http.ResponseWriter, status int, errType string, code string, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{
			"message": message,
			"type":    errType,
			"code":    code,
		},
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
