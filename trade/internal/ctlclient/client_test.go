package ctlclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// envelopeForSuccess 拼装 ctl successResponse 框架
func envelopeForSuccess(t *testing.T, data any) []byte {
	t.Helper()
	dataRaw, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal data: %v", err)
	}
	out, err := json.Marshal(map[string]any{
		"code":       "OK",
		"message":    "success",
		"data":       json.RawMessage(dataRaw),
		"request_id": "req-test",
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return out
}

// envelopeForError 拼装 ctl errorResponse 框架
func envelopeForError(t *testing.T, code, message, requestID string) []byte {
	t.Helper()
	out, err := json.Marshal(map[string]any{
		"code":       code,
		"message":    message,
		"request_id": requestID,
	})
	if err != nil {
		t.Fatalf("marshal err envelope: %v", err)
	}
	return out
}

func TestGetBundleByID_Success(t *testing.T) {
	wantBundleID := "bundle-pro-1y"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 校验 method + path + bearer
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		if got, want := r.URL.Path, "/internal/ctl/bundles/"+wantBundleID; got != want {
			t.Errorf("path mismatch: got %q want %q", got, want)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret-xyz" {
			t.Errorf("Authorization header mismatch: got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(envelopeForSuccess(t, &BundleDetail{
			BundleID:              wantBundleID,
			BundleName:            "Pro 一年",
			BundleState:           "ONLINE",
			AgentQuota:            5,
			Credit:                100000,
			BundleSalesAvailCount: 100,
			BundleSalesTotalCount: 100,
			BundleSalesState:      "AVAILABLE",
		}))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	got, err := c.GetBundleByID(context.Background(), wantBundleID)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got.BundleID != wantBundleID {
		t.Fatalf("BundleID mismatch: %+v", got)
	}
	if got.BundleState != "ONLINE" || got.AgentQuota != 5 || got.Credit != 100000 {
		t.Fatalf("payload field mismatch: %+v", got)
	}
}

func TestGetBundleByID_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write(envelopeForError(t, "NOT_FOUND", "bundle not found", "req-1"))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	_, err := c.GetBundleByID(context.Background(), "bundle-missing")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected errors.Is(err, ErrNotFound), got %v", err)
	}
}

func TestGetBundleByID_EmptyBundleIDClientSide(t *testing.T) {
	c := New("http://does-not-matter", "secret-xyz")
	_, err := c.GetBundleByID(context.Background(), "  ")
	if err == nil || !strings.Contains(err.Error(), "bundleID is required") {
		t.Fatalf("expected bundleID required err, got %v", err)
	}
}

func TestListInServicePasses_NonEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/ctl/passes" {
			t.Errorf("path mismatch: %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("external_user_id"); got != "user-aaa" {
			t.Errorf("external_user_id mismatch: %q", got)
		}
		if got := r.URL.Query().Get("state"); got != "in_service" {
			t.Errorf("state mismatch: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(envelopeForSuccess(t, map[string]any{
			"passes": []*PassDetail{
				{
					PassID:      "pass-1",
					UserID:      "user-aaa",
					BundleID:    "bundle-pro-1y",
					ExpiredTime: time.Now().Add(30 * 24 * time.Hour).UTC(),
				},
			},
		}))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	passes, err := c.ListInServicePasses(context.Background(), "user-aaa")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(passes) != 1 || passes[0].PassID != "pass-1" {
		t.Fatalf("unexpected passes: %+v", passes)
	}
}

func TestListInServicePasses_Empty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(envelopeForSuccess(t, map[string]any{"passes": []*PassDetail{}}))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	passes, err := c.ListInServicePasses(context.Background(), "user-aaa")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(passes) != 0 {
		t.Fatalf("expected empty, got %+v", passes)
	}
}

func TestListInServicePasses_EmptyExternalUserID(t *testing.T) {
	c := New("http://does-not-matter", "secret-xyz")
	_, err := c.ListInServicePasses(context.Background(), "  ")
	if err == nil || !strings.Contains(err.Error(), "externalUserID is required") {
		t.Fatalf("expected externalUserID required err, got %v", err)
	}
}

