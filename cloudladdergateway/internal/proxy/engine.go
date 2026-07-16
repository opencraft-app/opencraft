package proxy

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/audit"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/discovery"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/rules"
)

var (
	ErrNoRoute            = errors.New("no route matched request")
	ErrMethodDenied       = errors.New("method is not allowed for route")
	ErrInvalidMethod      = errors.New("method is not supported")
	ErrBodyTooLarge       = errors.New("body is larger than configured max_body_bytes")
	ErrSignedHostMismatch = errors.New("signed host does not match route trusted host")
)

type Engine struct {
	routes       []Route
	maxBodyBytes int64
	httpClient   *http.Client
	polaris      *discovery.PolarisResolver
	auditor      audit.Auditor
}

type EngineOption func(*Engine)

func WithAuditor(auditor audit.Auditor) EngineOption {
	return func(e *Engine) {
		e.auditor = auditor
	}
}

type Route struct {
	ID          string
	Description string
	Mode        string
	Condition   string
	Upstream    Upstream
	Webhooks    []Webhook
}

type Upstream struct {
	BaseURL        string
	Scheme         string
	Polaris        *PolarisUpstream
	Timeout        time.Duration
	AllowedMethods []string
	Headers        map[string]string
	HeadersFromEnv map[string]string
	TrustedHost    string
	TrustedScheme  string
}

type PolarisUpstream struct {
	Service   string
	Namespace string
}

type Webhook struct {
	ID                  string
	URL                 string
	Method              string
	Mode                string
	Condition           string
	Timeout             time.Duration
	Headers             map[string]string
	ForwardOriginal     bool
	SigningSecretEnv    string
	IncludeRequestBody  bool
	IncludeResponseBody bool
}

func NewEngine(cfg config.Config, opts ...EngineOption) (*Engine, error) {
	transport, err := newTransport(cfg.Transport)
	if err != nil {
		return nil, err
	}
	polaris, err := discovery.NewPolarisResolver(cfg.Discovery.Polaris, transport)
	if err != nil {
		return nil, err
	}
	routes := make([]Route, 0, len(cfg.Routes))
	for _, routeCfg := range cfg.Routes {
		upstreamCfg, err := cfg.ResolveUpstream(routeCfg.ID, routeCfg.Upstream)
		if err != nil {
			return nil, err
		}
		timeout, _ := config.ParseDuration(upstreamCfg.Timeout, 30*time.Second)
		allowedMethods, err := normalizeMethods(upstreamCfg.AllowedMethods)
		if err != nil {
			return nil, fmt.Errorf("route %q upstream methods: %w", routeCfg.ID, err)
		}
		upstream := Upstream{
			BaseURL:        strings.TrimRight(upstreamCfg.BaseURL, "/"),
			Scheme:         strings.TrimSpace(upstreamCfg.Scheme),
			Timeout:        timeout,
			AllowedMethods: allowedMethods,
			Headers:        cloneStringMap(upstreamCfg.Headers),
			HeadersFromEnv: cloneStringMap(upstreamCfg.HeadersFromEnv),
		}
		upstream.TrustedHost, upstream.TrustedScheme = signedTunnelTrustedHost(upstreamCfg)
		if upstream.Scheme == "" {
			upstream.Scheme = "http"
		}
		if upstreamCfg.Polaris.Service != "" {
			upstream.Polaris = &PolarisUpstream{
				Service:   upstreamCfg.Polaris.Service,
				Namespace: upstreamCfg.Polaris.Namespace,
			}
		}
		route := Route{
			ID:          routeCfg.ID,
			Description: routeCfg.Description,
			Mode:        strings.ToLower(strings.TrimSpace(routeCfg.Mode)),
			Condition:   routeCfg.Condition,
			Upstream:    upstream,
		}
		for _, webhookCfg := range routeCfg.Webhooks {
			webhookTimeout, _ := config.ParseDuration(webhookCfg.Timeout, 10*time.Second)
			mode := strings.ToLower(strings.TrimSpace(webhookCfg.Mode))
			if mode == "" {
				mode = "async"
			}
			method := strings.ToUpper(strings.TrimSpace(webhookCfg.Method))
			if method == "" {
				method = http.MethodPost
			}
			if !isSupportedHTTPMethod(method) {
				return nil, fmt.Errorf("route %q webhook %q method: %w: %s", routeCfg.ID, webhookCfg.ID, ErrInvalidMethod, method)
			}
			route.Webhooks = append(route.Webhooks, Webhook{
				ID:                  webhookCfg.ID,
				URL:                 strings.TrimRight(webhookCfg.URL, "/"),
				Method:              method,
				Mode:                mode,
				Condition:           webhookCfg.Condition,
				Timeout:             webhookTimeout,
				Headers:             cloneStringMap(webhookCfg.Headers),
				ForwardOriginal:     webhookCfg.ForwardOriginal,
				SigningSecretEnv:    webhookCfg.SigningSecretEnv,
				IncludeRequestBody:  webhookCfg.IncludeRequestBody,
				IncludeResponseBody: webhookCfg.IncludeResponseBody,
			})
		}
		routes = append(routes, route)
	}
	engine := &Engine{
		routes:       routes,
		maxBodyBytes: cfg.MaxBodyBytes,
		httpClient:   &http.Client{Transport: transport},
		polaris:      polaris,
	}
	for _, opt := range opts {
		opt(engine)
	}
	return engine, nil
}

