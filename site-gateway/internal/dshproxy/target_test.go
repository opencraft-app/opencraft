package dshproxy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHTTPResolverUsesOpaqueKeyAndValidatesTarget(t *testing.T) {
	const opaqueKey = "opaque key value"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Key") != opaqueKey {
			t.Errorf("request method/key = %q/%q", r.Method, r.Header.Get("Key"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"region":"ap-beijing","instance_id":"ins-test123"}}`))
	}))
	defer server.Close()
	resolver, err := NewHTTPResolver(server.URL, &http.Client{Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	target, err := resolver.Resolve(context.Background(), opaqueKey)
	if err != nil {
		t.Fatal(err)
	}
	if target.Region != "ap-beijing" || target.InstanceID != "ins-test123" {
		t.Fatalf("target = %+v", target)
	}
}

func TestHTTPResolverRejectsMissingAndInvalidTargets(t *testing.T) {
	resolver, _ := NewHTTPResolver("http://127.0.0.1", &http.Client{Timeout: time.Second})
	if _, err := resolver.Resolve(context.Background(), " "); !errors.Is(err, ErrMissingKey) {
		t.Fatalf("missing key error = %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"region":"../bad","instance_id":"127.0.0.1:22"}}`))
	}))
	defer server.Close()
	resolver, _ = NewHTTPResolver(server.URL, &http.Client{Timeout: time.Second})
	if _, err := resolver.Resolve(context.Background(), "opaque"); !errors.Is(err, ErrInvalidTarget) {
		t.Fatalf("invalid target error = %v", err)
	}
}
