package clientauth

import (
	"net/http"
	"time"

	gatewayv1 "github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1"
	"github.com/openclaw/openclaw/mono/shared/cloudladdertransport"
)

const (
	HeaderCaller    = cloudladdertransport.HeaderCaller
	HeaderTimestamp = cloudladdertransport.HeaderTimestamp
	HeaderSignature = cloudladdertransport.HeaderSignature
)

type HTTPRequest = cloudladdertransport.Request

func SignProxyRequest(secret string, req *gatewayv1.ProxyRequest, now time.Time) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	req.Timestamp = now.UTC().Format(time.RFC3339)
	req.Signature = cloudladdertransport.Sign(secret, cloudladdertransport.Request{
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
	cloudladdertransport.SignHTTPHeaders(secret, headers, req, now)
}
