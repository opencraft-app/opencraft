package gateway

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"testing"
)

func TestCanonicalClientIP(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	tests := []struct {
		name       string
		remoteAddr string
		forwarded  []string
		want       string
	}{
		{
			name:       "uses rightmost valid address appended by load balancer",
			remoteAddr: "10.0.0.12:32456",
			forwarded:  []string{"198.51.100.77, 1.203.100.246"},
			want:       "1.203.100.246",
		},
		{
			name:       "supports multiple forwarded header lines",
			remoteAddr: "10.0.0.12:32456",
			forwarded:  []string{"198.51.100.77", "203.0.113.10, 2001:db8::8"},
			want:       "2001:db8::8",
		},
		{
			name:       "skips malformed forwarded values",
			remoteAddr: "10.0.0.12:32456",
			forwarded:  []string{"198.51.100.77, unknown"},
			want:       "198.51.100.77",
		},
		{
			name:       "falls back to remote address",
			remoteAddr: "192.0.2.44:32456",
			want:       "192.0.2.44",
		},
		{
			name:       "normalizes mapped ipv4 address",
			remoteAddr: "[::ffff:192.0.2.45]:32456",
			want:       "192.0.2.45",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = tt.remoteAddr
			for _, value := range tt.forwarded {
				req.Header.Add("X-Forwarded-For", value)
			}

			if got := canonicalClientIP(req, trusted); got != tt.want {
				t.Fatalf("canonicalClientIP() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCanonicalClientIPIgnoresForwardingHeadersFromUntrustedPeer(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "192.0.2.44:32456"
	req.Header.Set("X-Forwarded-For", "198.51.100.77, 1.203.100.246")

	if got := canonicalClientIP(req, []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}); got != "192.0.2.44" {
		t.Fatalf("canonicalClientIP() = %q, want TCP peer", got)
	}
}

func TestCanonicalClientIPPeelsTrustedProxyChain(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.12:32456"
	req.Header.Set("X-Forwarded-For", "198.51.100.77, 10.0.0.13")
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	if got := canonicalClientIP(req, trusted); got != "198.51.100.77" {
		t.Fatalf("canonicalClientIP() = %q, want first untrusted hop", got)
	}
}

func TestNewHandlerRejectsInvalidTrustedProxyCIDR(t *testing.T) {
	_, err := NewHandler(Config{AuthServiceURL: "http://auth.invalid", TrustedProxyCIDRs: []string{"not-a-cidr"}})
	if err == nil {
		t.Fatal("expected invalid trusted proxy CIDR to fail configuration")
	}
}

func TestReverseProxyOverwritesSpoofableClientIPHeaders(t *testing.T) {
	received := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	handler, err := NewHandler(Config{
		AuthServiceURL:    "http://auth.invalid",
		TrustedProxyCIDRs: []string{"10.0.0.0/8"},
		Routes: []Route{{
			Name:     "sms",
			Prefix:   "/auth/sms",
			Upstream: upstream.URL,
			Access:   AccessPublic,
			Methods:  []string{http.MethodPost},
		}},
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/auth/sms/send", nil)
	req.RemoteAddr = "10.0.0.12:32456"
	req.Header.Set("X-Forwarded-For", "198.51.100.77, 1.203.100.246")
	req.Header.Set("X-Real-IP", "198.51.100.78")
	req.Header.Set("X-Lightclaw-Client-IP", "198.51.100.79")
	req.Header.Set("Forwarded", "for=198.51.100.80")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}

	headers := <-received
	for _, name := range []string{"X-Forwarded-For", "X-Real-IP", "X-Lightclaw-Client-IP"} {
		if got := headers.Values(name); len(got) != 1 || got[0] != "1.203.100.246" {
			t.Errorf("%s = %v, want one canonical value", name, got)
		}
	}
	if got := headers.Get("Forwarded"); got != "" {
		t.Errorf("Forwarded = %q, want stripped", got)
	}
}

func TestReverseProxyFallsBackToRemoteAddress(t *testing.T) {
	received := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream URL: %v", err)
	}
	proxy := newSingleHostReverseProxy(target, http.DefaultTransport, "/auth", "", "", nil)
	req := httptest.NewRequest(http.MethodPost, "/auth/sms/send", nil)
	req.RemoteAddr = "192.0.2.44:45123"
	req.Header.Set("X-Real-IP", "198.51.100.78")
	req.Header.Set("X-Lightclaw-Client-IP", "198.51.100.79")

	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}

	headers := <-received
	for _, name := range []string{"X-Forwarded-For", "X-Real-IP", "X-Lightclaw-Client-IP"} {
		if got := headers.Get(name); got != "192.0.2.44" {
			t.Errorf("%s = %q, want remote address fallback", name, got)
		}
	}
}
