package cloudladderauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	HeaderCaller    = "X-CloudLadder-Caller"
	HeaderTimestamp = "X-CloudLadder-Timestamp"
	HeaderSignature = "X-CloudLadder-Signature"
)

const proxyPathMarker = "/v1/proxy/"

// SignProxyURLHeaders signs the exact route and upstream path consumed by
// CloudLadder's HTTP authentication middleware.
func SignProxyURLHeaders(
	secret string,
	caller string,
	headers http.Header,
	method string,
	targetURL *url.URL,
	body []byte,
	now time.Time,
) error {
	if secret == "" {
		return errors.New("cloudladder HMAC secret is empty")
	}
	caller = strings.TrimSpace(caller)
	if caller == "" {
		return errors.New("cloudladder caller is empty")
	}
	if headers == nil {
		return errors.New("cloudladder request headers are nil")
	}
	routeID, proxyPath, err := proxyRoute(targetURL)
	if err != nil {
		return err
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	timestamp := now.UTC().Format(time.RFC3339)
	canonical := strings.Join([]string{
		caller,
		routeID,
		strings.ToUpper(strings.TrimSpace(method)),
		proxyPath,
		targetURL.RawQuery,
		timestamp,
		bodySHA256(body),
	}, "\n")
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(canonical))

	headers.Set(HeaderCaller, caller)
	headers.Set(HeaderTimestamp, timestamp)
	headers.Set(HeaderSignature, "sha256="+hex.EncodeToString(mac.Sum(nil)))
	return nil
}

func proxyRoute(targetURL *url.URL) (string, string, error) {
	if targetURL == nil {
		return "", "", errors.New("cloudladder target URL is nil")
	}
	escapedPath := targetURL.EscapedPath()
	markerIndex := strings.Index(escapedPath, proxyPathMarker)
	if markerIndex < 0 {
		return "", "", fmt.Errorf("cloudladder target URL path %q does not contain %s", escapedPath, proxyPathMarker)
	}
	tail := strings.TrimPrefix(escapedPath[markerIndex:], proxyPathMarker)
	parts := strings.SplitN(tail, "/", 2)
	if len(parts) != 2 || parts[0] == "" {
		return "", "", fmt.Errorf("cloudladder target URL path %q has no route or proxy path", escapedPath)
	}
	routeID, err := url.PathUnescape(parts[0])
	if err != nil {
		return "", "", fmt.Errorf("decode cloudladder route ID: %w", err)
	}
	return routeID, "/" + parts[1], nil
}

func bodySHA256(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
