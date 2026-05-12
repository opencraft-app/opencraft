package cloudladdertransport

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
)

const (
	HeaderCaller     = "X-CloudLadder-Caller"
	HeaderTimestamp  = "X-CloudLadder-Timestamp"
	HeaderSignature  = "X-CloudLadder-Signature"
	HeaderSignedHost = "X-CloudLadder-Signed-Host"
)

type Request struct {
	Caller    string
	RouteID   string
	Method    string
	Path      string
	Query     string
	Body      []byte
	Timestamp string
}

func Sign(secret string, req Request) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(CanonicalString(req)))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func CanonicalString(req Request) string {
	return strings.Join([]string{
		req.Caller,
		req.RouteID,
		strings.ToUpper(req.Method),
		req.Path,
		req.Query,
		req.Timestamp,
		BodySHA256(req.Body),
	}, "\n")
}

func BodySHA256(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func SignHTTPHeaders(secret string, headers http.Header, req Request, now time.Time) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	timestamp := now.UTC().Format(time.RFC3339)
	headers.Set(HeaderCaller, req.Caller)
	headers.Set(HeaderTimestamp, timestamp)
	headers.Set(HeaderSignature, Sign(secret, Request{
		Caller:    req.Caller,
		RouteID:   req.RouteID,
		Method:    req.Method,
		Path:      req.Path,
		Query:     req.Query,
		Body:      req.Body,
		Timestamp: timestamp,
	}))
}
