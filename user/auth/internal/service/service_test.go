package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/contentaudit"
)

func TestSharedStoreEnforcesCooldownAcrossServiceInstances(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svcA := NewWithStore(store, Options{Now: fixedNow})
	svcB := NewWithStore(store, Options{Now: fixedNow})

	if _, err := svcA.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("first send failed: %v", err)
	}

	_, err := svcB.SendVerificationCode(context.Background(), "13800138000")
	if err == nil {
		t.Fatal("expected cooldown error from second service instance")
	}

	var authErr *Error
	if !errors.As(err, &authErr) {
		t.Fatalf("expected service error, got %T", err)
	}
	if authErr.Code != "sms_cooldown" {
		t.Fatalf("expected sms_cooldown, got %s", authErr.Code)
	}
}

func TestSharedStorePersistsSessionsAcrossServiceInstances(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svcA := NewWithStore(store, Options{Now: fixedNow})
	svcB := NewWithStore(store, Options{Now: fixedNow})

	if _, err := svcA.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send failed: %v", err)
	}
	code := mustCurrentSMSCode(t, svcA, "13800138000")

	session, err := svcA.VerifySMS(context.Background(), VerifySMSInput{
		Name:       "测试用户",
		Phone:      "13800138000",
		Code:       code,
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("verify failed: %v", err)
	}

	current, err := svcB.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("load session from second service failed: %v", err)
	}
	if current.User.Phone != "13800138000" {
		t.Fatalf("unexpected phone: %s", current.User.Phone)
	}

	plan, err := svcB.ConfirmFreePlan(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("confirm free plan from second service failed: %v", err)
	}
	if plan.Tier != "free" {
		t.Fatalf("expected free plan, got %s", plan.Tier)
	}

	reloaded, err := svcA.CurrentSubscription(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("reload subscription from first service failed: %v", err)
	}
	if reloaded == nil || reloaded.Tier != "free" {
		t.Fatal("expected plan confirmation to be shared across service instances")
	}
}

func TestSharedStoreSupportsPasswordSessionsAcrossServiceInstances(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svcA := NewWithStore(store, Options{Now: fixedNow})
	svcB := NewWithStore(store, Options{Now: fixedNow})

	session, err := svcA.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "Alice",
		Email:      "alice@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}

	if _, err := svcB.CurrentSession(context.Background(), session.Token); err != nil {
		t.Fatalf("current session on second service failed: %v", err)
	}

	signedIn, err := svcB.SignInWithPassword(context.Background(), "alice@example.com", "password123")
	if err != nil {
		t.Fatalf("sign in on second service failed: %v", err)
	}
	if signedIn.User.Email != "alice@example.com" {
		t.Fatalf("unexpected email: %s", signedIn.User.Email)
	}
}

func TestSendVerificationCodeRejectsInvalidPhone(t *testing.T) {
	svc := New(Options{Now: fixedNow})

	_, err := svc.SendVerificationCode(context.Background(), "12345")
	if err == nil {
		t.Fatal("expected invalid phone error")
	}

	var authErr *Error
	if !errors.As(err, &authErr) {
		t.Fatalf("expected service error, got %T", err)
	}
	if authErr.Code != "invalid_phone" {
		t.Fatalf("expected invalid_phone, got %s", authErr.Code)
	}
}

func TestSendVerificationCodeEnforcesCooldown(t *testing.T) {
	svc := New(Options{Now: fixedNow})

	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("first send failed: %v", err)
	}

	_, err := svc.SendVerificationCode(context.Background(), "13800138000")
	if err == nil {
		t.Fatal("expected cooldown error")
	}

	var authErr *Error
	if !errors.As(err, &authErr) {
		t.Fatalf("expected service error, got %T", err)
	}
	if authErr.Code != "sms_cooldown" {
		t.Fatalf("expected sms_cooldown, got %s", authErr.Code)
	}
	if authErr.RetryAfter <= 0 {
		t.Fatalf("expected retry after, got %s", authErr.RetryAfter)
	}
}

func TestSendVerificationCodeUsesConfiguredDefaultSMSCode(t *testing.T) {
	svc := New(Options{
		Now:            fixedNow,
		DefaultSMSCode: "123456",
	})

	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send failed: %v", err)
	}

	code := mustCurrentSMSCode(t, svc, "13800138000")
	if code != "123456" {
		t.Fatalf("expected fixed sms code 123456, got %q", code)
	}
}

