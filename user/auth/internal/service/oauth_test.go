package service

import (
	"context"
	"testing"
)

func TestOAuthSignInCreatesUserAndKeepsSubscriptionOutOfSession(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	firstSession, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "qq",
		ProviderSubject: "openid-123",
		Name:            "QQ星球",
		AvatarURL:       "https://q.qlogo.cn/headimg_dl?dst_uin=10001&spec=640",
		InviteCode:      "VALID2026",
	})
	if err != nil {
		t.Fatalf("first oauth sign-in failed: %v", err)
	}
	if firstSession.User.ID == "" {
		t.Fatal("expected oauth sign-in to create a user")
	}
	if firstSession.User.Name != "QQ星球" {
		t.Fatalf("expected oauth user name to come from provider profile, got %q", firstSession.User.Name)
	}
	if firstSession.PlanSelection != nil {
		t.Fatal("expected oauth sign-in to start without a selected plan")
	}

	if _, err := svc.UpdateSubscription(context.Background(), firstSession.Token, "free"); err != nil {
		t.Fatalf("update subscription failed: %v", err)
	}
	if err := svc.SignOut(context.Background(), firstSession.Token); err != nil {
		t.Fatalf("sign out failed: %v", err)
	}

	secondSession, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "qq",
		ProviderSubject: "openid-123",
		Name:            "QQ星球-新昵称",
		AvatarURL:       "https://q.qlogo.cn/headimg_dl?dst_uin=10001&spec=640",
	})
	if err != nil {
		t.Fatalf("second oauth sign-in failed: %v", err)
	}
	if secondSession.User.ID != firstSession.User.ID {
		t.Fatalf("expected repeated oauth sign-in to reuse same user, got %q then %q", firstSession.User.ID, secondSession.User.ID)
	}
	if secondSession.PlanSelection != nil {
		t.Fatal("expected oauth session to omit subscription details")
	}
}

func TestOAuthSignInRejectsMissingProviderSubject(t *testing.T) {
	t.Parallel()

	svc := New(Options{Now: fixedNow})

	_, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider: "qq",
		Name:     "QQ用户",
	})
	if err == nil {
		t.Fatal("expected oauth sign-in to reject empty provider subject")
	}

	authErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("expected service error, got %T", err)
	}
	if authErr.Code != "invalid_oauth_identity" {
		t.Fatalf("expected invalid_oauth_identity, got %q", authErr.Code)
	}
}

func TestOAuthSignInCreatesUsableUserForFirstSignInWithoutInvite(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	firstSession, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "qq",
		ProviderSubject: "openid-first-time",
		Name:            "QQ新人",
	})
	if err != nil {
		t.Fatalf("expected first oauth sign-in without invite to succeed, got %v", err)
	}
	if firstSession.User.InviteRequired {
		t.Fatal("expected first oauth sign-in without invite to skip invite gating")
	}

	secondSession, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "qq",
		ProviderSubject: "openid-first-time",
		Name:            "QQ新人-再次登录",
	})
	if err != nil {
		t.Fatalf("returning oauth sign-in failed: %v", err)
	}
	if secondSession.User.ID != firstSession.User.ID {
		t.Fatalf("expected returning oauth sign-in to reuse same user, got %q then %q", firstSession.User.ID, secondSession.User.ID)
	}
	if secondSession.User.InviteRequired {
		t.Fatal("expected returning oauth sign-in to keep invite gating disabled")
	}

	activatedUser, err := svc.ActivateInvite(context.Background(), firstSession.Token, "VALID2026")
	if err != nil {
		t.Fatalf("activate invite failed: %v", err)
	}
	if activatedUser.InviteRequired {
		t.Fatal("expected activate invite compatibility call to remain invite-free")
	}

	thirdSession, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "qq",
		ProviderSubject: "openid-first-time",
		Name:            "QQ新人-激活后登录",
	})
	if err != nil {
		t.Fatalf("post-activation oauth sign-in failed: %v", err)
	}
	if thirdSession.User.ID != firstSession.User.ID {
		t.Fatalf("expected post-activation oauth sign-in to reuse same user, got %q then %q", firstSession.User.ID, thirdSession.User.ID)
	}
	if thirdSession.User.InviteRequired {
		t.Fatal("expected post-activation oauth sign-in to keep user activated")
	}
}

func TestBindOAuthToCurrentSessionReusesExistingRegisteredUserWithoutInvite(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	if _, err := svc.SendVerificationCode(context.Background(), "13912345678"); err != nil {
		t.Fatalf("send verification code failed: %v", err)
	}
	code := mustCurrentSMSCode(t, svc, "13912345678")
	phoneSession, err := svc.VerifySMS(context.Background(), VerifySMSInput{
		Phone:      "13912345678",
		Code:       code,
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("phone sign-in failed: %v", err)
	}

	qqSession, err := svc.BindOAuthToCurrentSession(context.Background(), phoneSession.Token, OAuthSignInInput{
		Provider:        "qq",
		ProviderSubject: "openid-bind-current-user",
		Name:            "QQ绑定用户",
	})
	if err != nil {
		t.Fatalf("bind oauth to current session failed: %v", err)
	}
	if qqSession.User.ID != phoneSession.User.ID {
		t.Fatalf("expected qq bind to keep existing user id, got %q then %q", phoneSession.User.ID, qqSession.User.ID)
	}

	returningSession, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "qq",
		ProviderSubject: "openid-bind-current-user",
		Name:            "QQ绑定用户",
	})
	if err != nil {
		t.Fatalf("qq returning sign-in failed: %v", err)
	}
	if returningSession.User.ID != phoneSession.User.ID {
		t.Fatalf("expected qq returning sign-in to reuse existing user id, got %q then %q", phoneSession.User.ID, returningSession.User.ID)
	}
}

