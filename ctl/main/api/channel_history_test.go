package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ctl/pkg/transport"
)

func TestChannelHistoryRoutesRequireFlagAndUser(t *testing.T) {
	stub := &stubLogic{channelSessionsResp: &transport.ChannelSessionsResponse{Items: []transport.ChannelSession{}}}
	router := newRouter(&instanceHandler{logic: stub}, &bundleHandler{}, &passHandler{})
	path := "/v1/instances/ins-1/bots/bot-1/channel-sessions"

	for _, flag := range []string{"", "false"} {
		t.Setenv("CHANNEL_HISTORY_ENABLED", flag)
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("X-User-Id", "user-1")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("flag=%q disabled status=%d body=%s", flag, rec.Code, rec.Body.String())
		}
	}

	t.Setenv("CHANNEL_HISTORY_ENABLED", "true")
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("no user status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, path+"?limit=100", nil)
	req.Header.Set("X-User-Id", "user-1")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid limit status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, path+"/session-1/messages?limit=21", nil)
	req.Header.Set("X-User-Id", "user-1")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid message limit status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestChannelHistoryRoutesReturnReadOnlyPages(t *testing.T) {
	t.Setenv("CHANNEL_HISTORY_ENABLED", "true")
	stub := &stubLogic{
		channelSessionsResp: &transport.ChannelSessionsResponse{Items: []transport.ChannelSession{{ID: "session-1", Source: "feishu", ChatType: "group"}}},
		channelMessagesResp: &transport.ChannelMessagesResponse{Items: []transport.ChannelMessage{{ID: 1, Role: "user", Text: "hello"}}},
	}
	router := newRouter(&instanceHandler{logic: stub}, &bundleHandler{}, &passHandler{})
	for _, path := range []string{
		"/v1/instances/ins-1/bots/bot-1/channel-sessions",
		"/v1/instances/ins-1/bots/bot-1/channel-sessions/session-1/messages",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("X-User-Id", "user-1")
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", path, rec.Code, rec.Body.String())
		}
		var body struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || len(body.Data) == 0 {
			t.Fatalf("%s invalid response: %s", path, rec.Body.String())
		}
	}
}