func TestVerifySMSCreatesSessionAndPlanCanBeConfirmed(t *testing.T) {
	svc := New(Options{Now: fixedNow})

	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send failed: %v", err)
	}
	code := mustCurrentSMSCode(t, svc, "13800138000")

	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{
		Name:       "测试用户",
		Phone:      "13800138000",
		Code:       code,
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("verify failed: %v", err)
	}
	if session.User.Phone != "13800138000" {
		t.Fatalf("unexpected phone: %s", session.User.Phone)
	}
	if session.PlanSelection != nil {
		t.Fatal("expected plan to be nil before confirmation")
	}

	plan, err := svc.ConfirmFreePlan(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("confirm plan failed: %v", err)
	}
	if plan.Tier != "free" {
		t.Fatalf("expected free plan, got %s", plan.Tier)
	}

	current, err := svc.CurrentSubscription(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("load subscription failed: %v", err)
	}
	if current == nil || current.Tier != "free" {
		t.Fatal("expected confirmed free plan to be queryable")
	}
}

func TestVerifyRealnameRequiresConfiguredVerifierAndCipher(t *testing.T) {
	svc := New(Options{Now: fixedNow})
	session := mustPasswordSession(t, svc, "missing-realname-config@example.com")

	_, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{
		Name:   "张三",
		IDCard: "11010519491231002X",
	})
	if err == nil {
		t.Fatal("expected realname unavailable error")
	}
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "realname_unavailable" || authErr.Status != 503 {
		t.Fatalf("expected realname_unavailable 503, got %#v", err)
	}
}

func TestVerifyRealnameRejectsInvalidInput(t *testing.T) {
	svc := New(Options{
		Now:              fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{Result: "0"}},
		RealnameCipher:   stubRealnameCipher{},
	})
	session := mustPasswordSession(t, svc, "invalid-realname@example.com")

	_, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "", IDCard: "11010519491231002X"})
	if err == nil {
		t.Fatal("expected empty name to fail")
	}
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "invalid_realname" {
		t.Fatalf("expected invalid_realname, got %#v", err)
	}

	_, err = svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "bad"})
	if err == nil {
		t.Fatal("expected invalid id card to fail")
	}
	if !errors.As(err, &authErr) || authErr.Code != "invalid_id_card" {
		t.Fatalf("expected invalid_id_card, got %#v", err)
	}
}

func TestVerifyRealnameMismatchDoesNotUpdateSession(t *testing.T) {
	svc := New(Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:      "FailedOperation.IdCardVerificationFailed",
			Description: "mismatch",
			RequestID:   "req-mismatch",
		}},
		RealnameCipher: stubRealnameCipher{},
	})
	session := mustPasswordSession(t, svc, "mismatch-realname@example.com")

	_, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"})
	if err == nil {
		t.Fatal("expected mismatch to fail")
	}
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "realname_mismatch" || authErr.Status != 400 {
		t.Fatalf("expected realname_mismatch 400, got %#v", err)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session: %v", err)
	}
	if current.User.RealnameVerified {
		t.Fatal("expected mismatch not to mark user verified")
	}
}

func TestVerifyRealnameSuccessAndOverwrite(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-success",
		}},
		RealnameCipher: stubRealnameCipher{},
	})
	session := mustPasswordSessionWithStore(t, svc, "success-realname@example.com")

	before, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session before realname: %v", err)
	}
	if before.User.RealnameVerified {
		t.Fatal("expected user to start unverified")
	}

	result, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"})
	if err != nil {
		t.Fatalf("verify realname: %v", err)
	}
	if !result.OK || !result.Verified || result.NameMasked != "张*" || result.IDCardMasked != "1101**********002X" || result.RequestID != "req-success" {
		t.Fatalf("unexpected realname result: %+v", result)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session after realname: %v", err)
	}
	if !current.User.RealnameVerified {
		t.Fatal("expected user to be marked realname verified")
	}

	if _, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "李四", IDCard: "11010519491231003X"}); err != nil {
		t.Fatalf("re-verify realname: %v", err)
	}
	record := store.realnames[session.User.ID]
	if record.NameMasked != "李*" || record.IDCardMasked != "1101**********003X" {
		t.Fatalf("expected latest realname metadata to be overwritten, got %+v", record)
	}
	history := store.realnameHistory[session.User.ID]
	if len(history) != 2 {
		t.Fatalf("expected two realname history records, got %d", len(history))
	}
	if history[0].NameMasked != "张*" || history[1].NameMasked != "李*" {
		t.Fatalf("expected realname history to keep every verified value, got %+v", history)
	}
}

