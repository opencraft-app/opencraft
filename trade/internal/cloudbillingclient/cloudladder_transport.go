package cloudbillingclient

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	headerCloudLadderCaller     = "X-CloudLadder-Caller"
	headerCloudLadderTimestamp  = "X-CloudLadder-Timestamp"
	headerCloudLadderSignature  = "X-CloudLadder-Signature"
	headerCloudLadderSignedHost = "X-CloudLadder-Signed-Host"
)

type cloudLadderTransportOptions struct {
	gatewayBaseURL string
	routeID        string
	caller         string
	secret         string
	base           http.RoundTripper
	now            func() time.Time
}

type cloudLadderTransport struct {
	gatewayBaseURL *url.URL
	routeID        string
	caller         string
	secret         string
	base           http.RoundTripper
	now            func() time.Time
}

type cloudLadderSignatureRequest struct {
	caller    string
	routeID   string
	method    string
	path      string
	query     string
	body      []byte
	timestamp string
}

func newCloudLadderRoundTripper(opts cloudLadderTransportOptions) (*cloudLadderTransport, error) {
	gatewayBaseURL, err := url.Parse(strings.TrimRight(opts.gatewayBaseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("gateway base url: %w", err)
	}
	if gatewayBaseURL.Scheme == "" || gatewayBaseURL.Host == "" {
		return nil, errors.New("gateway base url must include scheme and host")
	}
	if strings.TrimSpace(opts.routeID) == "" {
		return nil, errors.New("route id is required")
	}
	if strings.TrimSpace(opts.caller) == "" {
		return nil, errors.New("caller is required")
	}
	if opts.secret == "" {
		return nil, errors.New("secret is required")
	}
	base := opts.base
	if base == nil {
		base = http.DefaultTransport
	}
	now := opts.now
	if now == nil {
		now = time.Now
	}
	return &cloudLadderTransport{
		gatewayBaseURL: gatewayBaseURL,
		routeID:        opts.routeID,
		caller:         opts.caller,
		secret:         opts.secret,
		base:           base,
		now:            now,
	}, nil
}

func (t *cloudLadderTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req == nil {
		return nil, errors.New("request is required")
	}
	if req.URL == nil {
		return nil, errors.New("request URL is required")
	}
	body, err := snapshotCloudLadderBody(req)
	if err != nil {
		return nil, err
	}
	originalPath := canonicalCloudLadderPath(req.URL)
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
	out.Header.Set(headerCloudLadderSignedHost, originalHost)
	signCloudLadderHTTPHeaders(t.secret, out.Header, cloudLadderSignatureRequest{
		caller:  t.caller,
		routeID: t.routeID,
		method:  req.Method,
		path:    originalPath,
		query:   req.URL.RawQuery,
		body:    body,
	}, t.now())
	return t.base.RoundTrip(out)
}

func (t *cloudLadderTransport) rewriteURL(originalPath string, rawQuery string) *url.URL {
	rewritten := *t.gatewayBaseURL
	basePath := strings.TrimRight(rewritten.EscapedPath(), "/")
	routePath := "/v1/proxy/" + url.PathEscape(t.routeID)
	escapedOriginalPath := ensureCloudLadderLeadingSlash(originalPath)
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

func canonicalCloudLadderPath(u *url.URL) string {
	if u.RawPath != "" {
		return ensureCloudLadderLeadingSlash(u.RawPath)
	}
	if escaped := u.EscapedPath(); escaped != "" {
		return ensureCloudLadderLeadingSlash(escaped)
	}
	return "/"
}

func ensureCloudLadderLeadingSlash(path string) string {
	if strings.HasPrefix(path, "/") {
		return path
	}
	return "/" + path
}

func snapshotCloudLadderBody(req *http.Request) ([]byte, error) {
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

func signCloudLadderRequest(secret string, req cloudLadderSignatureRequest) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(canonicalCloudLadderString(req)))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func canonicalCloudLadderString(req cloudLadderSignatureRequest) string {
	return strings.Join([]string{
		req.caller,
		req.routeID,
		strings.ToUpper(req.method),
		req.path,
		req.query,
		req.timestamp,
		cloudLadderBodySHA256(req.body),
	}, "\n")
}

func cloudLadderBodySHA256(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func signCloudLadderHTTPHeaders(secret string, headers http.Header, req cloudLadderSignatureRequest, now time.Time) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	timestamp := now.UTC().Format(time.RFC3339)
	headers.Set(headerCloudLadderCaller, req.caller)
	headers.Set(headerCloudLadderTimestamp, timestamp)
	headers.Set(headerCloudLadderSignature, signCloudLadderRequest(secret, cloudLadderSignatureRequest{
		caller:    req.caller,
		routeID:   req.routeID,
		method:    req.method,
		path:      req.path,
		query:     req.query,
		body:      req.body,
		timestamp: timestamp,
	}))
}
