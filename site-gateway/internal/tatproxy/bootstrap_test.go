package tatproxy

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFederationStarterSignsAndDecodesBootstrap(t *testing.T) {
	hmacKey := []byte("0123456789abcdef0123456789abcdef")
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost || r.URL.EscapedPath() != "/auth/federation/bots/bot-1/tat/session" {
			t.Errorf("request = %s %s", r.Method, r.URL.EscapedPath())
		}
		var payload map[string]string
		if json.Unmarshal(body, &payload) != nil || payload["delegated_session"] != "delegated-1" {
			t.Errorf("body = %s", body)
		}
		bodyHash := sha256.Sum256(body)
		canonical := strings.Join([]string{
			"dsh-site-gateway", "h1", http.MethodPost, r.URL.EscapedPath(), "",
			now.Format(time.RFC3339), "request-123456789", hex.EncodeToString(bodyHash[:]),
		}, "\n")
		mac := hmac.New(sha256.New, hmacKey)
		_, _ = mac.Write([]byte(canonical))
		wantSignature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
		if r.Header.Get(headerClientID) != "dsh-site-gateway" || r.Header.Get(headerKeyID) != "h1" ||
			r.Header.Get(headerTimestamp) != now.Format(time.RFC3339) || r.Header.Get(headerRequestID) != "request-123456789" ||
			r.Header.Get(headerSignature) != wantSignature {
			t.Errorf("federation headers = %v", r.Header)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sessionId":"session-1","region":"ap-beijing","instanceId":"ins-test123","ownerUin":"10001","loginUin":"10002","appId":1250000000,"wsUrl":"wss://ap-beijing.forward.tat-tc.tencent.cn/ws","cols":120,"rows":40,"timeoutSeconds":3600}`))
	}))
	defer server.Close()
	starter, err := NewFederationStarter(FederationStarterOptions{
		BaseURL: server.URL, ClientID: "dsh-site-gateway", KeyID: "h1", HMACKey: hmacKey,
		HTTPClient: server.Client(), Clock: func() time.Time { return now }, RequestID: func() string { return "request-123456789" },
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := starter.Start(t.Context(), Target{BotID: "bot-1", DelegatedSession: "delegated-1"})
	if err != nil {
		t.Fatal(err)
	}
	if got.SessionID != "session-1" || got.InstanceID != "ins-test123" || got.OwnerUIN != "10001" || got.AppID != 1250000000 {
		t.Fatalf("bootstrap = %+v", got)
	}
}

func TestFederationStarterMapsAuthErrorsAndRejectsUntrustedWebSocket(t *testing.T) {
	hmacKey := []byte("0123456789abcdef0123456789abcdef")
	for _, tc := range []struct {
		status int
		want   error
	}{
		{status: http.StatusUnauthorized, want: ErrFederationUnauthorized},
		{status: http.StatusNotFound, want: ErrFederationNotFound},
		{status: http.StatusConflict, want: ErrFederationConflict},
		{status: http.StatusGatewayTimeout, want: ErrFederationTimeout},
	} {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(tc.status) }))
			defer server.Close()
			starter, _ := NewFederationStarter(FederationStarterOptions{BaseURL: server.URL, ClientID: "dsh", KeyID: "h1", HMACKey: hmacKey, HTTPClient: server.Client()})
			_, err := starter.Start(t.Context(), Target{BotID: "bot-1", DelegatedSession: "delegated-1"})
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"sessionId":"session-1","region":"ap-beijing","instanceId":"ins-test123","ownerUin":"10001","loginUin":"10002","appId":1250000000,"wsUrl":"wss://attacker.example/ws","cols":120,"rows":40,"timeoutSeconds":3600}`))
	}))
	defer server.Close()
	starter, _ := NewFederationStarter(FederationStarterOptions{BaseURL: server.URL, ClientID: "dsh", KeyID: "h1", HMACKey: hmacKey, HTTPClient: server.Client()})
	if _, err := starter.Start(t.Context(), Target{BotID: "bot-1", DelegatedSession: "delegated-1"}); !errors.Is(err, ErrFederationUpstream) {
		t.Fatalf("untrusted websocket error = %v", err)
	}
}

func TestValidateBootstrapRejectsExplicitWebSocketPort(t *testing.T) {
	bootstrap := Bootstrap{
		SessionID: "session-1", Region: "ap-beijing", InstanceID: "ins-test123",
		OwnerUIN: "10001", AppID: 1250000000,
		WSURL: "wss://ap-beijing.forward.tat-tc.tencent.cn:8443/ws",
	}
	if err := validateBootstrap(bootstrap); err == nil {
		t.Fatal("bootstrap with explicit WebSocket port was accepted")
	}
}

func TestFederationStarterDoesNotFollowRedirects(t *testing.T) {
	hmacKey := []byte("0123456789abcdef0123456789abcdef")
	redirected := false
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		redirected = true
	}))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Redirect(w, nil, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()

	starter, err := NewFederationStarter(FederationStarterOptions{
		BaseURL: source.URL, ClientID: "dsh", KeyID: "h1", HMACKey: hmacKey, HTTPClient: source.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := starter.Start(t.Context(), Target{BotID: "bot-1", DelegatedSession: "delegated-1"}); !errors.Is(err, ErrFederationUpstream) {
		t.Fatalf("redirect error = %v, want federation upstream error", err)
	}
	if redirected {
		t.Fatal("federation client followed a redirect")
	}
}

func TestFederationStarterRejectsOversizedOrAmbiguousBootstrap(t *testing.T) {
	hmacKey := []byte("0123456789abcdef0123456789abcdef")
	for name, response := range map[string]string{
		"multiple JSON values": validBootstrapJSON() + ` {}`,
		"oversized body":       validBootstrapJSON() + strings.Repeat(" ", maxResponseBody),
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, response)
			}))
			defer server.Close()
			starter, err := NewFederationStarter(FederationStarterOptions{
				BaseURL: server.URL, ClientID: "dsh", KeyID: "h1", HMACKey: hmacKey, HTTPClient: server.Client(),
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := starter.Start(t.Context(), Target{BotID: "bot-1", DelegatedSession: "delegated-1"}); !errors.Is(err, ErrFederationUpstream) {
				t.Fatalf("error = %v, want federation upstream", err)
			}
		})
	}
}

func TestFederationStarterSealsHostBoundExpiringLoginState(t *testing.T) {
	hmacKey := []byte("0123456789abcdef0123456789abcdef")
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	starter, err := NewFederationStarter(FederationStarterOptions{
		BaseURL: "https://auth.internal", ClientID: "dsh", KeyID: "h1", HMACKey: hmacKey,
		Clock: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := starter.SealLoginState("BOT-1.DSH.LIGHTVELA.SITE:443", "/api/chat?q=1", "state-1", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := starter.OpenLoginState(sealed, "bot-1.dsh.lightvela.site")
	if err != nil || claims.Host != "bot-1.dsh.lightvela.site" || claims.ReturnTo != "/api/chat?q=1" || claims.State != "state-1" {
		t.Fatalf("claims=%+v err=%v", claims, err)
	}
	if _, err := starter.OpenLoginState(sealed, "bot-2.dsh.lightvela.site"); !errors.Is(err, ErrFederationUnauthorized) {
		t.Fatalf("different host error=%v", err)
	}
	now = now.Add(time.Minute)
	if _, err := starter.OpenLoginState(sealed, "bot-1.dsh.lightvela.site"); !errors.Is(err, ErrFederationUnauthorized) {
		t.Fatalf("expired state error=%v", err)
	}
}

func TestFederationStarterSignsAndExchangesDelegatedSession(t *testing.T) {
	hmacKey := []byte("0123456789abcdef0123456789abcdef")
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost || r.URL.Path != "/auth/federation/exchange" || r.Header.Get(headerClientID) != "dsh" || r.Header.Get(headerKeyID) != "h1" || r.Header.Get(headerTimestamp) != now.Format(time.RFC3339) || r.Header.Get(headerRequestID) != "exchange-request" || r.Header.Get(headerSignature) == "" {
			t.Errorf("exchange request method=%s path=%s headers=%v", r.Method, r.URL.Path, r.Header)
		}
		var payload map[string]string
		if json.Unmarshal(body, &payload) != nil || payload["ticket"] != "ticket-1" || payload["redirect_uri"] != "https://bot-1.dsh.lightvela.site/auth/lightvela/callback" {
			t.Errorf("exchange body=%s", body)
		}
		_, _ = io.WriteString(w, `{"delegated_session":"delegated-1","expires_at":"2026-08-24T12:05:00Z"}`)
	}))
	defer server.Close()
	starter, err := NewFederationStarter(FederationStarterOptions{
		BaseURL: server.URL, ClientID: "dsh", KeyID: "h1", HMACKey: hmacKey, HTTPClient: server.Client(),
		Clock: func() time.Time { return now }, RequestID: func() string { return "exchange-request" },
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := starter.Exchange(t.Context(), "ticket-1", "https://bot-1.dsh.lightvela.site/auth/lightvela/callback")
	if err != nil || session.Value != "delegated-1" || !session.ExpiresAt.After(now) {
		t.Fatalf("session=%+v err=%v", session, err)
	}
}

func TestTargetRejectsNonDNSBotIDAndPreservesOpaqueSession(t *testing.T) {
	if target := (Target{BotID: strings.Repeat("a", 63), DelegatedSession: "delegated-1"}); target.Validate() != nil {
		t.Fatal("63-byte Bot ID was rejected")
	}
	if target := (Target{BotID: strings.Repeat("a", 64), DelegatedSession: "delegated-1"}); target.Validate() == nil {
		t.Fatal("64-byte Bot ID unexpectedly validated")
	}
	for _, target := range []Target{
		{BotID: "Bot-1", DelegatedSession: "delegated-1"},
		{BotID: "bot_1", DelegatedSession: "delegated-1"},
		{BotID: " bot-1", DelegatedSession: "delegated-1"},
	} {
		if err := target.Validate(); err == nil {
			t.Fatalf("target %+v unexpectedly validated", target)
		}
	}
	if target := (Target{BotID: "bot-1", DelegatedSession: " delegated-1"}); target.Validate() != nil || target.Key() == "" {
		t.Fatalf("opaque delegated session was rejected or changed: %+v", target)
	}
}

func validBootstrapJSON() string {
	return `{"sessionId":"session-1","region":"ap-beijing","instanceId":"ins-test123","ownerUin":"10001","loginUin":"10002","appId":1250000000,"wsUrl":"wss://ap-beijing.forward.tat-tc.tencent.cn/ws","cols":120,"rows":40,"timeoutSeconds":3600}`
}
