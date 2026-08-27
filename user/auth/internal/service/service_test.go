package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/contentaudit"
	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

func fixedVerificationCode(code string) func(int) (string, error) {
	return func(int) (string, error) { return code, nil }
}

func TestInternalShadowBindingRepairsMissingInternationalAppID(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	shadowStore := shadowbinding.NewMemoryStore()
	_, _ = shadowStore.SavePendingBinding(context.Background(), "usr_intl", "sgprod_u1", now)
	_, _ = shadowStore.MarkBindingActive(context.Background(), "usr_intl", 450850000004, 450850000004, 0, now)
	client := &stubShadowRegisterClient{
		temporaryResult: shadowbinding.CloudTemporaryCredentials{
			Uin: 450850000004, OwnerUin: 450850000004,
			TmpSecretID: "tmp-id", TmpSecretKey: "tmp-key", Token: "tmp-token", ExpiredTime: now.Add(time.Hour),
		},
		accountInfoResult: shadowbinding.CloudAccountInfo{LoginUin: 450850000004, OwnerUin: 450850000004, AppID: 1471748557},
	}
	shadowSvc := shadowbinding.New(shadowStore, client, shadowbinding.Options{Enabled: true, SiteKind: shadowbinding.SiteKindIntl, Now: func() time.Time { return now }})
	svc := NewWithStore(NewMemoryStore(StoreOptions{Now: func() time.Time { return now }}), Options{Now: func() time.Time { return now }, ShadowBinding: shadowSvc})

	binding, err := svc.InternalShadowBinding(context.Background(), "usr_intl", "192.0.2.1", "lightvela-trade")
	if err != nil {
		t.Fatalf("InternalShadowBinding: %v", err)
	}
	if binding.AppID != 1471748557 || client.temporaryCalls != 1 || client.accountInfoCalls != 1 {
		t.Fatalf("binding was not repaired: binding=%+v temporary_calls=%d account_info_calls=%d", binding, client.temporaryCalls, client.accountInfoCalls)
	}
	if client.lastTemporary.ClientIP != "192.0.2.1" || client.lastTemporary.ClientUA != "lightvela-trade" {
		t.Fatalf("client metadata was not forwarded: %+v", client.lastTemporary)
	}
}

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

func TestFacelessRealnameSkipsFaceCaptureAndUsesFaceIDPhoneProofFlow(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	shadowClient := &stubShadowRegisterClient{
		result: shadowbinding.CloudRegisterResult{Uin: 300000000071, OwnerUin: 300000000071, AppID: 1250000000},
	}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), shadowClient, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{
		Now:                       fixedNow,
		VerificationCodeGenerator: fixedVerificationCode("111111"),
		RealnameVerifier:          stubRealnameVerifier{result: RealnameProviderResult{Result: "0"}},
		RealnameCipher:            stubRealnameCipher{},
		RealnameFaceID: RealnameFaceIDConfig{
			Mode:      RealnameAssuranceModeFaceless,
			DigestKey: []byte("0123456789abcdef0123456789abcdef"),
		},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	session := mustPasswordSessionWithPhone(t, svc, "faceless@example.invalid", "13800138118")

	started, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name: "张三", IDCard: "11010519491231002X", ClientIP: "127.0.0.1", ClientUA: "test", ConsentAccepted: true,
	})
	if err != nil {
		t.Fatalf("start faceless realname: %v", err)
	}
	if started.VerifyURL != "" {
		t.Fatalf("faceless flow must not issue a face-capture URL, got %+v", started)
	}
	attempt, err := store.GetRealnameFaceIDAttempt(context.Background(), started.AttemptID)
	if err != nil {
		t.Fatalf("load faceless attempt: %v", err)
	}
	if attempt.State != RealnameFaceIDStateFaceSucceeded || attempt.FaceVerifiedAt == nil {
		t.Fatalf("faceless flow must enter the FaceID phone-proof stage, got %+v", attempt)
	}

	if _, err := svc.SendRealnameFaceIDPhoneCode(context.Background(), session.Token, RealnameFaceIDPhoneCodeInput{
		AttemptID: started.AttemptID, ClientIP: "127.0.0.1",
	}); err != nil {
		t.Fatalf("send FaceID-flow shadow phone code: %v", err)
	}
	if shadowClient.smsCalls != 1 || shadowClient.lastSMS.Phone != "13800138118" {
		t.Fatalf("expected Tencent safety-phone SMS for current user, got calls=%d input=%+v", shadowClient.smsCalls, shadowClient.lastSMS)
	}

	verified, err := svc.VerifyRealnameFaceIDPhone(context.Background(), session.Token, RealnameFaceIDPhoneProofInput{
		AttemptID: started.AttemptID, Code: "888888", ClientIP: "127.0.0.1", ClientUA: "test",
	})
	if err != nil {
		t.Fatalf("verify Tencent safety-phone code: %v", err)
	}
	if verified.State != RealnameFaceIDStateSucceeded {
		t.Fatalf("expected faceless FaceID-flow verification to complete, got %+v", verified)
	}
}

func TestFacelessRealnameRequiresTwoFactorVerifier(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	svc := NewWithStore(store, Options{
		Now:            fixedNow,
		RealnameCipher: stubRealnameCipher{},
		RealnameFaceID: RealnameFaceIDConfig{
			Mode:      RealnameAssuranceModeFaceless,
			DigestKey: []byte("0123456789abcdef0123456789abcdef"),
		},
	})
	session := mustPasswordSessionWithPhone(t, svc, "faceless-no-verifier@example.invalid", "13800138119")

	_, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name: "张三", IDCard: "11010519491231002X", ConsentAccepted: true,
	})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "realname_unavailable" {
		t.Fatalf("faceless mode must fail closed without two-factor verifier, got %#v", err)
	}
}

