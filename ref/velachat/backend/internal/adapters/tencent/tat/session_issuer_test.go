package tat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	tencenttatport "chatserver/internal/ports/tencenttat"
)

func TestHTTPSessionIssuerSendsExactTargetAndMapsBootstrap(t *testing.T) {
	var captured struct {
		authorization string
		path          string
		body          map[string]any
	}
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		captured.authorization = request.Header.Get("Authorization")
		captured.path = request.URL.Path
		if err := json.NewDecoder(request.Body).Decode(&captured.body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{
			"sessionId":"session-test",
			"wsUrl":"wss://terminal.example.test/connect",
			"expiresAt":"2026-07-30T22:05:00Z",
			"ownerUin":"100000000001",
			"loginUin":"100000000002",
			"appId":1250000000,
			"instanceId":"rins-test0001",
			"cols":120,
			"rows":32,
			"timeoutSeconds":3600
		}`)
	}))
	t.Cleanup(server.Close)
	issuer, err := NewHTTPSessionIssuer(SessionIssuerConfig{
		BaseURL:      server.URL,
		ServiceToken: "test-service-token",
		HTTPClient:   server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := issuer.Issue(
		context.Background(),
		tencenttatport.TerminalTarget{
			ComputerID:   adapterOperationID,
			Region:       "ap-beijing",
			InstanceKind: "managed",
			InstanceID:   "rins-test0001",
			OS:           tencenttatport.OSLinux,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if captured.authorization != "Bearer test-service-token" ||
		captured.path != "/v1/tat/terminal-sessions" ||
		captured.body["computerId"] != adapterOperationID ||
		captured.body["region"] != "ap-beijing" ||
		captured.body["instanceId"] != "rins-test0001" ||
		captured.body["instanceKind"] != "managed" ||
		captured.body["osType"] != "linux" {
		t.Fatalf("captured = %#v", captured)
	}
	if session.OwnerUIN != "100000000001" ||
		session.OwnerUIN == "100000000002" ||
		session.SessionID != "session-test" ||
		session.InstanceID != "rins-test0001" ||
		session.Cols != 120 ||
		session.Rows != 32 ||
		session.MaxIdleSeconds != 3600 {
		t.Fatalf("session = %#v", session)
	}
}

func TestHTTPSessionIssuerRejectsRedirectAndInvalidResponseWithoutLeaks(
	t *testing.T,
) {
	redirect := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		http.Redirect(writer, request, "/leak", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirect.Close)
	issuer, err := NewHTTPSessionIssuer(SessionIssuerConfig{
		BaseURL:      redirect.URL,
		ServiceToken: "secret-service-token",
		HTTPClient:   redirect.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = issuer.Issue(context.Background(), tencenttatport.TerminalTarget{
		ComputerID: adapterOperationID, Region: "ap-beijing",
		InstanceKind: "managed", InstanceID: "rins-test0001",
		OS: tencenttatport.OSLinux,
	})
	if err == nil {
		t.Fatal("redirect unexpectedly succeeded")
	}
	message := err.Error()
	if strings.Contains(message, "secret-service-token") ||
		strings.Contains(message, redirect.URL) {
		t.Fatalf("error leaked sensitive config: %q", message)
	}
}

func TestHTTPSessionIssuerRejectsUnsafeConfig(t *testing.T) {
	for _, config := range []SessionIssuerConfig{
		{},
		{BaseURL: "https://issuer.example.test", ServiceToken: "short"},
		{
			BaseURL:      "http://issuer.example.test",
			ServiceToken: "valid-service-token",
			HTTPClient:   &http.Client{Timeout: time.Second},
		},
	} {
		if _, err := NewHTTPSessionIssuer(config); err == nil {
			t.Fatalf("NewHTTPSessionIssuer(%#v) unexpectedly succeeded", config)
		}
	}
}