func TestCompletePass_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/internal/ctl/passes/complete" {
			t.Errorf("path mismatch: %s", r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type mismatch: %q", got)
		}
		// 反序列化请求体校验透传
		raw, _ := io.ReadAll(r.Body)
		var got CompletePassRequest
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("decode req body: %v", err)
		}
		if got.UserID != "user-aaa" || got.BundleID != "bundle-pro-1y" || got.TimeSpan != 12 ||
			got.TimeUnit != "m" || got.Uin != 100012345 || got.AppID != 1500001 ||
			got.DealName != "20260508-deal-1" {
			t.Errorf("req body mismatch: %+v", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(envelopeForSuccess(t, &PassDetail{
			PassID:   "pass-new",
			UserID:   got.UserID,
			BundleID: got.BundleID,
			Uin:      got.Uin,
			AppID:    got.AppID,
		}))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	got, err := c.CompletePass(context.Background(), &CompletePassRequest{
		UserID:   "user-aaa",
		BundleID: "bundle-pro-1y",
		TimeSpan: 12,
		TimeUnit: "m",
		Uin:      100012345,
		AppID:    1500001,
		DealName: "20260508-deal-1",
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got.PassID != "pass-new" {
		t.Fatalf("unexpected detail: %+v", got)
	}
}

func TestCompletePass_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write(envelopeForError(t, "UNAUTHORIZED", "bearer mismatch", "req-2"))
	}))
	defer srv.Close()

	c := New(srv.URL, "wrong-secret")
	_, err := c.CompletePass(context.Background(), &CompletePassRequest{
		UserID: "user-aaa", BundleID: "b", TimeSpan: 1, TimeUnit: "m", Uin: 1, AppID: 1, DealName: "d",
	})
	if err == nil {
		t.Fatalf("expected err, got nil")
	}
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected errors.Is ErrUnauthorized, got %v", err)
	}
}

func TestCompletePass_BusinessErrorPropagatesCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write(envelopeForError(t, "PASS_ALREADY_EXISTS", "user has active pass", "req-3"))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	_, err := c.CompletePass(context.Background(), &CompletePassRequest{
		UserID: "user-aaa", BundleID: "b", TimeSpan: 1, TimeUnit: "m", Uin: 1, AppID: 1, DealName: "d",
	})
	if err == nil {
		t.Fatalf("expected err, got nil")
	}
	var ctlErr *Error
	if !errors.As(err, &ctlErr) {
		t.Fatalf("expected errors.As *Error, got %v", err)
	}
	if ctlErr.HTTPStatus != http.StatusConflict {
		t.Errorf("HTTPStatus mismatch: %d", ctlErr.HTTPStatus)
	}
	if ctlErr.Code != "PASS_ALREADY_EXISTS" {
		t.Errorf("Code mismatch: %q", ctlErr.Code)
	}
	if ctlErr.RequestID != "req-3" {
		t.Errorf("RequestID mismatch: %q", ctlErr.RequestID)
	}
	if !strings.Contains(ctlErr.Message, "active pass") {
		t.Errorf("Message mismatch: %q", ctlErr.Message)
	}
}

func TestDo_ContextCancelStopsRequest(t *testing.T) {
	// server 故意阻塞 200ms，client ctx 50ms 后取消
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(200 * time.Millisecond):
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := c.GetBundleByID(ctx, "bundle-x")
	if err == nil {
		t.Fatalf("expected ctx timeout err, got nil")
	}
	if !errors.Is(err, context.DeadlineExceeded) && !strings.Contains(err.Error(), "context deadline exceeded") {
		t.Fatalf("expected context deadline exceeded, got %v", err)
	}
}

func TestNew_TrimsBaseURLAndToken(t *testing.T) {
	c := New("  http://ctl.local:8080/  ", "  secret-xyz  ").(*httpClient)
	if c.baseURL != "http://ctl.local:8080" {
		t.Errorf("baseURL not trimmed: %q", c.baseURL)
	}
	if c.token != "secret-xyz" {
		t.Errorf("token not trimmed: %q", c.token)
	}
	if c.httpClient.Timeout != 4*time.Second {
		t.Errorf("default timeout mismatch: %v", c.httpClient.Timeout)
	}
}

func TestNew_CustomHTTPClient(t *testing.T) {
	custom := &http.Client{Timeout: 7 * time.Second}
	c := New("http://x", "y", Options{HTTPClient: custom}).(*httpClient)
	if c.httpClient != custom {
		t.Fatalf("custom http client not adopted")
	}
}
