package gateway

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/service-gateway/internal/accesslog"
)

const sessionCookieName = "lc_session"
const defaultAdminBridgeCookieName = "lc_admin_basic_bridge"

const (
	upstreamDialTimeout           = 10 * time.Second
	upstreamTLSHandshakeTimeout   = 10 * time.Second
	defaultResponseHeaderTimeout  = 10 * time.Second
	upstreamExpectContinueTimeout = 1 * time.Second
	upstreamIdleConnTimeout       = 90 * time.Second
	defaultAdminBridgeCookieTTL   = 24 * time.Hour
)

type AdminBridgeCookieConfig struct {
	Name   string
	Secret string
	TTL    time.Duration
	Hosts  []string
	Secure bool
}

type adminBridgeClaims struct {
	Version             int    `json:"v"`
	Username            string `json:"u"`
	PasswordFingerprint string `json:"pf"`
	IssuedAt            int64  `json:"iat"`
	ExpiresAt           int64  `json:"exp"`
}

type adminBridgeState int

const (
	adminBridgeMissing adminBridgeState = iota
	adminBridgeAuthorized
	adminBridgeInvalid
)

type Handler struct {
	authServiceURL         string
	subscriptionServiceURL string
	allowedOrigins         originAllowlist
	client                 *http.Client
	routes                 []compiledRoute
	accessLogger           accessLogSink
	metrics                requestMetricsSink
	adminUsername          string
	adminPassword          string
	adminRealm             string
	adminBridgeCookieName  string
	adminBridgeCookieTTL   time.Duration
	adminBridgeSigningKey  []byte
	adminBridgeHosts       map[string]struct{}
	adminBridgeSecure      bool
	adminBridgeConfigured  bool
	realnameWallEnabled    bool
}

type accessLogSink interface {
	Log(entry accesslog.Entry)
}

type requestMetricsSink interface {
	ObserveRequest(method, route, endpoint string, status int, duration time.Duration)
}

type Option func(*Handler)

func WithAccessLogger(logger accessLogSink) Option {
	return func(h *Handler) {
		h.accessLogger = logger
	}
}

func WithMetrics(metrics requestMetricsSink) Option {
	return func(h *Handler) {
		h.metrics = metrics
	}
}

func WithAdminBasicAuth(username, password string) Option {
	return func(h *Handler) {
		h.adminUsername = strings.TrimSpace(username)
		h.adminPassword = strings.TrimSpace(password)
	}
}

func WithAdminBasicAuthRealm(realm string) Option {
	return func(h *Handler) {
		h.adminRealm = strings.TrimSpace(realm)
	}
}

func WithRealnameWallEnabled(enabled bool) Option {
	return func(h *Handler) {
		h.realnameWallEnabled = enabled
	}
}

func WithAdminBridgeCookie(cfg AdminBridgeCookieConfig) Option {
	return func(h *Handler) {
		h.adminBridgeConfigured = true
		if name := strings.TrimSpace(cfg.Name); name != "" {
			h.adminBridgeCookieName = name
		}
		if cfg.TTL > 0 {
			h.adminBridgeCookieTTL = cfg.TTL
		}
		h.adminBridgeSigningKey = []byte(strings.TrimSpace(cfg.Secret))
		if len(cfg.Hosts) > 0 {
			h.adminBridgeHosts = normalizeHosts(cfg.Hosts)
		}
		if cfg.Secure {
			h.adminBridgeSecure = true
		}
	}
}

type compiledRoute struct {
	route Route
	proxy *httputil.ReverseProxy
}

type sessionEnvelope struct {
	Session struct {
		User struct {
			ID               string `json:"id"`
			Email            string `json:"email"`
			InviteRequired   bool   `json:"inviteRequired"`
			RealnameVerified bool   `json:"realnameVerified"`
		} `json:"user"`
	} `json:"session"`
}

type currentSubscriptionEnvelope struct {
	HasSubscription bool `json:"hasSubscription"`
	Subscription    *struct {
		Code   string `json:"code"`
		Status string `json:"status"`
	} `json:"subscription"`
}

