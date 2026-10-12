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
)

type recordingGroupObserver struct {
	joined, left []string
	destroyed    []string
	restricted   map[string]bool
}

func (observer *recordingGroupObserver) ObserveMembersJoined(_ context.Context, groupID string, userIDs []string) error {
	observer.joined = append(observer.joined, groupID+":"+strings.Join(userIDs, ","))
	return nil
}

func (observer *recordingGroupObserver) ObserveMembersLeft(_ context.Context, groupID string, userIDs []string) error {
	observer.left = append(observer.left, groupID+":"+strings.Join(userIDs, ","))
	return nil
}

func (observer *recordingGroupObserver) ObserveGroupDestroyed(_ context.Context, groupID string) error {
	observer.destroyed = append(observer.destroyed, groupID)
	return nil
}

func (observer *recordingGroupObserver) IsRestricted(_ context.Context, userID string) (bool, error) {
	return observer.restricted[userID], nil
}

func newTestCallbackDispatcher(t *testing.T, now time.Time, observer *recordingGroupObserver, restrictCreate bool) http.Handler {
	t.Helper()
	state, err := NewTencentIMStateCallbackHandler(TencentIMStateCallbackConfig{
		SDKAppID: 1600000000, Token: []byte("test-callback-token"),
		Clock: callbackClock{now: now}, MaxBodyBytes: 16 << 10,
	}, &recordingPresenceObserver{})
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewTencentIMCallbackDispatcher(state, TencentIMGroupCallbackConfig{
		SDKAppID: 1600000000, Token: []byte("test-callback-token"), Clock: callbackClock{now: now},
		MaxBodyBytes: 64 << 10, AdminUserID: "platform_admin", RestrictClientGroupCreate: restrictCreate,
	}, observer)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func signedCommandRequest(now time.Time, command, body string) *http.Request {
	requestTime := strconv.FormatInt(now.Unix(), 10)
	sign := sha256.Sum256([]byte("test-callback-token" + requestTime))
	target := "/v1/callbacks/tencent-im/state?SdkAppid=1600000000&CallbackCommand=" + command +
		"&contenttype=json&RequestTime=" + requestTime + "&Sign=" + hex.EncodeToString(sign[:])
	request := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func TestTencentIMCallbackDispatcherReconcilesGroupMembership(t *testing.T) {
	now := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	observer := &recordingGroupObserver{}
	handler := newTestCallbackDispatcher(t, now, observer, false)

	for _, test := range []struct{ command, body string }{
		{groupAfterJoinCommand, `{"CallbackCommand":"Group.CallbackAfterNewMemberJoin","GroupId":"vg_x","NewMemberList":[{"Member_Account":"a_bot"}]}`},
		{groupAfterExitCommand, `{"CallbackCommand":"Group.CallbackAfterMemberExit","GroupId":"vg_x","ExitMemberList":[{"Member_Account":"u_a"}]}`},
		{groupAfterDestroyCommand, `{"CallbackCommand":"Group.CallbackAfterGroupDestroyed","GroupId":"vg_x"}`},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, signedCommandRequest(now, test.command, test.body))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"ErrorCode":0`) {
			t.Fatalf("%s response = %d %s", test.command, response.Code, response.Body)
		}
	}
	if len(observer.joined) != 1 || observer.joined[0] != "vg_x:a_bot" ||
		len(observer.left) != 1 || observer.left[0] != "vg_x:u_a" ||
		len(observer.destroyed) != 1 {
		t.Fatalf("observer = %#v", observer)
	}
}

func TestTencentIMCallbackDispatcherRejectsRestrictedSenderAndClientGroupCreate(t *testing.T) {
	now := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	observer := &recordingGroupObserver{restricted: map[string]bool{"u_banned": true}}
	handler := newTestCallbackDispatcher(t, now, observer, true)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, signedCommandRequest(now, groupBeforeSendCommand,
		`{"CallbackCommand":"Group.CallbackBeforeSendMsg","GroupId":"vg_x","From_Account":"u_banned"}`))
	if !strings.Contains(response.Body.String(), `"ErrorCode":1`) {
		t.Fatalf("restricted sender response = %s", response.Body)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, signedCommandRequest(now, c2cBeforeSendCommand,
		`{"CallbackCommand":"C2C.CallbackBeforeSendMsg","From_Account":"u_ok"}`))
	if !strings.Contains(response.Body.String(), `"ErrorCode":0`) {
		t.Fatalf("allowed sender response = %s", response.Body)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, signedCommandRequest(now, groupBeforeCreateCommand,
		`{"CallbackCommand":"Group.CallbackBeforeCreateGroup","Operator_Account":"u_client"}`))
	if !strings.Contains(response.Body.String(), `"ErrorCode":1`) {
		t.Fatalf("client group create response = %s", response.Body)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, signedCommandRequest(now, groupBeforeCreateCommand,
		`{"CallbackCommand":"Group.CallbackBeforeCreateGroup","Operator_Account":"platform_admin"}`))
	if !strings.Contains(response.Body.String(), `"ErrorCode":0`) {
		t.Fatalf("admin group create response = %s", response.Body)
	}
}

func TestTencentIMCallbackDispatcherRejectsBadSignature(t *testing.T) {
	now := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	handler := newTestCallbackDispatcher(t, now, &recordingGroupObserver{}, false)
	request := signedCommandRequest(now, groupAfterJoinCommand, `{"CallbackCommand":"Group.CallbackAfterNewMemberJoin"}`)
	query := request.URL.Query()
	query.Set("Sign", strings.Repeat("0", 64))
	request.URL.RawQuery = query.Encode()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("bad signature status = %d", response.Code)
	}
}
