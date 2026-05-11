package clientauth

import (
	"net/http"
	"time"

	gatewayv1 "github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
)

const (
	HeaderCaller    = "X-CloudLadder-Caller"
	HeaderTimestamp = "X-CloudLadder-Timestamp"
	HeaderSignature = "X-CloudLadder-Signature"
)

type HTTPRequest struct {
	Caller  string
	RouteID string
	Method  string
	Path    string
	Query   string
	Body    []byte
}

func SignProxyRequest(secret string, req *gatewayv1.ProxyRequest, now time.Time) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	req.Timestamp = now.UTC().Format(time.RFC3339)
	req.Signature = auth.Sign(secret, auth.Request{
		Caller:    req.GetCaller(),
		RouteID:   req.GetRouteId(),
		Method:    req.GetMethod(),
		Path:      req.GetPath(),
		Query:     req.GetQuery(),
		Body:      req.GetBody(),
		Timestamp: req.GetTimestamp(),
	})
}

func SignHTTPHeaders(secret string, headers http.Header, req HTTPRequest, now time.Time) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	timestamp := now.UTC().Format(time.RFC3339)
	headers.Set(HeaderCaller, req.Caller)
	headers.Set(HeaderTimestamp, timestamp)
	headers.Set(HeaderSignature, auth.Sign(secret, auth.Request{
		Caller:    req.Caller,
		RouteID:   req.RouteID,
		Method:    req.Method,
		Path:      req.Path,
		Query:     req.Query,
		Body:      req.Body,
		Timestamp: timestamp,
	}))
}