func NewHandler(cfg Config, opts ...Option) (http.Handler, error) {
	if strings.TrimSpace(cfg.AuthServiceURL) == "" {
		return nil, errors.New("auth service url is required")
	}

	authTransport := newUpstreamTransport(defaultResponseHeaderTimeout)

	routes := make([]compiledRoute, 0, len(cfg.Routes))
	subscriptionServiceURL := ""
	for _, route := range cfg.Routes {
		if err := validateRoute(route); err != nil {
			return nil, err
		}

		target, err := url.Parse(route.Upstream)
		if err != nil {
			return nil, fmt.Errorf("parse upstream for route %s: %w", route.Name, err)
		}

		responseHeaderTimeout, err := parseResponseHeaderTimeout(route.ResponseHeaderTimeout)
		if err != nil {
			return nil, fmt.Errorf("route %s response_header_timeout: %w", route.Name, err)
		}

		routes = append(routes, compiledRoute{
			route: route,
			proxy: newSingleHostReverseProxy(target, newUpstreamTransport(responseHeaderTimeout), route.Prefix, route.RewritePrefix, route.UpstreamBearerTokenEnv),
		})
		if subscriptionServiceURL == "" && hasRoutePrefix("/subscriptions/current", route.Prefix) {
			subscriptionServiceURL = strings.TrimRight(target.String(), "/")
		}
	}

	sort.SliceStable(routes, func(i, j int) bool {
		return len(routes[i].route.Prefix) > len(routes[j].route.Prefix)
	})

	handler := &Handler{
		authServiceURL:         strings.TrimRight(cfg.AuthServiceURL, "/"),
		subscriptionServiceURL: subscriptionServiceURL,
		allowedOrigins:         normalizeAllowedOrigins(cfg.AllowedOrigins),
		client: &http.Client{
			Timeout:   10 * time.Second,
			Transport: authTransport,
		},
		routes:                routes,
		adminRealm:            "Lightclaw Admin",
		adminBridgeCookieName: defaultAdminBridgeCookieName,
		adminBridgeCookieTTL:  defaultAdminBridgeCookieTTL,
		adminBridgeSecure:     true,
		realnameWallEnabled:   true,
	}
	for _, opt := range opts {
		opt(handler)
	}
	if requiresAdminAccess(routes) {
		if handler.adminUsername == "" || handler.adminPassword == "" {
			return nil, errors.New("admin basic auth credentials are required when admin routes are configured")
		}
	}
	if handler.adminBridgeConfigured {
		if len(handler.adminBridgeSigningKey) == 0 {
			return nil, errors.New("admin bridge cookie secret is required when admin bridge is configured")
		}
		if handler.adminBridgeCookieName == "" {
			return nil, errors.New("admin bridge cookie name is required when admin bridge is configured")
		}
		if handler.adminBridgeCookieTTL <= 0 {
			return nil, errors.New("admin bridge cookie ttl must be positive when admin bridge is configured")
		}
	}

	return handler, nil
}

func newUpstreamTransport(responseHeaderTimeout time.Duration) *http.Transport {
	return &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   upstreamDialTimeout,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       upstreamIdleConnTimeout,
		TLSHandshakeTimeout:   upstreamTLSHandshakeTimeout,
		ExpectContinueTimeout: upstreamExpectContinueTimeout,
		ResponseHeaderTimeout: responseHeaderTimeout,
	}
}

func parseResponseHeaderTimeout(raw string) (time.Duration, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return defaultResponseHeaderTimeout, nil
	}

	timeout, err := time.ParseDuration(trimmed)
	if err != nil {
		return 0, err
	}
	if timeout <= 0 {
		return 0, fmt.Errorf("must be positive")
	}
	return timeout, nil
}

func requiresAdminAccess(routes []compiledRoute) bool {
	for _, route := range routes {
		if route.route.Access == AccessAdmin {
			return true
		}
	}
	return false
}

