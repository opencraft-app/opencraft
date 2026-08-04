package httptransport

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
)

func TestRequestIDEntersContextAndResponse(t *testing.T) {
	const want = "01989c24-7540-7f12-a27b-c83243215dd1"
	var contextID string
	handler := RequestIDMiddleware(fixedRequestIDGenerator{value: want})(
		http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			contextID = RequestID(request.Context())
			writer.WriteHeader(http.StatusNoContent)
		}),
	)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))

	if contextID != want {
		t.Fatalf("context requestId = %q, want %q", contextID, want)
	}
	if got := recorder.Header().Get("X-Request-ID"); got != want {
		t.Fatalf("X-Request-ID = %q, want %q", got, want)
	}
}

func TestRecoveryReturnsUnifiedInternalError(t *testing.T) {
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "fallback"})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := RequestIDMiddleware(fixedRequestIDGenerator{value: "request-1"})(
		RecoveryMiddleware(encoder, logger)(
			http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				panic("Bearer secret must not escape")
			}),
		),
	)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))

	assertErrorEnvelope(t, recorder, http.StatusInternalServerError, "internal_error")
	if strings.Contains(recorder.Body.String(), "Bearer") {
		t.Fatalf("panic value leaked: %s", recorder.Body)
	}
}

func TestBodyLimitRejectsBeforeHandler(t *testing.T) {
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	called := false
	handler := BodyLimitMiddleware(8, encoder)(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			called = true
		}),
	)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodPost, "/", strings.NewReader("123456789")),
	)

	if called {
		t.Fatal("downstream handler called for oversized body")
	}
	assertErrorEnvelope(t, recorder, http.StatusBadRequest, "invalid_request")
}

func TestJSONContentTypeRejectsWrongMediaType(t *testing.T) {
	spec, err := openapi.GetSwagger()
	if err != nil {
		t.Fatalf("GetSwagger() error = %v", err)
	}
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	middleware, err := JSONContentTypeMiddleware(spec, encoder)
	if err != nil {
		t.Fatalf("JSONContentTypeMiddleware() error = %v", err)
	}
	called := false
	handler := middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/auth/login",
		strings.NewReader(`{"email":"a@example.com","password":"x"}`),
	)
	request.Header.Set("Content-Type", "text/plain")

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if called {
		t.Fatal("downstream handler called for wrong Content-Type")
	}
	assertErrorEnvelope(t, recorder, http.StatusBadRequest, "invalid_request")
}

func TestCORSAllowsOnlyExplicitOriginMethodAndHeaders(t *testing.T) {
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	middleware, err := CORSMiddleware(CORSConfig{
		AllowedOrigins: []string{"https://app.example.cn"},
		AllowedMethods: []string{http.MethodGet, http.MethodPost},
		AllowedHeaders: []string{"Authorization", "Content-Type"},
		MaxAge:         time.Hour,
	}, encoder)
	if err != nil {
		t.Fatalf("CORSMiddleware() error = %v", err)
	}
	handler := middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("preflight reached downstream handler")
	}))

	allowed := httptest.NewRequest(http.MethodOptions, "/v1/me", nil)
	allowed.Header.Set("Origin", "https://app.example.cn")
	allowed.Header.Set("Access-Control-Request-Method", http.MethodGet)
	allowed.Header.Set("Access-Control-Request-Headers", "Authorization")
	allowedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(allowedRecorder, allowed)
	if allowedRecorder.Code != http.StatusNoContent {
		t.Fatalf("allowed preflight status = %d, want 204", allowedRecorder.Code)
	}
	if got := allowedRecorder.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.cn" {
		t.Fatalf("Access-Control-Allow-Origin = %q", got)
	}
	if got := allowedRecorder.Header().Get("Access-Control-Allow-Methods"); got != "GET, POST" {
		t.Fatalf("Access-Control-Allow-Methods = %q", got)
	}

	disallowed := httptest.NewRequest(http.MethodOptions, "/v1/me", nil)
	disallowed.Header.Set("Origin", "https://evil.example")
	disallowed.Header.Set("Access-Control-Request-Method", http.MethodGet)
	disallowedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(disallowedRecorder, disallowed)
	assertErrorEnvelope(t, disallowedRecorder, http.StatusForbidden, "permission_denied")
	if got := disallowedRecorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("disallowed origin received ACAO = %q", got)
	}
}