func (e *Engine) Invoke(ctx context.Context, req Request) (Response, error) {
	start := time.Now()
	req.Method = strings.ToUpper(strings.TrimSpace(req.Method))
	if req.Method == "" {
		req.Method = http.MethodPost
	}
	if !isSupportedHTTPMethod(req.Method) {
		err := fmt.Errorf("%w: %s", ErrInvalidMethod, req.Method)
		e.recordAudit(ctx, req, req.RouteID, "", 0, start, err, 0, 0)
		return Response{}, err
	}
	req.RequestID = ensureRequestID(req.RequestID, req.Headers)
	req.Caller = ensureCaller(req.Caller, req.Attributes, req.Headers)
	if req.Path == "" {
		req.Path = "/"
	}
	if !strings.HasPrefix(req.Path, "/") {
		req.Path = "/" + req.Path
	}
	if int64(len(req.Body)) > e.maxBodyBytes {
		e.recordAudit(ctx, req, "", "", 0, start, ErrBodyTooLarge, 0, 0)
		return Response{}, ErrBodyTooLarge
	}
	route, err := e.Match(ctx, req)
	if err != nil {
		e.recordAudit(ctx, req, req.RouteID, "", 0, start, err, 0, 0)
		return Response{}, err
	}
	if !methodAllowed(route.Upstream.AllowedMethods, req.Method) {
		err := fmt.Errorf("%w: %s", ErrMethodDenied, req.Method)
		e.recordAudit(ctx, req, route.ID, "", 0, start, err, 0, 0)
		return Response{}, err
	}

	baseURL, err := e.resolveBaseURL(ctx, route.Upstream)
	if err != nil {
		e.recordAudit(ctx, req, route.ID, "", 0, start, err, 0, 0)
		return Response{}, err
	}
	targetURL, err := joinURL(baseURL, req.Path, req.Query)
	if err != nil {
		e.recordAudit(ctx, req, route.ID, "", 0, start, err, 0, 0)
		return Response{}, err
	}
	upstreamCtx, cancel := context.WithTimeout(ctx, route.Upstream.Timeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(upstreamCtx, req.Method, targetURL, bytes.NewReader(req.Body))
	if err != nil {
		e.recordAudit(ctx, req, route.ID, targetURL, 0, start, err, 0, 0)
		return Response{}, err
	}
	copyHeaders(httpReq.Header, req.Headers)
	if route.Mode == config.RouteModeSignedHTTPTunnel {
		if err := prepareSignedTunnelRequest(httpReq, req, route); err != nil {
			e.recordAudit(ctx, req, route.ID, targetURL, 0, start, err, 0, 0)
			return Response{}, err
		}
	} else {
		for name, value := range route.Upstream.Headers {
			setRequestHeader(httpReq, name, value)
		}
		for name, envName := range route.Upstream.HeadersFromEnv {
			setRequestHeader(httpReq, name, os.Getenv(envName))
		}
		httpReq.Header.Set("X-CloudLadder-Route", route.ID)
	}

	httpResp, err := e.httpClient.Do(httpReq)
	if err != nil {
		e.recordAudit(ctx, req, route.ID, targetURL, 0, start, err, 0, 0)
		return Response{}, err
	}
	defer httpResp.Body.Close()

	body, err := readLimited(httpResp.Body, e.maxBodyBytes)
	if err != nil {
		e.recordAudit(ctx, req, route.ID, targetURL, httpResp.StatusCode, start, err, 0, 0)
		return Response{}, err
	}
	resp := Response{
		StatusCode:  httpResp.StatusCode,
		Headers:     cloneHeader(httpResp.Header),
		Body:        body,
		UpstreamURL: targetURL,
	}
	resp.WebhookDeliveries = e.deliverWebhooks(ctx, route, req, resp)
	e.recordAudit(ctx, req, route.ID, targetURL, resp.StatusCode, start, nil, len(resp.Body), len(resp.WebhookDeliveries))
	return resp, nil
}

func (e *Engine) Match(ctx context.Context, req Request) (Route, error) {
	if req.RouteID != "" {
		for _, route := range e.routes {
			if route.ID != req.RouteID {
				continue
			}
			ok, err := evalRouteCondition(ctx, route, req)
			if err != nil {
				return Route{}, fmt.Errorf("route %q condition: %w", route.ID, err)
			}
			if !ok {
				return Route{}, ErrNoRoute
			}
			return route, nil
		}
		return Route{}, ErrNoRoute
	}
	for _, route := range e.routes {
		ok, err := evalRouteCondition(ctx, route, req)
		if err != nil {
			return Route{}, fmt.Errorf("route %q condition: %w", route.ID, err)
		}
		if ok {
			return route, nil
		}
	}
	return Route{}, ErrNoRoute
}

func (e *Engine) HasRoute(routeID string) bool {
	for _, route := range e.routes {
		if route.ID == routeID {
			return true
		}
	}
	return false
}

func (e *Engine) resolveBaseURL(ctx context.Context, upstream Upstream) (string, error) {
	if upstream.Polaris == nil {
		return upstream.BaseURL, nil
	}
	address, err := e.polaris.Resolve(ctx, upstream.Polaris.Service, upstream.Polaris.Namespace)
	if err != nil {
		return "", err
	}
	return upstream.Scheme + "://" + address, nil
}

func (e *Engine) deliverWebhooks(ctx context.Context, route Route, req Request, resp Response) []WebhookDelivery {
	deliveries := make([]WebhookDelivery, 0, len(route.Webhooks))
	for _, webhook := range route.Webhooks {
		ok, err := rules.Eval(webhook.Condition, toRuleRequest(req), &rules.Response{
			StatusCode:  resp.StatusCode,
			Headers:     resp.Headers,
			UpstreamURL: resp.UpstreamURL,
		})
		if err != nil {
			deliveries = append(deliveries, WebhookDelivery{
				ID:     webhook.ID,
				Mode:   webhook.Mode,
				Status: "condition_error",
				Error:  err.Error(),
			})
			continue
		}
		if !ok {
			continue
		}
		if webhook.Mode == "sync" {
			deliveries = append(deliveries, e.deliverWebhook(ctx, route, webhook, req, resp))
			continue
		}
		targetURL := webhookTargetURL(webhook, req)
		deliveries = append(deliveries, WebhookDelivery{
			ID:        webhook.ID,
			Mode:      webhook.Mode,
			Status:    "queued",
			TargetURL: targetURL,
		})
		go func(webhook Webhook) {
			_ = e.deliverWebhook(context.Background(), route, webhook, req, resp)
		}(webhook)
	}
	return deliveries
}

func (e *Engine) deliverWebhook(ctx context.Context, route Route, webhook Webhook, req Request, resp Response) WebhookDelivery {
	targetURL := webhookTargetURL(webhook, req)
	payload, contentType, err := webhookPayload(route, webhook, req, resp)
	if err != nil {
		return WebhookDelivery{ID: webhook.ID, Mode: webhook.Mode, Status: "failed", Error: err.Error(), TargetURL: targetURL}
	}
	webhookCtx, cancel := context.WithTimeout(ctx, webhook.Timeout)
	defer cancel()

	method := webhook.Method
	if webhook.ForwardOriginal {
		method = req.Method
	}
	httpReq, err := http.NewRequestWithContext(webhookCtx, method, targetURL, bytes.NewReader(payload))
	if err != nil {
		return WebhookDelivery{ID: webhook.ID, Mode: webhook.Mode, Status: "failed", Error: err.Error(), TargetURL: targetURL}
	}
	if webhook.ForwardOriginal {
		copyHeaders(httpReq.Header, req.Headers)
	} else {
		httpReq.Header.Set("Content-Type", contentType)
	}
	for name, value := range webhook.Headers {
		setRequestHeader(httpReq, name, value)
	}
	httpReq.Header.Set("X-CloudLadder-Route", route.ID)
	httpReq.Header.Set("X-CloudLadder-Webhook", webhook.ID)
	signWebhook(httpReq.Header, webhook.SigningSecretEnv, payload)

	httpResp, err := e.httpClient.Do(httpReq)
	if err != nil {
		return WebhookDelivery{ID: webhook.ID, Mode: webhook.Mode, Status: "failed", Error: err.Error(), TargetURL: targetURL}
	}
	defer httpResp.Body.Close()
	_, _ = io.Copy(io.Discard, httpResp.Body)
	status := "delivered"
	if httpResp.StatusCode >= 400 {
		status = "failed"
	}
	return WebhookDelivery{
		ID:         webhook.ID,
		Mode:       webhook.Mode,
		Status:     status,
		StatusCode: httpResp.StatusCode,
		TargetURL:  targetURL,
	}
}

func evalRouteCondition(_ context.Context, route Route, req Request) (bool, error) {
	return rules.Eval(route.Condition, toRuleRequest(req), nil)
}

func toRuleRequest(req Request) rules.Request {
	return rules.Request{
		RequestID:  req.RequestID,
		Caller:     req.Caller,
		RouteID:    req.RouteID,
		Method:     req.Method,
		Path:       req.Path,
		Query:      req.Query,
		Headers:    req.Headers,
		Attributes: req.Attributes,
	}
}

func (e *Engine) recordAudit(
	ctx context.Context,
	req Request,
	operation string,
	upstreamURL string,
	statusCode int,
	start time.Time,
	err error,
	responseBodyBytes int,
	webhookCount int,
) {
	if e.auditor == nil {
		return
	}
	errorMessage := ""
	if err != nil {
		errorMessage = err.Error()
	}
	e.auditor.Record(ctx, audit.Event{
		Timestamp:         start,
		RequestID:         req.RequestID,
		Caller:            req.Caller,
		Operation:         operation,
		Method:            req.Method,
		Path:              req.Path,
		Query:             req.Query,
		UpstreamURL:       upstreamURL,
		StatusCode:        statusCode,
		Duration:          time.Since(start),
		Error:             errorMessage,
		RequestBodyBytes:  len(req.Body),
		RequestBodySHA256: audit.BodySHA256(req.Body),
		ResponseBodyBytes: responseBodyBytes,
		WebhookCount:      webhookCount,
	})
}

func webhookPayload(route Route, webhook Webhook, req Request, resp Response) ([]byte, string, error) {
	if webhook.ForwardOriginal {
		return req.Body, firstContentType(req.Headers), nil
	}
	event := map[string]any{
		"route_id": route.ID,
		"request": map[string]any{
			"method":     req.Method,
			"path":       req.Path,
			"query":      req.Query,
			"headers":    req.Headers,
			"attributes": req.Attributes,
		},
		"response": map[string]any{
			"status_code":  resp.StatusCode,
			"headers":      resp.Headers,
			"upstream_url": resp.UpstreamURL,
		},
	}
	if webhook.IncludeRequestBody {
		event["request"].(map[string]any)["body"] = string(req.Body)
	}
	if webhook.IncludeResponseBody {
		event["response"].(map[string]any)["body"] = string(resp.Body)
	}
	payload, err := json.Marshal(event)
	return payload, "application/json", err
}

func webhookTargetURL(webhook Webhook, req Request) string {
	if !webhook.ForwardOriginal {
		return webhook.URL
	}
	target, err := joinURL(webhook.URL, req.Path, req.Query)
	if err != nil {
		return webhook.URL
	}
	return target
}

func joinURL(baseURL string, path string, rawQuery string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	escapedPath := strings.TrimRight(parsed.EscapedPath(), "/") + "/" + strings.TrimLeft(path, "/")
	unescapedPath, err := url.PathUnescape(escapedPath)
	if err != nil {
		return "", err
	}
	parsed.Path = unescapedPath
	parsed.RawPath = escapedPath
	parsed.RawQuery = rawQuery
	return parsed.String(), nil
}

func normalizeMethods(methods []string) ([]string, error) {
	out := make([]string, 0, len(methods))
	for _, method := range methods {
		method = strings.ToUpper(strings.TrimSpace(method))
		if method == "" {
			continue
		}
		if !isSupportedHTTPMethod(method) {
			return nil, fmt.Errorf("%w: %s", ErrInvalidMethod, method)
		}
		out = append(out, method)
	}
	return out, nil
}

func methodAllowed(allowed []string, method string) bool {
	return len(allowed) == 0 || slices.Contains(allowed, strings.ToUpper(method))
}

func isSupportedHTTPMethod(method string) bool {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case http.MethodConnect,
		http.MethodDelete,
		http.MethodGet,
		http.MethodHead,
		http.MethodOptions,
		http.MethodPatch,
		http.MethodPost,
		http.MethodPut,
		http.MethodTrace:
		return true
	default:
		return false
	}
}

