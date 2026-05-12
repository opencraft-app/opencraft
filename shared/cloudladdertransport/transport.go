package cloudladdertransport

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Options struct {
	GatewayBaseURL string
	RouteID        string
	Caller         string
	Secret         string
	Base           http.RoundTripper
	Now            func() time.Time
}

type Transport struct {
	gatewayBaseURL *url.URL
	routeID        string
	caller         string
	secret         string
	base           http.RoundTripper
	now            func() time.Time
}

func New(opts Options) (*Transport, error) {
	gatewayBaseURL, err := url.Parse(strings.TrimRight(opts.GatewayBaseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("gateway base url: %w", err)
	}
	if gatewayBaseURL.Scheme == "" || gatewayBaseURL.Host == "" {
		return nil, errors.New("gateway base url must include scheme and host")
	}
	if strings.TrimSpace(opts.RouteID) == "" {
		return nil, errors.New("route id is required")
	}
	if strings.TrimSpace(opts.Caller) == "" {
		return nil, errors.New("caller is required")
	}
	if opts.Secret == "" {
		return nil, errors.New("secret is required")
	}
	base := opts.Base
	if base == nil {
		base = http.DefaultTransport
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Transport{
		gatewayBaseURL: gatewayBaseURL,
		routeID:        opts.RouteID,
		caller:         opts.Caller,
		secret:         opts.Secret,
		base:           base,
		now:            now,
	}, nil
}

func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req == nil {
		return nil, errors.New("request is required")
	}
	if req.URL == nil {
		return nil, errors.New("request URL is required")
	}
	body, err := snapshotBody(req)
	if err != nil {
		return nil, err
	}
	originalPath := canonicalPath(req.URL)
	originalHost := req.Host
	if originalHost == "" {
		originalHost = req.URL.Host
	}
	if strings.TrimSpace(originalHost) == "" {
		return nil, errors.New("request host is required")
	}

	out := req.Clone(req.Context())
	out.URL = t.rewriteURL(originalPath, req.URL.RawQuery)
	out.Host = ""
	out.RequestURI = ""
	if req.Body != nil {
		out.Body = io.NopCloser(bytes.NewReader(body))
		out.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(body)), nil
		}
		out.ContentLength = int64(len(body))
	}
	out.Header = req.Header.Clone()
	out.Header.Set(HeaderSignedHost, originalHost)
	SignHTTPHeaders(t.secret, out.Header, Request{
		Caller:  t.caller,
		RouteID: t.routeID,
		Method:  req.Method,
		Path:    originalPath,
		Query:   req.URL.RawQuery,
		Body:    body,
	}, t.now())
	return t.base.RoundTrip(out)
}

func (t *Transport) rewriteURL(originalPath string, rawQuery string) *url.URL {
	rewritten := *t.gatewayBaseURL
	basePath := strings.TrimRight(rewritten.EscapedPath(), "/")
	routePath := "/v1/proxy/" + url.PathEscape(t.routeID)
	escapedOriginalPath := ensureLeadingSlash(originalPath)
	escapedFullPath := basePath + routePath + escapedOriginalPath
	unescapedFullPath, err := url.PathUnescape(escapedFullPath)
	if err == nil {
		rewritten.Path = unescapedFullPath
		rewritten.RawPath = escapedFullPath
	} else {
		rewritten.Path = escapedFullPath
		rewritten.RawPath = ""
	}
	rewritten.RawQuery = rawQuery
	return &rewritten
}

func canonicalPath(u *url.URL) string {
	if u.RawPath != "" {
		return ensureLeadingSlash(u.RawPath)
	}
	if escaped := u.EscapedPath(); escaped != "" {
		return ensureLeadingSlash(escaped)
	}
	return "/"
}

func ensureLeadingSlash(path string) string {
	if strings.HasPrefix(path, "/") {
		return path
	}
	return "/" + path
}

func snapshotBody(req *http.Request) ([]byte, error) {
	if req.Body == nil {
		return nil, nil
	}
	if req.GetBody != nil {
		body, err := req.GetBody()
		if err != nil {
			return nil, fmt.Errorf("get request body: %w", err)
		}
		defer body.Close()
		return io.ReadAll(body)
	}
	body, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	_ = req.Body.Close()
	req.Body = io.NopCloser(bytes.NewReader(body))
	return body, nil
}
