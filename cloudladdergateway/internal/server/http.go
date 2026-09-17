package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	gatewayv1 "github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/audit"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/devroute"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/proxy"
)

func NewGinRouter(engine *proxy.Engine, authenticator *auth.Authenticator, maxBodyBytes int64, externalRoutes ...config.ExternalRoute) *gin.Engine {
	return NewGinRouterWithUinRoutes(engine, authenticator, maxBodyBytes, nil, externalRoutes...)
}

// NewGinRouterWithUinRoutes 额外接收「按 uin 改派」的路由表。
//
// uinRoutes 的 key 是入口 route id，value 是该 route 上配置的 uin 改派规则。
// 传 nil 等价于不启用改派，与 NewGinRouter 行为一致。
func NewGinRouterWithUinRoutes(
	engine *proxy.Engine,
	authenticator *auth.Authenticator,
	maxBodyBytes int64,
	uinRoutes map[string][]config.UinRoute,
	externalRoutes ...config.ExternalRoute,
) *gin.Engine {
	return NewGinRouterWithDeveloperRoutes(engine, authenticator, maxBodyBytes, uinRoutes, DeveloperRoutes{}, externalRoutes...)
}

// DeveloperRoutes enables testing-only dynamic callback routing. RouteID is
// the configured callback route whose policy is inherited by dynamic targets.
type DeveloperRoutes struct {
	RouteID             string
	Store               devroute.Store
	Now                 func() time.Time
	Auditor             audit.Auditor
	TunnelAuthorization string
}