func readLimited(reader io.Reader, maxBytes int64) ([]byte, error) {
	limited := io.LimitReader(reader, maxBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, ErrBodyTooLarge
	}
	return body, nil
}

func newTransport(cfg config.TransportConfig) (*http.Transport, error) {
	if cfg.MaxIdleConns <= 0 {
		cfg.MaxIdleConns = 100
	}
	if cfg.MaxIdleConnsPerHost <= 0 {
		cfg.MaxIdleConnsPerHost = 20
	}
	idleConnTimeout, err := config.ParseDuration(cfg.IdleConnTimeout, 90*time.Second)
	if err != nil {
		return nil, err
	}
	responseHeaderTimeout, err := config.ParseDuration(cfg.ResponseHeaderTimeout, 30*time.Second)
	if err != nil {
		return nil, err
	}
	tlsHandshakeTimeout, err := config.ParseDuration(cfg.TLSHandshakeTimeout, 10*time.Second)
	if err != nil {
		return nil, err
	}
	expectContinueTimeout, err := config.ParseDuration(cfg.ExpectContinueTimeout, time.Second)
	if err != nil {
		return nil, err
	}
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          cfg.MaxIdleConns,
		MaxIdleConnsPerHost:   cfg.MaxIdleConnsPerHost,
		IdleConnTimeout:       idleConnTimeout,
		ResponseHeaderTimeout: responseHeaderTimeout,
		TLSHandshakeTimeout:   tlsHandshakeTimeout,
		ExpectContinueTimeout: expectContinueTimeout,
	}, nil
}

