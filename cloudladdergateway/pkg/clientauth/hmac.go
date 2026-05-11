package clientauth

import (
	"time"

	gatewayv1 "github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
)

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
