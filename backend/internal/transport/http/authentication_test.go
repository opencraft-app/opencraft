package httptransport

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	appauthn "chatserver/internal/app/authn"
	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"

	"github.com/getkin/kin-openapi/openapi3filter"
)

const (
	hookTestAccountID  = "01989c24-7540-7f12-a27b-c83243215dd1"
	hookTestSessionID  = "01989c24-7540-7f12-a27b-c83243215dd2"
	hookTestServerID   = "01989c24-7540-7f12-a27b-c83243215dd3"
	hookTestAgentID    = "01989c24-7540-7f12-a27b-c83243215dd4"
	hookTestComputerID = "01989c24-7540-7f12-a27b-c83243215dd5"
)

type schemeAuthenticator struct {
	candidates []authnport.CredentialCandidate
}

func (a *schemeAuthenticator) Authenticate(
	_ context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	a.candidates = append(a.candidates, candidate)
	switch typed := candidate.(type) {
	case authnport.HumanBearerCandidate:
		if typed.Credential().Reveal() != "human-token" {
			return nil, apperror.New("unauthenticated", "登录凭证无效", nil)
		}
		return authnport.NewCurrentHumanPrincipal(
			hookTestAccountID,
			hookTestSessionID,
			1,
		)
	case authnport.RuntimeBearerCandidate:
		if typed.Credential().Reveal() == "human-token" {
			return nil, apperror.New(
				"runtime_credential_invalid",
				"Runtime 凭证无效",
				nil,
			)
		}
		return authnport.NewCurrentRuntimePrincipal(
			hookTestServerID,
			hookTestAgentID,
			2,
		)
	case authnport.AgentCredentialCandidate:
		if typed.Credential().Reveal() != "agent-secret" {
			return nil, apperror.New(
				"runtime_credential_invalid",
				"Agent 凭证无效",
				nil,
			)
		}
		return authnport.NewCurrentAgentCredentialPrincipal(
			hookTestServerID,
			hookTestAgentID,
			3,
		)
	case authnport.ComputerCredentialCandidate:
		if typed.Credential().Reveal() != "computer-secret" {
			return nil, apperror.New("computer_credential_invalid", "Computer 凭证无效", nil)
		}
		return authnport.NewCurrentComputerPrincipal(hookTestServerID, hookTestComputerID, 4)
	case authnport.ComputerBearerCandidate:
		if typed.Credential().Reveal() != "computer-token" {
			return nil, apperror.New("computer_credential_invalid", "Computer 凭证无效", nil)
		}
		return authnport.NewCurrentComputerPrincipal(hookTestServerID, hookTestComputerID, 4)
	default:
		return nil, errors.New("unexpected candidate")
	}
}

func TestAuthenticationHookKeepsSchemesIsolated(t *testing.T) {
	tests := []struct {
		name          string
		scheme        string
		authorization string
		wantCandidate authnport.CandidateKind
		wantPrincipal authnport.PrincipalKind
	}{
		{
			name:          "human",
			scheme:        "HumanBearer",
			authorization: "Bearer human-token",
			wantCandidate: authnport.CandidateHumanBearer,
			wantPrincipal: authnport.PrincipalHuman,
		},
		{
			name:          "runtime",
			scheme:        "RuntimeBearer",
			authorization: "Bearer runtime-token",
			wantCandidate: authnport.CandidateRuntimeBearer,
			wantPrincipal: authnport.PrincipalRuntime,
		},
		{
			name:          "agent credential",
			scheme:        "AgentCredentialAuth",
			authorization: "AgentCredential agent-secret",
			wantCandidate: authnport.CandidateAgentCredential,
			wantPrincipal: authnport.PrincipalAgentCredential,
		},
		{
			name:          "computer credential",
			scheme:        "ComputerCredentialAuth",
			authorization: "ComputerCredential computer-secret",
			wantCandidate: authnport.CandidateComputerCredential,
			wantPrincipal: authnport.PrincipalComputer,
		},
		{
			name:          "computer bootstrap credential",
			scheme:        "ComputerBootstrapAuth",
			authorization: "ComputerCredential computer-secret",
			wantCandidate: authnport.CandidateComputerCredential,
			wantPrincipal: authnport.PrincipalComputer,
		},
		{
			name:          "computer bearer",
			scheme:        "ComputerBearer",
			authorization: "Bearer computer-token",
			wantCandidate: authnport.CandidateComputerBearer,
			wantPrincipal: authnport.PrincipalComputer,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			authenticator := &schemeAuthenticator{}
			hook := newTestAuthenticationHook(t, authenticator)
			var got authnport.CurrentPrincipal
			handler := WithAuthState(http.HandlerFunc(func(
				writer http.ResponseWriter,
				request *http.Request,
			) {
				err := hook.Authenticate(
					request.Context(),
					authenticationInput(request, test.scheme),
				)
				if err != nil {
					t.Fatalf("Authenticate() error = %v", err)
				}
				var ok bool
				got, ok = CurrentPrincipal(request.Context())
				if !ok {
					t.Fatal("CurrentPrincipal() is absent after successful authentication")
				}
				writer.WriteHeader(http.StatusNoContent)
			}))
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("Authorization", test.authorization)

			handler.ServeHTTP(httptest.NewRecorder(), request)

			if len(authenticator.candidates) != 1 {
				t.Fatalf("candidate count = %d, want 1", len(authenticator.candidates))
			}
			if authenticator.candidates[0].Kind() != test.wantCandidate {
				t.Fatalf(
					"candidate kind = %q, want %q",
					authenticator.candidates[0].Kind(),
					test.wantCandidate,
				)
			}
			if got.Kind() != test.wantPrincipal {
				t.Fatalf("principal kind = %q, want %q", got.Kind(), test.wantPrincipal)
			}
		})
	}
}

