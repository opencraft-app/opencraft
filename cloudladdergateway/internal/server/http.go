package server

import (
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	gatewayv1 "github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/proxy"
)

func NewGinRouter(engine *proxy.Engine, authenticator *auth.Authenticator, maxBodyBytes int64) *gin.Engine {
	router := gin.New()
	router.Use(gin.Recovery())

	router.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	router.GET("/readyz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})
	router.Any("/v1/proxy/:route_id/*path", invokeHTTP(engine, authenticator, maxBodyBytes))
	router.Any("/v1/webhook/:route_id/*path", invokeHTTP(engine, authenticator, maxBodyBytes))
	return router
}

func invokeHTTP(engine *proxy.Engine, authenticator *auth.Authenticator, maxBodyBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		routeID := c.Param("route_id")
		if !engine.HasRoute(routeID) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		body, err := readHTTPBody(c.Request, maxBodyBytes)
		if err != nil {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
		}
		if err := authenticator.Verify(auth.RequestFromHTTP(c.Request, routeID, c.Param("path"), body)); err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}
		req := proxy.Request{
			RequestID:  firstHeader(c.Request.Header, "X-Request-ID", "X-CloudLadder-Request-ID"),
			Caller:     firstHeader(c.Request.Header, "X-CloudLadder-Caller", "X-Caller", "X-Service-Name"),
			RouteID:    routeID,
			Method:     c.Request.Method,
			Path:       c.Param("path"),
			Query:      c.Request.URL.RawQuery,
			Headers:    c.Request.Header.Clone(),
			Body:       body,
			Attributes: attributesFromHeaders(c.Request.Header),
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