func TestConfirmedPlanPersistsAcrossPasswordSessions(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "Alice",
		Email:      "alice@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}

	if _, err := svc.ConfirmFreePlan(context.Background(), session.Token); err != nil {
		t.Fatalf("confirm plan failed: %v", err)
	}
	if err := svc.SignOut(context.Background(), session.Token); err != nil {
		t.Fatalf("sign out failed: %v", err)
	}

	nextSession, err := svc.SignInWithPassword(context.Background(), "alice@example.com", "password123")
	if err != nil {
		t.Fatalf("sign in failed: %v", err)
	}
	if nextSession.PlanSelection != nil {
		t.Fatal("expected password session to omit subscription details")
	}
}

func TestCreateImpersonationSessionMarksSessionAndKeepsReasonInternal(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})
	normalSession := mustPasswordSessionWithStore(t, svc, "impersonation@example.com")

	if normalSession.Impersonated {
		t.Fatal("expected normal password session not to be impersonated")
	}

	session, err := svc.CreateImpersonationSession(context.Background(), normalSession.User.ID, "  帮用户排查账单问题  ")
	if err != nil {
		t.Fatalf("create impersonation session: %v", err)
	}
	if !session.Impersonated {
		t.Fatal("expected impersonation session to be marked")
	}
	if session.ImpersonationReason != "帮用户排查账单问题" {
		t.Fatalf("expected trimmed reason to be stored internally, got %q", session.ImpersonationReason)
	}
	if session.ExpiresAt.Sub(fixedNow()) != impersonationSessionTTL {
		t.Fatalf("expected short impersonation ttl %s, got %s", impersonationSessionTTL, session.ExpiresAt.Sub(fixedNow()))
	}

	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current impersonation session: %v", err)
	}
	if !current.Impersonated || current.ImpersonationReason != "帮用户排查账单问题" {
		t.Fatalf("expected persisted impersonation metadata, got impersonated=%v reason=%q", current.Impersonated, current.ImpersonationReason)
	}
}

func TestCreateImpersonationSessionRequiresReason(t *testing.T) {
	svc := New(Options{Now: fixedNow})
	session := mustPasswordSession(t, svc, "impersonation-reason@example.com")

	_, err := svc.CreateImpersonationSession(context.Background(), session.User.ID, "   ")
	if err == nil {
		t.Fatal("expected missing reason to fail")
	}
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "impersonation_reason_required" || authErr.Status != 400 {
		t.Fatalf("expected impersonation_reason_required 400, got %#v", err)
	}
}

func TestCreateSessionForUserCreatesNormalShortLivedSession(t *testing.T) {
	svc := New(Options{Now: fixedNow})
	passwordSession := mustPasswordSession(t, svc, "e2e-session-for-user@example.com")

	session, err := svc.CreateSessionForUser(context.Background(), passwordSession.User.ID, 17*time.Minute)
	if err != nil {
		t.Fatalf("create session for user: %v", err)
	}
	if session.Impersonated {
		t.Fatal("expected e2e session mint to create a normal session")
	}
	if session.ExpiresAt.Sub(fixedNow()) != 17*time.Minute {
		t.Fatalf("expected requested ttl, got %s", session.ExpiresAt.Sub(fixedNow()))
	}

	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current minted session: %v", err)
	}
	if current.User.ID != passwordSession.User.ID || current.Impersonated {
		t.Fatalf("unexpected current minted session: user=%q impersonated=%v", current.User.ID, current.Impersonated)
	}
}

func TestCreateSessionForUserRejectsInvalidTTL(t *testing.T) {
	svc := New(Options{Now: fixedNow})
	session := mustPasswordSession(t, svc, "e2e-session-invalid-ttl@example.com")

	_, err := svc.CreateSessionForUser(context.Background(), session.User.ID, 0)
	if err == nil {
		t.Fatal("expected invalid ttl to fail")
	}
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "invalid_session_ttl" || authErr.Status != 400 {
		t.Fatalf("expected invalid_session_ttl 400, got %#v", err)
	}
}

