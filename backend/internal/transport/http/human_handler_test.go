package httptransport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	apphumanaccount "chatserver/internal/app/humanaccount"
	"chatserver/internal/apperror"
	authnport "chatserver/internal/ports/authn"
	humanaccountport "chatserver/internal/ports/humanaccount"
)

type fakeHumanAccountService struct {
	getAccountID     string
	account          humanaccountport.Account
	getErr           error
	sessionAccountID string
	session          apphumanaccount.IMSession
	sessionErr       error
}

func (service *fakeHumanAccountService) Get(
	_ context.Context,
	accountID string,
) (humanaccountport.Account, error) {
	service.getAccountID = accountID
	return service.account, service.getErr
}

func (service *fakeHumanAccountService) CreateIMSession(
	_ context.Context,
	accountID string,
) (apphumanaccount.IMSession, error) {
	service.sessionAccountID = accountID
	return service.session, service.sessionErr
}

func TestMeHandlerReturnsCurrentAccountAndShortLivedIMSession(t *testing.T) {
	expiry := time.Date(2026, 7, 30, 18, 0, 0, 0, time.UTC)
	service := &fakeHumanAccountService{
		account: humanaccountport.Account{
			ID:          handlerAccountID,
			Email:       "alice@example.com",
			DisplayName: "爱丽丝",
			IMUserID:    "u_OPAQUE",
			IMState:     "ready",
			Revision:    2,
		},
		session: apphumanaccount.IMSession{
			SDKAppID:  1600000000,
			UserID:    "u_OPAQUE",
			UserSig:   "short-lived-user-sig",
			ExpiresAt: expiry,
		},
	}
	handler, err := NewMeHandler(service)
	if err != nil {
		t.Fatal(err)
	}
	ctx := currentHumanContext(t)

	meResponse, err := handler.GetMe(ctx, openapi.GetMeRequestObject{})
	if err != nil {
		t.Fatalf("GetMe() error = %v", err)
	}
	me, ok := meResponse.(openapi.GetMe200JSONResponse)
	if !ok ||
		me.Id.String() != handlerAccountID ||
		me.ImUserId == nil ||
		*me.ImUserId != "u_OPAQUE" ||
		service.getAccountID != handlerAccountID {
		t.Fatalf("GetMe() response = %#v", meResponse)
	}

	sessionResponse, err := handler.CreateHumanImSession(
		ctx,
		openapi.CreateHumanImSessionRequestObject{},
	)
	if err != nil {
		t.Fatalf("CreateHumanImSession() error = %v", err)
	}
	session, ok := sessionResponse.(openapi.CreateHumanImSession200JSONResponse)
	if !ok ||
		session.Body.SdkAppId != 1600000000 ||
		session.Body.UserId != "u_OPAQUE" ||
		session.Body.UserSig == nil ||
		*session.Body.UserSig != "short-lived-user-sig" ||
		!session.Body.ExpiresAt.Equal(expiry) ||
		session.Headers.CacheControl != "no-store" ||
		session.Headers.Pragma != "no-cache" ||
		service.sessionAccountID != handlerAccountID {
		t.Fatalf("CreateHumanImSession() response = %#v", sessionResponse)
	}
}

func TestMeHandlerRequiresCurrentHumanPrincipal(t *testing.T) {
	handler, err := NewMeHandler(&fakeHumanAccountService{})
	if err != nil {
		t.Fatal(err)
	}
	response, err := handler.GetMe(
		context.Background(),
		openapi.GetMeRequestObject{},
	)
	if response != nil || apperror.CodeOf(err) != "unauthenticated" {
		t.Fatalf("GetMe() = (%#v, %v)", response, err)
	}
}

func TestHumanRoutesExposeAuthAndMeButNotFutureOperations(t *testing.T) {
	authService := &fakeAccountAuthService{loginResult: handlerAuthResult()}
	meService := &fakeHumanAccountService{}
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	handler, err := NewHumanRoutes(authService, meService, encoder)
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/v1/auth/login"},
		{method: http.MethodGet, path: "/v1/me"},
		{method: http.MethodPost, path: "/v1/me/im/session"},
	} {
		request := httptest.NewRequest(route.method, route.path, nil)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code == http.StatusNotFound {
			t.Fatalf("%s %s was not registered", route.method, route.path)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/servers", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("GET /v1/servers status = %d", recorder.Code)
	}
}

func currentHumanContext(t *testing.T) context.Context {
	t.Helper()
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
	return context.WithValue(
		context.Background(),
		authStateContextKey{},
		state,
	)
}
