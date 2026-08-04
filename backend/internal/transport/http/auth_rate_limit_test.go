package httptransport

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	ratelimitport "chatserver/internal/ports/ratelimit"
)

type recordingLimiter struct {
	request  ratelimitport.Request
	decision ratelimitport.Decision
	err      error
}

func (l *recordingLimiter) Allow(
	_ context.Context,
	request ratelimitport.Request,
) (ratelimitport.Decision, error) {
	l.request = request
	return l.decision, l.err
}

func TestAuthRateLimitUsesIPAndLoginHashWithoutConsumingBody(t *testing.T) {
	limiter := &recordingLimiter{
		decision: ratelimitport.Decision{Allowed: true},
	}
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	middleware, err := AuthRateLimitMiddleware(limiter, encoder)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"email":"Alice@Example.COM","password":"secret-123"}`)
	var downstream []byte
	handler := ClientIPMiddleware(nil)(middleware(http.HandlerFunc(func(
		_ http.ResponseWriter,
		request *http.Request,
	) {
		downstream, _ = io.ReadAll(request.Body)
	})))
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/auth/login",
		bytes.NewReader(body),
	)
	request.RemoteAddr = "192.0.2.10:54321"
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if !bytes.Equal(downstream, body) {
		t.Fatalf("downstream body = %q", downstream)
	}
	if limiter.request.OperationClass != "auth_login" ||
		len(limiter.request.Subjects) != 2 {
		t.Fatalf("rate request = %#v", limiter.request)
	}
	if limiter.request.Subjects[0].Kind() != ratelimitport.SubjectIP ||
		limiter.request.Subjects[0].Key() != "192.0.2.10" ||
		limiter.request.Subjects[1].Kind() != ratelimitport.SubjectLoginHash {
		t.Fatalf("subjects = %#v", limiter.request.Subjects)
	}
}

func TestAuthRateLimitUsesRefreshAccountPrefix(t *testing.T) {
	limiter := &recordingLimiter{
		decision: ratelimitport.Decision{Allowed: true},
	}
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	middleware, err := AuthRateLimitMiddleware(limiter, encoder)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(
		`{"refreshToken":"rt1.01989c24-7540-7f12-a27b-c83243215dd1.` +
			`01989c24-7540-7f12-a27b-c83243215dd2.` +
			`QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI"}`,
	)
	handler := ClientIPMiddleware(nil)(middleware(http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
	})))
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/auth/refresh",
		bytes.NewReader(body),
	)
	request.RemoteAddr = "192.0.2.20:54321"
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if limiter.request.OperationClass != "auth_refresh" ||
		len(limiter.request.Subjects) != 2 ||
		limiter.request.Subjects[1].Kind() != ratelimitport.SubjectAccountID {
		t.Fatalf("rate request = %#v", limiter.request)
	}
}

func TestAuthRateLimitReturnsUnified429AndRetryAfter(t *testing.T) {
	limiter := &recordingLimiter{
		decision: ratelimitport.Decision{
			Allowed:    false,
			RetryAfter: 1500 * time.Millisecond,
		},
	}
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	middleware, err := AuthRateLimitMiddleware(limiter, encoder)
	if err != nil {
		t.Fatal(err)
	}
	called := false
	handler := ClientIPMiddleware(nil)(middleware(http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
		called = true
	})))
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/auth/login",
		bytes.NewReader([]byte(`{"email":"alice@example.com"}`)),
	)
	request.RemoteAddr = "192.0.2.30:54321"
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if called {
		t.Fatal("rate-limited request reached downstream")
	}
	assertErrorEnvelope(t, recorder, http.StatusTooManyRequests, "rate_limited")
	if got := recorder.Header().Get("Retry-After"); got != "2" {
		t.Fatalf("Retry-After = %q, want 2", got)
	}
}

func TestAuthRateLimitProtectsHumanIMSessionByClientIP(t *testing.T) {
	limiter := &recordingLimiter{
		decision: ratelimitport.Decision{Allowed: true},
	}
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	middleware, err := AuthRateLimitMiddleware(limiter, encoder)
	if err != nil {
		t.Fatal(err)
	}
	handler := ClientIPMiddleware(nil)(middleware(http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
	})))
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/me/im/session",
		nil,
	)
	request.RemoteAddr = "192.0.2.40:54321"
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, request)

	if limiter.request.OperationClass != "human_im_session" ||
		len(limiter.request.Subjects) != 1 ||
		limiter.request.Subjects[0].Kind() != ratelimitport.SubjectIP {
		t.Fatalf("rate request = %#v", limiter.request)
	}
}