func TestDeleteCurrentUserRemovesUserSessionsAndSubscription(t *testing.T) {
	svc := New(Options{Now: fixedNow})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "Delete Me",
		Email:      "delete-me@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}

	if _, err := svc.ConfirmFreePlan(context.Background(), session.Token); err != nil {
		t.Fatalf("confirm plan failed: %v", err)
	}

	if err := svc.DeleteCurrentUser(context.Background(), session.Token); err != nil {
		t.Fatalf("delete current user failed: %v", err)
	}

	if _, err := svc.CurrentSession(context.Background(), session.Token); err == nil {
		t.Fatal("expected current session lookup to fail after account deletion")
	}

	if _, err := svc.SignInWithPassword(context.Background(), "delete-me@example.com", "password123"); err == nil {
		t.Fatal("expected sign-in to fail after account deletion")
	}
}

func TestConfirmedPlanPersistsAcrossPhoneSessions(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("initial send failed: %v", err)
	}
	firstCode := mustCurrentSMSCode(t, svc, "13800138000")
	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{
		Name:       "测试用户",
		Phone:      "13800138000",
		Code:       firstCode,
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("initial verify failed: %v", err)
	}

	if _, err := svc.ConfirmFreePlan(context.Background(), session.Token); err != nil {
		t.Fatalf("confirm plan failed: %v", err)
	}
	if err := svc.SignOut(context.Background(), session.Token); err != nil {
		t.Fatalf("sign out failed: %v", err)
	}

	advancedNow := func() time.Time {
		return fixedNow().Add(2 * time.Minute)
	}
	laterSvc := NewWithStore(store, Options{Now: advancedNow})
	if _, err := laterSvc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("second send failed: %v", err)
	}
	secondCode := mustCurrentSMSCode(t, laterSvc, "13800138000")
	nextSession, err := laterSvc.VerifySMS(context.Background(), VerifySMSInput{
		Name:  "测试用户",
		Phone: "13800138000",
		Code:  secondCode,
	})
	if err != nil {
		t.Fatalf("second verify failed: %v", err)
	}
	if nextSession.PlanSelection != nil {
		t.Fatal("expected phone session to omit subscription details")
	}
}

func TestUpdateProfileRenamesCurrentUser(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "旧昵称",
		Email:      "profile@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}

	user, err := svc.UpdateProfile(context.Background(), session.Token, "新昵称")
	if err != nil {
		t.Fatalf("update profile failed: %v", err)
	}
	if user.Name != "新昵称" {
		t.Fatalf("expected updated nickname, got %q", user.Name)
	}

	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("load session failed: %v", err)
	}
	if current.User.Name != "新昵称" {
		t.Fatalf("expected current session to expose updated nickname, got %q", current.User.Name)
	}
}

func TestUpdateProfileQueuesNameAuditWhenEnabled(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		ContentAudit: ContentAuditConfig{
			Enabled:   true,
			ProductID: "30003",
			UserSID:   "300025",
		},
	})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "旧昵称",
		Email:      "profile-audit@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}

	user, err := svc.UpdateProfile(context.Background(), session.Token, "新昵称")
	if err != nil {
		t.Fatalf("update profile failed: %v", err)
	}
	if user.Name != "旧昵称" || user.PendingName != "新昵称" || user.NameAuditStatus != "pending" {
		t.Fatalf("expected pending audit without replacing official name, got %+v", user)
	}

	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("load session failed: %v", err)
	}
	if current.User.Name != "旧昵称" || current.User.PendingName != "新昵称" {
		t.Fatalf("expected session to keep official name and expose pending name, got %+v", current.User)
	}
}

