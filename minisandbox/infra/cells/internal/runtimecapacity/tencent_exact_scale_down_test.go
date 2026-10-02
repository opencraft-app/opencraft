package runtimecapacity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type fakeTencentCredentialProvider struct {
	credential TencentCredential
	err        error
	calls      int
}

func TestTencentExactScaleDownUsesVPCInternalEndpoint(t *testing.T) {
	if tencentTKEHost != "tke.internal.tencentcloudapi.com" {
		t.Fatalf("default endpoint = %q", tencentTKEHost)
	}
}

func (p *fakeTencentCredentialProvider) GetCredential() (TencentCredential, error) {
	p.calls++
	return p.credential, p.err
}

func TestTencentExactScaleDownAuthorizationMatchesTC3Fixture(t *testing.T) {
	now := time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
	client := &TencentExactScaleDownClient{SecretID: "test-id", SecretKey: "test-secret"}
	endpoint, err := url.Parse("https://example.invalid")
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"ClusterId":"cls-test","MachineNames":["np-runtime0-4"],"EnableScaleDown":true,"InstanceDeleteMode":"terminate"}`)
	want := "TC3-HMAC-SHA256 Credential=test-id/2026-09-03/tke/tc3_request, " +
		"SignedHeaders=content-type;host;x-tc-action, " +
		"Signature=949e4834ae9adf4533068560fc8ae897b0e83833a15f1cfe0976373492d53db6"
	if got := client.authorization(endpoint, payload, now); got != want {
		t.Fatalf("TC3 authorization mismatch\ngot:  %s\nwant: %s", got, want)
	}
}

func TestTencentExactScaleDownSendsOneExactMachineAndTerminates(t *testing.T) {
	credentials := &fakeTencentCredentialProvider{credential: TencentCredential{
		SecretID: "test-id", SecretKey: "test-secret", Token: "temporary-token",
	}}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/" {
			t.Fatalf("unexpected request target: %s %s", request.Method, request.URL)
		}
		for name, want := range map[string]string{
			"Content-Type":   "application/json; charset=utf-8",
			"X-TC-Action":    tencentTKEAction,
			"X-TC-Version":   tencentTKEVersion,
			"X-TC-Region":    "ap-beijing",
			"X-TC-Timestamp": "1788436800",
			"X-TC-Token":     "temporary-token",
		} {
			if got := request.Header.Get(name); got != want {
				t.Fatalf("header %s=%q, want %q", name, got, want)
			}
		}
		if !strings.HasPrefix(request.Header.Get("Authorization"), "TC3-HMAC-SHA256 Credential=test-id/") {
			t.Fatalf("missing TC3 authorization: %q", request.Header.Get("Authorization"))
		}
		var payload struct {
			ClusterID          string   `json:"ClusterId"`
			MachineNames       []string `json:"MachineNames"`
			EnableScaleDown    bool     `json:"EnableScaleDown"`
			InstanceDeleteMode string   `json:"InstanceDeleteMode"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload.ClusterID != "cls-test" || len(payload.MachineNames) != 1 ||
			payload.MachineNames[0] != "np-runtime0-4" || !payload.EnableScaleDown ||
			payload.InstanceDeleteMode != "terminate" {
			t.Fatalf("unsafe Tencent payload: %#v", payload)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"Response":{"RequestId":"request-exact-1"}}`))
	}))
	t.Cleanup(server.Close)
	client := &TencentExactScaleDownClient{
		Credentials: credentials,
		Region:      "ap-beijing", ClusterID: "cls-test", Endpoint: server.URL,
		HTTPClient: server.Client(), Now: func() time.Time {
			return time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)
		},
	}
	response, err := client.DeleteMachineAndScaleDown(context.Background(), exactScaleDownFixture())
	if err != nil {
		t.Fatal(err)
	}
	if response.RequestID != "request-exact-1" {
		t.Fatalf("request ID = %q", response.RequestID)
	}
	if credentials.calls != 1 {
		t.Fatalf("credential provider calls = %d, want 1", credentials.calls)
	}
}

func TestTencentExactScaleDownFailsBeforeHTTPWhenOIDCCredentialFails(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	defer server.Close()
	for name, provider := range map[string]*fakeTencentCredentialProvider{
		"sts failure":   {err: errors.New("STS unavailable")},
		"missing token": {credential: TencentCredential{SecretID: "id", SecretKey: "key"}},
	} {
		t.Run(name, func(t *testing.T) {
			client := &TencentExactScaleDownClient{
				Credentials: provider, Region: "ap-beijing", ClusterID: "cls-test",
				Endpoint: server.URL, HTTPClient: server.Client(),
			}
			if _, err := client.DeleteMachineAndScaleDown(context.Background(), exactScaleDownFixture()); err == nil {
				t.Fatal("invalid OIDC credential did not fail closed")
			}
		})
	}
	if called {
		t.Fatal("provider API was called without a complete short-lived credential")
	}
}

func TestTencentExactScaleDownFailsClosedOnMalformedAndAPIError(t *testing.T) {
	for name, body := range map[string]string{
		"malformed": `{`,
		"api error": `{"Response":{"Error":{"Code":"UnauthorizedOperation","Message":"denied"},"RequestId":"request-1"}}`,
		"empty ID":  `{"Response":{}}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				_, _ = response.Write([]byte(body))
			}))
			defer server.Close()
			client := &TencentExactScaleDownClient{
				SecretID: "id", SecretKey: "key", Region: "ap-beijing", ClusterID: "cls-test",
				Endpoint: server.URL, HTTPClient: server.Client(),
			}
			if _, err := client.DeleteMachineAndScaleDown(context.Background(), exactScaleDownFixture()); err == nil {
				t.Fatal("unsafe provider response did not fail closed")
			}
		})
	}
}

func exactScaleDownFixture() ExactScaleDownRequest {
	return ExactScaleDownRequest{
		ClusterID: "cls-test", MachineName: "np-runtime0-4", MachineUID: "machine-4",
		NodeName: "runtime-4", NodeUID: "node-4", MachineSetName: "np-runtime0",
		MachineSetUID: "machineset-1", FromReplicas: 4, ToReplicas: 3,
	}
}