func TestOAuthSignInLinksVerifiedEmailToExistingUser(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	passwordSession, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Email:      "same-user@lightvela.ai",
		Password:   "secure2026!",
		Name:       "Lightvela User",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("password sign-up failed: %v", err)
	}

	googleSession, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "google",
		ProviderSubject: "google-sub-same-user",
		Email:           "same-user@lightvela.ai",
		EmailVerified:   true,
		Name:            "Google Profile",
	})
	if err != nil {
		t.Fatalf("google oauth sign-in failed: %v", err)
	}
	if googleSession.User.ID != passwordSession.User.ID {
		t.Fatalf("expected google sign-in to reuse existing user, got %q then %q", passwordSession.User.ID, googleSession.User.ID)
	}
	if googleSession.User.Name != passwordSession.User.Name {
		t.Fatalf("expected existing user profile to be preserved, got %q", googleSession.User.Name)
	}

	returningSession, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "google",
		ProviderSubject: "google-sub-same-user",
		Email:           "same-user@lightvela.ai",
		EmailVerified:   true,
		Name:            "Google Profile Updated",
	})
	if err != nil {
		t.Fatalf("returning google oauth sign-in failed: %v", err)
	}
	if returningSession.User.ID != passwordSession.User.ID {
		t.Fatalf("expected returning google sign-in to reuse existing user, got %q then %q", passwordSession.User.ID, returningSession.User.ID)
	}
}

func TestOAuthSignInDoesNotLinkUnverifiedEmailToExistingUser(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	passwordSession, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Email:      "unverified@lightvela.ai",
		Password:   "secure2026!",
		Name:       "Existing User",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("password sign-up failed: %v", err)
	}

	_, err = svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "google",
		ProviderSubject: "google-sub-unverified-email",
		Email:           "unverified@lightvela.ai",
		EmailVerified:   false,
		Name:            "Unverified Profile",
	})
	if err == nil {
		t.Fatal("expected unverified oauth email conflict")
	}
	authErr, ok := err.(*Error)
	if !ok {
		t.Fatalf("expected service error, got %T", err)
	}
	if authErr.Code != "oauth_email_conflict" {
		t.Fatalf("expected oauth_email_conflict, got %q", authErr.Code)
	}
	if passwordSession.User.ID == "" {
		t.Fatal("expected existing user to remain available")
	}
}

func TestOAuthSignInLinksGitHubEmailToExistingUserWithoutVerifiedFlag(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	passwordSession, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Email:      "github-user@lightvela.ai",
		Password:   "secure2026!",
		Name:       "GitHub User",
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("password sign-up failed: %v", err)
	}

	githubSession, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "github",
		ProviderSubject: "123456",
		Email:           "github-user@lightvela.ai",
		EmailVerified:   false,
		Name:            "GitHub Profile",
	})
	if err != nil {
		t.Fatalf("github oauth sign-in failed: %v", err)
	}
	if githubSession.User.ID != passwordSession.User.ID {
		t.Fatalf("expected github sign-in to reuse existing user, got %q then %q", passwordSession.User.ID, githubSession.User.ID)
	}
}

func TestOAuthSignInUsesWeChatFallbackName(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	session, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "wechat",
		ProviderSubject: "openid-wechat-fallback-name",
		InviteCode:      "VALID2026",
	})
	if err != nil {
		t.Fatalf("wechat oauth sign-in failed: %v", err)
	}
	if session.User.Name != "微信用户" {
		t.Fatalf("expected wechat fallback name, got %q", session.User.Name)
	}
}

func TestOAuthSignInReusesWeChatIdentity(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{Now: fixedNow})

	firstSession, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "wechat",
		ProviderSubject: "unionid-wechat-returning-user",
		Name:            "微信回访用户",
		InviteCode:      "VALID2026",
	})
	if err != nil {
		t.Fatalf("first wechat oauth sign-in failed: %v", err)
	}

	secondSession, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "wechat",
		ProviderSubject: "unionid-wechat-returning-user",
		Name:            "微信回访用户-新昵称",
	})
	if err != nil {
		t.Fatalf("second wechat oauth sign-in failed: %v", err)
	}
	if secondSession.User.ID != firstSession.User.ID {
		t.Fatalf("expected repeated wechat oauth sign-in to reuse same user, got %q then %q", firstSession.User.ID, secondSession.User.ID)
	}
}