func NewGinRouterWithDeveloperRoutes(
	engine *proxy.Engine,
	authenticator *auth.Authenticator,
	maxBodyBytes int64,
	uinRoutes map[string][]config.UinRoute,
	developerRoutes DeveloperRoutes,
	externalRoutes ...config.ExternalRoute,
) *gin.Engine {
	router := gin.New()
	router.UseEscapedPath = true
	router.UnescapePathValues = false
	router.Use(gin.Recovery())

	router.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	router.GET("/readyz", func(c *gin.Context) {
		if developerRoutes.Store != nil {
			ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
			defer cancel()
			if err := developerRoutes.Store.Ready(ctx); err != nil {
				c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not_ready", "error": "developer route store is unavailable"})
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})
	router.Any("/v1/proxy/:route_id/*path", invokeHTTP(engine, authenticator, maxBodyBytes, uinRoutes, developerRoutes))
	router.Any("/v1/webhook/:route_id/*path", invokeHTTP(engine, authenticator, maxBodyBytes, uinRoutes, developerRoutes))
	for _, externalRoute := range externalRoutes {
		registerExternalRoute(router, externalRoute, invokeExternalHTTP(engine, authenticator, maxBodyBytes, externalRoute))
	}
	return router
}

func registerExternalRoute(router *gin.Engine, externalRoute config.ExternalRoute, handler gin.HandlerFunc) {
	if len(externalRoute.Methods) == 0 {
		router.Any(externalRoute.Path, handler)
		return
	}
	for _, method := range externalRoute.Methods {
		router.Handle(strings.ToUpper(strings.TrimSpace(method)), externalRoute.Path, handler)
	}
}

func invokeHTTP(
	engine *proxy.Engine,
	authenticator *auth.Authenticator,
	maxBodyBytes int64,
	uinRoutes map[string][]config.UinRoute,
	developerRoutes DeveloperRoutes,
) gin.HandlerFunc {
	return func(c *gin.Context) {
		routeID := c.Param("route_id")
		if !engine.HasRoute(routeID) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		proxyPath := c.Param("path")

		// 入口 route 没配静态或动态 uin 改派时保持原路径，不读 body、不做任何额外解析。
		rules := uinRoutes[routeID]
		dynamicEnabled := developerRoutes.Store != nil && routeID == strings.TrimSpace(developerRoutes.RouteID)
		if len(rules) == 0 && !dynamicEnabled {
			invokeResolvedHTTP(c, engine, authenticator, maxBodyBytes, routeID, proxyPath)
			return
		}

		body, err := readHTTPBody(c.Request, maxBodyBytes)
		if err != nil {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
		}
		if dynamicEnabled {
			if err := authenticator.Verify(auth.RequestFromHTTP(c.Request, routeID, proxyPath, body)); err != nil {
				recordDynamicRouteDecision(c, developerRoutes, routeID, "", body, http.StatusUnauthorized, "callback authentication failed", devroute.Registration{})
				c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
				return
			}
		}
		uin, hasUIN := callbackUIN(body)
		if dynamicEnabled && hasUIN {
			registration, err := developerRoutes.Store.Get(c.Request.Context(), uin)
			switch {
			case err == nil:
				now := time.Now()
				if developerRoutes.Now != nil {
					now = developerRoutes.Now()
				}
				state := registration.State(now)
				if state != devroute.StateActive {
					recordDynamicRouteDecision(c, developerRoutes, routeID, uin, body, http.StatusServiceUnavailable, "developer route registration is "+string(state), registration)
					c.JSON(http.StatusServiceUnavailable, gin.H{
						"error":  "developer route registration is unavailable",
						"status": state,
					})
					return
				}
				if registration.DeliveryMode != devroute.DeliveryModeDirect && registration.DeliveryMode != devroute.DeliveryModeDevtunnel {
					recordDynamicRouteDecision(c, developerRoutes, routeID, uin, body, http.StatusServiceUnavailable, "developer route delivery mode is invalid", registration)
					c.JSON(http.StatusServiceUnavailable, gin.H{"error": "developer route registration is unavailable"})
					return
				}
				dynamic := proxy.DynamicUpstream{BaseURL: registration.BaseURL, Host: registration.TunnelHost}
				if registration.DeliveryMode == devroute.DeliveryModeDevtunnel {
					if strings.TrimSpace(developerRoutes.TunnelAuthorization) == "" {
						recordDynamicRouteDecision(c, developerRoutes, routeID, uin, body, http.StatusServiceUnavailable, "developer tunnel authorization is unavailable", registration)
						c.JSON(http.StatusServiceUnavailable, gin.H{"error": "developer route registration is unavailable"})
						return
					}
					dynamic.Authorization = developerRoutes.TunnelAuthorization
				}
				invokeResolvedHTTPWithBodyAndDynamicAuthenticated(c, engine, routeID, proxyPath, body,
					routeID+"-uin-"+uin, dynamic)
				return
			case errors.Is(err, devroute.ErrNotFound):
				// Never registered: preserve the existing static/fallback behavior.
			default:
				// Store availability is part of the routing decision. Failing open here
				// could send a claimed UIN into the shared environment.
				recordDynamicRouteDecision(c, developerRoutes, routeID, uin, body, http.StatusServiceUnavailable, "developer route store is unavailable", devroute.Registration{})
				c.JSON(http.StatusServiceUnavailable, gin.H{"error": "developer route store is unavailable"})
				return
			}
		}
		if target, ok := resolveUinRoute(rules, body); ok {
			// 改派目标不存在时不要静默回落到兜底环境 —— 那会让这条回调发货到别人的环境，
			// 是 2026-08-05 跨环境脏数据事故的成因。宁可 404 让计费重试并暴露配置错误。
			if !engine.HasRoute(target) {
				c.JSON(http.StatusNotFound, gin.H{
					"error": fmt.Sprintf("uin route target %q is not configured", target),
				})
				return
			}
			routeID = target
		}
		if dynamicEnabled {
			invokeResolvedHTTPWithBodyAuthenticated(c, engine, routeID, proxyPath, body)
			return
		}
		invokeResolvedHTTPWithBody(c, engine, authenticator, routeID, proxyPath, body)
	}
}

// resolveUinRoute 从 CGW envelope 的 interface.para.uin 取影子账号 uin 并查改派表。
//
// 解析不出 uin（body 不是 JSON、结构不符、uin 为空）时返回 false，由调用方走入口 route
// 自身的 upstream 兜底 —— 这类请求本来就不属于任何开发者环境。
//
// uin 在协议里是带引号的字符串（PDF §公共参数），但实测 jifei 偶有发数字的情况，
// 这里两种都接。
func resolveUinRoute(rules []config.UinRoute, body []byte) (string, bool) {
	uin, ok := callbackUIN(body)
	if !ok {
		return "", false
	}
	for _, rule := range rules {
		if uin == strings.TrimSpace(rule.Uin) {
			return rule.RouteID, true
		}
	}
	return "", false
}

func callbackUIN(body []byte) (string, bool) {
	var payload struct {
		Interface struct {
			Para struct {
				Uin json.Number `json:"uin"`
			} `json:"para"`
		} `json:"interface"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", false
	}
	uin := strings.TrimSpace(payload.Interface.Para.Uin.String())
	if uin == "" {
		return "", false
	}
	return uin, true
}

func invokeExternalHTTP(engine *proxy.Engine, authenticator *auth.Authenticator, maxBodyBytes int64, externalRoute config.ExternalRoute) gin.HandlerFunc {
	upstreamPath := externalRoute.UpstreamPath
	if upstreamPath == "" {
		upstreamPath = externalRoute.Path
	}
	return func(c *gin.Context) {
		body, err := readHTTPBody(c.Request, maxBodyBytes)
		if err != nil {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
		}
		routeID, body, err := resolveExternalRoute(externalRoute, c.Request.Header, body)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		if !engine.HasRoute(routeID) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		invokeResolvedHTTPWithBody(c, engine, authenticator, routeID, upstreamPath, body)
	}
}

func invokeResolvedHTTP(c *gin.Context, engine *proxy.Engine, authenticator *auth.Authenticator, maxBodyBytes int64, routeID string, proxyPath string) {
	body, err := readHTTPBody(c.Request, maxBodyBytes)
	if err != nil {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
		return
	}
	invokeResolvedHTTPWithBody(c, engine, authenticator, routeID, proxyPath, body)
}

func invokeResolvedHTTPWithBody(c *gin.Context, engine *proxy.Engine, authenticator *auth.Authenticator, routeID string, proxyPath string, body []byte) {
	if err := authenticator.Verify(auth.RequestFromHTTP(c.Request, routeID, proxyPath, body)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	invokeResolvedHTTPWithBodyAuthenticated(c, engine, routeID, proxyPath, body)
}

func invokeResolvedHTTPWithBodyAuthenticated(c *gin.Context, engine *proxy.Engine, routeID string, proxyPath string, body []byte) {
	req := proxy.Request{
		RequestID:     firstHeader(c.Request.Header, "X-Request-ID", "X-CloudLadder-Request-ID"),
		Caller:        firstHeader(c.Request.Header, "X-CloudLadder-Caller", "X-Caller", "X-Service-Name"),
		RouteID:       routeID,
		Method:        c.Request.Method,
		Path:          proxyPath,
		Query:         c.Request.URL.RawQuery,
		OriginalHost:  c.Request.Host,
		OriginalPath:  c.Request.URL.EscapedPath(),
		OriginalQuery: c.Request.URL.RawQuery,
		Headers:       c.Request.Header.Clone(),
		Body:          body,
		Attributes:    attributesFromHeaders(c.Request.Header),
	}
	resp, err := engine.Invoke(c.Request.Context(), req)
	writeProxyResponse(c, resp, err)
}

func invokeResolvedHTTPWithBodyAndDynamicAuthenticated(
	c *gin.Context,
	engine *proxy.Engine,
	routeID string,
	proxyPath string,
	body []byte,
	operation string,
	dynamic proxy.DynamicUpstream,
) {
	req := proxy.Request{
		RequestID:     firstHeader(c.Request.Header, "X-Request-ID", "X-CloudLadder-Request-ID"),
		Caller:        firstHeader(c.Request.Header, "X-CloudLadder-Caller", "X-Caller", "X-Service-Name"),
		RouteID:       routeID,
		Method:        c.Request.Method,
		Path:          proxyPath,
		Query:         c.Request.URL.RawQuery,
		OriginalHost:  c.Request.Host,
		OriginalPath:  c.Request.URL.EscapedPath(),
		OriginalQuery: c.Request.URL.RawQuery,
		Headers:       c.Request.Header.Clone(),
		Body:          body,
		Attributes:    attributesFromHeaders(c.Request.Header),
	}
	resp, err := engine.InvokeWithDynamicUpstream(c.Request.Context(), req, operation, dynamic)
	writeProxyResponse(c, resp, err)
}

func writeProxyResponse(c *gin.Context, resp proxy.Response, err error) {
	if err != nil {
		status := http.StatusBadRequest
		switch {
		case errors.Is(err, proxy.ErrNoRoute):
			status = http.StatusNotFound
		case errors.Is(err, proxy.ErrUpstreamTimeout):
			status = http.StatusGatewayTimeout
		case errors.Is(err, proxy.ErrUpstreamUnavailable):
			status = http.StatusBadGateway
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	for name, values := range resp.Headers {
		if strings.EqualFold(name, "Content-Length") {
			continue
		}
		for _, value := range values {
			c.Writer.Header().Add(name, value)
		}
	}
	c.Writer.Header().Set("X-CloudLadder-Upstream-URL", resp.UpstreamURL)
	c.Writer.WriteHeader(resp.StatusCode)
	_, _ = c.Writer.Write(resp.Body)
}

func recordDynamicRouteDecision(
	c *gin.Context,
	developerRoutes DeveloperRoutes,
	routeID string,
	uin string,
	body []byte,
	status int,
	errorMessage string,
	registration devroute.Registration,
) {
	if developerRoutes.Auditor == nil {
		return
	}
	operation := routeID + "-dynamic-route"
	if uin != "" {
		operation += "-uin-" + uin
	}
	developerRoutes.Auditor.Record(c.Request.Context(), audit.Event{
		Timestamp:         time.Now(),
		RequestID:         firstHeader(c.Request.Header, "X-Request-ID", "X-CloudLadder-Request-ID"),
		Caller:            firstHeader(c.Request.Header, "X-CloudLadder-Caller", "X-Caller", "X-Service-Name"),
		Operation:         operation,
		Method:            c.Request.Method,
		Path:              c.Request.URL.EscapedPath(),
		Query:             c.Request.URL.RawQuery,
		UpstreamURL:       registration.BaseURL,
		StatusCode:        status,
		Error:             errorMessage,
		RequestBodyBytes:  len(body),
		RequestBodySHA256: audit.BodySHA256(body),
		DeveloperSourceIP: registration.SourceIP,
		TunnelHost:        registration.TunnelHost,
	})
}

func resolveExternalRoute(externalRoute config.ExternalRoute, headers http.Header, body []byte) (string, []byte, error) {
	for _, candidate := range externalRoute.HeaderRoutes {
		if strings.TrimSpace(headers.Get(candidate.Name)) == strings.TrimSpace(candidate.Value) {
			return candidate.RouteID, body, nil
		}
	}
	return resolveExternalAuthCodeRoute(externalRoute, body)
}

func resolveExternalAuthCodeRoute(externalRoute config.ExternalRoute, body []byte) (string, []byte, error) {
	if len(externalRoute.AuthCodeRoutes) == 0 && len(externalRoute.UserIDRoutes) == 0 && len(externalRoute.UserIDPrefixRoutes) == 0 {
		return externalRoute.RouteID, body, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return externalRoute.RouteID, body, nil
	}
	callback, ok := payload["interface"].(map[string]any)
	if !ok {
		return externalRoute.RouteID, body, nil
	}
	para, ok := callback["para"].(map[string]any)
	if !ok {
		return externalRoute.RouteID, body, nil
	}
	if callback["interfaceName"] == "qcloud.saas.checkSaaSAccountExist" {
		userID, _ := para["user_id"].(string)
		for _, candidate := range externalRoute.UserIDRoutes {
			if userID == candidate.UserID {
				return candidate.RouteID, body, nil
			}
		}
		for _, candidate := range externalRoute.UserIDPrefixRoutes {
			if strings.HasPrefix(userID, candidate.Prefix) {
				return candidate.RouteID, body, nil
			}
		}
		return externalRoute.RouteID, body, nil
	}
	if callback["interfaceName"] != "qcloud.saas.checkSaaSAuthCode" {
		return externalRoute.RouteID, body, nil
	}
	authCode, ok := para["auth_code"].(string)
	if !ok || authCode == "" {
		return externalRoute.RouteID, body, nil
	}
	for _, candidate := range externalRoute.AuthCodeRoutes {
		if strings.HasPrefix(authCode, candidate.Prefix) {
			rawCode := strings.TrimPrefix(authCode, candidate.Prefix)
			if rawCode == "" {
				return "", nil, fmt.Errorf("callback auth_code has no value after routing prefix")
			}
			para["auth_code"] = rawCode
			updatedBody, err := json.Marshal(payload)
			if err != nil {
				return "", nil, fmt.Errorf("encode callback body: %w", err)
			}
			return candidate.RouteID, updatedBody, nil
		}
	}
	if strings.Contains(authCode, ".") {
		return "", nil, fmt.Errorf("callback auth_code has an unsupported routing prefix")
	}
	return externalRoute.RouteID, body, nil
}

func firstHeader(headers http.Header, names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(headers.Get(name)); value != "" {
			return value
		}
	}
	return ""
}

func readHTTPBody(req *http.Request, maxBodyBytes int64) ([]byte, error) {
	defer req.Body.Close()
	body, err := io.ReadAll(io.LimitReader(req.Body, maxBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBodyBytes {
		return nil, proxy.ErrBodyTooLarge
	}
	return body, nil
}

func attributesFromHeaders(headers http.Header) map[string]string {
	attrs := map[string]string{}
	for name, values := range headers {
		if !strings.HasPrefix(strings.ToLower(name), "x-cloudladder-attr-") || len(values) == 0 {
			continue
		}
		key := strings.TrimPrefix(strings.ToLower(name), "x-cloudladder-attr-")
		attrs[key] = values[0]
	}
	return attrs
}

func headersFromProto(headers []*gatewayv1.Header) http.Header {
	out := http.Header{}
	for _, header := range headers {
		for _, value := range header.GetValues() {
			out.Add(header.GetName(), value)
		}
	}
	return out
}

func headersToProto(headers http.Header) []*gatewayv1.Header {
	out := make([]*gatewayv1.Header, 0, len(headers))
	for name, values := range headers {
		out = append(out, &gatewayv1.Header{Name: name, Values: append([]string(nil), values...)})
	}
	return out
}