func TestFacelessRealnameRejectsLegacyVerifyEndpoint(t *testing.T) {
	svc := New(Options{
		Now:              fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{Result: "0"}},
		RealnameCipher:   stubRealnameCipher{},
		RealnameFaceID:   RealnameFaceIDConfig{Mode: RealnameAssuranceModeFaceless},
	})
	session := mustPasswordSessionWithPhone(t, svc, "faceless-legacy-endpoint@example.invalid", "13800138120")

	_, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{
		Name: "张三", IDCard: "11010519491231002X",
	})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "realname_faceid_required" {
		t.Fatalf("faceless mode must use the attempt state machine, got %#v", err)
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

func TestVerificationSendRateLimitUsesClientIPAcrossRecipients(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	svc := NewWithStore(store, Options{Now: fixedNow})

	for i := 0; i < 100; i++ {
		phone := fmt.Sprintf("138%08d", i)
		if _, err := svc.SendVerificationCodeForClient(context.Background(), phone, "203.0.113.10"); err != nil {
			t.Fatalf("send %d failed: %v", i+1, err)
		}
	}

	_, err := svc.SendVerificationCodeForClient(context.Background(), "13900000000", "203.0.113.10")
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "verification_rate_limited" || authErr.Status != http.StatusTooManyRequests {
		t.Fatalf("expected verification_rate_limited 429, got %#v", err)
	}
}

func TestVerificationCheckRateLimitUsesRecipientAndClientIP(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	svc := NewWithStore(store, Options{Now: fixedNow})
	phone := "13800138000"

	for i := 0; i < 10; i++ {
		_, _ = svc.VerifySMS(context.Background(), VerifySMSInput{
			Phone:    phone,
			Code:     "000000",
			ClientIP: fmt.Sprintf("203.0.113.%d", i+1),
		})
	}

	_, err := svc.VerifySMS(context.Background(), VerifySMSInput{
		Phone:    phone,
		Code:     "000000",
		ClientIP: "203.0.113.200",
	})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "verification_rate_limited" || authErr.Status != http.StatusTooManyRequests {
		t.Fatalf("expected recipient verification_rate_limited 429, got %#v", err)
	}

	for i := 0; i < 10; i++ {
		_, _ = svc.VerifySMS(context.Background(), VerifySMSInput{
			Phone:    fmt.Sprintf("139%08d", i),
			Code:     "000000",
			ClientIP: "198.51.100.20",
		})
	}
	_, err = svc.VerifySMS(context.Background(), VerifySMSInput{
		Phone:    "13700000000",
		Code:     "000000",
		ClientIP: "198.51.100.20",
	})
	if !errors.As(err, &authErr) || authErr.Code != "verification_rate_limited" || authErr.Status != http.StatusTooManyRequests {
		t.Fatalf("expected IP verification_rate_limited 429, got %#v", err)
	}
}

func TestNumericVerificationCodesAreRandomSixDigits(t *testing.T) {
	seen := make(map[string]struct{})
	for i := 0; i < 32; i++ {
		code, err := newNumericVerificationCode(6)
		if err != nil {
			t.Fatalf("generate code: %v", err)
		}
		if len(code) != 6 || strings.Trim(code, "0123456789") != "" {
			t.Fatalf("expected six digits, got %q", code)
		}
		seen[code] = struct{}{}
	}
	if len(seen) < 2 {
		t.Fatal("expected randomized verification codes")
	}
}

func TestVerificationPolicyControlsMaximumFailures(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		Verification: VerificationPolicy{
			MaxFailures: 2,
		},
	})

	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send failed: %v", err)
	}
	for i := 0; i < 2; i++ {
		_, _ = svc.VerifySMS(context.Background(), VerifySMSInput{Phone: "13800138000", Code: "000000"})
	}
	store.mu.Lock()
	_, exists := store.smsChallenges["13800138000"]
	store.mu.Unlock()
	if exists {
		t.Fatal("expected challenge to be deleted after configured maximum failures")
	}
}

func TestVerificationDeliveryErrorMapsProviderControls(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "provider rate limit", err: errors.New("[TencentCloudSDKError] Code=LimitExceeded.PhoneNumberOneHourLimit, Message=too frequent"), status: http.StatusTooManyRequests, code: "verification_provider_rate_limited"},
		{name: "provider blacklist", err: errors.New("[TencentCloudSDKError] Code=FailedOperation.InBlacklist, Message=blocked"), status: http.StatusForbidden, code: "verification_provider_rejected"},
		{name: "provider credentials", err: errors.New("[TencentCloudSDKError] Code=AuthFailure.SecretIdNotFound, Message=bad credential"), status: http.StatusBadGateway, code: "sms_failed"},
		{name: "provider outage", err: errors.New("network unavailable"), status: http.StatusBadGateway, code: "sms_failed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := verificationDeliveryError(tt.err, "sms_failed", "短信发送失败。")
			var authErr *Error
			if !errors.As(err, &authErr) || authErr.Status != tt.status || authErr.Code != tt.code {
				t.Fatalf("unexpected mapped error: %#v", err)
			}
		})
	}
}

func TestSendVerificationCodeUsesInjectedGenerator(t *testing.T) {
	svc := New(Options{
		Now:                       fixedNow,
		VerificationCodeGenerator: fixedVerificationCode("123456"),
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

func TestVerifyRealnameSyncsShadowBasicAuthWhenBindingIsActive(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	client := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{
		Now:                       fixedNow,
		VerificationCodeGenerator: fixedVerificationCode("111111"),
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-success",
		}},
		RealnameCipher:             stubRealnameCipher{},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	session := mustPasswordSessionWithPhone(t, svc, "shadow-basic-realname@example.com", "13800138000")

	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{UserID: session.User.ID, Phone: "13800138000", VerifyCode: "888888"}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}
	result, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{
		Name:     "张三",
		IDCard:   "11010519491231002X",
		ClientIP: "127.0.0.1",
		ClientUA: "agent",
	})
	if err != nil {
		t.Fatalf("verify realname: %v", err)
	}
	if !result.OK || client.basicAuthCalls != 1 {
		t.Fatalf("expected realname ok and one basic auth sync, result=%+v calls=%d", result, client.basicAuthCalls)
	}
	if client.lastBasicAuth.Name != "张三" || client.lastBasicAuth.IDCard != "11010519491231002X" || client.lastBasicAuth.AuthCode == "" {
		t.Fatalf("unexpected basic auth sync input: %+v", client.lastBasicAuth)
	}
	if client.lastBasicAuth.ClientIP != "127.0.0.1" || client.lastBasicAuth.ClientUA != "agent" {
		t.Fatalf("expected client context to be forwarded, got %+v", client.lastBasicAuth)
	}
	binding, err := shadowSvc.GetBindingByUserID(context.Background(), session.User.ID)
	if err != nil {
		t.Fatalf("get shadow binding: %v", err)
	}
	if binding.BasicAuthStatus != shadowbinding.BasicAuthStatusSucceeded || binding.BasicAuthSyncedAt == nil {
		t.Fatalf("expected basic auth sync status, got %+v", binding)
	}
}

func TestVerifyRealnameDoesNotSyncShadowBasicAuthByDefault(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	client := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{
		Now:                       fixedNow,
		VerificationCodeGenerator: fixedVerificationCode("111111"),
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-default-no-basic-auth-sync",
		}},
		RealnameCipher: stubRealnameCipher{},
		ShadowBinding:  shadowSvc,
	})
	session := mustPasswordSessionWithPhone(t, svc, "shadow-basic-default-off@example.com", "13800138000")

	result, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"})
	if err != nil {
		t.Fatalf("verify realname: %v", err)
	}
	if !result.OK || client.basicAuthCalls != 0 {
		t.Fatalf("expected local realname success without basic auth sync, result=%+v calls=%d", result, client.basicAuthCalls)
	}
	profile, err := svc.CurrentProfile(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current profile: %v", err)
	}
	if profile.RealnameSyncStatus != "" {
		t.Fatalf("expected no sync status when feature is disabled, got %+v", profile)
	}

	_, err = svc.RetryRealnameSync(context.Background(), session.Token, "127.0.0.1", "agent")
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "shadow_basic_auth_sync_disabled" || authErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("expected disabled retry error, got %#v", err)
	}
}

