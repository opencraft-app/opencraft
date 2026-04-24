package faultinject

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type stubInjector struct {
	result SGLimitResult
	err    error
	calls  int
}

func (s *stubInjector) InjectSGLimit(context.Context, SGLimitRequest) (SGLimitResult, error) {
	s.calls++
	return s.result, s.err
}

func TestHandlerRejectsUnauthorizedRequest(t *testing.T) {
	h := &Handler{
		injector: &stubInjector{},
		token:    "secret",
	}
	req := httptest.NewRequest(http.MethodPost, "/inject/sg-limit", bytes.NewBufferString(`{}`))
	rec := httptest.NewRecorder()

	h.handleInjectSGLimit(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestHandlerRunsInjectorAndReturnsJSON(t *testing.T) {
	stub := &stubInjector{
		result: SGLimitResult{
			RunID:            "run-1",
			TemplateClassID:  "tc-1",
			SKUID:            "sku-1",
			SourcePoolID:     "pool-1",
			SourcePoolPaused: true,
			AutoCleanup:      true,
		},
	}
	h := &Handler{
		injector: stub,
		token:    "secret",
	}
	req := httptest.NewRequest(http.MethodPost, "/inject/sg-limit", bytes.NewBufferString(`{"region":"ap-beijing","zone":"ap-beijing-8","vpc_id":"vpc-1","subnet_id":"subnet-1","security_groups":["sg-1"],"base_image":"img-1","instance_type":"SA9.MEDIUM2"}`))
	req.Header.Set("X-Faultinject-Token", "secret")
	rec := httptest.NewRecorder()

	h.handleInjectSGLimit(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if stub.calls != 1 {
		t.Fatalf("expected injector to be called once, got %d", stub.calls)
	}
	var got SGLimitResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if got.RunID != "run-1" || got.SourcePoolID != "pool-1" || !got.SourcePoolPaused {
		t.Fatalf("unexpected response: %+v", got)
	}
}
