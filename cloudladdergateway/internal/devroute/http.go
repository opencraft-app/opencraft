package devroute

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/audit"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/tunnelcap"
)

var (
	ErrTargetUnreachable = errors.New("developer route target is unreachable")
)

type TargetProbe interface {
	Probe(ctx context.Context, baseURL string) error
}

type HTTPProbe struct {
	path   string
	client *http.Client
}

func NewHTTPProbe(path string, client *http.Client) *HTTPProbe {
	path = "/" + strings.TrimLeft(strings.TrimSpace(path), "/")
	if path == "/" {
		path = "/healthz"
	}
	if client == nil {
		client = http.DefaultClient
	}
	probeClient := *client
	probeClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &HTTPProbe{path: path, client: &probeClient}
}

func (p *HTTPProbe) Probe(ctx context.Context, baseURL string) error {
	if p == nil || p.client == nil {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+p.path, nil)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrTargetUnreachable, err)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrTargetUnreachable, err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("%w: status %d", ErrTargetUnreachable, resp.StatusCode)
	}
	return nil
}

type APIOptions struct {
	Store              Store
	Authenticator      *auth.Authenticator
	TargetProbe        TargetProbe
	AllowedCIDRs       []string
	AllowedPorts       []int
	RegistrationRoute  string
	RegistrationCaller string
	DeliveryMode       string
	TunnelBaseURL      string
	TunnelHostSuffix   string
	Auditor            audit.Auditor
	DefaultTTL         time.Duration
	MaxTTL             time.Duration
	Now                func() time.Time
	TunnelTokenSource  io.Reader
}

type API struct {
	store              Store
	authenticator      *auth.Authenticator
	targetProbe        TargetProbe
	allowedCIDRs       []netip.Prefix
	allowedPorts       map[int]struct{}
	registrationRoute  string
	registrationCaller string
	deliveryMode       string
	tunnelBaseURL      string
	tunnelHostSuffix   string
	auditor            audit.Auditor
	defaultTTL         time.Duration
	maxTTL             time.Duration
	now                func() time.Time
	tunnelTokenSource  io.Reader
}

