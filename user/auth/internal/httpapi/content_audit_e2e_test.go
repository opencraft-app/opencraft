package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/contentaudit"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
)

func TestContentAuditDisabledProfileUpdateE2E(t *testing.T) {
	t.Parallel()

	harness := newContentAuditE2EHarness(service.ContentAuditConfig{Enabled: false})
	sessionCookie := harness.signUp(t, "audit-disabled@example.com")

	update := performJSONRequest(t, harness.router, http.MethodPut, "/auth/profile", map[string]any{
		"name": "新昵称",
	}, sessionCookie)
	if update.Code != http.StatusOK {
		t.Fatalf("expected 200 from profile update, got %d: %s", update.Code, update.Body.String())
	}
	var updateBody profileResponseBody
	decodeJSONResponse(t, update, &updateBody)
	if updateBody.User.Name != "新昵称" || updateBody.User.PendingName != "" || updateBody.User.NameAuditStatus != "" {
		t.Fatalf("expected disabled audit to rename directly, got %+v", updateBody.User)
	}
}

func TestContentAuditCallbackPassesPendingNameE2E(t *testing.T) {
	t.Parallel()

	harness := newContentAuditE2EHarness(service.ContentAuditConfig{
		Enabled:   true,
		ProductID: "30003",
		UserSID:   "300025",
	})
	sessionCookie := harness.signUp(t, "audit-pass@example.com")

	update := performJSONRequest(t, harness.router, http.MethodPut, "/auth/profile", map[string]any{
		"name": "待审核昵称",
	}, sessionCookie)
	if update.Code != http.StatusOK {
		t.Fatalf("expected 200 from profile update, got %d: %s", update.Code, update.Body.String())
	}
	var updateBody profileResponseBody
	decodeJSONResponse(t, update, &updateBody)
	if updateBody.User.Name != "旧昵称" || updateBody.User.PendingName != "待审核昵称" || updateBody.User.NameAuditStatus != "pending" {
		t.Fatalf("expected pending audit response, got %+v", updateBody.User)
	}

	if err := harness.worker.RunOnce(context.Background(), 20); err != nil {
		t.Fatalf("run content audit worker: %v", err)
	}
	if harness.client.requestID == "" {
		t.Fatal("expected worker to submit a content audit request")
	}

	callback := performJSONRequest(t, harness.router, http.MethodPost, "/contentaudit/callback", map[string]any{
		"Comm": map[string]any{"uiHitSource": 0},
		"Res": map[string]any{
			"uiResultCode": 2,
			"uiResultType": 0,
			"strResultMsg": "pass",
			"ResID": map[string]any{
				"strMsgID": harness.client.requestID,
			},
		},
	})
	if callback.Code != http.StatusOK {
		t.Fatalf("expected 200 from content audit callback, got %d: %s", callback.Code, callback.Body.String())
	}

	profile := performJSONRequest(t, harness.router, http.MethodGet, "/auth/profile", nil, sessionCookie)
	if profile.Code != http.StatusOK {
		t.Fatalf("expected 200 from profile, got %d: %s", profile.Code, profile.Body.String())
	}
	var profileBody profileResponseBody
	decodeJSONResponse(t, profile, &profileBody)
	if profileBody.User.Name != "待审核昵称" || profileBody.User.PendingName != "" || profileBody.User.NameAuditStatus != "passed" {
		t.Fatalf("expected callback pass to apply pending nickname, got %+v", profileBody.User)
	}
}