func TestUpdateProfileAuditsNameSynchronouslyWhenClientConfigured(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	cfg := ContentAuditConfig{
		Enabled:          true,
		NameAuditEnabled: true,
		ProductID:        "30018",
		UserSID:          "300071",
	}
	queueSvc := NewWithStore(store, Options{
		Now:          fixedNow,
		ContentAudit: cfg,
	})
	svc := NewWithStore(store, Options{
		Now:                fixedNow,
		ContentAudit:       cfg,
		ContentAuditClient: stubContentAuditClient{result: &contentaudit.ResponseResult{ResultCode: contentaudit.ResultCodePass}},
	})

	session, err := queueSvc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "旧昵称",
		Email:      "profile-audit-sync@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}
	if pending, err := queueSvc.UpdateProfile(context.Background(), session.Token, "待审核昵称"); err != nil {
		t.Fatalf("queue pending name failed: %v", err)
	} else if pending.PendingName != "待审核昵称" || pending.NameAuditStatus != "pending" {
		t.Fatalf("expected pending name before sync audit, got %+v", pending)
	}

	user, err := svc.UpdateProfile(context.Background(), session.Token, "新昵称")
	if err != nil {
		t.Fatalf("update profile failed: %v", err)
	}
	if user.Name != "新昵称" || user.PendingName != "" || user.NameAuditStatus != "" {
		t.Fatalf("expected direct sync audit to update name without pending task state, got %+v", user)
	}
}

func TestUpdateProfileRejectsMaliciousNameSynchronously(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	cfg := ContentAuditConfig{
		Enabled:          true,
		NameAuditEnabled: true,
		ProductID:        "30018",
		UserSID:          "300071",
	}
	svc := NewWithStore(store, Options{
		Now:                fixedNow,
		ContentAudit:       cfg,
		ContentAuditClient: stubContentAuditClient{result: &contentaudit.ResponseResult{ResultCode: contentaudit.ResultCodeMalicious, ResultType: 20007}},
	})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "旧昵称",
		Email:      "profile-audit-sync-reject@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}

	_, err = svc.UpdateProfile(context.Background(), session.Token, "违规昵称")
	var serviceErr *Error
	if !errors.As(err, &serviceErr) || serviceErr.Code != "content_audit_rejected" {
		t.Fatalf("expected content_audit_rejected error, got %v", err)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("load session failed: %v", err)
	}
	if current.User.Name != "旧昵称" || current.User.PendingName != "" || current.User.NameAuditStatus != "" {
		t.Fatalf("expected rejected sync audit to keep current name without pending task state, got %+v", current.User)
	}
}

func TestUpdateProfileBypassesNameAuditWhenDisabled(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		ContentAudit: ContentAuditConfig{
			Enabled:   false,
			ProductID: "30003",
			UserSID:   "300025",
		},
	})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "旧昵称",
		Email:      "profile-audit-disabled@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}

	user, err := svc.UpdateProfile(context.Background(), session.Token, "新昵称")
	if err != nil {
		t.Fatalf("update profile failed: %v", err)
	}
	if user.Name != "新昵称" || user.PendingName != "" || user.NameAuditStatus != "" {
		t.Fatalf("expected disabled audit to rename directly, got %+v", user)
	}
}

func TestContentAuditWorkerAppliesPassedName(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	cfg := ContentAuditConfig{Enabled: true, ProductID: "30003", UserSID: "300025"}
	svc := NewWithStore(store, Options{Now: fixedNow, ContentAudit: cfg})
	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "旧昵称",
		Email:      "profile-audit-pass@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}
	if _, err := svc.UpdateProfile(context.Background(), session.Token, "新昵称"); err != nil {
		t.Fatalf("queue audit failed: %v", err)
	}

	worker := NewContentAuditWorker(store, stubContentAuditClient{
		result: &contentaudit.ResponseResult{ResultCode: contentaudit.ResultCodePass},
	}, cfg, ContentAuditWorkerOptions{Now: fixedNow})
	if err := worker.RunOnce(context.Background(), 20); err != nil {
		t.Fatalf("run worker: %v", err)
	}

	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("load session failed: %v", err)
	}
	if current.User.Name != "新昵称" || current.User.PendingName != "" || current.User.NameAuditStatus != "passed" {
		t.Fatalf("expected passed audit to apply pending name, got %+v", current.User)
	}
}