func copyHeaders(dst http.Header, src http.Header) {
	for name, values := range src {
		if isHopByHopHeader(name) {
			continue
		}
		for _, value := range values {
			dst.Add(name, value)
		}
	}
}

var signedTunnelControlHeaders = []string{
	"X-CloudLadder-Caller",
	"X-CloudLadder-Timestamp",
	"X-CloudLadder-Signature",
	"X-CloudLadder-Signed-Host",
	"X-CloudLadder-Route",
	"X-CloudLadder-Request-ID",
	"X-Caller",
	"X-Service-Name",
}

func prepareSignedTunnelRequest(httpReq *http.Request, req Request, route Route) error {
	trustedHost := strings.TrimSpace(route.Upstream.TrustedHost)
	if trustedHost == "" {
		return fmt.Errorf("route %q signed_http_tunnel missing trusted host", route.ID)
	}
	signedHost := strings.TrimSpace(headerValue(req.Headers, "X-CloudLadder-Signed-Host"))
	if signedHost == "" {
		return fmt.Errorf("%w: missing X-CloudLadder-Signed-Host", ErrSignedHostMismatch)
	}
	expected, err := normalizeSignedHost(trustedHost, route.Upstream.TrustedScheme)
	if err != nil {
		return fmt.Errorf("route %q trusted host: %w", route.ID, err)
	}
	actual, err := normalizeSignedHost(signedHost, route.Upstream.TrustedScheme)
	if err != nil {
		return fmt.Errorf("route %q signed host: %w", route.ID, err)
	}
	if actual != expected {
		return fmt.Errorf("%w: got %q want %q", ErrSignedHostMismatch, signedHost, trustedHost)
	}
	for _, name := range signedTunnelControlHeaders {
		deleteHeader(httpReq.Header, name)
	}
	deleteHeader(httpReq.Header, "Host")
	setRequestHeader(httpReq, "Host", trustedHost)
	return nil
}

