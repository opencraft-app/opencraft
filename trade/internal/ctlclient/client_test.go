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

func TestListPassesByUser_NonEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/ctl/passes" {
			t.Errorf("path mismatch: %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("external_user_id"); got != "user-aaa" {
			t.Errorf("external_user_id mismatch: %q", got)
		}
		// Q66 修订 + Q69：不再带 state 参数（互斥占用规则只看是否存在记录）
		if got := r.URL.Query().Get("state"); got != "" {
			t.Errorf("state should not be set, got %q", got)
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
	passes, err := c.ListPassesByUser(context.Background(), "user-aaa")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(passes) != 1 || passes[0].PassID != "pass-1" {
		t.Fatalf("unexpected passes: %+v", passes)
	}
}

func TestListPassesByUser_Empty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(envelopeForSuccess(t, map[string]any{"passes": []*PassDetail{}}))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	passes, err := c.ListPassesByUser(context.Background(), "user-aaa")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(passes) != 0 {
		t.Fatalf("expected empty, got %+v", passes)
	}
}

func TestListPassesByUser_EmptyExternalUserID(t *testing.T) {
	c := New("http://does-not-matter", "secret-xyz")
	_, err := c.ListPassesByUser(context.Background(), "  ")
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

func TestTransferPass_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/internal/ctl/passes/transfer" {
			t.Errorf("path mismatch: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret-xyz" {
			t.Errorf("Authorization header mismatch: got %q", got)
		}
		raw, _ := io.ReadAll(r.Body)
		var got TransferPassRequest
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("decode req body: %v", err)
		}
		if got.PassID != "pass-free" || got.UserID != "user-aaa" ||
			got.SourceBundleID != "bundle_free_trial_01" || got.TargetBundleID != "bundle_launch_01" ||
			got.NewUin != 330500000004 || got.NewAppID != 1447552654 || got.DealName != "deal-transfer-1" {
			t.Errorf("req body mismatch: %+v", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(envelopeForSuccess(t, &PassDetail{
			PassID:   got.PassID,
			UserID:   got.UserID,
			BundleID: got.TargetBundleID,
			Uin:      got.NewUin,
			AppID:    got.NewAppID,
		}))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	got, err := c.TransferPass(context.Background(), &TransferPassRequest{
		PassID:         "pass-free",
		UserID:         "user-aaa",
		SourceBundleID: "bundle_free_trial_01",
		TargetBundleID: "bundle_launch_01",
		NewUin:         330500000004,
		NewAppID:       1447552654,
		DealName:       "deal-transfer-1",
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got.PassID != "pass-free" || got.BundleID != "bundle_launch_01" {
		t.Fatalf("unexpected detail: %+v", got)
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

// ============================================================================
// R-C RenewPass 测试（设计稿 .tmp/trade-pass-renew-design.md §4.3 / §5.2 + R-D 待落地 ctl endpoint）
// ============================================================================

func TestRenewPass_Success(t *testing.T) {
	wantPassID := "pass-renew-1"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if got, want := r.URL.Path, "/internal/ctl/passes/"+wantPassID+"/renew"; got != want {
			t.Errorf("path mismatch: got %q want %q", got, want)
		}
		// 反序列化请求体校验透传
		raw, _ := io.ReadAll(r.Body)
		var got RenewPassRequest
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("decode req body: %v", err)
		}
		if got.TimeSpan != 1 || got.TimeUnit != "y" || got.DealName != "deal-r-c-renew-1" || got.FlowID != 1234 {
			t.Errorf("req body mismatch: %+v", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(envelopeForSuccess(t, &RenewPassResponse{
			PassID: wantPassID,
			TaskID: "task-renew-aaa",
		}))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	got, err := c.RenewPass(context.Background(), wantPassID, &RenewPassRequest{
		TimeSpan: 1,
		TimeUnit: "y", // Q19=b 全链路放开 m/d/y
		DealName: "deal-r-c-renew-1",
		FlowID:   1234,
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got.PassID != wantPassID || got.TaskID != "task-renew-aaa" {
		t.Fatalf("response mismatch: %+v", got)
	}
}

func TestRenewPass_EmptyPassIDClientSide(t *testing.T) {
	c := New("http://does-not-matter", "secret-xyz")
	_, err := c.RenewPass(context.Background(), "  ", &RenewPassRequest{TimeSpan: 1, TimeUnit: "m", DealName: "d"})
	if err == nil || !strings.Contains(err.Error(), "passID is required") {
		t.Fatalf("expected passID required err, got %v", err)
	}
}

// TestRenewPass_NilRequestSafe 验证 req == nil 时方法不 panic（兜底空 RenewPassRequest{}）。
// 真实路径上 trade renewresource handler 必传非 nil req；这里只是防御。
func TestRenewPass_NilRequestSafe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 空 body 解析为 RenewPassRequest 零值，不报错
		raw, _ := io.ReadAll(r.Body)
		var got RenewPassRequest
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatalf("decode: %v", err)
			}
		}
		// 零值 TimeSpan/TimeUnit/DealName/FlowID 都应是默认值
		if got.TimeSpan != 0 || got.TimeUnit != "" || got.DealName != "" || got.FlowID != 0 {
			t.Errorf("expected zero RenewPassRequest, got %+v", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(envelopeForSuccess(t, &RenewPassResponse{PassID: "pass-x", TaskID: "task-x"}))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	got, err := c.RenewPass(context.Background(), "pass-x", nil)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got.PassID != "pass-x" {
		t.Fatalf("response mismatch: %+v", got)
	}
}

func TestRenewPass_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write(envelopeForError(t, ErrCodePassNotFound, "pass not found", "req-rn-1"))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	_, err := c.RenewPass(context.Background(), "pass-missing", &RenewPassRequest{
		TimeSpan: 1, TimeUnit: "m", DealName: "d",
	})
	if err == nil {
		t.Fatalf("expected err, got nil")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected errors.Is ErrNotFound, got %v", err)
	}
}

func TestRenewPass_BusinessErrorRenewing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write(envelopeForError(t, ErrCodePassRenewing, "pass already renewing", "req-rn-2"))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	_, err := c.RenewPass(context.Background(), "pass-1", &RenewPassRequest{
		TimeSpan: 1, TimeUnit: "m", DealName: "d",
	})
	if err == nil {
		t.Fatalf("expected err, got nil")
	}
	var ctlErr *Error
	if !errors.As(err, &ctlErr) {
		t.Fatalf("expected errors.As *Error, got %v", err)
	}
	if ctlErr.HTTPStatus != http.StatusForbidden {
		t.Errorf("HTTPStatus mismatch: %d", ctlErr.HTTPStatus)
	}
	if ctlErr.Code != ErrCodePassRenewing {
		t.Errorf("Code mismatch: %q", ctlErr.Code)
	}
}

func TestRenewPass_NotImplemented(t *testing.T) {
	// cvm-kind 异步路径占位返 501（与 ctl/pkg/errcode/pass.go R-B 已加 ErrPassRenewNotImplemented 对偶）
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotImplemented)
		_, _ = w.Write(envelopeForError(t, ErrCodePassRenewNotImplement,
			"cvm-kind async renew not yet implemented", "req-rn-3"))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	_, err := c.RenewPass(context.Background(), "pass-cvm-1", &RenewPassRequest{
		TimeSpan: 1, TimeUnit: "m", DealName: "d",
	})
	if err == nil {
		t.Fatalf("expected err, got nil")
	}
	var ctlErr *Error
	if !errors.As(err, &ctlErr) {
		t.Fatalf("expected errors.As *Error, got %v", err)
	}
	if ctlErr.HTTPStatus != http.StatusNotImplemented {
		t.Errorf("HTTPStatus mismatch: %d", ctlErr.HTTPStatus)
	}
	if ctlErr.Code != ErrCodePassRenewNotImplement {
		t.Errorf("Code mismatch: %q", ctlErr.Code)
	}
}

// ============================================================================
// D-5b DestroyPass 测试（设计稿 .tmp/trade-pass-destroy-design.md §3.5 / §4.5.2 / §4.5.3）
// ============================================================================

func TestDestroyPass_Success(t *testing.T) {
	wantPassID := "pass-destroy-1"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if got, want := r.URL.Path, "/internal/ctl/passes/"+wantPassID+"/destroy"; got != want {
			t.Errorf("path mismatch: got %q want %q", got, want)
		}
		raw, _ := io.ReadAll(r.Body)
		var got DestroyPassRequest
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("decode req body: %v", err)
		}
		if got.FlowID != 9001 {
			t.Errorf("FlowID mismatch: %d", got.FlowID)
		}
		if got.DestroyReason != "biz" {
			t.Errorf("DestroyReason mismatch: %q (Q24 透传)", got.DestroyReason)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(envelopeForSuccess(t, &DestroyPassResponse{
			PassID: wantPassID,
			TaskID: "task-destroy-aaa",
		}))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	got, err := c.DestroyPass(context.Background(), wantPassID, &DestroyPassRequest{
		FlowID:        9001,
		DestroyReason: "biz",
	})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got.PassID != wantPassID || got.TaskID != "task-destroy-aaa" {
		t.Fatalf("response mismatch: %+v", got)
	}
}

func TestDestroyPass_EmptyPassIDClientSide(t *testing.T) {
	c := New("http://does-not-matter", "secret-xyz")
	_, err := c.DestroyPass(context.Background(), "  ", &DestroyPassRequest{FlowID: 1, DestroyReason: "biz"})
	if err == nil || !strings.Contains(err.Error(), "passID is required") {
		t.Fatalf("expected passID required err, got %v", err)
	}
}

// TestDestroyPass_NilRequestSafe 验证 req == nil 时方法不 panic（兜底空 DestroyPassRequest{}）。
func TestDestroyPass_NilRequestSafe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var got DestroyPassRequest
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatalf("decode: %v", err)
			}
		}
		if got.FlowID != 0 || got.DestroyReason != "" {
			t.Errorf("expected zero DestroyPassRequest, got %+v", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(envelopeForSuccess(t, &DestroyPassResponse{PassID: "p-x", TaskID: "t-x"}))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	if _, err := c.DestroyPass(context.Background(), "p-x", nil); err != nil {
		t.Fatalf("nil req should be safe, got err: %v", err)
	}
}

// TestDestroyPass_NotFound_TypedErrNotFound 验证 ctl 返 404 时 ErrNotFound（与 IsolatePass 同范式）。
func TestDestroyPass_NotFound_TypedErrNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write(envelopeForError(t, ErrCodePassNotFound, "pass not found", "req-d-1"))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	_, err := c.DestroyPass(context.Background(), "p-1", &DestroyPassRequest{FlowID: 1})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected errors.Is ErrNotFound, got %v", err)
	}
}

// TestDestroyPass_Terminating_TypedError 验证 ctl 返 403 PASS_TERMINATING 时返 *Error
// 且 Code == ErrCodePassTerminating（trade handler 据此走 600402 让 jifei 重试）。
func TestDestroyPass_Terminating_TypedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write(envelopeForError(t, ErrCodePassTerminating, "pass already terminating", "req-d-2"))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	_, err := c.DestroyPass(context.Background(), "p-2", &DestroyPassRequest{FlowID: 1})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	var ctlErr *Error
	if !errors.As(err, &ctlErr) {
		t.Fatalf("expected errors.As *Error, got %v", err)
	}
	if ctlErr.HTTPStatus != http.StatusForbidden {
		t.Errorf("HTTPStatus mismatch: %d", ctlErr.HTTPStatus)
	}
	if ctlErr.Code != ErrCodePassTerminating {
		t.Errorf("Code mismatch: %q", ctlErr.Code)
	}
}

// TestDestroyPass_InvalidParam_TypedError 验证 ctl 返 400 PASS_INVALID_PARAM
// （pass status 不在 {deleting, isolated} 集合）→ *Error.Code 类型化判定。
func TestDestroyPass_InvalidParam_TypedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write(envelopeForError(t, ErrCodePassInvalidParam,
			"pass status \"active\" not eligible for destroy", "req-d-3"))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-xyz")
	_, err := c.DestroyPass(context.Background(), "p-3", &DestroyPassRequest{FlowID: 1})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	var ctlErr *Error
	if !errors.As(err, &ctlErr) {
		t.Fatalf("expected errors.As *Error, got %v", err)
	}
	if ctlErr.HTTPStatus != http.StatusBadRequest {
		t.Errorf("HTTPStatus mismatch: %d", ctlErr.HTTPStatus)
	}
	if ctlErr.Code != ErrCodePassInvalidParam {
		t.Errorf("Code mismatch: %q", ctlErr.Code)
	}
}