func TestContentAuditWorkerRejectsMaliciousName(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	cfg := ContentAuditConfig{Enabled: true, ProductID: "30003", UserSID: "300025"}
	svc := NewWithStore(store, Options{Now: fixedNow, ContentAudit: cfg})
	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "旧昵称",
		Email:      "profile-audit-fail@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}
	if _, err := svc.UpdateProfile(context.Background(), session.Token, "违规昵称"); err != nil {
		t.Fatalf("queue audit failed: %v", err)
	}

	worker := NewContentAuditWorker(store, stubContentAuditClient{
		result: &contentaudit.ResponseResult{ResultCode: contentaudit.ResultCodeMalicious, ResultType: 20007},
	}, cfg, ContentAuditWorkerOptions{Now: fixedNow})
	if err := worker.RunOnce(context.Background(), 20); err != nil {
		t.Fatalf("run worker: %v", err)
	}

	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("load session failed: %v", err)
	}
	if current.User.Name != "旧昵称" || current.User.PendingName != "" || current.User.NameAuditStatus != "failed" {
		t.Fatalf("expected failed audit to keep official name, got %+v", current.User)
	}
}

func TestSetUserAvatarPersistsAcrossSessions(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "头像用户",
		Email:      "avatar@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}

	user, err := svc.SetUserAvatar(context.Background(), session.User.ID, "avatars/usr_01/current.jpg", "upload")
	if err != nil {
		t.Fatalf("set avatar failed: %v", err)
	}
	if user.AvatarObjectKey != "avatars/usr_01/current.jpg" {
		t.Fatalf("expected avatar object key to be persisted, got %q", user.AvatarObjectKey)
	}

	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("load session failed: %v", err)
	}
	if current.User.AvatarObjectKey != "avatars/usr_01/current.jpg" {
		t.Fatalf("expected current session avatar object key, got %q", current.User.AvatarObjectKey)
	}
}

func TestQueueAvatarAuditKeepsCurrentAvatarUntilPassed(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	cfg := ContentAuditConfig{
		Enabled:            true,
		AvatarAuditEnabled: true,
		ProductID:          "30018",
		UserSID:            "300071",
	}
	svc := NewWithStore(store, Options{Now: fixedNow, ContentAudit: cfg})
	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "头像用户",
		Email:      "avatar-audit@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}
	if _, err := svc.SetUserAvatar(context.Background(), session.User.ID, "avatars/usr_01/current.jpg", "upload"); err != nil {
		t.Fatalf("set current avatar failed: %v", err)
	}

	user, err := svc.QueueAvatarAudit(context.Background(), session.User.ID, "avatars/usr_01/pending.jpg", "upload", "https://example.com/pending.jpg")
	if err != nil {
		t.Fatalf("queue avatar audit failed: %v", err)
	}
	if user.AvatarObjectKey != "avatars/usr_01/current.jpg" || user.PendingAvatarObjectKey != "avatars/usr_01/pending.jpg" || user.AvatarAuditStatus != "pending" {
		t.Fatalf("expected pending avatar without replacing current avatar, got %+v", user)
	}

	worker := NewContentAuditWorker(store, stubContentAuditClient{
		result: &contentaudit.ResponseResult{ResultCode: contentaudit.ResultCodePass},
	}, cfg, ContentAuditWorkerOptions{Now: fixedNow})
	if err := worker.RunOnce(context.Background(), 20); err != nil {
		t.Fatalf("run worker: %v", err)
	}

	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("load session failed: %v", err)
	}
	if current.User.AvatarObjectKey != "avatars/usr_01/pending.jpg" || current.User.PendingAvatarObjectKey != "" || current.User.AvatarAuditStatus != "passed" {
		t.Fatalf("expected passed avatar audit to promote pending avatar, got %+v", current.User)
	}
}

func TestQueueAvatarAuditAuditsSynchronouslyWhenClientConfigured(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	cfg := ContentAuditConfig{
		Enabled:            true,
		AvatarAuditEnabled: true,
		ProductID:          "30018",
		UserSID:            "300071",
	}
	svc := NewWithStore(store, Options{
		Now:                fixedNow,
		ContentAudit:       cfg,
		ContentAuditClient: stubContentAuditClient{result: &contentaudit.ResponseResult{ResultCode: contentaudit.ResultCodePass}},
	})
	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "头像用户",
		Email:      "avatar-audit-sync@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}

	user, err := svc.QueueAvatarAudit(context.Background(), session.User.ID, "avatars/usr_01/current.jpg", "upload", "https://example.com/current.jpg")
	if err != nil {
		t.Fatalf("sync avatar audit failed: %v", err)
	}
	if user.AvatarObjectKey != "avatars/usr_01/current.jpg" || user.PendingAvatarObjectKey != "" || user.AvatarAuditStatus != "" {
		t.Fatalf("expected direct sync audit to update avatar without pending task state, got %+v", user)
	}
}