func TestVerifyRealnameKeepsLocalSuccessWhenShadowBasicAuthSyncFails(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	client := &stubShadowRegisterClient{
		result:       shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000},
		basicAuthErr: errors.New("save basic auth failed"),
	}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{
		Now:                       fixedNow,
		VerificationCodeGenerator: fixedVerificationCode("111111"),
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-success",
		}},
		RealnameCipher:             stubRealnameCipher{},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	session := mustPasswordSessionWithPhone(t, svc, "shadow-basic-fail-realname@example.com", "13800138000")

	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{UserID: session.User.ID, Phone: "13800138000", VerifyCode: "888888"}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}
	if _, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"}); err != nil {
		t.Fatalf("basic auth sync failure should not fail local realname: %v", err)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session: %v", err)
	}
	if !current.User.RealnameVerified {
		t.Fatalf("expected local realname success, user=%+v calls=%d", current.User, client.basicAuthCalls)
	}
	if client.basicAuthCalls < 1 {
		t.Fatalf("expected at least one failed basic auth sync attempt, calls=%d", client.basicAuthCalls)
	}
	binding, err := shadowSvc.GetBindingByUserID(context.Background(), session.User.ID)
	if err != nil {
		t.Fatalf("get shadow binding: %v", err)
	}
	if binding.BasicAuthStatus != shadowbinding.BasicAuthStatusFailed || binding.BasicAuthLastErrorCode == "" {
		t.Fatalf("expected failed basic auth sync status, got %+v", binding)
	}
	if current.User.RealnameSyncStatus != RealnameSyncStatusFailed {
		t.Fatalf("expected failed realname sync status on session, got %+v", current.User)
	}

	callsBeforeProfile := client.basicAuthCalls
	profile, err := svc.CurrentProfile(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current profile: %v", err)
	}
	if profile.RealnameSyncStatus != RealnameSyncStatusFailed {
		t.Fatalf("expected failed realname sync status on profile, got %+v", profile)
	}
	if client.basicAuthCalls != callsBeforeProfile {
		t.Fatalf("current profile must not call basic auth sync, before=%d after=%d", callsBeforeProfile, client.basicAuthCalls)
	}
}

func TestVerifyRealnameChecksSessionBeforeProvider(t *testing.T) {
	verifier := &countingRealnameVerifier{result: RealnameProviderResult{Result: "0", RequestID: "req-should-not-call"}}
	svc := New(Options{
		Now:              fixedNow,
		RealnameVerifier: verifier,
		RealnameCipher:   stubRealnameCipher{},
	})

	_, err := svc.VerifyRealname(context.Background(), "missing-session", RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"})
	if err == nil {
		t.Fatal("expected invalid session to fail")
	}
	if verifier.calls != 0 {
		t.Fatalf("expected realname provider not to be called for invalid session, calls=%d", verifier.calls)
	}
}

func TestVerifyRealnamePhoneWithoutShadowPromotes3FA(t *testing.T) {
	svc := New(Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-phone-no-shadow",
		}},
		RealnameCipher: stubRealnameCipher{},
	})
	session, code := mustPreparePhoneRealnameChallenge(t, svc, "13800138000", "phone-no-shadow@example.invalid")

	result, err := svc.VerifyRealnamePhone(context.Background(), session.Token, RealnamePhoneVerifyInput{Code: code})
	if err != nil {
		t.Fatalf("verify phone realname without shadow: %v", err)
	}
	if !result.OK || result.RealnameLevel != RealnameLevelPhone3FA || result.ShadowBindingStatus != shadowbinding.StatusDisabled {
		t.Fatalf("unexpected phone realname result: %+v", result)
	}

	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session: %v", err)
	}
	if current.User.RealnameLevel != RealnameLevelPhone3FA {
		t.Fatalf("expected phone_3fa, got %q", current.User.RealnameLevel)
	}
}

func TestVerifyRealnamePhoneWithShadowRequiresBindingSuccess(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	client := &stubShadowRegisterClient{err: errors.New("register failed")}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{
		Enabled: true,
		Now:     fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-phone-shadow",
		}},
		RealnameCipher:             stubRealnameCipher{},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	session, code := mustPreparePhoneRealnameChallenge(t, svc, "13800138001", "phone-shadow@example.invalid")

	_, err := svc.VerifyRealnamePhone(context.Background(), session.Token, RealnamePhoneVerifyInput{Code: code})
	if err == nil {
		t.Fatal("expected shadow binding failure to fail phone realname")
	}
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "shadow_binding_failed" || authErr.Status != 502 {
		t.Fatalf("expected shadow_binding_failed 502, got %#v", err)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session after failed shadow binding: %v", err)
	}
	if current.User.RealnameLevel != RealnameLevelIDCard2FA {
		t.Fatalf("expected failed shadow binding to keep idcard_2fa, got %q", current.User.RealnameLevel)
	}

	client.err = nil
	client.result = shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}
	result, err := svc.VerifyRealnamePhone(context.Background(), session.Token, RealnamePhoneVerifyInput{Code: code})
	if err != nil {
		t.Fatalf("retry phone realname after shadow recovery: %v", err)
	}
	if !result.OK || result.RealnameLevel != RealnameLevelPhone3FA || result.ShadowBindingStatus != shadowbinding.StatusActive {
		t.Fatalf("unexpected retried phone realname result: %+v", result)
	}
	current, err = svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session after recovered shadow binding: %v", err)
	}
	if current.User.RealnameLevel != RealnameLevelPhone3FA {
		t.Fatalf("expected phone_3fa after active shadow binding, got %q", current.User.RealnameLevel)
	}
}

