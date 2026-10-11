package httptransport

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	appagentpresence "chatserver/internal/app/agentpresence"
)

type callbackClock struct{ now time.Time }

func (clock callbackClock) Now() time.Time { return clock.now }

type recordingPresenceObserver struct {
	values []appagentpresence.IMObservation
	err    error
}

func (observer *recordingPresenceObserver) ObserveIMPresence(
	_ context.Context,
	value appagentpresence.IMObservation,
) error {
	observer.values = append(observer.values, value)
	return observer.err
}

func TestTencentIMStateCallbackAuthenticatesAndProjectsLogin(t *testing.T) {
	now := time.Date(2026, 7, 31, 18, 0, 0, 0, time.UTC)
	observer := &recordingPresenceObserver{}
	handler, err := NewTencentIMStateCallbackHandler(
		TencentIMStateCallbackConfig{
			SDKAppID:     1600000000,
			Token:        []byte("test-callback-token"),
			Clock:        callbackClock{now: now},
			MaxBodyBytes: 16 << 10,
		},
		observer,
	)
	if err != nil {
		t.Fatal(err)
	}
	body := `{
		"CallbackCommand":"State.StateChange",
		"EventTime":1785492000123,
		"Info":{
			"Action":"Login",
			"To_Account":"a_TEST_ONLY",
			"Reason":"Register"
		}
	}`
	request := signedCallbackRequest(
		t,
		now,
		"test-callback-token",
		body,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), `"ActionStatus":"OK"`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if len(observer.values) != 1 {
		t.Fatalf("observations = %#v", observer.values)
	}
	got := observer.values[0]
	if got.IMUserID != "a_TEST_ONLY" ||
		got.Presence != "online" ||
		got.Reason != "Register" ||
		got.ObservedAt.UnixMilli() != 1785492000123 {
		t.Fatalf("observation = %#v", got)
	}
}

func TestTencentIMStateCallbackRejectsInvalidEnvelope(t *testing.T) {
	now := time.Date(2026, 7, 31, 18, 0, 0, 0, time.UTC)
	tests := []struct {
		name        string
		requestTime time.Time
		token       string
		query       string
		body        string
	}{
		{
			name:        "bad signature",
			requestTime: now,
			token:       "wrong-token",
			query:       "SdkAppid=1600000000&CallbackCommand=State.StateChange&contenttype=json",
			body:        validStateCallbackBody(),
		},
		{
			name:        "expired signature",
			requestTime: now.Add(-2 * time.Minute),
			token:       "test-callback-token",
			query:       "SdkAppid=1600000000&CallbackCommand=State.StateChange&contenttype=json",
			body:        validStateCallbackBody(),
		},
		{
			name:        "wrong SDKAppID",
			requestTime: now,
			token:       "test-callback-token",
			query:       "SdkAppid=1600000001&CallbackCommand=State.StateChange&contenttype=json",
			body:        validStateCallbackBody(),
		},
		{
			name:        "command mismatch",
			requestTime: now,
			token:       "test-callback-token",
			query:       "SdkAppid=1600000000&CallbackCommand=State.StateChange&contenttype=json",
			body: strings.Replace(
				validStateCallbackBody(),
				"State.StateChange",
				"Group.CallbackAfterSendMsg",
				1,
			),
		},
		{
			name:        "duplicate SDKAppID",
			requestTime: now,
			token:       "test-callback-token",
			query:       "SdkAppid=1600000000&SdkAppid=1600000000&CallbackCommand=State.StateChange&contenttype=json",
			body:        validStateCallbackBody(),
		},
		{
			name:        "trailing JSON",
			requestTime: now,
			token:       "test-callback-token",
			query:       "SdkAppid=1600000000&CallbackCommand=State.StateChange&contenttype=json",
			body:        validStateCallbackBody() + `{}`,
		},
		{
			name:        "body too large",
			requestTime: now,
			token:       "test-callback-token",
			query:       "SdkAppid=1600000000&CallbackCommand=State.StateChange&contenttype=json",
			body:        strings.Repeat(" ", 16<<10) + validStateCallbackBody(),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			observer := &recordingPresenceObserver{}
			handler, err := NewTencentIMStateCallbackHandler(
				TencentIMStateCallbackConfig{
					SDKAppID:     1600000000,
					Token:        []byte("test-callback-token"),
					Clock:        callbackClock{now: now},
					MaxBodyBytes: 16 << 10,
				},
				observer,
			)
			if err != nil {
				t.Fatal(err)
			}
			request := callbackRequest(
				t,
				test.requestTime,
				test.token,
				test.query,
				test.body,
			)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code == http.StatusOK || len(observer.values) != 0 {
				t.Fatalf(
					"response=%d observations=%#v",
					response.Code,
					observer.values,
				)
			}
		})
	}
}