func TestQueueAvatarAuditRejectsMaliciousAvatarSynchronously(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	cfg := ContentAuditConfig{
		Enabled:            true,
		AvatarAuditEnabled: true,
		ProductID:          "30018",
		UserSID:            "300071",
	}
	svc := NewWithStore(store, Options{
		Now:                fixedNow,
		ContentAudit:       cfg,
		ContentAuditClient: stubContentAuditClient{result: &contentaudit.ResponseResult{ResultCode: contentaudit.ResultCodeMalicious, ResultType: 20002}},
	})
	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "头像用户",
		Email:      "avatar-audit-sync-reject@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}
	if _, err := svc.SetUserAvatar(context.Background(), session.User.ID, "avatars/usr_01/current.jpg", "upload"); err != nil {
		t.Fatalf("set current avatar failed: %v", err)
	}

	_, err = svc.QueueAvatarAudit(context.Background(), session.User.ID, "avatars/usr_01/rejected.jpg", "upload", "https://example.com/rejected.jpg")
	var serviceErr *Error
	if !errors.As(err, &serviceErr) || serviceErr.Code != "content_audit_rejected" {
		t.Fatalf("expected content_audit_rejected error, got %v", err)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("load session failed: %v", err)
	}
	if current.User.AvatarObjectKey != "avatars/usr_01/current.jpg" || current.User.PendingAvatarObjectKey != "" || current.User.AvatarAuditStatus != "" {
		t.Fatalf("expected rejected sync audit to keep current avatar without pending task state, got %+v", current.User)
	}
}

func TestQueueAvatarAuditDisabledFallsBackToImmediateAvatar(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow, ContentAudit: ContentAuditConfig{Enabled: false}})
	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:       "头像用户",
		Email:      "avatar-audit-disabled@example.com",
		Password:   "password123",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("sign up failed: %v", err)
	}
	user, err := svc.QueueAvatarAudit(context.Background(), session.User.ID, "avatars/usr_01/current.jpg", "upload", "https://example.com/current.jpg")
	if err != nil {
		t.Fatalf("queue avatar audit disabled failed: %v", err)
	}
	if user.AvatarObjectKey != "avatars/usr_01/current.jpg" || user.PendingAvatarObjectKey != "" || user.AvatarAuditStatus != "" {
		t.Fatalf("expected immediate avatar when avatar audit is disabled, got %+v", user)
	}
}

func TestVerifySMSIgnoresInviteCode(t *testing.T) {
	svc := New(Options{Now: fixedNow})

	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send failed: %v", err)
	}
	code := mustCurrentSMSCode(t, svc, "13800138000")

	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{
		Name:       "测试用户",
		Phone:      "13800138000",
		Code:       code,
		InviteCode: "BADCODE",
	})
	if err != nil {
		t.Fatalf("expected invite code to be ignored, got %v", err)
	}
	if session.User.Phone != "13800138000" {
		t.Fatalf("unexpected phone after verify: %s", session.User.Phone)
	}
}

func TestInviteCodeCanBeReusedWhenValidationIsDisabled(t *testing.T) {
	svc := New(Options{Now: fixedNow})

	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("first send failed: %v", err)
	}
	firstCode := mustCurrentSMSCode(t, svc, "13800138000")
	if _, err := svc.VerifySMS(context.Background(), VerifySMSInput{
		Name:       "用户一号",
		Phone:      "13800138000",
		Code:       firstCode,
		InviteCode: "VALID2026",
	}); err != nil {
		t.Fatalf("first verify failed: %v", err)
	}

	if _, err := svc.SendVerificationCode(context.Background(), "13900139000"); err != nil {
		t.Fatalf("second send failed: %v", err)
	}
	secondCode := mustCurrentSMSCode(t, svc, "13900139000")
	secondSession, err := svc.VerifySMS(context.Background(), VerifySMSInput{
		Name:       "用户二号",
		Phone:      "13900139000",
		Code:       secondCode,
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("expected repeated invite code to be ignored, got %v", err)
	}
	if secondSession.User.Phone != "13900139000" {
		t.Fatalf("unexpected second phone: %s", secondSession.User.Phone)
	}
}