func TestIssueTencentCloudConsoleAuthCodeUsesCurrentUsersActiveBinding(t *testing.T) {
	shadowSvc := shadowbinding.New(
		shadowbinding.NewMemoryStore(),
		&stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}},
		shadowbinding.Options{Enabled: true, Now: fixedNow, AuthCodePrefix: "bjsbx"},
	)
	svc := NewWithStore(
		NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true}),
		Options{Now: fixedNow, ShadowBinding: shadowSvc},
	)
	session := mustPasswordSessionWithPhone(t, svc, "console-login@example.invalid", "13800138090")
	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID: session.User.ID,
		Phone:  session.User.Phone,
	}); err != nil {
		t.Fatalf("seed active shadow binding: %v", err)
	}

	code, err := svc.IssueTencentCloudConsoleAuthCode(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("issue Tencent Cloud console auth code: %v", err)
	}
	if !strings.HasPrefix(code.Code, "bjsbx.") {
		t.Fatalf("expected Beijing routing prefix, got %q", code.Code)
	}
	if got, want := code.ExpiresAt, fixedNow().Add(10*time.Minute); !got.Equal(want) {
		t.Fatalf("expected expiry %s, got %s", want, got)
	}

	rawCode := strings.TrimPrefix(code.Code, "bjsbx.")
	consumed, err := shadowSvc.ConsumeAuthCode(context.Background(), rawCode)
	if err != nil {
		t.Fatalf("consume issued raw auth code: %v", err)
	}
	if got, want := consumed.UserID, session.User.ID; got != want {
		t.Fatalf("expected code for current user %q, got %q", want, got)
	}
}

func TestIssueTencentCloudConsoleAuthCodeRequiresActiveBinding(t *testing.T) {
	shadowSvc := shadowbinding.New(
		shadowbinding.NewMemoryStore(),
		&stubShadowRegisterClient{},
		shadowbinding.Options{Enabled: true, Now: fixedNow},
	)
	svc := NewWithStore(
		NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true}),
		Options{Now: fixedNow, ShadowBinding: shadowSvc},
	)
	session := mustPasswordSessionWithPhone(t, svc, "console-no-binding@example.invalid", "13800138091")

	_, err := svc.IssueTencentCloudConsoleAuthCode(context.Background(), session.Token)
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "shadow_binding_not_ready" || authErr.Status != http.StatusConflict {
		t.Fatalf("expected shadow_binding_not_ready 409, got %#v", err)
	}
}

func TestVerifyRealnamePhoneWithShadowUsesTencentCode(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	client := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{
		Enabled: true,
		Now:     fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-phone-shadow-cloud",
		}},
		RealnameCipher:             stubRealnameCipher{},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	session, _ := mustPreparePhoneRealnameChallenge(t, svc, "13800138002", "phone-shadow-cloud@example.invalid")

	result, err := svc.VerifyRealnamePhone(context.Background(), session.Token, RealnamePhoneVerifyInput{Code: "888888"})
	if err != nil {
		t.Fatalf("verify phone realname with tencent code: %v", err)
	}
	if !result.OK || result.RealnameLevel != RealnameLevelPhone3FA || result.ShadowBindingStatus != shadowbinding.StatusActive {
		t.Fatalf("unexpected phone realname result: %+v", result)
	}
	if client.calls != 1 || client.lastRegister.VerifyCode != "888888" || client.lastRegister.Phone != "13800138002" {
		t.Fatalf("expected tencent register with cloud code, calls=%d input=%+v", client.calls, client.lastRegister)
	}
}

func TestVerifyRealnamePhoneMapsTencentPhoneBound(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	client := &stubShadowRegisterClient{
		err: errors.New("[TencentCloudSDKError] Code=LimitExceeded.PhoneNumBound, Message=Phone number binding exceeds limit"),
	}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{
		Enabled: true,
		Now:     fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-phone-shadow-bound",
		}},
		RealnameCipher:             stubRealnameCipher{},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	session, _ := mustPreparePhoneRealnameChallenge(t, svc, "13800138003", "phone-shadow-bound@example.invalid")

	_, err := svc.VerifyRealnamePhone(context.Background(), session.Token, RealnamePhoneVerifyInput{Code: "888888"})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "phone_in_use" || authErr.Status != http.StatusConflict {
		t.Fatalf("expected phone_in_use 409, got %#v", err)
	}
}

func TestVerifyPhoneChangeUpdatesCurrentUserPhone(t *testing.T) {
	svc := New(Options{Now: fixedNow, VerificationCodeGenerator: fixedVerificationCode("654321")})
	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send initial sms: %v", err)
	}
	initialCode := mustCurrentSMSCode(t, svc, "13800138000")
	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{Name: "换绑用户", Phone: "13800138000", Code: initialCode})
	if err != nil {
		t.Fatalf("verify initial sms: %v", err)
	}

	if _, err := svc.SendPhoneChangeCode(context.Background(), session.Token, "13900139000", "127.0.0.1"); err != nil {
		t.Fatalf("send phone change sms: %v", err)
	}
	result, err := svc.VerifyPhoneChange(context.Background(), session.Token, PhoneChangeVerifyInput{
		Phone: "13900139000",
		Code:  mustCurrentSMSCode(t, svc, "13900139000"),
	})
	if err != nil {
		t.Fatalf("verify phone change: %v", err)
	}
	if !result.OK || result.User.Phone != "13900139000" || result.ShadowBindingStatus != shadowbinding.StatusDisabled {
		t.Fatalf("unexpected phone change result: %+v", result)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session: %v", err)
	}
	if current.User.Phone != "13900139000" {
		t.Fatalf("expected current session phone to be updated, got %q", current.User.Phone)
	}
}

func TestSendPhoneChangeCodeRequiresValidSession(t *testing.T) {
	svc := New(Options{Now: fixedNow})

	_, err := svc.SendPhoneChangeCode(context.Background(), "not-a-session-token", "13900139000", "127.0.0.1")
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "unauthorized" || authErr.Status != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized for invalid session token, got %#v", err)
	}
}

func TestVerifyPhoneChangeRejectsPhoneOwnedByAnotherUser(t *testing.T) {
	svc := New(Options{Now: fixedNow})
	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send first sms: %v", err)
	}
	firstCode := mustCurrentSMSCode(t, svc, "13800138000")
	first, err := svc.VerifySMS(context.Background(), VerifySMSInput{Name: "用户一", Phone: "13800138000", Code: firstCode})
	if err != nil {
		t.Fatalf("verify first user sms: %v", err)
	}
	if _, err := svc.SendVerificationCode(context.Background(), "13900139000"); err != nil {
		t.Fatalf("send second sms: %v", err)
	}
	secondCode := mustCurrentSMSCode(t, svc, "13900139000")
	if _, err := svc.VerifySMS(context.Background(), VerifySMSInput{Name: "用户二", Phone: "13900139000", Code: secondCode}); err != nil {
		t.Fatalf("verify second user sms: %v", err)
	}
	if _, err := svc.SendPhoneChangeCode(context.Background(), first.Token, "13900139000", "127.0.0.1"); err != nil {
		t.Fatalf("send phone change sms: %v", err)
	}
	_, err = svc.VerifyPhoneChange(context.Background(), first.Token, PhoneChangeVerifyInput{
		Phone: "13900139000",
		Code:  mustCurrentSMSCode(t, svc, "13900139000"),
	})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "phone_in_use" || authErr.Status != http.StatusConflict {
		t.Fatalf("expected phone_in_use conflict, got %#v", err)
	}
}