func TestHumanBearerCannotPassRuntimeScheme(t *testing.T) {
	authenticator := &schemeAuthenticator{}
	hook := newTestAuthenticationHook(t, authenticator)
	handlerCalled := false
	handler := WithAuthState(http.HandlerFunc(func(
		_ http.ResponseWriter,
		request *http.Request,
	) {
		err := hook.Authenticate(
			request.Context(),
			authenticationInput(request, "RuntimeBearer"),
		)
		if got := apperror.CodeOf(err); got != "runtime_credential_invalid" {
			t.Fatalf("Authenticate() code = %q, want runtime_credential_invalid", got)
		}
		if _, ok := CurrentPrincipal(request.Context()); ok {
			t.Fatal("CurrentPrincipal() exists after failed currentness check")
		}
		handlerCalled = true
	}))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Authorization", "Bearer human-token")

	handler.ServeHTTP(httptest.NewRecorder(), request)

	if !handlerCalled {
		t.Fatal("test handler was not called")
	}
}

func TestAnonymousEndpointDoesNotRequirePrincipal(t *testing.T) {
	handler := WithAuthState(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if _, ok := CurrentPrincipal(request.Context()); ok {
			t.Fatal("anonymous request unexpectedly has CurrentPrincipal")
		}
		writer.WriteHeader(http.StatusNoContent)
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNoContent)
	}
}

func TestEnrollmentAuthStoresOnlyValidatedTokenWithoutCreatingPrincipal(t *testing.T) {
	authenticator := &schemeAuthenticator{}
	hook := newTestAuthenticationHook(t, authenticator)
	const token = "cen1." + hookTestServerID + "." + hookTestComputerID +
		".7.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	handler := WithAuthState(http.HandlerFunc(func(
		_ http.ResponseWriter,
		request *http.Request,
	) {
		if err := hook.Authenticate(
			request.Context(), authenticationInput(request, "EnrollmentAuth"),
		); err != nil {
			t.Fatalf("Authenticate() error = %v", err)
		}
		got, ok := CurrentEnrollmentToken(request.Context())
		if !ok || got != token {
			t.Fatalf("CurrentEnrollmentToken() = (%q, %v)", got, ok)
		}
		if _, ok := CurrentPrincipal(request.Context()); ok {
			t.Fatal("Enrollment token must not become a platform principal")
		}
	}))
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Authorization", "Enrollment "+token)
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if len(authenticator.candidates) != 0 {
		t.Fatalf("Enrollment auth called principal authenticator: %d", len(authenticator.candidates))
	}
}

func TestAgentCredentialRouteHintContainsOnlyParsedServerID(t *testing.T) {
	const raw = "arc_" + hookTestServerID + "." + hookTestAgentID +
		".7.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	candidate, err := candidateFromAuthorization(
		agentCredentialScheme,
		"AgentCredential "+raw,
	)
	if err != nil {
		t.Fatalf("candidateFromAuthorization() error = %v", err)
	}
	typed, ok := candidate.(authnport.AgentCredentialCandidate)
	if !ok {
		t.Fatalf("candidate type = %T", candidate)
	}
	if got := typed.RoutePrefix(); got != hookTestServerID {
		t.Fatalf("RoutePrefix() = %q, want %q", got, hookTestServerID)
	}
	if typed.RoutePrefix() == raw {
		t.Fatal("route hint retained full credential")
	}
}

func TestComputerCredentialRouteHintContainsOnlyParsedServerID(t *testing.T) {
	const raw = "crc_" + hookTestServerID + "." + hookTestComputerID +
		".4.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	candidate, err := candidateFromAuthorization(
		computerCredentialScheme,
		"ComputerCredential "+raw,
	)
	if err != nil {
		t.Fatal(err)
	}
	typed, ok := candidate.(authnport.ComputerCredentialCandidate)
	if !ok {
		t.Fatalf("candidate type = %T", candidate)
	}
	if typed.RoutePrefix() != hookTestServerID {
		t.Fatalf("RoutePrefix() = %q", typed.RoutePrefix())
	}
}

func TestAuthStateIsNotSharedAcrossRequests(t *testing.T) {
	var states []*AuthState
	handler := WithAuthState(http.HandlerFunc(func(
		_ http.ResponseWriter,
		request *http.Request,
	) {
		state, ok := authStateFromContext(request.Context())
		if !ok {
			t.Fatal("AuthState is absent")
		}
		states = append(states, state)
	}))

	handler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodGet, "/first", nil),
	)
	handler.ServeHTTP(
		httptest.NewRecorder(),
		httptest.NewRequest(http.MethodGet, "/second", nil),
	)

	if len(states) != 2 {
		t.Fatalf("state count = %d, want 2", len(states))
	}
	if states[0] == states[1] {
		t.Fatal("AuthState pointer was reused across requests")
	}
}

func newTestAuthenticationHook(
	t *testing.T,
	authenticator authnport.Authenticator,
) *AuthenticationHook {
	t.Helper()
	service, err := appauthn.NewService(authenticator)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	hook, err := NewAuthenticationHook(service)
	if err != nil {
		t.Fatalf("NewAuthenticationHook() error = %v", err)
	}
	return hook
}

func authenticationInput(
	request *http.Request,
	scheme string,
) *openapi3filter.AuthenticationInput {
	return &openapi3filter.AuthenticationInput{
		RequestValidationInput: &openapi3filter.RequestValidationInput{
			Request: request,
		},
		SecuritySchemeName: scheme,
	}
}