func validateRoute(route Route) error {
	if strings.TrimSpace(route.Name) == "" {
		return errors.New("route name is required")
	}
	if strings.TrimSpace(route.Prefix) == "" {
		return fmt.Errorf("route %s prefix is required", route.Name)
	}
	if strings.TrimSpace(route.Upstream) == "" {
		return fmt.Errorf("route %s upstream is required", route.Name)
	}
	if rewritePrefix := strings.TrimSpace(route.RewritePrefix); rewritePrefix != "" && !strings.HasPrefix(rewritePrefix, "/") {
		return fmt.Errorf("route %s rewrite_prefix must start with /", route.Name)
	}
	if tokenEnv := strings.TrimSpace(route.UpstreamBearerTokenEnv); tokenEnv != "" && strings.ContainsAny(tokenEnv, " \t\r\n=") {
		return fmt.Errorf("route %s upstream_bearer_token_env is invalid", route.Name)
	}
	switch route.Access {
	case AccessPublic, AccessAdmin, AccessAuthenticated, AccessInternalOnly:
	default:
		return fmt.Errorf("route %s access %q is invalid", route.Name, route.Access)
	}
	return nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	if r.URL.Path == "/healthz" {
		rec := newStatusRecorder(w)
		writeJSON(rec, http.StatusOK, map[string]string{"status": "ok"})
		h.observeRequest(start, "healthz", r, rec.statusCode())
		return
	}

	matched, ok := h.matchRoute(r.URL.Path)
	if !ok {
		rec := newStatusRecorder(w)
		writeJSON(rec, http.StatusNotFound, map[string]string{"error": "route_not_found"})
		h.observeRequest(start, "unmatched", r, rec.statusCode())
		h.logRequest(start, matched, nil, r, rec.statusCode(), "")
		return
	}

	applyCORSHeaders(h.allowedOrigins, w.Header(), r, matched.route.Methods)

	if isCORSPreflight(r) {
		rec := newStatusRecorder(w)
		rec.WriteHeader(http.StatusNoContent)
		h.observeRequest(start, matched.route.Name, r, rec.statusCode())
		h.logRequest(start, matched, nil, r, rec.statusCode(), "")
		return
	}

	if !methodAllowed(matched.route.Methods, r.Method) {
		rec := newStatusRecorder(w)
		writeJSON(rec, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		h.observeRequest(start, matched.route.Name, r, rec.statusCode())
		h.logRequest(start, matched, nil, r, rec.statusCode(), "")
		return
	}

	clearIdentityHeaders(r.Header)

	if matched.isPublicAllowed(r) {
		rec := newStatusRecorder(w)
		matched.proxy.ServeHTTP(rec, r)
		h.observeRequest(start, matched.route.Name, r, rec.statusCode())
		h.logRequest(start, matched, nil, r, rec.statusCode(), "")
		return
	}

	switch matched.route.Access {
	case AccessPublic:
		rec := newStatusRecorder(w)
		matched.proxy.ServeHTTP(rec, r)
		h.observeRequest(start, matched.route.Name, r, rec.statusCode())
		h.logRequest(start, matched, nil, r, rec.statusCode(), "")
		return
	case AccessAdmin:
		bridgeState := h.authorizeAdminViaBridgeCookie(r)
		switch bridgeState {
		case adminBridgeAuthorized:
			rec := newStatusRecorder(w)
			matched.proxy.ServeHTTP(rec, r)
			h.observeRequest(start, matched.route.Name, r, rec.statusCode())
			h.logRequest(start, matched, nil, r, rec.statusCode(), "bridge")
			return
		case adminBridgeInvalid:
			h.writeAdminChallenge(start, matched, w, r)
			return
		}
		if !h.authorizeAdmin(r) {
			h.writeAdminChallenge(start, matched, w, r)
			return
		}
		rec := newStatusRecorder(w)
		if h.isAdminBridgeHost(r.Host) {
			if cookie := h.issueAdminBridgeCookie(); cookie != nil {
				rec.Header().Add("Set-Cookie", cookie.String())
			}
		}
		matched.proxy.ServeHTTP(rec, r)
		h.observeRequest(start, matched.route.Name, r, rec.statusCode())
		h.logRequest(start, matched, nil, r, rec.statusCode(), "basic")
		return
	case AccessInternalOnly:
		rec := newStatusRecorder(w)
		writeJSON(rec, http.StatusForbidden, map[string]string{"error": "internal_only"})
		h.observeRequest(start, matched.route.Name, r, rec.statusCode())
		h.logRequest(start, matched, nil, r, rec.statusCode(), "")
		return
	case AccessAuthenticated:
		session, err := h.introspect(r.Context(), r)
		if err != nil {
			rec := newStatusRecorder(w)
			writeJSON(rec, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			h.observeRequest(start, matched.route.Name, r, rec.statusCode())
			h.logRequest(start, matched, nil, r, rec.statusCode(), "")
			return
		}
		if h.shouldRequireRealname(matched.route, r) && !session.Session.User.RealnameVerified {
			rec := newStatusRecorder(w)
			writeJSON(rec, http.StatusForbidden, map[string]string{"error": "realname_required"})
			h.observeRequest(start, matched.route.Name, r, rec.statusCode())
			h.logRequest(start, matched, session, r, rec.statusCode(), "")
			return
		}
		if requiresActiveSubscription(r) {
			subscription, err := h.currentSubscription(r.Context(), r, session)
			if err != nil {
				rec := newStatusRecorder(w)
				writeJSON(rec, http.StatusBadGateway, map[string]string{"error": "subscription_check_failed"})
				h.observeRequest(start, matched.route.Name, r, rec.statusCode())
				h.logRequest(start, matched, session, r, rec.statusCode(), "")
				return
			}
			if !hasActiveSubscription(subscription) {
				rec := newStatusRecorder(w)
				writeJSON(rec, http.StatusForbidden, map[string]string{"error": "subscription_required"})
				h.observeRequest(start, matched.route.Name, r, rec.statusCode())
				h.logRequest(start, matched, session, r, rec.statusCode(), "")
				return
			}
		}
		injectIdentityHeaders(r.Header, session)
		rec := newStatusRecorder(w)
		matched.proxy.ServeHTTP(rec, r)
		h.observeRequest(start, matched.route.Name, r, rec.statusCode())
		h.logRequest(start, matched, session, r, rec.statusCode(), "")
		return
	default:
		rec := newStatusRecorder(w)
		writeJSON(rec, http.StatusInternalServerError, map[string]string{"error": "invalid_route_access"})
		h.observeRequest(start, matched.route.Name, r, rec.statusCode())
		h.logRequest(start, matched, nil, r, rec.statusCode(), "")
		return
	}
}

// requiresActiveSubscription 在 POST /v1/instances 前做订阅资格校验。
//
// 路径 D-mini 过渡期临时关闭：
//   - 前端已切换到 ctl /v1/passes 作为资格来源，subscription 服务不再是真相源
//   - 在未完成 service-gateway 改调 /v1/passes 前，若仍走旧逻辑会导致所有创建实例 403 subscription_required
//   - 因此本方法先直接返回 false；等 pass-based 校验落地后再恢复
//
// 恢复方式：将方法体改回 `return r.Method == http.MethodPost && r.URL.Path == "/v1/instances"`，
// 并把下游 currentSubscription 的调用切到 ctl /v1/passes。
func requiresActiveSubscription(_ *http.Request) bool {
	return false
}

func hasActiveSubscription(current *currentSubscriptionEnvelope) bool {
	return current != nil &&
		current.HasSubscription &&
		current.Subscription != nil &&
		strings.EqualFold(strings.TrimSpace(current.Subscription.Status), "active")
}

func (h *Handler) matchRoute(path string) (compiledRoute, bool) {
	for _, route := range h.routes {
		if hasRoutePrefix(path, route.route.Prefix) {
			return route, true
		}
	}
	return compiledRoute{}, false
}

func hasRoutePrefix(path string, prefix string) bool {
	normalized := strings.TrimSuffix(prefix, "/")
	if normalized == "" {
		normalized = "/"
	}
	if path == normalized {
		return true
	}
	if normalized == "/" {
		return strings.HasPrefix(path, "/")
	}
	return strings.HasPrefix(path, normalized+"/")
}

func methodAllowed(allowed []string, method string) bool {
	if len(allowed) == 0 {
		return true
	}
	return slices.Contains(allowed, method)
}

func isRealnameWriteMethod(method string) bool {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case http.MethodPost, http.MethodPut, http.MethodPatch:
		return true
	default:
		return false
	}
}

func (h *Handler) shouldRequireRealname(route Route, r *http.Request) bool {
	if !h.realnameWallEnabled || !route.RequireRealname || !isRealnameWriteMethod(r.Method) {
		return false
	}
	return true
}

func applyCORSHeaders(allowedOrigins originAllowlist, header http.Header, r *http.Request, allowedMethods []string) {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return
	}
	if !allowedOrigins.Allows(origin) {
		return
	}

	header.Set("Access-Control-Allow-Origin", origin)
	header.Set("Access-Control-Allow-Credentials", "true")
	header.Set("Vary", appendVary(header.Values("Vary"), "Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"))
	header.Set("Access-Control-Allow-Methods", strings.Join(corsAllowedMethods(allowedMethods), ", "))
	header.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id, X-Trace-Id")
	header.Set("Access-Control-Max-Age", "600")
}

