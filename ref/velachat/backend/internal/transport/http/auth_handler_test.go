package httptransport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	appaccountauth "chatserver/internal/app/accountauth"
	"chatserver/internal/apperror"
	accountauthport "chatserver/internal/ports/accountauth"
	authnport "chatserver/internal/ports/authn"

	openapi_types "github.com/oapi-codegen/runtime/types"
)

const (
	handlerAccountID = "01989c24-7540-7f12-a27b-c83243215dd1"
	handlerSessionID = "01989c24-7540-7f12-a27b-c83243215dd2"
)

var handlerExpiry = time.Date(2026, 7, 30, 12, 15, 0, 0, time.UTC)

type fakeAccountAuthService struct {
	registerCommand appaccountauth.RegisterCommand
	registerResult  appaccountauth.Result
	registerErr     error
	loginCommand    appaccountauth.LoginCommand
	loginResult     appaccountauth.Result
	loginErr        error
	refreshRaw      string
	refreshResult   appaccountauth.Result
	refreshErr      error
	logoutAccountID string
	logoutSessionID string
	logoutErr       error
}

func (s *fakeAccountAuthService) Register(
	_ context.Context,
	command appaccountauth.RegisterCommand,
) (appaccountauth.Result, error) {
	s.registerCommand = command
	return s.registerResult, s.registerErr
}

func (s *fakeAccountAuthService) Login(
	_ context.Context,
	command appaccountauth.LoginCommand,
) (appaccountauth.Result, error) {
	s.loginCommand = command
	return s.loginResult, s.loginErr
}

func (s *fakeAccountAuthService) Refresh(
	_ context.Context,
	raw string,
) (appaccountauth.Result, error) {
	s.refreshRaw = raw
	return s.refreshResult, s.refreshErr
}

func (s *fakeAccountAuthService) Logout(
	_ context.Context,
	accountID string,
	sessionID string,
) error {
	s.logoutAccountID = accountID
	s.logoutSessionID = sessionID
	return s.logoutErr
}

func TestAuthHandlerMapsRegisterLoginAndRefresh(t *testing.T) {
	result := handlerAuthResult()
	service := &fakeAccountAuthService{
		registerResult: result,
		loginResult:    result,
		refreshResult:  result,
	}
	handler, err := NewAuthHandler(service)
	if err != nil {
		t.Fatal(err)
	}

	register, err := handler.Register(context.Background(), openapi.RegisterRequestObject{
		Body: &openapi.RegisterRequest{
			Email:       openapi_types.Email("alice@example.com"),
			Password:    "password-123",
			DisplayName: "Alice",
		},
	})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	registered, ok := register.(openapi.Register201JSONResponse)
	if !ok || registered.Body.Account.Id.String() != handlerAccountID ||
		registered.Body.AccessToken == nil ||
		registered.Headers.CacheControl != "no-store" {
		t.Fatalf("Register() response = %#v", register)
	}
	if service.registerCommand.Email != "alice@example.com" {
		t.Fatalf("Register() command = %#v", service.registerCommand)
	}

	login, err := handler.Login(context.Background(), openapi.LoginRequestObject{
		Body: &openapi.LoginRequest{
			Email:    openapi_types.Email("alice@example.com"),
			Password: "password-123",
		},
	})
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if _, ok := login.(openapi.Login200JSONResponse); !ok {
		t.Fatalf("Login() response = %T", login)
	}

	refresh, err := handler.RefreshAuth(
		context.Background(),
		openapi.RefreshAuthRequestObject{
			Body: &openapi.RefreshRequest{RefreshToken: "refresh-token-value"},
		},
	)
	if err != nil {
		t.Fatalf("RefreshAuth() error = %v", err)
	}
	if _, ok := refresh.(openapi.RefreshAuth200JSONResponse); !ok {
		t.Fatalf("RefreshAuth() response = %T", refresh)
	}
	if service.refreshRaw != "refresh-token-value" {
		t.Fatalf("Refresh() raw = %q", service.refreshRaw)
	}
}

func TestAuthHandlerReturnsApplicationErrorToStrictErrorPath(t *testing.T) {
	service := &fakeAccountAuthService{
		registerErr: apperror.New(
			"account_already_exists",
			"该邮箱已注册",
			nil,
		),
	}
	handler, err := NewAuthHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.Register(
		context.Background(),
		openapi.RegisterRequestObject{Body: &openapi.RegisterRequest{}},
	)
	if response != nil || apperror.CodeOf(err) != "account_already_exists" {
		t.Fatalf("Register() = %#v, %v", response, err)
	}
}

func TestAuthHandlerLogoutUsesCurrentHumanPrincipal(t *testing.T) {
	service := &fakeAccountAuthService{}
	handler, err := NewAuthHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	principal, err := authnport.NewCurrentHumanPrincipal(
		handlerAccountID,
		handlerSessionID,
		1,
	)
	if err != nil {
		t.Fatal(err)
	}
	state := &AuthState{}
	if err := state.setPrincipal(principal); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(
		context.Background(),
		authStateContextKey{},
		state,
	)

	response, err := handler.Logout(ctx, openapi.LogoutRequestObject{})
	if err != nil {
		t.Fatalf("Logout() error = %v", err)
	}
	if _, ok := response.(openapi.Logout204Response); !ok {
		t.Fatalf("Logout() response = %T", response)
	}
	if service.logoutAccountID != handlerAccountID ||
		service.logoutSessionID != handlerSessionID {
		t.Fatalf(
			"Logout(account=%q, session=%q)",
			service.logoutAccountID,
			service.logoutSessionID,
		)
	}
}

func TestAuthOnlyRoutesDoNotExposeUnimplementedOperations(t *testing.T) {
	service := &fakeAccountAuthService{loginResult: handlerAuthResult()}
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	handler, err := NewAuthOnlyRoutes(service, encoder)
	if err != nil {
		t.Fatal(err)
	}

	login := httptest.NewRequest(
		http.MethodPost,
		"/v1/auth/login",
		nil,
	)
	loginRecorder := httptest.NewRecorder()
	handler.ServeHTTP(loginRecorder, login)
	if loginRecorder.Code == http.StatusNotFound {
		t.Fatal("auth route was not registered")
	}

	me := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	meRecorder := httptest.NewRecorder()
	handler.ServeHTTP(meRecorder, me)
	if meRecorder.Code != http.StatusNotFound {
		t.Fatalf("GET /v1/me status = %d, want 404", meRecorder.Code)
	}
}

func handlerAuthResult() appaccountauth.Result {
	return appaccountauth.Result{
		AccessToken:  "access-token",
		RefreshToken: "refresh-token",
		ExpiresAt:    handlerExpiry,
		Account: accountauthport.Account{
			ID:           handlerAccountID,
			Email:        "alice@example.com",
			DisplayName:  "Alice",
			IMState:      "provisioning",
			TokenVersion: 1,
			Revision:     1,
		},
	}
}
