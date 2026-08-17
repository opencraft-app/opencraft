package computerupdate

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	update "chatserver/internal/computerupdate"
)

func TestRoutesKeepComputerReadAnonymousAndFenceOperatorWrites(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 17, 17, 0, 0, 0, time.UTC)
	service := &fakeUpdateService{
		envelope: update.ChannelEnvelope{
			Signed: update.SignedDescriptor{
				SchemaVersion: 1, Payload: "c2lnbmVkLXBheWxvYWQ",
				Signature: update.ChannelSignature{
					Algorithm: "ed25519", KeyID: "channel-key-1",
					Value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				},
			},
			Downloads: update.ChannelDownloads{
				CatalogURL:           "https://cos.ap-beijing.myqcloud.com/catalog",
				ManifestURL:          "https://cos.ap-beijing.myqcloud.com/manifest",
				ManifestSignatureURL: "https://cos.ap-beijing.myqcloud.com/signature",
				ProgramURL:           "https://cos.ap-beijing.myqcloud.com/program",
				ExpiresAt:            now.Add(5 * time.Minute),
			},
			ETag: `"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`,
		},
		views: []update.ChannelView{{
			Channel: "stable", Target: "linux-amd64", Sequence: 1,
			ExpectedVersion:  "v0.1.51",
			CatalogSHA256:    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			DescriptorSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			IssuedAt:         now, KeyID: "channel-key-1",
		}},
	}
	handler, err := NewHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	routes, err := NewRoutes(handler, RoutesConfig{
		Host:   "updates.internal.example",
		Origin: "https://updates.internal.example",
		TrustedProxyCIDRs: []netip.Prefix{
			netip.MustParsePrefix("10.20.0.0/16"),
		},
		RequestID: func() string { return "request-update-1" },
	})
	if err != nil {
		t.Fatal(err)
	}

	read := httptest.NewRequest(
		http.MethodGet,
		"http://updates.internal.example/computer-releases/stable/linux-amd64",
		nil,
	)
	read.Host = "updates.internal.example"
	read.RemoteAddr = "203.0.113.8:42000"
	readRecorder := httptest.NewRecorder()
	routes.ServeHTTP(readRecorder, read)
	if readRecorder.Code != http.StatusOK ||
		readRecorder.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("anonymous read = %d headers=%v body=%s", readRecorder.Code, readRecorder.Header(), readRecorder.Body.String())
	}

	body := bytes.NewBufferString(`{"version":"v0.1.51"}`)
	spoofed := httptest.NewRequest(
		http.MethodPut,
		"http://updates.internal.example/ops/computer-updates/channels/stable",
		body,
	)
	spoofed.Host = "updates.internal.example"
	spoofed.RemoteAddr = "203.0.113.8:42001"
	spoofed.Header.Set("Origin", "https://updates.internal.example")
	spoofed.Header.Set("Content-Type", "application/json")
	spoofed.Header.Set("If-Match", `"0"`)
	spoofed.Header.Set(
		"X-Vela-Operator-Fingerprint",
		strings.Repeat("31", 32),
	)
	spoofedRecorder := httptest.NewRecorder()
	routes.ServeHTTP(spoofedRecorder, spoofed)
	if spoofedRecorder.Code != http.StatusForbidden ||
		!strings.Contains(spoofedRecorder.Body.String(), "operator_forbidden") {
		t.Fatalf("spoofed write = %d %s", spoofedRecorder.Code, spoofedRecorder.Body.String())
	}

	trusted := httptest.NewRequest(
		http.MethodPut,
		"http://updates.internal.example/ops/computer-updates/channels/stable",
		bytes.NewBufferString(`{"version":"v0.1.51"}`),
	)
	trusted.Host = "updates.internal.example"
	trusted.RemoteAddr = "10.20.4.8:42002"
	trusted.Header = spoofed.Header.Clone()
	trustedRecorder := httptest.NewRecorder()
	routes.ServeHTTP(trustedRecorder, trusted)
	if trustedRecorder.Code != http.StatusOK || service.promote.Version != "v0.1.51" {
		t.Fatalf("trusted write = %d %s command=%#v", trustedRecorder.Code, trustedRecorder.Body.String(), service.promote)
	}

	wrongOrigin := trusted.Clone(trusted.Context())
	wrongOrigin.Body = http.NoBody
	wrongOrigin.Header.Set("Origin", "https://evil.example")
	wrongOriginRecorder := httptest.NewRecorder()
	routes.ServeHTTP(wrongOriginRecorder, wrongOrigin)
	if wrongOriginRecorder.Code != http.StatusForbidden {
		t.Fatalf("wrong origin = %d %s", wrongOriginRecorder.Code, wrongOriginRecorder.Body.String())
	}
}