func NewAPI(opts APIOptions) (*API, error) {
	if opts.Store == nil || opts.Authenticator == nil {
		return nil, errors.New("developer route store and authenticator are required")
	}
	allowedCIDRs, err := parsePrefixes(opts.AllowedCIDRs)
	if err != nil {
		return nil, fmt.Errorf("allowed cidrs: %w", err)
	}
	if len(allowedCIDRs) == 0 {
		return nil, errors.New("at least one developer cidr is required")
	}
	registrationRoute := strings.TrimSpace(opts.RegistrationRoute)
	registrationCaller := strings.TrimSpace(opts.RegistrationCaller)
	if registrationRoute == "" || registrationCaller == "" {
		return nil, errors.New("developer route registration route and caller are required")
	}
	deliveryMode := strings.ToLower(strings.TrimSpace(opts.DeliveryMode))
	if deliveryMode == "" {
		deliveryMode = DeliveryModeDirect
	}
	if deliveryMode != DeliveryModeDirect && deliveryMode != DeliveryModeDevtunnel {
		return nil, fmt.Errorf("unsupported developer route delivery mode %q", deliveryMode)
	}
	tunnelBaseURL := strings.TrimRight(strings.TrimSpace(opts.TunnelBaseURL), "/")
	tunnelHostSuffix := normalizeTunnelHostSuffix(opts.TunnelHostSuffix)
	if deliveryMode == DeliveryModeDevtunnel {
		if err := validateTunnelBaseURL(tunnelBaseURL); err != nil {
			return nil, err
		}
		if tunnelHostSuffix == "" {
			return nil, errors.New("devtunnel host suffix is required")
		}
	}
	allowedPorts := make(map[int]struct{}, len(opts.AllowedPorts))
	for _, port := range opts.AllowedPorts {
		if port < 1 || port > 65535 {
			return nil, fmt.Errorf("invalid allowed port %d", port)
		}
		allowedPorts[port] = struct{}{}
	}
	if len(allowedPorts) == 0 {
		return nil, errors.New("at least one developer port is required")
	}
	defaultTTL := opts.DefaultTTL
	if defaultTTL <= 0 {
		defaultTTL = 8 * time.Hour
	}
	maxTTL := opts.MaxTTL
	if maxTTL <= 0 {
		maxTTL = 24 * time.Hour
	}
	if defaultTTL > maxTTL {
		return nil, errors.New("default ttl exceeds max ttl")
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &API{
		store:              opts.Store,
		authenticator:      opts.Authenticator,
		targetProbe:        opts.TargetProbe,
		allowedCIDRs:       allowedCIDRs,
		allowedPorts:       allowedPorts,
		registrationRoute:  registrationRoute,
		registrationCaller: registrationCaller,
		deliveryMode:       deliveryMode,
		tunnelBaseURL:      tunnelBaseURL,
		tunnelHostSuffix:   tunnelHostSuffix,
		auditor:            opts.Auditor,
		defaultTTL:         defaultTTL,
		maxTTL:             maxTTL,
		now:                now,
		tunnelTokenSource:  opts.TunnelTokenSource,
	}, nil
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	tracked := &statusWriter{ResponseWriter: w, status: http.StatusOK}
	state := &controlAuditState{operation: controlOperation(r.Method)}
	defer func() {
		a.recordControlAudit(r, tracked.status, started, state)
	}()

	body, err := readControlBody(r)
	if err != nil {
		state.errorCode = "request_body_too_large"
		writeAPIError(tracked, http.StatusRequestEntityTooLarge, state.errorCode)
		return
	}
	authRequest := auth.RequestFromHTTP(r, a.registrationRoute, r.URL.EscapedPath(), body)
	if err := a.authenticator.VerifyRequiredCaller(authRequest, a.registrationCaller); err != nil {
		state.errorCode = "unauthorized"
		writeAPIError(tracked, http.StatusUnauthorized, state.errorCode)
		return
	}
	state.caller = a.registrationCaller

	switch r.Method {
	case http.MethodPost:
		a.register(tracked, r, body, state)
	case http.MethodGet:
		a.status(tracked, r, state)
	case http.MethodDelete:
		a.disable(tracked, r, state)
	default:
		tracked.Header().Set("Allow", "GET, POST, DELETE")
		state.errorCode = "method_not_allowed"
		writeAPIError(tracked, http.StatusMethodNotAllowed, state.errorCode)
	}
}

type registrationRequest struct {
	UIN        string `json:"uin"`
	TargetIP   string `json:"targetIp"`
	Port       int    `json:"port"`
	TTLSeconds int    `json:"ttlSeconds"`
}

func (a *API) register(w http.ResponseWriter, r *http.Request, rawBody []byte, state *controlAuditState) {
	var body registrationRequest
	decoder := json.NewDecoder(bytes.NewReader(rawBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		state.errorCode = "invalid_request"
		writeAPIError(w, http.StatusBadRequest, state.errorCode)
		return
	}
	body.UIN = strings.TrimSpace(body.UIN)
	state.uin = body.UIN
	if !validUIN(body.UIN) {
		state.errorCode = "invalid_uin"
		writeAPIError(w, http.StatusBadRequest, state.errorCode)
		return
	}
	if _, ok := a.allowedPorts[body.Port]; !ok {
		state.errorCode = "port_not_allowed"
		writeAPIError(w, http.StatusBadRequest, state.errorCode)
		return
	}
	address, err := netip.ParseAddr(strings.TrimSpace(body.TargetIP))
	if err != nil || !containsAddress(a.allowedCIDRs, address.Unmap()) {
		state.errorCode = "target_ip_not_allowed"
		writeAPIError(w, http.StatusForbidden, state.errorCode)
		return
	}
	address = address.Unmap()
	ttl := a.defaultTTL
	if body.TTLSeconds > 0 {
		if int64(body.TTLSeconds) > int64(a.maxTTL/time.Second) {
			state.errorCode = "ttl_not_allowed"
			writeAPIError(w, http.StatusBadRequest, state.errorCode)
			return
		}
		ttl = time.Duration(body.TTLSeconds) * time.Second
	}
	if ttl < time.Minute || ttl > a.maxTTL {
		state.errorCode = "ttl_not_allowed"
		writeAPIError(w, http.StatusBadRequest, state.errorCode)
		return
	}

	registration := Registration{
		UIN:          body.UIN,
		UserID:       a.registrationCaller,
		DeliveryMode: a.deliveryMode,
		SourceIP:     address.String(),
		Port:         body.Port,
		RenewedAt:    a.now().UTC(),
		TTL:          ttl,
	}
	if a.deliveryMode == DeliveryModeDevtunnel {
		registration.BaseURL = a.tunnelBaseURL
		registration.TunnelHost = tunnelHostForUIN(body.UIN, a.tunnelHostSuffix)
	} else {
		registration.BaseURL = "http://" + net.JoinHostPort(address.String(), strconv.Itoa(body.Port))
	}
	state.targetURL = registration.BaseURL
	state.sourceIP = registration.SourceIP
	state.tunnelHost = registration.TunnelHost
	if a.targetProbe != nil {
		if err := a.targetProbe.Probe(r.Context(), registration.BaseURL); err != nil {
			state.errorCode = "target_unreachable"
			writeAPIError(w, http.StatusBadGateway, state.errorCode)
			return
		}
	}
	tunnelToken := ""
	if a.deliveryMode == DeliveryModeDevtunnel {
		var err error
		tunnelToken, registration.TunnelTokenHash, err = tunnelcap.Issue(body.UIN, a.tunnelTokenSource)
		if err != nil {
			state.errorCode = "tunnel_capability_unavailable"
			writeAPIError(w, http.StatusInternalServerError, state.errorCode)
			return
		}
	}
	if err := a.store.Upsert(r.Context(), registration); err != nil {
		state.errorCode = "store_unavailable"
		writeAPIError(w, http.StatusBadGateway, state.errorCode)
		return
	}
	a.writeRegistration(w, http.StatusOK, registration, tunnelToken)
}

func (a *API) status(w http.ResponseWriter, r *http.Request, state *controlAuditState) {
	uin, ok := requestUIN(r)
	state.uin = uin
	if !ok {
		state.errorCode = "invalid_uin"
		writeAPIError(w, http.StatusBadRequest, state.errorCode)
		return
	}
	registration, err := a.store.Get(r.Context(), uin)
	if errors.Is(err, ErrNotFound) {
		state.errorCode = "registration_not_found"
		writeAPIError(w, http.StatusNotFound, state.errorCode)
		return
	}
	if err != nil {
		state.errorCode = "store_unavailable"
		writeAPIError(w, http.StatusBadGateway, state.errorCode)
		return
	}
	state.targetURL = registration.BaseURL
	state.sourceIP = registration.SourceIP
	state.tunnelHost = registration.TunnelHost
	a.writeRegistration(w, http.StatusOK, registration, "")
}

func (a *API) disable(w http.ResponseWriter, r *http.Request, state *controlAuditState) {
	uin, ok := requestUIN(r)
	state.uin = uin
	if !ok {
		state.errorCode = "invalid_uin"
		writeAPIError(w, http.StatusBadRequest, state.errorCode)
		return
	}
	now := a.now().UTC()
	if err := a.store.Disable(r.Context(), uin, now); err != nil {
		if errors.Is(err, ErrNotFound) {
			state.errorCode = "registration_not_found"
			writeAPIError(w, http.StatusNotFound, state.errorCode)
			return
		}
		state.errorCode = "store_unavailable"
		writeAPIError(w, http.StatusBadGateway, state.errorCode)
		return
	}
	registration, err := a.store.Get(r.Context(), uin)
	if err != nil {
		state.errorCode = "store_unavailable"
		writeAPIError(w, http.StatusBadGateway, state.errorCode)
		return
	}
	state.targetURL = registration.BaseURL
	state.sourceIP = registration.SourceIP
	state.tunnelHost = registration.TunnelHost
	a.writeRegistration(w, http.StatusOK, registration, "")
}

func (a *API) writeRegistration(w http.ResponseWriter, status int, registration Registration, tunnelToken string) {
	now := a.now().UTC()
	response := map[string]any{
		"uin":          registration.UIN,
		"deliveryMode": registration.DeliveryMode,
		"targetIp":     registration.SourceIP,
		"port":         registration.Port,
		"tunnelHost":   registration.TunnelHost,
		"status":       registration.State(now),
		"updatedAt":    registration.RenewedAt.UTC().Format(time.RFC3339),
		"expiresAt":    registration.RenewedAt.Add(registration.TTL).UTC().Format(time.RFC3339),
	}
	if tunnelToken != "" {
		response["tunnelToken"] = tunnelToken
	}
	writeAPIJSON(w, status, response)
}

func parsePrefixes(raw []string) ([]netip.Prefix, error) {
	prefixes := make([]netip.Prefix, 0, len(raw))
	for _, item := range raw {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(item)
		if err != nil {
			return nil, err
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

func containsAddress(prefixes []netip.Prefix, address netip.Addr) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

const maxControlBodyBytes int64 = 64 << 10

func readControlBody(r *http.Request) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxControlBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxControlBodyBytes {
		return nil, errors.New("developer route request body is too large")
	}
	return body, nil
}

func validUIN(uin string) bool {
	if uin == "" {
		return false
	}
	value, err := strconv.ParseUint(uin, 10, 64)
	return err == nil && value > 0 && strconv.FormatUint(value, 10) == uin
}

func requestUIN(r *http.Request) (string, bool) {
	values, ok := r.URL.Query()["uin"]
	if !ok || len(values) != 1 {
		return "", false
	}
	uin := strings.TrimSpace(values[0])
	return uin, validUIN(uin)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

type controlAuditState struct {
	operation  string
	caller     string
	uin        string
	targetURL  string
	sourceIP   string
	tunnelHost string
	errorCode  string
}

func controlOperation(method string) string {
	switch method {
	case http.MethodPost:
		return "developer-route-register"
	case http.MethodGet:
		return "developer-route-status"
	case http.MethodDelete:
		return "developer-route-unregister"
	default:
		return "developer-route-control"
	}
}

func (a *API) recordControlAudit(r *http.Request, status int, started time.Time, state *controlAuditState) {
	if a.auditor == nil {
		return
	}
	operation := state.operation
	if state.uin != "" {
		operation += "-uin-" + state.uin
	}
	a.auditor.Record(r.Context(), audit.Event{
		Timestamp:         started,
		RequestID:         firstControlHeader(r.Header, "X-Request-ID", "X-CloudLadder-Request-ID"),
		Caller:            state.caller,
		Operation:         operation,
		Method:            r.Method,
		Path:              r.URL.EscapedPath(),
		Query:             r.URL.RawQuery,
		UpstreamURL:       state.targetURL,
		StatusCode:        status,
		Duration:          time.Since(started),
		Error:             state.errorCode,
		DeveloperSourceIP: state.sourceIP,
		TunnelHost:        state.tunnelHost,
	})
}

func firstControlHeader(headers http.Header, names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(headers.Get(name)); value != "" {
			return value
		}
	}
	return ""
}

func writeAPIError(w http.ResponseWriter, status int, code string) {
	writeAPIJSON(w, status, map[string]string{"code": code, "message": code})
}

func writeAPIJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