func TestSignOutRevokesSession(t *testing.T) {
	svc := New(Options{Now: fixedNow})

	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send failed: %v", err)
	}
	code := mustCurrentSMSCode(t, svc, "13800138000")
	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{
		Name:       "测试用户",
		Phone:      "13800138000",
		Code:       code,
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("verify failed: %v", err)
	}

	if err := svc.SignOut(context.Background(), session.Token); err != nil {
		t.Fatalf("sign out failed: %v", err)
	}

	_, err = svc.CurrentSession(context.Background(), session.Token)
	if err == nil {
		t.Fatal("expected session lookup to fail after sign out")
	}
}

func TestCreateAdminInviteGeneratesShortCode(t *testing.T) {
	svc := New(Options{Now: fixedNow})

	invite, err := svc.CreateAdminInvite(context.Background(), "", "")
	if err != nil {
		t.Fatalf("create admin invite failed: %v", err)
	}
	if len(invite.Code) != 6 {
		t.Fatalf("expected 6-char invite code, got %q", invite.Code)
	}
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	for _, r := range invite.Code {
		if !strings.ContainsRune(alphabet, r) {
			t.Fatalf("unexpected invite rune %q in %q", r, invite.Code)
		}
	}
}

func fixedNow() time.Time {
	return time.Date(2026, 3, 18, 10, 0, 0, 0, time.UTC)
}

func mustCurrentSMSCode(t *testing.T, svc *Service, phone string) string {
	t.Helper()

	items, err := svc.ListAdminSMSChallenges(context.Background(), phone, 10)
	if err != nil {
		t.Fatalf("list sms challenges failed: %v", err)
	}
	for _, item := range items {
		if item.Phone == phone {
			if item.Code == "" {
				t.Fatal("expected sms code to be present in admin listing")
			}
			return item.Code
		}
	}
	t.Fatalf("sms challenge for %s not found", phone)
	return ""
}

func mustPasswordSession(t *testing.T, svc *Service, email string) *AuthSession {
	t.Helper()
	return mustPasswordSessionWithStore(t, svc, email)
}

func mustPasswordSessionWithStore(t *testing.T, svc *Service, email string) *AuthSession {
	t.Helper()
	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:     "Alice",
		Email:    email,
		Password: "password123",
	})
	if err != nil {
		t.Fatalf("sign up password session: %v", err)
	}
	return session
}

type stubRealnameVerifier struct {
	result RealnameProviderResult
	err    error
}

func (s stubRealnameVerifier) Verify(_ context.Context, _ string, _ string) (RealnameProviderResult, error) {
	if s.err != nil {
		return RealnameProviderResult{}, s.err
	}
	return s.result, nil
}

type stubRealnameCipher struct{}

func (stubRealnameCipher) Encrypt(plaintext string) (string, error) {
	return fmt.Sprintf("enc(%s)", plaintext), nil
}

type stubContentAuditClient struct {
	result *contentaudit.ResponseResult
	err    error
}

func (s stubContentAuditClient) CreateTextTask(_ context.Context, req contentaudit.CreateTextTaskRequest) (*contentaudit.CreateTextTaskResponse, error) {
	if s.err != nil {
		return nil, s.err
	}
	if req.Data.Content.User.StrNick == "" || len(req.Data.Content.Media.Text) != 1 || req.Data.Content.Media.Text[0].StrContent == "" {
		return nil, fmt.Errorf("invalid text audit request: %+v", req.Data.Content)
	}
	return &contentaudit.CreateTextTaskResponse{
		Response: contentaudit.CreateTextTaskResponseBody{
			Data: &contentaudit.CreateTextTaskResponseData{
				Result: s.result,
			},
		},
	}, nil
}

func (s stubContentAuditClient) CreateImageTask(_ context.Context, req contentaudit.CreateImageTaskRequest) (*contentaudit.CreateTextTaskResponse, error) {
	if s.err != nil {
		return nil, s.err
	}
	if req.Data.Content.User.StrHeadUrl == "" || len(req.Data.Content.Media.Pic) != 1 || req.Data.Content.Media.Pic[0].StrURL == "" {
		return nil, fmt.Errorf("invalid image audit request: %+v", req.Data.Content)
	}
	return &contentaudit.CreateTextTaskResponse{
		Response: contentaudit.CreateTextTaskResponseBody{
			Data: &contentaudit.CreateTextTaskResponseData{
				Result: s.result,
			},
		},
	}, nil
}