func TestPhoneChangeUsesTencentCodeForActiveShadowBinding(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	client := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{Now: fixedNow, VerificationCodeGenerator: fixedVerificationCode("111111"), ShadowBinding: shadowSvc})
	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send initial sms: %v", err)
	}
	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{Name: "换绑用户", Phone: "13800138000", Code: "111111"})
	if err != nil {
		t.Fatalf("verify initial sms: %v", err)
	}
	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID:     session.User.ID,
		Phone:      "13800138000",
		VerifyCode: "111111",
	}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}
	if _, err := svc.SendPhoneChangeCode(context.Background(), session.Token, "13900139000", "127.0.0.1"); err != nil {
		t.Fatalf("send phone change sms: %v", err)
	}
	if client.smsCalls != 1 || client.lastSMS.Phone != "13900139000" {
		t.Fatalf("expected tencent sms call for new phone, calls=%d input=%+v", client.smsCalls, client.lastSMS)
	}
	result, err := svc.VerifyPhoneChange(context.Background(), session.Token, PhoneChangeVerifyInput{
		Phone: "13900139000",
		Code:  "888888",
	})
	if err != nil {
		t.Fatalf("verify phone change with tencent code: %v", err)
	}
	if result.User.Phone != "13900139000" || client.updateCalls != 1 || client.lastUpdate.VerifyCode != "888888" {
		t.Fatalf("unexpected phone change result=%+v updateCalls=%d input=%+v", result, client.updateCalls, client.lastUpdate)
	}
}

func TestPhoneChangeUsesTencentCodeForInitialShadowBinding(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	client := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{Now: fixedNow, VerificationCodeGenerator: fixedVerificationCode("111111"), ShadowBinding: shadowSvc})
	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send initial sms: %v", err)
	}
	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{Name: "首次绑定用户", Phone: "13800138000", Code: "111111"})
	if err != nil {
		t.Fatalf("verify initial sms: %v", err)
	}

	if _, err := svc.SendPhoneChangeCode(context.Background(), session.Token, "13900139000", "127.0.0.1"); err != nil {
		t.Fatalf("send phone change sms: %v", err)
	}
	if client.smsCalls != 1 || client.lastSMS.Phone != "13900139000" {
		t.Fatalf("expected tencent sms call for initial shadow binding, calls=%d input=%+v", client.smsCalls, client.lastSMS)
	}
	result, err := svc.VerifyPhoneChange(context.Background(), session.Token, PhoneChangeVerifyInput{
		Phone:    "13900139000",
		Code:     "888888",
		ClientIP: "127.0.0.1",
		ClientUA: "test-agent",
	})
	if err != nil {
		t.Fatalf("verify phone change with tencent code: %v", err)
	}
	if result.User.Phone != "13900139000" || result.ShadowBindingStatus != shadowbinding.StatusActive {
		t.Fatalf("unexpected phone change result: %+v", result)
	}
	if client.calls != 1 {
		t.Fatalf("expected shadow account registration, calls=%d", client.calls)
	}
}

func TestSendShadowBindingCodeUsesTencentSMSWhenShadowEnabled(t *testing.T) {
	client := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(NewMemoryStore(StoreOptions{Now: fixedNow}), Options{Now: fixedNow, VerificationCodeGenerator: fixedVerificationCode("111111"), ShadowBinding: shadowSvc})

	if _, err := svc.SendShadowBindingCode(context.Background(), "13800138000", "127.0.0.1"); err != nil {
		t.Fatalf("send shadow binding sms: %v", err)
	}
	if client.smsCalls != 1 || client.lastSMS.Phone != "13800138000" {
		t.Fatalf("expected tencent sms call, calls=%d input=%+v", client.smsCalls, client.lastSMS)
	}
}

func TestPhoneChangeMapsTencentPhoneBound(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	client := &stubShadowRegisterClient{
		err: errors.New("[TencentCloudSDKError] Code=LimitExceeded.PhoneNumBound, Message=Phone number binding exceeds limit"),
	}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{Now: fixedNow, VerificationCodeGenerator: fixedVerificationCode("111111"), ShadowBinding: shadowSvc})
	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send initial sms: %v", err)
	}
	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{Name: "手机号占用用户", Phone: "13800138000", Code: "111111"})
	if err != nil {
		t.Fatalf("verify initial sms: %v", err)
	}
	client.err = nil
	if _, err := svc.SendPhoneChangeCode(context.Background(), session.Token, "13900139000", "127.0.0.1"); err != nil {
		t.Fatalf("send phone change sms: %v", err)
	}
	client.err = errors.New("[TencentCloudSDKError] Code=LimitExceeded.PhoneNumBound, Message=Phone number binding exceeds limit")

	_, err = svc.VerifyPhoneChange(context.Background(), session.Token, PhoneChangeVerifyInput{
		Phone: "13900139000",
		Code:  "888888",
	})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "phone_in_use" || authErr.Status != http.StatusConflict {
		t.Fatalf("expected phone_in_use 409, got %#v", err)
	}
}

func TestPhoneChangeMapsTencentVerifyCodeMismatch(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	client := &stubShadowRegisterClient{
		result: shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000},
	}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{Now: fixedNow, VerificationCodeGenerator: fixedVerificationCode("111111"), ShadowBinding: shadowSvc})
	if _, err := svc.SendVerificationCode(context.Background(), "13800138000"); err != nil {
		t.Fatalf("send initial sms: %v", err)
	}
	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{Name: "换绑用户", Phone: "13800138000", Code: "111111"})
	if err != nil {
		t.Fatalf("verify initial sms: %v", err)
	}
	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID:     session.User.ID,
		Phone:      "13800138000",
		VerifyCode: "111111",
	}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}
	if _, err := svc.SendPhoneChangeCode(context.Background(), session.Token, "13900139000", "127.0.0.1"); err != nil {
		t.Fatalf("send phone change code: %v", err)
	}
	client.err = errors.New("[TencentCloudSDKError] Code=OperationDenied.VerifyCodeNotMatch, Message=phone verify code error")
	_, err = svc.VerifyPhoneChange(context.Background(), session.Token, PhoneChangeVerifyInput{
		Phone: "13900139000",
		Code:  "bad-code",
	})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "invalid_sms_code" || authErr.Status != http.StatusBadRequest {
		t.Fatalf("expected invalid sms code mapping, got %#v", err)
	}
}

