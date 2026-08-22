package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

func runShadowTaskInline(task func()) { task() }

type oauthBillingClient struct {
	calls  int
	result shadowbinding.BillingAccountResult
	err    error
}

func (c *oauthBillingClient) EnsureBillingAccount(context.Context, int64) (shadowbinding.BillingAccountResult, error) {
	c.calls++
	return c.result, c.err
}

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

func TestIntlOAuthSignInProvisionsShadowAccountAndBilling(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	shadowStore := shadowbinding.NewMemoryStore()
	now := fixedNow()
	cloud := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{
		Uin:      450860000002,
		OwnerUin: 450860000002,
	}, temporaryResult: shadowbinding.CloudTemporaryCredentials{
		Uin: 450860000002, OwnerUin: 450860000002,
		TmpSecretID: "tmp-id", TmpSecretKey: "tmp-key", Token: "tmp-token", ExpiredTime: now.Add(time.Hour),
	}, accountInfoResult: shadowbinding.CloudAccountInfo{
		LoginUin: 450860000002, OwnerUin: 450860000002, AppID: 1374210036,
	}}
	billing := &oauthBillingClient{result: shadowbinding.BillingAccountResult{IsOpen: true}}
	shadowSvc := shadowbinding.New(shadowStore, cloud, shadowbinding.Options{
		Enabled:        true,
		SiteKind:       shadowbinding.SiteKindIntl,
		BillingAccount: billing,
		RunAsync:       runShadowTaskInline,
		Now:            fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now:           fixedNow,
		SiteKind:      shadowbinding.SiteKindIntl,
		ShadowBinding: shadowSvc,
	})

	session, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "google",
		ProviderSubject: "google-intl-user",
		Email:           "verified@example.com",
		EmailVerified:   true,
		Name:            "Intl User",
		ClientIP:        "198.51.100.23",
		ClientUA:        "oauth-client/1.0",
	})
	if err != nil {
		t.Fatalf("international oauth sign-in: %v", err)
	}
	binding, err := shadowStore.GetBindingByUserID(context.Background(), session.User.ID)
	if err != nil {
		t.Fatalf("get international shadow binding: %v", err)
	}
	if binding.Status != shadowbinding.StatusActive || binding.AppID != 1374210036 || cloud.calls != 1 || billing.calls != 1 {
		t.Fatalf("expected active international binding, binding=%+v cloud_calls=%d billing_calls=%d", binding, cloud.calls, billing.calls)
	}
	if cloud.lastRegister.Email != "verified@example.com" {
		t.Fatalf("expected oauth email to be used for registration, got %+v", cloud.lastRegister)
	}
	if cloud.lastTemporary.ClientIP != "198.51.100.23" || cloud.lastTemporary.ClientUA != "oauth-client/1.0" {
		t.Fatalf("expected oauth client metadata to reach AppID lookup, got %+v", cloud.lastTemporary)
	}
}

func TestIntlOAuthSignInRepairsExistingActiveBindingWithoutAppID(t *testing.T) {
	now := fixedNow()
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	seedService := NewWithStore(store, Options{Now: fixedNow})
	seedSession, err := seedService.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "google",
		ProviderSubject: "google-intl-existing",
		Email:           "existing@example.com",
		EmailVerified:   true,
		Name:            "Existing Intl User",
	})
	if err != nil {
		t.Fatalf("seed oauth user: %v", err)
	}

	shadowStore := shadowbinding.NewMemoryStore()
	if _, err := shadowStore.SavePendingBinding(context.Background(), seedSession.User.ID, "sgprod_existing", now); err != nil {
		t.Fatalf("save pending binding: %v", err)
	}
	if _, err := shadowStore.MarkBindingActive(context.Background(), seedSession.User.ID, 450860000099, 450860000099, 0, now); err != nil {
		t.Fatalf("mark active binding: %v", err)
	}
	cloud := &stubShadowRegisterClient{
		temporaryResult: shadowbinding.CloudTemporaryCredentials{
			Uin: 450860000099, OwnerUin: 450860000099,
			TmpSecretID: "tmp-id", TmpSecretKey: "tmp-key", Token: "tmp-token", ExpiredTime: now.Add(time.Hour),
		},
		accountInfoResult: shadowbinding.CloudAccountInfo{
			LoginUin: 450860000099, OwnerUin: 450860000099, AppID: 1472999999,
		},
	}
	shadowSvc := shadowbinding.New(shadowStore, cloud, shadowbinding.Options{
		Enabled: true, SiteKind: shadowbinding.SiteKindIntl, RunAsync: runShadowTaskInline, Now: fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow, SiteKind: shadowbinding.SiteKindIntl, ShadowBinding: shadowSvc,
	})

	if _, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "google",
		ProviderSubject: "google-intl-existing",
		Email:           "existing@example.com",
		EmailVerified:   true,
		Name:            "Existing Intl User",
		ClientIP:        "203.0.113.45",
		ClientUA:        "oauth-client/2.0",
	}); err != nil {
		t.Fatalf("repeat oauth sign-in: %v", err)
	}

	binding, err := shadowStore.GetBindingByUserID(context.Background(), seedSession.User.ID)
	if err != nil {
		t.Fatalf("get repaired binding: %v", err)
	}
	if binding.AppID != 1472999999 || cloud.temporaryCalls != 1 || cloud.accountInfoCalls != 1 {
		t.Fatalf("expected existing binding repair, binding=%+v temporary_calls=%d account_info_calls=%d", binding, cloud.temporaryCalls, cloud.accountInfoCalls)
	}
	if cloud.lastTemporary.ClientIP != "203.0.113.45" || cloud.lastTemporary.ClientUA != "oauth-client/2.0" {
		t.Fatalf("expected repair to use current oauth client metadata, got %+v", cloud.lastTemporary)
	}
}