func TestRoutesServeOperationsPageOnlyThroughTrustedProxy(t *testing.T) {
	t.Parallel()
	handler, err := NewHandler(&fakeUpdateService{})
	if err != nil {
		t.Fatal(err)
	}
	routes, err := NewRoutes(handler, RoutesConfig{
		Host:   "updates.internal.example",
		Origin: "https://updates.internal.example",
		TrustedProxyCIDRs: []netip.Prefix{
			netip.MustParsePrefix("10.20.0.0/16"),
		},
		RequestID: func() string { return "request-update-page" },
	})
	if err != nil {
		t.Fatal(err)
	}

	untrusted := httptest.NewRequest(
		http.MethodGet,
		"http://updates.internal.example/ops/computer-updates/",
		nil,
	)
	untrusted.Host = "updates.internal.example"
	untrusted.RemoteAddr = "203.0.113.8:42000"
	untrusted.Header.Set("X-Vela-Operator-Fingerprint", strings.Repeat("31", 32))
	untrustedRecorder := httptest.NewRecorder()
	routes.ServeHTTP(untrustedRecorder, untrusted)
	if untrustedRecorder.Code != http.StatusForbidden {
		t.Fatalf("untrusted page status=%d body=%s", untrustedRecorder.Code, untrustedRecorder.Body.String())
	}

	trusted := untrusted.Clone(untrusted.Context())
	trusted.RemoteAddr = "10.20.4.8:42001"
	trustedRecorder := httptest.NewRecorder()
	routes.ServeHTTP(trustedRecorder, trusted)
	if trustedRecorder.Code != http.StatusOK ||
		!strings.Contains(trustedRecorder.Header().Get("Content-Type"), "text/html") ||
		!strings.Contains(trustedRecorder.Header().Get("Content-Security-Policy"), "default-src 'none'") ||
		trustedRecorder.Header().Get("Cache-Control") != "no-store" ||
		!strings.Contains(trustedRecorder.Body.String(), "Computer Update") ||
		!strings.Contains(trustedRecorder.Body.String(), "/ops/computer-updates/channels") {
		t.Fatalf("trusted page status=%d headers=%v body=%s", trustedRecorder.Code, trustedRecorder.Header(), trustedRecorder.Body.String())
	}
}

func TestRoutesExposeProbeEndpointsWithoutIngressHost(t *testing.T) {
	t.Parallel()
	handler, err := NewHandler(&fakeUpdateService{})
	if err != nil {
		t.Fatal(err)
	}
	routes, err := NewRoutes(handler, RoutesConfig{
		Host: "updates.internal.example", Origin: "https://updates.internal.example",
		TrustedProxyCIDRs: []netip.Prefix{netip.MustParsePrefix("10.20.0.0/16")},
		RequestID:         func() string { return "request-update-probe" },
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		request := httptest.NewRequest(http.MethodGet, "http://10.20.4.9"+path, nil)
		request.Host = "10.20.4.9:8090"
		recorder := httptest.NewRecorder()
		routes.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK || recorder.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("GET %s status=%d headers=%v body=%q", path, recorder.Code, recorder.Header(), recorder.Body.String())
		}
	}
}
