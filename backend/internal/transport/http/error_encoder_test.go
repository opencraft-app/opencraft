package httptransport

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	"chatserver/internal/apperror"
)

type safeDiagnosticError struct {
	secret    string
	code      string
	retryable bool
}

func (failure safeDiagnosticError) Error() string   { return failure.secret }
func (failure safeDiagnosticError) TATCode() string { return failure.code }
func (failure safeDiagnosticError) Retryable() bool { return failure.retryable }

type fixedRequestIDGenerator struct {
	value string
	err   error
}

func (g fixedRequestIDGenerator) New() (string, error) {
	return g.value, g.err
}

type decoratedError struct {
	err        error
	details    map[string]any
	retryAfter time.Duration
}

func (e decoratedError) Error() string {
	return "外层错误包含不安全细节: " + e.err.Error()
}

func (e decoratedError) Unwrap() error {
	return e.err
}

func (e decoratedError) PublicDetails() map[string]any {
	return e.details
}

func (e decoratedError) RetryAfter() time.Duration {
	return e.retryAfter
}

func TestErrorEncoderAlwaysReturnsRequestIDAndSafeApplicationMessage(t *testing.T) {
	cause := errors.New("SELECT secret FROM tokens: Bearer top-secret 腾讯原文")
	appErr := apperror.New("permission_denied", "没有操作权限", cause)
	err := fmt.Errorf("repository leaked SQL: %w", appErr)
	recorder := httptest.NewRecorder()
	encoder := NewErrorEncoder(fixedRequestIDGenerator{
		value: "01989c24-7540-7f12-a27b-c83243215dd1",
	})

	encoder.Write(recorder, "", err)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusForbidden)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}

	var body openapi.ErrorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not ErrorEnvelope JSON: %v", err)
	}
	if body.Error.Code != "permission_denied" {
		t.Fatalf("code = %q, want permission_denied", body.Error.Code)
	}
	if body.Error.Message != "没有操作权限" {
		t.Fatalf("message = %q, want safe application message", body.Error.Message)
	}
	if body.Error.RequestId == "" {
		t.Fatal("requestId is empty")
	}

	response := recorder.Body.String()
	for _, secret := range []string{"SELECT", "Bearer", "top-secret", "腾讯原文", "repository"} {
		if strings.Contains(response, secret) {
			t.Errorf("response leaked %q: %s", secret, response)
		}
	}
}

func TestErrorEncoderHidesUnknownErrors(t *testing.T) {
	recorder := httptest.NewRecorder()
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})

	encoder.Write(recorder, "request-2", errors.New("database password is secret"))

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
	var body openapi.ErrorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not ErrorEnvelope JSON: %v", err)
	}
	if body.Error.Code != "internal_error" {
		t.Fatalf("code = %q, want internal_error", body.Error.Code)
	}
	if body.Error.RequestId != "request-2" {
		t.Fatalf("requestId = %q, want request-2", body.Error.RequestId)
	}
	if strings.Contains(recorder.Body.String(), "password") {
		t.Fatalf("response leaked unknown error: %s", recorder.Body.String())
	}
}

func TestErrorEncoderLogsOnlySafeDiagnosticFieldsForServerFailure(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	cause := safeDiagnosticError{
		secret:    "Authorization: Bearer must-not-appear",
		code:      "terminal_target_offline",
		retryable: true,
	}
	err := apperror.New("terminal_session_unavailable", "暂时无法创建终端会话", cause)
	recorder := httptest.NewRecorder()
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})

	encoder.Write(recorder, "request-terminal-1", err)

	logged := output.String()
	for _, expected := range []string{
		"request-terminal-1",
		"terminal_session_unavailable",
		"terminal_target_offline",
		`"retryable":true`,
	} {
		if !strings.Contains(logged, expected) {
			t.Errorf("log = %q, want safe field %q", logged, expected)
		}
	}
	for _, secret := range []string{"Authorization", "Bearer", "must-not-appear"} {
		if strings.Contains(logged, secret) {
			t.Fatalf("log leaked %q: %s", secret, logged)
		}
	}
}

func TestErrorEncoderIncludesPublicDetailsAndRetryAfter(t *testing.T) {
	tests := []struct {
		name       string
		code       string
		retryAfter time.Duration
		status     int
		header     string
	}{
		{
			name:       "product rate limit",
			code:       "rate_limited",
			retryAfter: 1500 * time.Millisecond,
			status:     http.StatusTooManyRequests,
			header:     "2",
		},
		{
			name:       "Tencent rate limit",
			code:       "tencent_rate_limited",
			retryAfter: 7 * time.Second,
			status:     http.StatusServiceUnavailable,
			header:     "7",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			appErr := apperror.New(test.code, "请稍后重试", errors.New("private upstream"))
			err := decoratedError{
				err:        appErr,
				details:    map[string]any{"scope": "login"},
				retryAfter: test.retryAfter,
			}
			recorder := httptest.NewRecorder()
			encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})

			encoder.Write(recorder, "", err)

			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d", recorder.Code, test.status)
			}
			if got := recorder.Header().Get("Retry-After"); got != test.header {
				t.Fatalf("Retry-After = %q, want %q", got, test.header)
			}

			var body openapi.ErrorEnvelope
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatalf("response is not ErrorEnvelope JSON: %v", err)
			}
			if body.Error.Details == nil || (*body.Error.Details)["scope"] != "login" {
				t.Fatalf("details = %#v, want public details", body.Error.Details)
			}
			if strings.Contains(recorder.Body.String(), "private upstream") {
				t.Fatalf("response leaked cause: %s", recorder.Body.String())
			}
		})
	}
}

func TestErrorEncoderCanWriteTransportCodeWithoutLeakingCause(t *testing.T) {
	recorder := httptest.NewRecorder()
	encoder := NewErrorEncoder(fixedRequestIDGenerator{
		err: errors.New("entropy unavailable"),
	})

	encoder.WriteCode(
		recorder,
		"",
		"invalid_request",
		errors.New("Authorization: Bearer should-not-leak"),
	)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	var body openapi.ErrorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not ErrorEnvelope JSON: %v", err)
	}
	if body.Error.RequestId == "" {
		t.Fatal("requestId is empty when generator fails")
	}
	if strings.Contains(recorder.Body.String(), "Bearer") {
		t.Fatalf("response leaked cause: %s", recorder.Body.String())
	}
}