type wildcardOrigin struct {
	scheme           string
	host             string
	port             string
	matchSubdomains  bool
	matchAnyHTTPPort bool
}

type originAllowlist struct {
	exact     map[string]struct{}
	wildcards []wildcardOrigin
	allowAny  bool
}

func (a originAllowlist) Allows(origin string) bool {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return false
	}
	if a.allowAny {
		return isReflectableCORSOrigin(origin)
	}
	if _, ok := a.exact[origin]; ok {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	scheme := strings.ToLower(u.Scheme)
	port := u.Port()
	for _, item := range a.wildcards {
		if scheme != item.scheme {
			continue
		}
		if !item.matchAnyHTTPPort && port != item.port {
			continue
		}
		if item.matchSubdomains {
			if host == item.host {
				continue
			}
			if strings.HasSuffix(host, "."+item.host) {
				return true
			}
			continue
		}
		if host == item.host {
			return true
		}
	}
	return false
}

func normalizeAllowedOrigins(origins []string) originAllowlist {
	allowed := originAllowlist{
		exact:     make(map[string]struct{}, len(origins)),
		wildcards: make([]wildcardOrigin, 0, len(origins)),
	}
	for _, origin := range origins {
		trimmed := strings.TrimSpace(origin)
		if trimmed == "" {
			continue
		}
		if trimmed == "*" {
			allowed.allowAny = true
			continue
		}
		if strings.HasSuffix(trimmed, ":*") {
			base := strings.TrimSuffix(trimmed, ":*")
			u, err := url.Parse(base)
			if err != nil {
				continue
			}
			host := strings.ToLower(u.Hostname())
			scheme := strings.ToLower(u.Scheme)
			if host == "" || scheme == "" {
				continue
			}
			item := wildcardOrigin{
				scheme:           scheme,
				host:             host,
				matchAnyHTTPPort: true,
			}
			if strings.HasPrefix(host, "*.") {
				item.matchSubdomains = true
				item.host = strings.TrimPrefix(host, "*.")
			}
			allowed.wildcards = append(allowed.wildcards, item)
			continue
		}
		u, err := url.Parse(trimmed)
		if err != nil {
			continue
		}
		host := strings.ToLower(u.Hostname())
		scheme := strings.ToLower(u.Scheme)
		port := u.Port()
		if strings.HasPrefix(host, "*.") {
			allowed.wildcards = append(allowed.wildcards, wildcardOrigin{
				scheme:          scheme,
				host:            strings.TrimPrefix(host, "*."),
				port:            port,
				matchSubdomains: true,
			})
			continue
		}
		allowed.exact[trimmed] = struct{}{}
	}
	return allowed
}

func isReflectableCORSOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.User != nil || u.Opaque != "" || u.Hostname() == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
		return true
	default:
		return false
	}
}

func corsAllowedMethods(allowed []string) []string {
	if len(allowed) == 0 {
		return []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions}
	}

	seen := make(map[string]struct{}, len(allowed)+1)
	methods := make([]string, 0, len(allowed)+1)
	for _, method := range allowed {
		upper := strings.ToUpper(strings.TrimSpace(method))
		if upper == "" {
			continue
		}
		if _, ok := seen[upper]; ok {
			continue
		}
		seen[upper] = struct{}{}
		methods = append(methods, upper)
	}
	if _, ok := seen[http.MethodOptions]; !ok {
		methods = append(methods, http.MethodOptions)
	}
	return methods
}

func appendVary(existing []string, values ...string) string {
	seen := map[string]struct{}{}
	merged := make([]string, 0, len(existing)+len(values))

	for _, raw := range existing {
		for _, part := range strings.Split(raw, ",") {
			value := strings.TrimSpace(part)
			if value == "" {
				continue
			}
			if _, ok := seen[value]; ok {
				continue
			}
			seen[value] = struct{}{}
			merged = append(merged, value)
		}
	}

	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		merged = append(merged, value)
	}

	return strings.Join(merged, ", ")
}

