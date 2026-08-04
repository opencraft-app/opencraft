package httptransport

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatserver/internal/api/openapi"
	appauthn "chatserver/internal/app/authn"
)

func TestValidatorReturnsUnifiedErrorForUnknownPath(t *testing.T) {
	handler := newTestValidatedHandler(t, http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
		t.Fatal("downstream handler called for unknown path")
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, "/v1/not-an-operation", nil),
	)

	assertErrorEnvelope(t, recorder, http.StatusNotFound, "route_not_found")
}

func TestValidatorReturnsMethodNotAllowedAndAllowHeader(t *testing.T) {
	handler := newTestValidatedHandler(t, http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
		t.Fatal("downstream handler called for wrong method")
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, "/v1/auth/login", nil),
	)

	assertErrorEnvelope(t, recorder, http.StatusMethodNotAllowed, "method_not_allowed")
	if got := recorder.Header().Get("Allow"); got != http.MethodPost {
		t.Fatalf("Allow = %q, want %q", got, http.MethodPost)
	}
}

func TestValidatorReturnsUnifiedErrorForInvalidPathParameter(t *testing.T) {
	handler := newTestValidatedHandler(t, http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
		t.Fatal("downstream handler called for invalid UUID")
	}))
	request := httptest.NewRequest(
		http.MethodGet,
		"/v1/servers/not-a-uuid",
		nil,
	)
	request.Header.Set("Authorization", "Bearer human-token")

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	assertErrorEnvelope(t, recorder, http.StatusBadRequest, "invalid_request")
}

func TestValidatorReturnsAuthenticationErrorBeforeHandler(t *testing.T) {
	handler := newTestValidatedHandler(t, http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
		t.Fatal("downstream handler called without authentication")
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, "/v1/me", nil),
	)

	assertErrorEnvelope(t, recorder, http.StatusUnauthorized, "unauthenticated")
}

func TestValidatorReturnsEnrollmentAuthenticationErrorBeforeHandler(t *testing.T) {
	handler := newTestValidatedHandler(t, http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
		t.Fatal("downstream handler called without enrollment authentication")
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(
			http.MethodGet,
			"/v1/computer-artifacts/0.1.0/darwin-arm64/install.sh",
			nil,
		),
	)

	assertErrorEnvelope(t, recorder, http.StatusUnauthorized, "enrollment_invalid")
}

func TestValidatorAuthenticatesBeforeReportingInvalidArtifactPath(t *testing.T) {
	handler := newTestValidatedHandler(t, http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
		t.Fatal("downstream handler called for invalid artifact path")
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(
			http.MethodGet,
			"/v1/computer-artifacts/0.1.0/darwin-arm64/unknown",
			nil,
		),
	)

	assertErrorEnvelope(t, recorder, http.StatusUnauthorized, "enrollment_invalid")
}

func TestValidatorReturnsUnifiedErrorForMalformedJSONBody(t *testing.T) {
	handler := newTestValidatedHandler(t, http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
		t.Fatal("downstream handler called for malformed body")
	}))
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/auth/login",
		strings.NewReader(`{}`),
	)
	request.Header.Set("Content-Type", "application/json")

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	assertErrorEnvelope(t, recorder, http.StatusBadRequest, "invalid_request")
}

func TestValidatorRejectsInvalidEmailFormat(t *testing.T) {
	handler := newTestValidatedHandler(t, http.HandlerFunc(func(
		http.ResponseWriter,
		*http.Request,
	) {
		t.Fatal("downstream handler called for invalid email format")
	}))
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/auth/login",
		strings.NewReader(`{"email":"not-an-email","password":"secret"}`),
	)
	request.Header.Set("Content-Type", "application/json")

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	assertErrorEnvelope(t, recorder, http.StatusBadRequest, "invalid_request")
}

func newTestValidatedHandler(t *testing.T, next http.Handler) http.Handler {
	t.Helper()
	authenticator := &schemeAuthenticator{}
	service, err := appauthn.NewService(authenticator)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	authHook, err := NewAuthenticationHook(service)
	if err != nil {
		t.Fatalf("NewAuthenticationHook() error = %v", err)
	}
	spec, err := openapi.GetSwagger()
	if err != nil {
		t.Fatalf("GetSwagger() error = %v", err)
	}
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	validator, err := NewValidator(spec, encoder, authHook)
	if err != nil {
		t.Fatalf("NewValidator() error = %v", err)
	}
	return WithAuthState(validator(next))
}

func assertErrorEnvelope(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
	status int,
	code string,
) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, want %d; body=%s", recorder.Code, status, recorder.Body)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	var body openapi.ErrorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not ErrorEnvelope JSON: %v; body=%s", err, recorder.Body)
	}
	if body.Error.Code != code {
		t.Fatalf("code = %q, want %q", body.Error.Code, code)
	}
	if body.Error.RequestId == "" {
		t.Fatal("requestId is empty")
	}
}