func TestContentAuditCallbackRejectsPendingNameE2E(t *testing.T) {
	t.Parallel()

	harness := newContentAuditE2EHarness(service.ContentAuditConfig{
		Enabled:   true,
		ProductID: "30003",
		UserSID:   "300025",
	})
	sessionCookie := harness.signUp(t, "audit-fail@example.com")

	update := performJSONRequest(t, harness.router, http.MethodPut, "/auth/profile", map[string]any{
		"name": "违规昵称",
	}, sessionCookie)
	if update.Code != http.StatusOK {
		t.Fatalf("expected 200 from profile update, got %d: %s", update.Code, update.Body.String())
	}
	if err := harness.worker.RunOnce(context.Background(), 20); err != nil {
		t.Fatalf("run content audit worker: %v", err)
	}

	callback := performJSONRequest(t, harness.router, http.MethodPost, "/contentaudit/callback", map[string]any{
		"Comm": map[string]any{"uiHitSource": 0},
		"Res": map[string]any{
			"uiResultCode": 1,
			"uiResultType": 20007,
			"strResultMsg": "malicious",
			"ResID": map[string]any{
				"strMsgID": harness.client.requestID,
			},
		},
	})
	if callback.Code != http.StatusOK {
		t.Fatalf("expected 200 from content audit callback, got %d: %s", callback.Code, callback.Body.String())
	}

	profile := performJSONRequest(t, harness.router, http.MethodGet, "/auth/profile", nil, sessionCookie)
	if profile.Code != http.StatusOK {
		t.Fatalf("expected 200 from profile, got %d: %s", profile.Code, profile.Body.String())
	}
	var profileBody profileResponseBody
	decodeJSONResponse(t, profile, &profileBody)
	if profileBody.User.Name != "旧昵称" || profileBody.User.PendingName != "" || profileBody.User.NameAuditStatus != "failed" {
		t.Fatalf("expected callback rejection to keep old nickname, got %+v", profileBody.User)
	}
}

type contentAuditE2EHarness struct {
	router http.Handler
	worker *service.ContentAuditWorker
	client *capturingContentAuditClient
}

func newContentAuditE2EHarness(cfg service.ContentAuditConfig) contentAuditE2EHarness {
	gin.SetMode(gin.TestMode)
	store := service.NewMemoryStore(service.StoreOptions{
		Now:                fixedHTTPTestNow,
		SeedDefaultInvites: true,
	})
	svc := service.NewWithStore(store, service.Options{
		Now:          fixedHTTPTestNow,
		SessionTTL:   30 * 24 * time.Hour,
		ContentAudit: cfg,
	})
	client := &capturingContentAuditClient{}
	return contentAuditE2EHarness{
		router: NewRouter(svc, ServerConfig{
			CookieSecure:   true,
			CookieSameSite: http.SameSiteNoneMode,
			SessionTTL:     30 * 24 * time.Hour,
			PublicBaseURL:  "https://lightclaw.tech",
		}),
		worker: service.NewContentAuditWorker(store, client, cfg, service.ContentAuditWorkerOptions{Now: fixedHTTPTestNow}),
		client: client,
	}
}

func (h contentAuditE2EHarness) signUp(t *testing.T, email string) *http.Cookie {
	t.Helper()

	signUp := performJSONRequest(t, h.router, http.MethodPost, "/auth/password/sign-up", map[string]any{
		"name":       "旧昵称",
		"email":      email,
		"password":   "password123",
		"inviteCode": "VALID2026",
	})
	if signUp.Code != http.StatusOK {
		t.Fatalf("expected 200 from sign-up, got %d: %s", signUp.Code, signUp.Body.String())
	}
	return sessionCookieFromRecorder(t, signUp)
}

type capturingContentAuditClient struct {
	requestID string
}

func (c *capturingContentAuditClient) CreateTextTask(_ context.Context, req contentaudit.CreateTextTaskRequest) (*contentaudit.CreateTextTaskResponse, error) {
	c.requestID = req.RequestID
	return &contentaudit.CreateTextTaskResponse{
		Response: contentaudit.CreateTextTaskResponseBody{
			RequestID: req.RequestID,
			Data: &contentaudit.CreateTextTaskResponseData{
				Result: &contentaudit.ResponseResult{StdRetMsg: "UNKNOWN"},
			},
		},
	}, nil
}

func (c *capturingContentAuditClient) CreateImageTask(_ context.Context, req contentaudit.CreateImageTaskRequest) (*contentaudit.CreateTextTaskResponse, error) {
	c.requestID = req.RequestID
	return &contentaudit.CreateTextTaskResponse{
		Response: contentaudit.CreateTextTaskResponseBody{
			RequestID: req.RequestID,
			Data: &contentaudit.CreateTextTaskResponseData{
				Result: &contentaudit.ResponseResult{StdRetMsg: "UNKNOWN"},
			},
		},
	}, nil
}