func TestTencentIMStateCallbackProjectsLogoutAndDisconnectOffline(
	t *testing.T,
) {
	now := time.Date(2026, 7, 31, 18, 0, 0, 0, time.UTC)
	for _, action := range []string{"Logout", "Disconnect"} {
		t.Run(action, func(t *testing.T) {
			observer := &recordingPresenceObserver{}
			handler, err := NewTencentIMStateCallbackHandler(
				TencentIMStateCallbackConfig{
					SDKAppID:     1600000000,
					Token:        []byte("test-callback-token"),
					Clock:        callbackClock{now: now},
					MaxBodyBytes: 16 << 10,
				},
				observer,
			)
			if err != nil {
				t.Fatal(err)
			}
			body := strings.Replace(
				validStateCallbackBody(),
				`"Action":"Login"`,
				`"Action":"`+action+`"`,
				1,
			)
			response := httptest.NewRecorder()
			handler.ServeHTTP(
				response,
				signedCallbackRequest(t, now, "test-callback-token", body),
			)
			if response.Code != http.StatusOK ||
				len(observer.values) != 1 ||
				observer.values[0].Presence != "offline" {
				t.Fatalf(
					"response=%d observations=%#v",
					response.Code,
					observer.values,
				)
			}
		})
	}
}

func TestTencentIMStateCallbackAcknowledgesCustomStatusWithoutProjection(
	t *testing.T,
) {
	now := time.Date(2026, 7, 31, 18, 0, 0, 0, time.UTC)
	observer := &recordingPresenceObserver{}
	handler, err := NewTencentIMStateCallbackHandler(
		TencentIMStateCallbackConfig{
			SDKAppID:     1600000000,
			Token:        []byte("test-callback-token"),
			Clock:        callbackClock{now: now},
			MaxBodyBytes: 16 << 10,
		},
		observer,
	)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Replace(
		validStateCallbackBody(),
		`"Action":"Login"`,
		`"Action":"CustomStatusChange"`,
		1,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		signedCallbackRequest(t, now, "test-callback-token", body),
	)
	if response.Code != http.StatusOK || len(observer.values) != 0 {
		t.Fatalf(
			"response=%d observations=%#v",
			response.Code,
			observer.values,
		)
	}
}

func signedCallbackRequest(
	t *testing.T,
	now time.Time,
	token string,
	body string,
) *http.Request {
	t.Helper()
	return callbackRequest(
		t,
		now,
		token,
		"SdkAppid=1600000000&CallbackCommand=State.StateChange&contenttype=json",
		body,
	)
}

func callbackRequest(
	t *testing.T,
	requestTime time.Time,
	token string,
	query string,
	body string,
) *http.Request {
	t.Helper()
	timestamp := strconv.FormatInt(requestTime.Unix(), 10)
	digest := sha256.Sum256([]byte(token + timestamp))
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/callbacks/tencent-im/state?"+query+
			"&RequestTime="+timestamp+
			"&Sign="+hex.EncodeToString(digest[:]),
		strings.NewReader(body),
	)
	request.Header.Set("Content-Type", "application/json")
	return request
}

func validStateCallbackBody() string {
	return `{
		"CallbackCommand":"State.StateChange",
		"EventTime":1785492000123,
		"Info":{
			"Action":"Login",
			"To_Account":"a_TEST_ONLY",
			"Reason":"Register"
		}
	}`
}