func TestShadowPhoneChangeDeletesChallengeAfterFiveWrongCodes(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	client := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{Now: fixedNow, VerificationCodeGenerator: fixedVerificationCode("111111"), ShadowBinding: shadowSvc})
	if _, err := svc.SendVerificationCode(context.Background(), "13800138001"); err != nil {
		t.Fatalf("send initial sms: %v", err)
	}
	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{Name: "防爆破用户", Phone: "13800138001", Code: "111111"})
	if err != nil {
		t.Fatalf("verify initial sms: %v", err)
	}
	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{UserID: session.User.ID, Phone: session.User.Phone, VerifyCode: "111111"}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}
	if _, err := svc.SendPhoneChangeCode(context.Background(), session.Token, "13900139001", "127.0.0.1"); err != nil {
		t.Fatalf("send phone change code: %v", err)
	}
	client.err = errors.New("[TencentCloudSDKError] Code=OperationDenied.VerifyCodeNotMatch, Message=phone verify code error")
	for attempt := 1; attempt <= 5; attempt++ {
		_, err := svc.VerifyPhoneChange(context.Background(), session.Token, PhoneChangeVerifyInput{Phone: "13900139001", Code: "wrong"})
		var authErr *Error
		if !errors.As(err, &authErr) || authErr.Code != "invalid_sms_code" {
			t.Fatalf("attempt %d: expected invalid_sms_code, got %#v", attempt, err)
		}
	}
	if client.updateCalls != 5 {
		t.Fatalf("expected five provider attempts, got %d", client.updateCalls)
	}
	_, err = svc.VerifyPhoneChange(context.Background(), session.Token, PhoneChangeVerifyInput{Phone: "13900139001", Code: "wrong"})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "sms_code_not_found" {
		t.Fatalf("expected exhausted challenge to require a new code, got %#v", err)
	}
	if client.updateCalls != 5 {
		t.Fatalf("exhausted challenge must block provider calls, got %d", client.updateCalls)
	}
}

func TestExternalSMSReservationIsSingleFlightAndGenerationBound(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	now := fixedNow()
	if _, err := store.SendVerificationCode(context.Background(), "13900139002", "111111", now, 5*time.Minute, time.Minute, 5); err != nil {
		t.Fatalf("send first challenge: %v", err)
	}
	first, err := store.ReserveExternalSMSChallenge(context.Background(), "13900139002", "reservation-1", now)
	if err != nil {
		t.Fatalf("reserve first challenge: %v", err)
	}
	if _, err := store.ReserveExternalSMSChallenge(context.Background(), "13900139002", "reservation-2", now); err == nil {
		t.Fatal("parallel reservation must be rejected")
	}

	secondNow := now.Add(time.Minute)
	if _, err := store.SendVerificationCode(context.Background(), "13900139002", "222222", secondNow, 5*time.Minute, time.Minute, 5); err != nil {
		t.Fatalf("send replacement challenge: %v", err)
	}
	if err := store.ConsumeExternalSMSChallenge(context.Background(), first); err != nil {
		t.Fatalf("consume stale reservation: %v", err)
	}
	second, err := store.ReserveExternalSMSChallenge(context.Background(), "13900139002", "reservation-3", secondNow)
	if err != nil {
		t.Fatalf("stale reservation must not delete replacement challenge: %v", err)
	}
	if second.Generation == first.Generation {
		t.Fatalf("replacement challenge must advance generation: first=%d second=%d", first.Generation, second.Generation)
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

func TestVerifyRealnameSkipsPhoneForSMSLoginWithoutShadow(t *testing.T) {
	svc := New(Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-skip-phone",
		}},
		RealnameCipher: stubRealnameCipher{},
	})
	if _, err := svc.SendVerificationCode(context.Background(), "13800138088"); err != nil {
		t.Fatalf("send login sms: %v", err)
	}
	code := mustCurrentSMSCode(t, svc, "13800138088")
	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{
		Name:       "短信用户",
		Phone:      "13800138088",
		Code:       code,
		InviteCode: "VALID2026",
	})
	if err != nil {
		t.Fatalf("verify login sms: %v", err)
	}
	if session.AuthMethod != AuthMethodSMS {
		t.Fatalf("expected sms auth method, got %q", session.AuthMethod)
	}

	result, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"})
	if err != nil {
		t.Fatalf("verify realname: %v", err)
	}
	if result.PhoneVerificationRequired || !result.PhoneVerificationSkipped || result.RealnameLevel != RealnameLevelPhone3FA {
		t.Fatalf("unexpected skip-phone result: %+v", result)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session: %v", err)
	}
	if current.User.RealnameLevel != RealnameLevelPhone3FA {
		t.Fatalf("expected phone_3fa, got %q", current.User.RealnameLevel)
	}
}

func TestVerifyRealnameSkipsPhoneForActiveShadowBinding(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	client := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{
		Enabled: true,
		Now:     fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-active-shadow-skip-phone",
		}},
		RealnameCipher:             stubRealnameCipher{},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	session := mustPasswordSessionWithPhone(t, svc, "active-shadow-skip-phone@example.invalid", "13800138089")
	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID:     session.User.ID,
		Phone:      session.User.Phone,
		ClientIP:   "127.0.0.1",
		ClientUA:   "test",
		VerifyCode: "888888",
	}); err != nil {
		t.Fatalf("seed active shadow binding: %v", err)
	}

	result, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"})
	if err != nil {
		t.Fatalf("verify realname: %v", err)
	}
	if result.PhoneVerificationRequired || !result.PhoneVerificationSkipped || result.RealnameLevel != RealnameLevelPhone3FA || result.ShadowBindingStatus != shadowbinding.StatusActive {
		t.Fatalf("unexpected active-shadow skip result: %+v", result)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session: %v", err)
	}
	if current.User.RealnameLevel != RealnameLevelPhone3FA {
		t.Fatalf("expected phone_3fa, got %q", current.User.RealnameLevel)
	}
}