func (h *Handler) authorizeAdmin(r *http.Request) bool {
	username, password, ok := r.BasicAuth()
	if !ok {
		return false
	}
	return secureEquals(username, h.adminUsername) && secureEquals(password, h.adminPassword)
}

func (h *Handler) writeAdminChallenge(start time.Time, route compiledRoute, w http.ResponseWriter, r *http.Request) {
	rec := newStatusRecorder(w)
	rec.Header().Set("WWW-Authenticate", fmt.Sprintf(`Basic realm=%q, charset="UTF-8"`, h.adminRealm))
	http.Error(rec, http.StatusText(http.StatusUnauthorized), http.StatusUnauthorized)
	h.observeRequest(start, route.route.Name, r, rec.statusCode())
	h.logRequest(start, route, nil, r, rec.statusCode(), "challenge")
}

func (h *Handler) authorizeAdminViaBridgeCookie(r *http.Request) adminBridgeState {
	if len(h.adminBridgeSigningKey) == 0 {
		return adminBridgeMissing
	}
	if !h.isAdminBridgeHost(r.Host) {
		return adminBridgeMissing
	}
	cookie, err := r.Cookie(h.adminBridgeCookieName)
	if err != nil {
		return adminBridgeMissing
	}
	if !h.validateAdminBridgeCookie(cookie.Value) {
		return adminBridgeInvalid
	}
	return adminBridgeAuthorized
}

func (h *Handler) isAdminBridgeHost(host string) bool {
	if len(h.adminBridgeHosts) == 0 {
		return true
	}
	normalized := normalizeHost(host)
	_, ok := h.adminBridgeHosts[normalized]
	return ok
}

func (h *Handler) issueAdminBridgeCookie() *http.Cookie {
	if len(h.adminBridgeSigningKey) == 0 {
		return nil
	}
	now := time.Now().UTC()
	claims := adminBridgeClaims{
		Version:             1,
		Username:            h.adminUsername,
		PasswordFingerprint: h.currentAdminPasswordFingerprint(),
		IssuedAt:            now.Unix(),
		ExpiresAt:           now.Add(h.adminBridgeCookieTTL).Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return nil
	}
	payloadEncoded := base64.RawURLEncoding.EncodeToString(payload)
	signature := h.signAdminBridgePayload(payloadEncoded)
	return &http.Cookie{
		Name:     h.adminBridgeCookieName,
		Value:    payloadEncoded + "." + signature,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.adminBridgeSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(h.adminBridgeCookieTTL.Seconds()),
	}
}

func (h *Handler) validateAdminBridgeCookie(raw string) bool {
	payloadEncoded, signature, ok := strings.Cut(raw, ".")
	if !ok || payloadEncoded == "" || signature == "" {
		return false
	}
	expectedSignature := h.signAdminBridgePayload(payloadEncoded)
	if !secureEquals(signature, expectedSignature) {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadEncoded)
	if err != nil {
		return false
	}
	var claims adminBridgeClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return false
	}
	now := time.Now().UTC().Unix()
	if claims.Version != 1 || claims.ExpiresAt <= now || claims.IssuedAt > now {
		return false
	}
	if !secureEquals(claims.Username, h.adminUsername) {
		return false
	}
	return secureEquals(claims.PasswordFingerprint, h.currentAdminPasswordFingerprint())
}

