package httptransport

import (
	"context"
	"errors"
	stdhttp "net/http"
	"net/http/httptest"
	"testing"
)

func TestLiveness不依赖外部服务(t *testing.T) {
	recorder := httptest.NewRecorder()
	NewLivenessHandler().ServeHTTP(recorder, httptest.NewRequest(stdhttp.MethodGet, "/healthz", nil))
	if recorder.Code != stdhttp.StatusOK || recorder.Body.String() != "ok\n" {
		t.Fatalf("liveness = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestReadiness只暴露稳定状态不泄漏底层错误(t *testing.T) {
	handler, err := NewReadinessHandler(func(context.Context) error {
		return errors.New("dsn-with-secret-password")
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(stdhttp.MethodGet, "/readyz", nil))
	if recorder.Code != stdhttp.StatusServiceUnavailable || recorder.Body.String() != "not ready\n" {
		t.Fatalf("readiness = %d %q", recorder.Code, recorder.Body.String())
	}
}

func TestReadiness通过时返回200(t *testing.T) {
	handler, err := NewReadinessHandler(func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(stdhttp.MethodGet, "/readyz", nil))
	if recorder.Code != stdhttp.StatusOK || recorder.Body.String() != "ready\n" {
		t.Fatalf("readiness = %d %q", recorder.Code, recorder.Body.String())
	}
}