func TestCurrentProfileReportsSucceededBasicAuthSyncWithoutPromotingOnRead(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	client := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000054, OwnerUin: 300000000054, AppID: 1250000000}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{
		Enabled: true,
		Now:     fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-converge-active-shadow",
		}},
		RealnameCipher:             stubRealnameCipher{},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	session := mustPasswordSessionWithPhone(t, svc, "converge-active-shadow@example.invalid", "13800138090")

	result, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"})
	if err != nil {
		t.Fatalf("verify realname: %v", err)
	}
	if !result.PhoneVerificationRequired || result.PhoneVerificationSkipped {
		t.Fatalf("expected phone verification before shadow binding, got %+v", result)
	}

	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID:     session.User.ID,
		Phone:      session.User.Phone,
		ClientIP:   "127.0.0.1",
		ClientUA:   "test",
		VerifyCode: "888888",
	}); err != nil {
		t.Fatalf("seed active shadow binding: %v", err)
	}
	if err := shadowSvc.SaveBasicAuth(context.Background(), shadowbinding.BasicAuthInput{
		UserID:      session.User.ID,
		AccountType: 0,
		Name:        "张三",
		IDCard:      "11010519491231002X",
		ClientIP:    "127.0.0.1",
		ClientUA:    "test",
	}); err != nil {
		t.Fatalf("seed basic auth sync: %v", err)
	}

	profile, err := svc.CurrentProfile(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current profile: %v", err)
	}
	if profile.RealnameLevel != RealnameLevelIDCard2FA {
		t.Fatalf("expected current profile to keep idcard_2fa on read, got %q", profile.RealnameLevel)
	}
	if profile.RealnameSyncStatus != RealnameSyncStatusSucceeded {
		t.Fatalf("expected succeeded realname sync status, got %+v", profile)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session: %v", err)
	}
	if current.User.RealnameLevel != RealnameLevelIDCard2FA {
		t.Fatalf("expected current session to keep idcard_2fa on read, got %q", current.User.RealnameLevel)
	}
	if current.User.RealnameSyncStatus != RealnameSyncStatusSucceeded {
		t.Fatalf("expected current session sync status to keep succeeded, got %+v", current.User)
	}
	stored, err := svc.FindUserByID(context.Background(), session.User.ID)
	if err != nil {
		t.Fatalf("find stored user: %v", err)
	}
	if stored.RealnameLevel != RealnameLevelIDCard2FA {
		t.Fatalf("expected read path not to promote stored user, got %q", stored.RealnameLevel)
	}
}

func TestCurrentProfileReportsPendingBasicAuthSyncWithoutCallingCloud(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	client := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000055, OwnerUin: 300000000055, AppID: 1250000000}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{
		Enabled: true,
		Now:     fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-pending-basic-auth",
		}},
		RealnameCipher:             stubRealnameCipher{},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	session := mustPasswordSessionWithPhone(t, svc, "pending-basic-auth@example.invalid", "13800138091")

	result, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"})
	if err != nil {
		t.Fatalf("verify realname: %v", err)
	}
	if !result.PhoneVerificationRequired {
		t.Fatalf("expected phone verification before binding, got %+v", result)
	}
	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID:     session.User.ID,
		Phone:      session.User.Phone,
		VerifyCode: "888888",
	}); err != nil {
		t.Fatalf("seed active shadow binding: %v", err)
	}
	callsBeforeProfile := client.basicAuthCalls
	profile, err := svc.CurrentProfile(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current profile: %v", err)
	}
	if profile.RealnameLevel != RealnameLevelIDCard2FA || profile.RealnameSyncStatus != RealnameSyncStatusPending {
		t.Fatalf("expected idcard_2fa pending sync status, got %+v", profile)
	}
	if client.basicAuthCalls != callsBeforeProfile {
		t.Fatalf("current profile must not call basic auth sync, before=%d after=%d", callsBeforeProfile, client.basicAuthCalls)
	}
}

func TestRetryRealnameSyncPromotesAfterStoredRealname(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	client := &stubShadowRegisterClient{
		result:       shadowbinding.CloudRegisterResult{Uin: 300000000056, OwnerUin: 300000000056, AppID: 1250000000},
		basicAuthErr: errors.New("save basic auth failed"),
	}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{
		Enabled: true,
		Now:     fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-retry-basic-auth",
		}},
		RealnameCipher:             stubRealnameCipher{},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	session := mustPasswordSessionWithPhone(t, svc, "retry-basic-auth@example.invalid", "13800138092")
	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID:     session.User.ID,
		Phone:      session.User.Phone,
		VerifyCode: "888888",
	}); err != nil {
		t.Fatalf("seed active shadow binding: %v", err)
	}
	if _, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"}); err != nil {
		t.Fatalf("verify realname should keep local success: %v", err)
	}
	failedProfile, err := svc.CurrentProfile(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current profile after failed sync: %v", err)
	}
	if failedProfile.RealnameLevel != RealnameLevelIDCard2FA || failedProfile.RealnameSyncStatus != RealnameSyncStatusFailed {
		t.Fatalf("expected failed sync before retry, got %+v", failedProfile)
	}

	passNotifier := &recordingPassBillingMigrationNotifier{}
	svc.passBillingMigrationNotifier = passNotifier
	client.basicAuthErr = nil
	result, err := svc.RetryRealnameSync(context.Background(), session.Token, "127.0.0.1", "agent")
	if err != nil {
		t.Fatalf("retry realname sync: %v", err)
	}
	if !result.OK || result.User.RealnameLevel != RealnameLevelPhone3FA || result.RealnameSyncStatus != RealnameSyncStatusSucceeded {
		t.Fatalf("unexpected retry result: %+v", result)
	}
	if client.lastBasicAuth.Name != "张三" || client.lastBasicAuth.IDCard != "11010519491231002X" || client.lastBasicAuth.ClientIP != "127.0.0.1" || client.lastBasicAuth.ClientUA != "agent" {
		t.Fatalf("expected retry to use stored realname and client context, got %+v", client.lastBasicAuth)
	}
	if len(passNotifier.calls) != 1 {
		t.Fatalf("expected retry success to notify pass billing migration once, got %d", len(passNotifier.calls))
	}
	if got := passNotifier.calls[0]; got.UserID != session.User.ID || got.Uin != 300000000056 || got.AppID != 1250000000 {
		t.Fatalf("unexpected pass billing migration binding: %+v", got)
	}

	passNotifier.calls = nil
	again, err := svc.RetryRealnameSync(context.Background(), session.Token, "127.0.0.1", "agent")
	if err != nil {
		t.Fatalf("retry realname sync after success: %v", err)
	}
	if !again.OK || again.RealnameSyncStatus != RealnameSyncStatusSucceeded {
		t.Fatalf("unexpected already-synced retry result: %+v", again)
	}
	if len(passNotifier.calls) != 1 {
		t.Fatalf("expected already-synced retry to notify pass billing migration once, got %d", len(passNotifier.calls))
	}
}

