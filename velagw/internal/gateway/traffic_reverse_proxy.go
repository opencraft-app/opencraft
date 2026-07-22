package gateway

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

type trafficProxyPlanContextKey struct{}

type trafficProxyPlan struct {
	target      *url.URL
	transport   http.RoundTripper
	upstreamKey string
	platformKey string
	replayBody  []byte
	replayable  bool
	accessLog   *AccessLog

	fallbackAttempted       bool
	fallbackRoundTripFailed bool
}

func newTrafficReverseProxy() *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			plan := trafficProxyPlanFromRequest(request.In)
			request.SetURL(plan.target)
			request.SetXForwarded()
			request.Out.Host = plan.target.Host
			request.Out.Header.Set("Authorization", "Bearer "+plan.upstreamKey)
		},
		Transport: trafficProxyRoundTripper{},
		ModifyResponse: func(response *http.Response) error {
			plan := trafficProxyPlanFromRequest(response.Request)
			plan.accessLog.Status = response.StatusCode
			plan.accessLog.UpstreamStatus = response.StatusCode
			plan.accessLog.Streaming = isEventStream(response.Header.Get("Content-Type"))
			if response.StatusCode >= http.StatusBadRequest {
				plan.accessLog.ErrorType = upstreamStatusErrorType(response.StatusCode)
			} else if plan.fallbackAttempted {
				plan.accessLog.ErrorType = "byok_platform_fallback"
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			plan := trafficProxyPlanFromRequest(r)
			plan.accessLog.Status = http.StatusBadGateway
			if plan.fallbackRoundTripFailed {
				plan.accessLog.ErrorType = "platform_fallback_roundtrip_error"
			} else {
				plan.accessLog.ErrorType = "upstream_roundtrip_error"
			}
			http.Error(w, err.Error(), http.StatusBadGateway)
		},
		ErrorLog: defaultAccessLogger,
	}
}

type trafficProxyRoundTripper struct{}

func (trafficProxyRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	plan := trafficProxyPlanFromRequest(request)
	if plan.transport == nil {
		return nil, fmt.Errorf("traffic transport unavailable")
	}
	response, err := plan.transport.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	attachResponseRequest(response, request)
	if !plan.replayable || !shouldFallbackTrafficStatus(response.StatusCode) {
		return observeTrafficResponseBody(response, plan), nil
	}

	plan.fallbackAttempted = true
	_ = response.Body.Close()
	retry := request.Clone(request.Context())
	retry.Header = request.Header.Clone()
	retry.Header.Set("Authorization", "Bearer "+plan.platformKey)
	setReplayBody(retry, plan.replayBody)
	response, err = plan.transport.RoundTrip(retry)
	if err != nil {
		plan.fallbackRoundTripFailed = true
		return nil, err
	}
	attachResponseRequest(response, retry)
	return observeTrafficResponseBody(response, plan), nil
}

func trafficProxyPlanFromRequest(request *http.Request) *trafficProxyPlan {
	if request == nil {
		panic("traffic reverse proxy request is nil")
	}
	plan, ok := request.Context().Value(trafficProxyPlanContextKey{}).(*trafficProxyPlan)
	if !ok || plan == nil || plan.target == nil || plan.accessLog == nil {
		panic("traffic reverse proxy plan is missing")
	}
	return plan
}

func attachResponseRequest(response *http.Response, request *http.Request) {
	if response != nil && response.Request == nil {
		response.Request = request
	}
}

type observedTrafficResponseBody struct {
	io.ReadCloser
	request   *http.Request
	accessLog *AccessLog
}

func (b *observedTrafficResponseBody) Read(buffer []byte) (int, error) {
	n, err := b.ReadCloser.Read(buffer)
	if err != nil &&
		!errors.Is(err, io.EOF) &&
		!errors.Is(err, context.Canceled) &&
		b.request.Context().Err() == nil {
		b.accessLog.ErrorType = "upstream_read_error"
	}
	return n, err
}

func observeTrafficResponseBody(response *http.Response, plan *trafficProxyPlan) *http.Response {
	if response != nil && response.Body != nil {
		response.Body = &observedTrafficResponseBody{
			ReadCloser: response.Body,
			request:    response.Request,
			accessLog:  plan.accessLog,
		}
	}
	return response
}

func setReplayBody(request *http.Request, body []byte) {
	request.Body = io.NopCloser(bytes.NewReader(body))
	request.ContentLength = int64(len(body))
	request.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(body)), nil
	}
}

func shouldFallbackTrafficStatus(statusCode int) bool {
	return statusCode == http.StatusUnauthorized ||
		statusCode == http.StatusForbidden ||
		statusCode == http.StatusTooManyRequests ||
		statusCode >= http.StatusInternalServerError
}

func isEventStream(contentType string) bool {
	return strings.Contains(strings.ToLower(contentType), "text/event-stream")
}