func TestIntlPasswordSignUpProvisionsShadowAccountAndBillingWhenEnabled(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	shadowStore := shadowbinding.NewMemoryStore()
	now := fixedNow()
	cloud := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{
		Uin:      450860000003,
		OwnerUin: 450860000003,
	}, temporaryResult: shadowbinding.CloudTemporaryCredentials{
		Uin: 450860000003, OwnerUin: 450860000003,
		TmpSecretID: "tmp-id", TmpSecretKey: "tmp-key", Token: "tmp-token", ExpiredTime: now.Add(time.Hour),
	}, accountInfoResult: shadowbinding.CloudAccountInfo{
		LoginUin: 450860000003, OwnerUin: 450860000003, AppID: 1374210037,
	}}
	billing := &oauthBillingClient{result: shadowbinding.BillingAccountResult{IsOpen: true}}
	shadowSvc := shadowbinding.New(shadowStore, cloud, shadowbinding.Options{
		Enabled:        true,
		SiteKind:       shadowbinding.SiteKindIntl,
		BillingAccount: billing,
		RunAsync:       runShadowTaskInline,
		Now:            fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now:                         fixedNow,
		SiteKind:                    shadowbinding.SiteKindIntl,
		ShadowBinding:               shadowSvc,
		PasswordSignupShadowEnabled: true,
	})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:     "Password Test User",
		Email:    "skipzhang@tencent.com",
		Password: "password-test-123",
		ClientIP: "198.51.100.24",
		ClientUA: "password-client/1.0",
	})
	if err != nil {
		t.Fatalf("international password sign-up: %v", err)
	}
	binding, err := shadowStore.GetBindingByUserID(context.Background(), session.User.ID)
	if err != nil {
		t.Fatalf("get international shadow binding: %v", err)
	}
	if binding.Status != shadowbinding.StatusActive || binding.AppID != 1374210037 || cloud.calls != 1 || billing.calls != 1 {
		t.Fatalf("expected active international binding, binding=%+v cloud_calls=%d billing_calls=%d", binding, cloud.calls, billing.calls)
	}
	if cloud.lastRegister.Email != "skipzhang@tencent.com" {
		t.Fatalf("expected password email to be used for test registration, got %+v", cloud.lastRegister)
	}
	if cloud.lastTemporary.ClientIP != "198.51.100.24" || cloud.lastTemporary.ClientUA != "password-client/1.0" {
		t.Fatalf("expected password sign-up client metadata to reach AppID lookup, got %+v", cloud.lastTemporary)
	}
}

func TestPasswordSignUpShadowProvisioningIsDisabledByDefault(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	shadowStore := shadowbinding.NewMemoryStore()
	cloud := &stubShadowRegisterClient{}
	billing := &oauthBillingClient{result: shadowbinding.BillingAccountResult{IsOpen: true}}
	shadowSvc := shadowbinding.New(shadowStore, cloud, shadowbinding.Options{
		Enabled:        true,
		SiteKind:       shadowbinding.SiteKindIntl,
		BillingAccount: billing,
		RunAsync:       runShadowTaskInline,
	})
	svc := NewWithStore(store, Options{
		Now:           fixedNow,
		SiteKind:      shadowbinding.SiteKindIntl,
		ShadowBinding: shadowSvc,
	})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:     "Password User",
		Email:    "disabled@example.com",
		Password: "password-test-123",
	})
	if err != nil {
		t.Fatalf("password sign-up: %v", err)
	}
	if _, err := shadowStore.GetBindingByUserID(context.Background(), session.User.ID); !errors.Is(err, shadowbinding.ErrNotFound) {
		t.Fatalf("password sign-up must not provision by default, err=%v", err)
	}
	if cloud.calls != 0 || billing.calls != 0 {
		t.Fatalf("password sign-up unexpectedly provisioned shadow: cloud_calls=%d billing_calls=%d", cloud.calls, billing.calls)
	}
}