func TestRetryRealnameSyncFailureKeepsIDCardLevelAndRecordsFailure(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	client := &stubShadowRegisterClient{
		result:       shadowbinding.CloudRegisterResult{Uin: 300000000057, OwnerUin: 300000000057, AppID: 1250000000},
		basicAuthErr: errors.New("save basic auth failed"),
	}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), client, shadowbinding.Options{
		Enabled: true,
		Now:     fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-retry-basic-auth-failed",
		}},
		RealnameCipher:             stubRealnameCipher{},
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
	})
	session := mustPasswordSessionWithPhone(t, svc, "retry-basic-auth-failed@example.invalid", "13800138093")
	if _, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"}); err != nil {
		t.Fatalf("verify realname: %v", err)
	}
	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID:     session.User.ID,
		Phone:      session.User.Phone,
		VerifyCode: "888888",
	}); err != nil {
		t.Fatalf("seed active shadow binding: %v", err)
	}

	_, err := svc.RetryRealnameSync(context.Background(), session.Token, "127.0.0.1", "agent")
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "shadow_basic_auth_failed" || authErr.Status != http.StatusBadGateway {
		t.Fatalf("expected shadow_basic_auth_failed 502, got %#v", err)
	}
	current, err := svc.CurrentProfile(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current profile: %v", err)
	}
	if current.RealnameLevel != RealnameLevelIDCard2FA || current.RealnameSyncStatus != RealnameSyncStatusFailed {
		t.Fatalf("expected failed sync to keep idcard_2fa, got %+v", current)
	}
	binding, err := shadowSvc.GetBindingByUserID(context.Background(), session.User.ID)
	if err != nil {
		t.Fatalf("get binding: %v", err)
	}
	if binding.BasicAuthStatus != shadowbinding.BasicAuthStatusFailed || binding.BasicAuthLastErrorCode == "" {
		t.Fatalf("expected retry failure to be recorded, got %+v", binding)
	}
}

func TestVerifyRealnameRequiresPhoneForNonSMSLogin(t *testing.T) {
	svc := New(Options{
		Now: fixedNow,
		RealnameVerifier: stubRealnameVerifier{result: RealnameProviderResult{
			Result:    "0",
			RequestID: "req-require-phone",
		}},
		RealnameCipher: stubRealnameCipher{},
	})
	session := mustPasswordSession(t, svc, "require-phone@example.invalid")

	result, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"})
	if err != nil {
		t.Fatalf("verify realname: %v", err)
	}
	if !result.PhoneVerificationRequired || result.PhoneVerificationSkipped {
		t.Fatalf("expected phone step to remain required, got %+v", result)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session: %v", err)
	}
	if current.User.RealnameLevel != RealnameLevelIDCard2FA {
		t.Fatalf("expected idcard_2fa, got %q", current.User.RealnameLevel)
	}
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

func mustPreparePhoneRealnameChallenge(t *testing.T, svc *Service, phone string, email string) (*AuthSession, string) {
	t.Helper()
	session := mustPasswordSessionWithPhone(t, svc, email, phone)
	if _, err := svc.VerifyRealname(context.Background(), session.Token, RealnameVerifyInput{Name: "张三", IDCard: "11010519491231002X"}); err != nil {
		t.Fatalf("verify idcard realname for %s: %v", email, err)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session after idcard realname: %v", err)
	}
	if current.User.RealnameLevel != RealnameLevelIDCard2FA {
		t.Fatalf("expected idcard_2fa before phone realname, got %q", current.User.RealnameLevel)
	}
	if _, err := svc.SendVerificationCode(context.Background(), phone); err != nil {
		t.Fatalf("send phone realname sms: %v", err)
	}
	return session, mustCurrentSMSCode(t, svc, phone)
}

func mustPasswordSessionWithPhone(t *testing.T, svc *Service, email, phone string) *AuthSession {
	t.Helper()
	session := mustPasswordSession(t, svc, email)
	store, ok := svc.store.(*MemoryStore)
	if !ok {
		t.Fatal("expected memory store for phone realname test helper")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	user, exists := store.usersByID[session.User.ID]
	if !exists {
		t.Fatalf("user %s not found", session.User.ID)
	}
	user.Phone = phone
	store.usersByID[user.ID] = user
	store.usersByPhone[phone] = user.ID
	session.User = user
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

type countingRealnameVerifier struct {
	calls  int
	result RealnameProviderResult
	err    error
}

func (s *countingRealnameVerifier) Verify(_ context.Context, _ string, _ string) (RealnameProviderResult, error) {
	s.calls++
	if s.err != nil {
		return RealnameProviderResult{}, s.err
	}
	return s.result, nil
}

type stubRealnameCipher struct{}

func (stubRealnameCipher) Encrypt(plaintext string) (string, error) {
	return fmt.Sprintf("enc(%s)", plaintext), nil
}

func (stubRealnameCipher) Decrypt(ciphertext string) (string, error) {
	if strings.HasPrefix(ciphertext, "enc(") && strings.HasSuffix(ciphertext, ")") {
		return strings.TrimSuffix(strings.TrimPrefix(ciphertext, "enc("), ")"), nil
	}
	return "", fmt.Errorf("decrypt error")
}

type stubShadowRegisterClient struct {
	calls             int
	smsCalls          int
	updateCalls       int
	basicAuthCalls    int
	temporaryCalls    int
	accountInfoCalls  int
	lastSMS           shadowbinding.CloudSendSMSInput
	lastRegister      shadowbinding.CloudRegisterInput
	lastUpdate        shadowbinding.CloudUpdatePhoneInput
	lastBasicAuth     shadowbinding.CloudSaveBasicAuthInput
	lastTemporary     shadowbinding.CloudTemporaryCredentialsInput
	result            shadowbinding.CloudRegisterResult
	temporaryResult   shadowbinding.CloudTemporaryCredentials
	accountInfoResult shadowbinding.CloudAccountInfo
	err               error
	basicAuthErr      error
}

func (c *stubShadowRegisterClient) GetTemporaryCredentialsForSaaS(_ context.Context, in shadowbinding.CloudTemporaryCredentialsInput) (shadowbinding.CloudTemporaryCredentials, error) {
	c.temporaryCalls++
	c.lastTemporary = in
	return c.temporaryResult, nil
}

func (c *stubShadowRegisterClient) DescribeAccountInfo(context.Context, shadowbinding.CloudTemporaryCredentials) (shadowbinding.CloudAccountInfo, error) {
	c.accountInfoCalls++
	return c.accountInfoResult, nil
}

func (c *stubShadowRegisterClient) SendSMSVerifyCode(_ context.Context, in shadowbinding.CloudSendSMSInput) error {
	c.smsCalls++
	c.lastSMS = in
	if c.err != nil {
		return c.err
	}
	return nil
}

func (c *stubShadowRegisterClient) RegisterShadowAccount(_ context.Context, in shadowbinding.CloudRegisterInput) (shadowbinding.CloudRegisterResult, error) {
	c.calls++
	c.lastRegister = in
	if c.err != nil {
		return shadowbinding.CloudRegisterResult{}, c.err
	}
	return c.result, nil
}

func (c *stubShadowRegisterClient) UpdatePhoneByAuthCode(_ context.Context, in shadowbinding.CloudUpdatePhoneInput) error {
	c.updateCalls++
	c.lastUpdate = in
	if c.err != nil {
		return c.err
	}
	return nil
}

func (c *stubShadowRegisterClient) SaveBasicAuthForSaaS(_ context.Context, in shadowbinding.CloudSaveBasicAuthInput) error {
	c.basicAuthCalls++
	c.lastBasicAuth = in
	return c.basicAuthErr
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
