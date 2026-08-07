package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	gatewayv1 "github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
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
	router := gin.New()
	router.UseEscapedPath = true
	router.UnescapePathValues = false
	router.Use(gin.Recovery())

	router.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	router.GET("/readyz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})
	router.Any("/v1/proxy/:route_id/*path", invokeHTTP(engine, authenticator, maxBodyBytes, uinRoutes))
	router.Any("/v1/webhook/:route_id/*path", invokeHTTP(engine, authenticator, maxBodyBytes, uinRoutes))
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
) gin.HandlerFunc {
	return func(c *gin.Context) {
		routeID := c.Param("route_id")
		if !engine.HasRoute(routeID) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		proxyPath := c.Param("path")

		// 入口 route 没配 uin 改派时保持原路径，不读 body、不做任何额外解析。
		rules := uinRoutes[routeID]
		if len(rules) == 0 {
			invokeResolvedHTTP(c, engine, authenticator, maxBodyBytes, routeID, proxyPath)
			return
		}

		body, err := readHTTPBody(c.Request, maxBodyBytes)
		if err != nil {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
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
	for _, rule := range rules {
		if uin == strings.TrimSpace(rule.Uin) {
			return rule.RouteID, true
		}
	}
	return "", false
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
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, proxy.ErrNoRoute) {
			status = http.StatusNotFound
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