func TestPasswordSignUpShadowProvisioningDoesNotRunForCNSite(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	shadowStore := shadowbinding.NewMemoryStore()
	cloud := &stubShadowRegisterClient{}
	shadowSvc := shadowbinding.New(shadowStore, cloud, shadowbinding.Options{Enabled: true})
	svc := NewWithStore(store, Options{
		Now:                         fixedNow,
		SiteKind:                    shadowbinding.SiteKindCN,
		ShadowBinding:               shadowSvc,
		PasswordSignupShadowEnabled: true,
	})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:     "CN Password User",
		Email:    "cn@example.com",
		Password: "password-test-123",
	})
	if err != nil {
		t.Fatalf("password sign-up: %v", err)
	}
	if _, err := shadowStore.GetBindingByUserID(context.Background(), session.User.ID); !errors.Is(err, shadowbinding.ErrNotFound) {
		t.Fatalf("cn password sign-up must not provision shadow, err=%v", err)
	}
	if cloud.calls != 0 {
		t.Fatalf("cn password sign-up unexpectedly provisioned shadow: calls=%d", cloud.calls)
	}
}

func TestIntlPasswordSignUpSurvivesProvisioningFailure(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	shadowStore := shadowbinding.NewMemoryStore()
	cloud := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{
		Uin:      450860000004,
		OwnerUin: 450860000004,
		AppID:    1374210038,
	}}
	billing := &oauthBillingClient{err: errors.New("billing unavailable")}
	shadowSvc := shadowbinding.New(shadowStore, cloud, shadowbinding.Options{
		Enabled:        true,
		SiteKind:       shadowbinding.SiteKindIntl,
		BillingAccount: billing,
		RunAsync:       runShadowTaskInline,
	})
	svc := NewWithStore(store, Options{
		Now:                         fixedNow,
		SiteKind:                    shadowbinding.SiteKindIntl,
		ShadowBinding:               shadowSvc,
		PasswordSignupShadowEnabled: true,
	})

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Name:     "Password Failure User",
		Email:    "password-failure@example.com",
		Password: "password-test-123",
	})
	if err != nil || session == nil {
		t.Fatalf("password sign-up must survive provisioning failure: session=%+v err=%v", session, err)
	}
	binding, err := shadowStore.GetBindingByUserID(context.Background(), session.User.ID)
	if err != nil || binding.Status != shadowbinding.StatusFailed || binding.Uin != 450860000004 {
		t.Fatalf("expected recoverable failed provisioning state, binding=%+v err=%v", binding, err)
	}
}

func TestIntlOAuthSignInSurvivesProvisioningFailure(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	shadowStore := shadowbinding.NewMemoryStore()
	cloud := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{
		Uin:      450860000002,
		OwnerUin: 450860000002,
		AppID:    1374210036,
	}}
	billing := &oauthBillingClient{err: errors.New("billing unavailable")}
	shadowSvc := shadowbinding.New(shadowStore, cloud, shadowbinding.Options{
		Enabled:        true,
		SiteKind:       shadowbinding.SiteKindIntl,
		BillingAccount: billing,
		RunAsync:       runShadowTaskInline,
	})
	svc := NewWithStore(store, Options{
		Now:           fixedNow,
		SiteKind:      shadowbinding.SiteKindIntl,
		ShadowBinding: shadowSvc,
	})

	session, err := svc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "google",
		ProviderSubject: "google-intl-failure",
		Email:           "failure@example.com",
		EmailVerified:   true,
		Name:            "Intl User",
	})
	if err != nil || session == nil {
		t.Fatalf("oauth login must not fail with provisioning: session=%+v err=%v", session, err)
	}
	binding, err := shadowStore.GetBindingByUserID(context.Background(), session.User.ID)
	if err != nil || binding.Status != shadowbinding.StatusFailed || binding.Uin != 450860000002 {
		t.Fatalf("expected recoverable failed provisioning state, binding=%+v err=%v", binding, err)
	}
}