func headerValue(headers http.Header, name string) string {
	if value := strings.TrimSpace(headers.Get(name)); value != "" {
		return value
	}
	for key, values := range headers {
		if !strings.EqualFold(key, name) {
			continue
		}
		for _, value := range values {
			if strings.TrimSpace(value) != "" {
				return value
			}
		}
	}
	return ""
}

func deleteHeader(headers http.Header, name string) {
	headers.Del(name)
	for key := range headers {
		if strings.EqualFold(key, name) {
			delete(headers, key)
		}
	}
}

func signedTunnelTrustedHost(upstream config.UpstreamConfig) (string, string) {
	scheme := strings.TrimSpace(upstream.Scheme)
	if strings.TrimSpace(upstream.BaseURL) != "" {
		if parsed, err := url.Parse(upstream.BaseURL); err == nil {
			if scheme == "" {
				scheme = parsed.Scheme
			}
		}
	}
	for key, value := range upstream.Headers {
		if strings.EqualFold(key, "Host") && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value), defaultScheme(scheme)
		}
	}
	if strings.TrimSpace(upstream.BaseURL) == "" {
		return "", defaultScheme(scheme)
	}
	parsed, err := url.Parse(upstream.BaseURL)
	if err != nil {
		return "", defaultScheme(scheme)
	}
	return parsed.Host, defaultScheme(scheme)
}

