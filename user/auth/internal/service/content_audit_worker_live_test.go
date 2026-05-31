package service

import (
	"context"
	"os"
	"testing"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/contentaudit"
)

func TestLiveContentAuditWorkerSubmitsNameAudit(t *testing.T) {
	if os.Getenv("CONTENT_AUDIT_LIVE_TEST") != "1" {
		t.Skip("set CONTENT_AUDIT_LIVE_TEST=1 to hit the real content audit proxy")
	}
	endpoint := os.Getenv("CONTENT_AUDIT_ENDPOINT")
	proxyToken := os.Getenv("CONTENT_AUDIT_PROXY_TOKEN")
	productID := os.Getenv("CONTENT_AUDIT_PRODUCT_ID")
	sid := os.Getenv("CONTENT_AUDIT_USER_SID")
	if endpoint == "" || proxyToken == "" || productID == "" || sid == "" {
		t.Fatal("CONTENT_AUDIT_ENDPOINT, CONTENT_AUDIT_PROXY_TOKEN, CONTENT_AUDIT_PRODUCT_ID and CONTENT_AUDIT_USER_SID are required")
	}
	client, err := contentaudit.New(contentaudit.Config{Endpoint: endpoint, ProxyToken: proxyToken})
	if err != nil {
		t.Fatalf("contentaudit.New returned error: %v", err)
	}

	cfg := ContentAuditConfig{Enabled: true, ProductID: productID, UserSID: sid}
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	svc := NewWithStore(store, Options{Now: fixedNow, ContentAudit: cfg})
	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "旧昵称",
		Email:      "profile-audit-live@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}
	if _, err := svc.UpdateProfile(context.Background(), session.Token, "真实Proxy测试昵称"); err != nil {
		t.Fatalf("queue audit failed: %v", err)
	}

	worker := NewContentAuditWorker(store, client, cfg, ContentAuditWorkerOptions{Now: fixedNow})
	if err := worker.RunOnce(context.Background(), 20); err != nil {
		t.Fatalf("run worker: %v", err)
	}

	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("load session failed: %v", err)
	}
	if current.User.Name != "旧昵称" || current.User.PendingName != "真实Proxy测试昵称" {
		t.Fatalf("expected async submit to keep pending nickname until callback, got %+v", current.User)
	}
}
