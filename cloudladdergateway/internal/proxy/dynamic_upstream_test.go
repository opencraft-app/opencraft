package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/audit"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
)

type dynamicCaptureAuditor struct{ events []audit.Event }

func (a *dynamicCaptureAuditor) Record(_ context.Context, event audit.Event) {
	a.events = append(a.events, event)
}

func TestInvokeWithDynamicUpstreamInheritsRoutePolicyAndUsesDynamicAuditID(t *testing.T) {
	var gotHeader, gotHost, gotAuthorization string
	dev := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("X-Callback-Policy")
		gotHost = r.Host
		gotAuthorization = r.Header.Get("Authorization")
		_, _ = w.Write([]byte("dev-ok"))
	}))
	defer dev.Close()

	auditor := &dynamicCaptureAuditor{}
	engine, err := NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID: "jifei-callback",
			Upstream: config.UpstreamConfig{
				BaseURL:        "http://127.0.0.1:9",
				Timeout:        "2s",
				AllowedMethods: []string{http.MethodPost},
				Headers:        map[string]string{"X-Callback-Policy": "inherited"},
			},
		}},
	}, WithAuditor(auditor))
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	resp, err := engine.InvokeWithDynamicUpstream(context.Background(), Request{
		RouteID: "jifei-callback", Method: http.MethodPost, Path: "/trade/jifei/callback",
	}, "jifei-callback-uin-450860000013", DynamicUpstream{
		BaseURL: dev.URL, Host: "uin-450860000013.tunnel.internal", Authorization: "Bearer per-route-test-token",
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if string(resp.Body) != "dev-ok" || gotHeader != "inherited" {
		t.Fatalf("response=%q inherited header=%q", resp.Body, gotHeader)
	}
	if gotHost != "uin-450860000013.tunnel.internal" || gotAuthorization != "Bearer per-route-test-token" {
		t.Fatalf("host=%q authorization=%q", gotHost, gotAuthorization)
	}
	if len(auditor.events) != 1 || auditor.events[0].Operation != "jifei-callback-uin-450860000013" {
		t.Fatalf("audit events = %+v", auditor.events)
	}
	auditJSON, err := json.Marshal(auditor.events)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(auditJSON), "per-route-test-token") {
		t.Fatalf("dynamic authorization leaked into audit: %s", auditJSON)
	}
}

func TestInvokeWithDynamicUpstreamRejectsURLComponentsAndInvalidHost(t *testing.T) {
	engine, err := NewEngine(config.Config{
		MaxBodyBytes: config.DefaultMaxBodyBytes,
		Routes: []config.RouteConfig{{
			ID:       "jifei-callback",
			Upstream: config.UpstreamConfig{BaseURL: "http://127.0.0.1:9", AllowedMethods: []string{http.MethodPost}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, dynamic := range []DynamicUpstream{
		{BaseURL: "http://user@127.0.0.1:9"},
		{BaseURL: "http://127.0.0.1:9/private"},
		{BaseURL: "http://127.0.0.1:9?next=private"},
		{BaseURL: "http://127.0.0.1:9", Host: "uin.example\r\nX-Evil: true"},
		{BaseURL: "http://127.0.0.1:9", Host: "uin example"},
	} {
		if _, err := engine.InvokeWithDynamicUpstream(context.Background(), Request{
			RouteID: "jifei-callback", Method: http.MethodPost, Path: "/trade/jifei/callback",
		}, "jifei-callback-uin-450860000013", dynamic); err == nil {
			t.Fatalf("invalid dynamic upstream accepted: %+v", dynamic)
		}
	}
}