func defaultScheme(scheme string) string {
	scheme = strings.ToLower(strings.TrimSpace(scheme))
	if scheme == "" {
		return "http"
	}
	return scheme
}

func normalizeSignedHost(host string, scheme string) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return "", errors.New("empty host")
	}
	if strings.Contains(host, "://") {
		parsed, err := url.Parse(host)
		if err != nil {
			return "", err
		}
		host = parsed.Host
	}
	if host == "" {
		return "", errors.New("empty host")
	}
	lower := strings.ToLower(host)
	name, port, err := net.SplitHostPort(lower)
	if err != nil {
		return lower, nil
	}
	scheme = defaultScheme(scheme)
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		return name, nil
	}
	return net.JoinHostPort(name, port), nil
}

func setRequestHeader(req *http.Request, name string, value string) {
	if strings.EqualFold(name, "Host") {
		req.Host = value
		return
	}
	req.Header.Set(name, value)
}

func cloneHeader(src http.Header) http.Header {
	dst := make(http.Header, len(src))
	copyHeaders(dst, src)
	return dst
}

func cloneStringMap(src map[string]string) map[string]string {
	if len(src) == 0 {
		return nil
	}
	dst := make(map[string]string, len(src))
	for key, value := range src {
		dst[key] = value
	}
	return dst
}

func firstContentType(headers http.Header) string {
	if value := headers.Get("Content-Type"); value != "" {
		return value
	}
	return "application/octet-stream"
}

func signWebhook(headers http.Header, envName string, payload []byte) {
	if envName == "" {
		return
	}
	secret := strings.TrimSpace(os.Getenv(envName))
	if secret == "" {
		return
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(payload)
	headers.Set("X-CloudLadder-Signature-SHA256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
}

func ensureRequestID(requestID string, headers http.Header) string {
	requestID = strings.TrimSpace(requestID)
	if requestID != "" {
		return requestID
	}
	for _, name := range []string{"X-Request-ID", "X-CloudLadder-Request-ID", "Traceparent"} {
		if value := strings.TrimSpace(headers.Get(name)); value != "" {
			return value
		}
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("clg-%d", time.Now().UnixNano())
	}
	return "clg-" + hex.EncodeToString(raw[:])
}

func ensureCaller(caller string, attrs map[string]string, headers http.Header) string {
	caller = strings.TrimSpace(caller)
	if caller != "" {
		return caller
	}
	for _, key := range []string{"caller", "service", "client"} {
		if value := strings.TrimSpace(attrs[key]); value != "" {
			return value
		}
	}
	for _, name := range []string{"X-CloudLadder-Caller", "X-Caller", "X-Service-Name"} {
		if value := strings.TrimSpace(headers.Get(name)); value != "" {
			return value
		}
	}
	return "unknown"
}

func isHopByHopHeader(name string) bool {
	switch strings.ToLower(name) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}