func (h *Handler) currentAdminPasswordFingerprint() string {
	mac := hmac.New(sha256.New, h.adminBridgeSigningKey)
	_, _ = mac.Write([]byte(h.adminUsername))
	_, _ = mac.Write([]byte{'\n'})
	_, _ = mac.Write([]byte(h.adminPassword))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (h *Handler) signAdminBridgePayload(payload string) string {
	mac := hmac.New(sha256.New, h.adminBridgeSigningKey)
	_, _ = mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func normalizeHosts(hosts []string) map[string]struct{} {
	normalized := make(map[string]struct{}, len(hosts))
	for _, host := range hosts {
		value := normalizeHost(host)
		if value == "" {
			continue
		}
		normalized[value] = struct{}{}
	}
	return normalized
}

func normalizeHost(host string) string {
	trimmed := strings.TrimSpace(strings.ToLower(host))
	if trimmed == "" {
		return ""
	}
	if h, _, err := net.SplitHostPort(trimmed); err == nil {
		return h
	}
	return trimmed
}

func secureEquals(left string, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func isCORSPreflight(r *http.Request) bool {
	return r.Method == http.MethodOptions &&
		strings.TrimSpace(r.Header.Get("Origin")) != "" &&
		strings.TrimSpace(r.Header.Get("Access-Control-Request-Method")) != ""
}

func (r compiledRoute) isPublicAllowed(req *http.Request) bool {
	for _, rule := range r.route.PublicAllow {
		if strings.EqualFold(rule.Method, req.Method) && rule.Path == req.URL.Path {
			return true
		}
	}
	return false
}

func (h *Handler) introspect(ctx context.Context, original *http.Request) (*sessionEnvelope, error) {
	authHeader, cookieHeader := extractAuth(original)
	if authHeader == "" && cookieHeader == "" {
		return nil, errors.New("missing session token")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.authServiceURL+"/auth/session", nil)
	if err != nil {
		return nil, fmt.Errorf("create auth introspection request: %w", err)
	}
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	if cookieHeader != "" {
		req.Header.Set("Cookie", cookieHeader)
	}

	resp, err := h.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call auth introspection: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("auth introspection status %d", resp.StatusCode)
	}

	var session sessionEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&session); err != nil {
		return nil, fmt.Errorf("decode auth introspection: %w", err)
	}
	if strings.TrimSpace(session.Session.User.ID) == "" {
		return nil, errors.New("missing user id in auth introspection")
	}

	return &session, nil
}

func (h *Handler) currentSubscription(ctx context.Context, original *http.Request, session *sessionEnvelope) (*currentSubscriptionEnvelope, error) {
	if strings.TrimSpace(h.subscriptionServiceURL) == "" {
		return nil, errors.New("subscription service url is not configured")
	}

	authHeader, cookieHeader := extractAuth(original)
	if authHeader == "" && cookieHeader == "" {
		return nil, errors.New("missing session token")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.subscriptionServiceURL+"/subscriptions/current", nil)
	if err != nil {
		return nil, fmt.Errorf("create current subscription request: %w", err)
	}
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	if cookieHeader != "" {
		req.Header.Set("Cookie", cookieHeader)
	}
	if session != nil {
		userID := strings.TrimSpace(session.Session.User.ID)
		if userID != "" {
			req.Header.Set("X-Lightclaw-User-ID", userID)
			req.Header.Set("X-User-Id", userID)
		}
	}

	resp, err := h.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call current subscription: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("current subscription status %d", resp.StatusCode)
	}

	var envelope currentSubscriptionEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("decode current subscription: %w", err)
	}

	return &envelope, nil
}

func extractAuth(r *http.Request) (string, string) {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		return authHeader, ""
	}

	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		return "", (&http.Cookie{Name: sessionCookieName, Value: cookie.Value}).String()
	}
	return "", ""
}

func clearIdentityHeaders(header http.Header) {
	header.Del("X-Lightclaw-User-ID")
	header.Del("X-Lightclaw-User-Email")
	header.Del("X-Lightclaw-Plan-Tier")
	header.Del("X-User-Id")
	header.Del("X-Uin")
}

func injectIdentityHeaders(header http.Header, session *sessionEnvelope) {
	header.Set("X-Lightclaw-User-ID", session.Session.User.ID)
	header.Set("X-Lightclaw-User-Email", session.Session.User.Email)
	header.Set("X-User-Id", session.Session.User.ID)
	header.Set("X-Uin", session.Session.User.ID)
}

