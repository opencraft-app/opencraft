package httptransport

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatserver/internal/apperror"
)

func TestStdHTTPBindErrorUsesUnifiedEnvelope(t *testing.T) {
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	handler := StdHTTPErrorHandler(encoder)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/", nil)

	handler(
		recorder,
		request,
		errors.New("failed parsing Authorization Bearer secret"),
	)

	assertErrorEnvelope(t, recorder, http.StatusBadRequest, "invalid_request")
	if strings.Contains(recorder.Body.String(), "Bearer") {
		t.Fatalf("response leaked bind error: %s", recorder.Body)
	}
}

func TestStrictRequestErrorUsesUnifiedEnvelope(t *testing.T) {
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	options := StrictServerOptions(encoder)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/", nil)

	options.RequestErrorHandlerFunc(
		recorder,
		request,
		errors.New("invalid JSON contains token secret"),
	)

	assertErrorEnvelope(t, recorder, http.StatusBadRequest, "invalid_request")
	if strings.Contains(recorder.Body.String(), "token secret") {
		t.Fatalf("response leaked request decode error: %s", recorder.Body)
	}
}

func TestStrictResponseErrorUsesInternalErrorWithoutLeak(t *testing.T) {
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	options := StrictServerOptions(encoder)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/", nil)

	options.ResponseErrorHandlerFunc(
		recorder,
		request,
		errors.New("unexpected response contains database password"),
	)

	assertErrorEnvelope(t, recorder, http.StatusInternalServerError, "internal_error")
	if strings.Contains(recorder.Body.String(), "database password") {
		t.Fatalf("response leaked response error: %s", recorder.Body)
	}
}

func TestStrictResponseErrorPreservesKnownApplicationCode(t *testing.T) {
	encoder := NewErrorEncoder(fixedRequestIDGenerator{value: "request-1"})
	options := StrictServerOptions(encoder)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/auth/register", nil)

	options.ResponseErrorHandlerFunc(
		recorder,
		request,
		apperror.New("account_already_exists", "该邮箱已注册", nil),
	)

	assertErrorEnvelope(
		t,
		recorder,
		http.StatusConflict,
		"account_already_exists",
	)
}