func TestRetryShadowBindingUsesVerifiedSessionEmail(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	initialSvc := NewWithStore(store, Options{Now: fixedNow})
	session, err := initialSvc.SignInWithOAuth(context.Background(), OAuthSignInInput{
		Provider:        "github",
		ProviderSubject: "github-existing-user",
		Email:           "verified@example.com",
		EmailVerified:   true,
		Name:            "Existing Intl User",
	})
	if err != nil {
		t.Fatalf("seed existing oauth user: %v", err)
	}
	store.mu.Lock()
	verifiedUser := store.usersByID[session.User.ID]
	verifiedUser.EmailVerified = true
	store.usersByID[session.User.ID] = verifiedUser
	store.mu.Unlock()

	shadowStore := shadowbinding.NewMemoryStore()
	cloud := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{
		Uin:      450860000004,
		OwnerUin: 450860000004,
		AppID:    1374211121,
	}}
	billing := &oauthBillingClient{result: shadowbinding.BillingAccountResult{IsOpen: true}}
	shadowSvc := shadowbinding.New(shadowStore, cloud, shadowbinding.Options{
		Enabled:        true,
		SiteKind:       shadowbinding.SiteKindIntl,
		BillingAccount: billing,
		RunAsync:       runShadowTaskInline,
	})
	retrySvc := NewWithStore(store, Options{
		Now:           fixedNow,
		SiteKind:      shadowbinding.SiteKindIntl,
		ShadowBinding: shadowSvc,
	})

	binding, err := retrySvc.RetryShadowBinding(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("retry shadow binding: %v", err)
	}
	if binding.Status != shadowbinding.StatusPending {
		t.Fatalf("binding=%+v, want immediate pending response", binding)
	}
	active, err := shadowStore.GetBindingByUserID(context.Background(), session.User.ID)
	if err != nil || active.Status != shadowbinding.StatusActive {
		t.Fatalf("stored binding=%+v, want async active: %v", active, err)
	}
	if cloud.lastRegister.Email != "verified@example.com" {
		t.Fatalf("registration email=%q, want verified session email", cloud.lastRegister.Email)
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

func TestOAuthSignInRegistrationDisabledRejectsOnlyNewUsers(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	svc := NewWithStore(store, Options{Now: fixedNow})
	ctx := context.Background()

	_, err := svc.SignInWithOAuth(ctx, OAuthSignInInput{
		Provider:             "github",
		ProviderSubject:      "github-new-user",
		Email:                "new-user@example.com",
		EmailVerified:        true,
		Name:                 "New User",
		RegistrationDisabled: true,
	})
	if err == nil {
		t.Fatal("expected disabled registration to reject a new GitHub user")
	}
	authErr, ok := err.(*Error)
	if !ok || authErr.Code != "oauth_registration_disabled" {
		t.Fatalf("expected oauth_registration_disabled, got %T %v", err, err)
	}

	existingSession, err := svc.SignInWithOAuth(ctx, OAuthSignInInput{
		Provider:        "github",
		ProviderSubject: "github-existing-user",
		Email:           "existing-user@example.com",
		EmailVerified:   true,
		Name:            "Existing User",
	})
	if err != nil {
		t.Fatalf("seed existing GitHub user: %v", err)
	}
	returningSession, err := svc.SignInWithOAuth(ctx, OAuthSignInInput{
		Provider:             "github",
		ProviderSubject:      "github-existing-user",
		Email:                "existing-user@example.com",
		EmailVerified:        true,
		Name:                 "Existing User",
		RegistrationDisabled: true,
	})
	if err != nil {
		t.Fatalf("returning GitHub user should still sign in: %v", err)
	}
	if returningSession.User.ID != existingSession.User.ID {
		t.Fatalf("expected existing user %q, got %q", existingSession.User.ID, returningSession.User.ID)
	}
}

func TestOAuthSignInRegistrationDisabledDoesNotCreateEmailLink(t *testing.T) {
	t.Parallel()

	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	svc := NewWithStore(store, Options{Now: fixedNow})
	ctx := context.Background()

	passwordSession, err := svc.SignUpWithPassword(ctx, PasswordSignUpInput{
		Email:    "existing-email@example.com",
		Password: "secure2026!",
		Name:     "Existing Email User",
	})
	if err != nil {
		t.Fatalf("seed existing email user: %v", err)
	}

	_, err = svc.SignInWithOAuth(ctx, OAuthSignInInput{
		Provider:             "github",
		ProviderSubject:      "github-links-existing-email",
		Email:                "existing-email@example.com",
		EmailVerified:        true,
		Name:                 "GitHub Profile",
		RegistrationDisabled: true,
	})
	if err == nil {
		t.Fatal("expected disabled registration to reject a new GitHub identity even when email exists")
	}
	authErr, ok := err.(*Error)
	if !ok || authErr.Code != "oauth_registration_disabled" {
		t.Fatalf("expected oauth_registration_disabled, got %T %v", err, err)
	}
	_ = passwordSession
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