func writeJSON(w http.ResponseWriter, status int, body map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (h *Handler) logRequest(start time.Time, route compiledRoute, session *sessionEnvelope, r *http.Request, status int, adminAuthMode string) {
	if h.accessLogger == nil {
		return
	}
	if shouldSkipAccessLog(r) {
		return
	}

	entry := accesslog.Entry{
		Timestamp:  start.UTC(),
		Method:     r.Method,
		Path:       r.URL.Path,
		Status:     status,
		DurationMS: time.Since(start).Milliseconds(),
		RouteName:  route.route.Name,
		RemoteAddr: remoteAddr(r),
		UserAgent:  r.UserAgent(),
		Referer:    r.Referer(),
		Origin:     r.Header.Get("Origin"),
	}
	if session != nil {
		entry.UserID = session.Session.User.ID
		entry.UserEmail = session.Session.User.Email
	}
	entry.AdminAuthMode = adminAuthMode

	h.accessLogger.Log(entry)
}

func shouldSkipAccessLog(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.UserAgent()), "clb-healthcheck")
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func newStatusRecorder(w http.ResponseWriter) *statusRecorder {
	return &statusRecorder{ResponseWriter: w}
}

func (r *statusRecorder) WriteHeader(statusCode int) {
	r.status = statusCode
	r.ResponseWriter.WriteHeader(statusCode)
}

func (r *statusRecorder) statusCode() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("underlying response writer does not support hijacking")
	}
	return hijacker.Hijack()
}

func (r *statusRecorder) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (r *statusRecorder) ReadFrom(src io.Reader) (int64, error) {
	if readerFrom, ok := r.ResponseWriter.(io.ReaderFrom); ok {
		return readerFrom.ReadFrom(src)
	}
	return io.Copy(r.ResponseWriter, src)
}

func (r *statusRecorder) Push(target string, opts *http.PushOptions) error {
	pusher, ok := r.ResponseWriter.(http.Pusher)
	if !ok {
		return http.ErrNotSupported
	}
	return pusher.Push(target, opts)
}

func remoteAddr(r *http.Request) string {
	if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		return strings.TrimSpace(parts[0])
	}
	host, _, found := strings.Cut(r.RemoteAddr, ":")
	if found {
		return host
	}
	return r.RemoteAddr
}

func (h *Handler) observeRequest(start time.Time, route string, r *http.Request, status int) {
	if h.metrics == nil {
		return
	}
	h.metrics.ObserveRequest(r.Method, route, r.URL.Path, status, time.Since(start))
}

func newSingleHostReverseProxy(target *url.URL, transport http.RoundTripper, routePrefix string, rewritePrefix string, upstreamBearerTokenEnv string) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = rewriteRoutePath(req.URL.Path, routePrefix, rewritePrefix)
		req.URL.RawPath = ""
	}
	proxy.Transport = withUpstreamBearerToken(transport, upstreamBearerTokenEnv)
	proxy.ModifyResponse = func(resp *http.Response) error {
		stripUpstreamCORSHeaders(resp.Header)
		return nil
	}
	return proxy
}

func withUpstreamBearerToken(base http.RoundTripper, tokenEnv string) http.RoundTripper {
	tokenEnv = strings.TrimSpace(tokenEnv)
	if tokenEnv == "" {
		return base
	}
	return roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		token := strings.TrimSpace(os.Getenv(tokenEnv))
		if token == "" {
			return nil, fmt.Errorf("upstream bearer token env %s is empty", tokenEnv)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Del("Cookie")
		return base.RoundTrip(req)
	})
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func rewriteRoutePath(requestPath string, routePrefix string, rewritePrefix string) string {
	if strings.TrimSpace(rewritePrefix) == "" {
		return requestPath
	}

	normalizedPrefix := strings.TrimSuffix(strings.TrimSpace(routePrefix), "/")
	if normalizedPrefix == "" {
		normalizedPrefix = "/"
	}

	normalizedRewrite := strings.TrimSuffix(strings.TrimSpace(rewritePrefix), "/")
	if normalizedRewrite == "" {
		normalizedRewrite = "/"
	}

	suffix := ""
	if requestPath != normalizedPrefix {
		suffix = strings.TrimPrefix(requestPath, normalizedPrefix)
	}

	if suffix == "" {
		return normalizedRewrite
	}
	if normalizedRewrite == "/" {
		return suffix
	}
	return normalizedRewrite + suffix
}

func stripUpstreamCORSHeaders(header http.Header) {
	header.Del("Access-Control-Allow-Origin")
	header.Del("Access-Control-Allow-Credentials")
	header.Del("Access-Control-Allow-Headers")
	header.Del("Access-Control-Allow-Methods")
	header.Del("Access-Control-Max-Age")
	header.Del("Access-Control-Expose-Headers")
}