func TestUntrustedPeerCannotSpoofForwardedClientIP(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	var got netip.Addr
	handler := ClientIPMiddleware(trusted)(http.HandlerFunc(func(
		_ http.ResponseWriter,
		request *http.Request,
	) {
		got, _ = ClientIP(request.Context())
	}))

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "203.0.113.10:4321"
	request.Header.Set("X-Forwarded-For", "198.51.100.22")
	handler.ServeHTTP(httptest.NewRecorder(), request)

	if want := netip.MustParseAddr("203.0.113.10"); got != want {
		t.Fatalf("ClientIP() = %v, want direct peer %v", got, want)
	}
}

func TestTrustedPeerUsesFirstUntrustedForwardedAddress(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	var got netip.Addr
	handler := ClientIPMiddleware(trusted)(http.HandlerFunc(func(
		_ http.ResponseWriter,
		request *http.Request,
	) {
		got, _ = ClientIP(request.Context())
	}))

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "10.0.0.2:4321"
	request.Header.Set("X-Forwarded-For", "198.51.100.22, 10.0.0.3")
	handler.ServeHTTP(httptest.NewRecorder(), request)

	if want := netip.MustParseAddr("198.51.100.22"); got != want {
		t.Fatalf("ClientIP() = %v, want first untrusted %v", got, want)
	}
}

func TestSensitiveResponseHeadersComeFromOpenAPIMetadata(t *testing.T) {
	spec, err := openapi.GetSwagger()
	if err != nil {
		t.Fatalf("GetSwagger() error = %v", err)
	}
	middleware, err := SensitiveResponseHeadersMiddleware(spec)
	if err != nil {
		t.Fatalf("SensitiveResponseHeadersMiddleware() error = %v", err)
	}
	handler := middleware(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}))

	request := httptest.NewRequest(http.MethodPost, "/v1/auth/login", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := recorder.Header().Get("Pragma"); got != "no-cache" {
		t.Fatalf("Pragma = %q, want no-cache", got)
	}
}

func TestRequestTimeoutPropagatesCancellation(t *testing.T) {
	cancelled := make(chan struct{})
	handler := RequestTimeoutMiddleware(20 * time.Millisecond)(
		http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
			<-request.Context().Done()
			close(cancelled)
		}),
	)

	handler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodGet, "/", nil),
	)

	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("handler context was not cancelled")
	}
}

func TestRequestIDContextDoesNotLeakAcrossRequests(t *testing.T) {
	generator := &sequenceIDGenerator{values: []string{"request-1", "request-2"}}
	var ids []string
	handler := RequestIDMiddleware(generator)(http.HandlerFunc(func(
		_ http.ResponseWriter,
		request *http.Request,
	) {
		ids = append(ids, RequestID(request.Context()))
	}))

	handler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodGet, "/first", nil),
	)
	handler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodGet, "/second", nil),
	)

	if len(ids) != 2 || ids[0] != "request-1" || ids[1] != "request-2" {
		t.Fatalf("request IDs = %#v", ids)
	}
}

type sequenceIDGenerator struct {
	values []string
}

func (g *sequenceIDGenerator) New() (string, error) {
	value := g.values[0]
	g.values = g.values[1:]
	return value, nil
}

func TestRequestIDCanBeReadFromNilContext(t *testing.T) {
	if got := RequestID(nil); got != "" {
		t.Fatalf("RequestID(nil) = %q, want empty", got)
	}
	if _, ok := ClientIP(context.Background()); ok {
		t.Fatal("ClientIP() unexpectedly present")
	}
}
