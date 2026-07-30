package service

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
	"golang.org/x/crypto/bcrypt"
)

func TestPhoneAuthEnabledExistingUserUsesLocalCodeAndPreservesName(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})

	legacy := NewWithStore(store, Options{
		Now:                       fixedNow,
		VerificationCodeGenerator: fixedVerificationCode("111111"),
	})
	if _, err := legacy.SendVerificationCode(context.Background(), "13800138131"); err != nil {
		t.Fatalf("seed send failed: %v", err)
	}
	if _, err := legacy.VerifySMS(context.Background(), VerifySMSInput{
		Name:  "原始名字",
		Phone: "13800138131",
		Code:  "111111",
	}); err != nil {
		t.Fatalf("seed verify failed: %v", err)
	}

	sender := &stubPhoneAuthSMSSender{}
	shadowClient := &stubShadowRegisterClient{}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), shadowClient, shadowbinding.Options{
		Enabled: true,
		Now:     fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		PhoneAuth: PhoneAuthConfig{
			Enabled:   true,
			SMSSender: sender,
		},
		ShadowBinding: shadowSvc,
	})

	if _, err := svc.SendVerificationCode(context.Background(), "13800138131"); err != nil {
		t.Fatalf("phone auth send failed: %v", err)
	}
	if len(store.smsChallenges) != 0 {
		t.Fatalf("expected legacy sms_challenges to stay empty, got %+v", store.smsChallenges)
	}
	if challenge, ok := store.phoneAuthChallenges["13800138131"]; !ok || challenge.Flow != PhoneAuthFlowExistingUserLocal {
		t.Fatalf("expected dedicated existing-user challenge, got %+v", store.phoneAuthChallenges)
	} else if challenge.CodeHash == sender.lastCode || bcrypt.CompareHashAndPassword([]byte(challenge.CodeHash), []byte(sender.lastCode)) != nil {
		t.Fatal("expected phone auth challenge to store only a verifiable code hash")
	}
	if sender.calls != 1 || sender.lastPhone != "13800138131" || sender.lastCode == "" {
		t.Fatalf("expected one local sms send, sender=%+v", sender)
	}
	if shadowClient.smsCalls != 0 || shadowClient.calls != 0 {
		t.Fatalf("expected no shadow cloud calls for existing user, smsCalls=%d registerCalls=%d", shadowClient.smsCalls, shadowClient.calls)
	}

	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{
		Name:  "新名字不能覆盖",
		Phone: "13800138131",
		Code:  sender.lastCode,
	})
	if err != nil {
		t.Fatalf("phone auth verify failed: %v", err)
	}
	if session.User.Name != "原始名字" {
		t.Fatalf("expected existing user name to stay unchanged, got %q", session.User.Name)
	}
}

func TestPhoneAuthDisabledKeepsLegacyNameUpdateBehavior(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})
	svc := NewWithStore(store, Options{
		Now:                       fixedNow,
		VerificationCodeGenerator: fixedVerificationCode("111111"),
	})

	if _, err := svc.SendVerificationCode(context.Background(), "13800138134"); err != nil {
		t.Fatalf("first send failed: %v", err)
	}
	if _, err := svc.VerifySMS(context.Background(), VerifySMSInput{Name: "原始名字", Phone: "13800138134", Code: "111111"}); err != nil {
		t.Fatalf("first verify failed: %v", err)
	}
	store.mu.Lock()
	delete(store.smsChallenges, "13800138134")
	store.mu.Unlock()
	if _, err := svc.SendVerificationCode(context.Background(), "13800138134"); err != nil {
		t.Fatalf("second send failed: %v", err)
	}
	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{Name: "更新名字", Phone: "13800138134", Code: "111111"})
	if err != nil {
		t.Fatalf("second verify failed: %v", err)
	}
	if session.User.Name != "更新名字" {
		t.Fatalf("expected legacy SMS flow to update name, got %q", session.User.Name)
	}
}

func TestPhoneAuthEnabledUnknownPhoneUsesShadowAndAllowsMissingName(t *testing.T) {
	store := NewMemoryStore(StoreOptions{
		Now:                fixedNow,
		SeedDefaultInvites: true,
	})

	sender := &stubPhoneAuthSMSSender{}
	shadowStore := shadowbinding.NewMemoryStore()
	shadowClient := &stubShadowRegisterClient{
		result: shadowbinding.CloudRegisterResult{
			Uin:      300000000071,
			OwnerUin: 300000000071,
			AppID:    1250000000,
		},
	}
	shadowSvc := shadowbinding.New(shadowStore, shadowClient, shadowbinding.Options{
		Enabled: true,
		Now:     fixedNow,
	})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		PhoneAuth: PhoneAuthConfig{
			Enabled:   true,
			SMSSender: sender,
		},
		ShadowBinding: shadowSvc,
	})

	if _, err := svc.SendVerificationCode(context.Background(), "13800138132"); err != nil {
		t.Fatalf("phone auth send failed: %v", err)
	}
	if len(store.smsChallenges) != 0 {
		t.Fatalf("expected legacy sms_challenges to stay empty, got %+v", store.smsChallenges)
	}
	if challenge, ok := store.phoneAuthChallenges["13800138132"]; !ok || challenge.Flow != PhoneAuthFlowNewUserShadow {
		t.Fatalf("expected dedicated shadow challenge, got %+v", store.phoneAuthChallenges)
	}
	if sender.calls != 0 {
		t.Fatalf("expected no local sms send for unknown phone, sender=%+v", sender)
	}
	if shadowClient.smsCalls != 1 || shadowClient.lastSMS.Phone != "13800138132" {
		t.Fatalf("expected shadow sms for unknown phone, smsCalls=%d last=%+v", shadowClient.smsCalls, shadowClient.lastSMS)
	}

	session, err := svc.VerifySMS(context.Background(), VerifySMSInput{
		Phone: "13800138132",
		Code:  "888888",
	})
	if err != nil {
		t.Fatalf("phone auth verify failed: %v", err)
	}
	if session.User.Name != "用户8132" {
		t.Fatalf("expected fallback name for missing input, got %q", session.User.Name)
	}
	if session.User.Phone != "13800138132" {
		t.Fatalf("unexpected phone in session user: %+v", session.User)
	}
	if shadowClient.calls != 1 || shadowClient.lastRegister.Phone != "13800138132" || shadowClient.lastRegister.VerifyCode != "888888" {
		t.Fatalf("expected RegisterCloudForSaaS verification, calls=%d input=%+v", shadowClient.calls, shadowClient.lastRegister)
	}
	binding, err := shadowSvc.GetBindingByUserID(context.Background(), session.User.ID)
	if err != nil {
		t.Fatalf("get shadow binding: %v", err)
	}
	if binding.Status != shadowbinding.StatusActive {
		t.Fatalf("expected active shadow binding before session issuance, got %+v", binding)
	}
}

func TestExternalPhoneAuthReservationIsSingleFlightAndGenerationBound(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	now := fixedNow()
	firstChallenge := PhoneAuthChallenge{Phone: "13800138135", Flow: PhoneAuthFlowNewUserShadow}
	if _, err := store.SendPhoneAuthChallenge(context.Background(), firstChallenge, now, 5*time.Minute, time.Minute, 5); err != nil {
		t.Fatalf("send first phone auth challenge: %v", err)
	}
	first, err := store.ReserveExternalPhoneAuthChallenge(context.Background(), firstChallenge.Phone, "reservation-1", now)
	if err != nil {
		t.Fatalf("reserve first phone auth challenge: %v", err)
	}
	if _, err := store.ReserveExternalPhoneAuthChallenge(context.Background(), firstChallenge.Phone, "reservation-2", now); err == nil {
		t.Fatal("parallel phone auth reservation must be rejected")
	}

	secondNow := now.Add(time.Minute)
	if _, err := store.SendPhoneAuthChallenge(context.Background(), firstChallenge, secondNow, 5*time.Minute, time.Minute, 5); err != nil {
		t.Fatalf("send replacement phone auth challenge: %v", err)
	}
	if err := store.ConsumeExternalPhoneAuthChallenge(context.Background(), first); err != nil {
		t.Fatalf("consume stale phone auth reservation: %v", err)
	}
	second, err := store.ReserveExternalPhoneAuthChallenge(context.Background(), firstChallenge.Phone, "reservation-3", secondNow)
	if err != nil {
		t.Fatalf("stale reservation must not delete replacement phone auth challenge: %v", err)
	}
	if second.Generation == first.Generation {
		t.Fatalf("replacement phone auth challenge must advance generation: first=%d second=%d", first.Generation, second.Generation)
	}
}

func TestNewUserPhoneAuthStopsAfterFiveWrongShadowCodes(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	shadowClient := &stubShadowRegisterClient{}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), shadowClient, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		PhoneAuth: PhoneAuthConfig{
			Enabled:   true,
			SMSSender: &stubPhoneAuthSMSSender{},
		},
		ShadowBinding: shadowSvc,
	})
	phone := "13800138136"
	if _, err := svc.SendVerificationCode(context.Background(), phone); err != nil {
		t.Fatalf("send phone auth code: %v", err)
	}
	shadowClient.err = errors.New("[TencentCloudSDKError] Code=OperationDenied.VerifyCodeNotMatch, Message=phone verify code error")
	for attempt := 1; attempt <= 5; attempt++ {
		_, err := svc.VerifySMS(context.Background(), VerifySMSInput{Phone: phone, Code: "wrong"})
		var authErr *Error
		if !errors.As(err, &authErr) || authErr.Code != "invalid_sms_code" {
			t.Fatalf("attempt %d: expected invalid_sms_code, got %#v", attempt, err)
		}
	}
	if shadowClient.calls != 5 {
		t.Fatalf("expected five provider attempts, got %d", shadowClient.calls)
	}
	_, err := svc.VerifySMS(context.Background(), VerifySMSInput{Phone: phone, Code: "wrong"})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "sms_code_not_found" || authErr.Status != http.StatusBadRequest {
		t.Fatalf("expected exhausted challenge to require a new code, got %#v", err)
	}
	if shadowClient.calls != 5 {
		t.Fatalf("exhausted challenge must block provider calls, got %d", shadowClient.calls)
	}
}

type stubPhoneAuthSMSSender struct {
	calls      int
	lastPhone  string
	lastCode   string
	lastExpiry int
	err        error
}

func (s *stubPhoneAuthSMSSender) SendVerificationCode(_ context.Context, phone string, code string, expiryMinutes int) error {
	s.calls++
	s.lastPhone = phone
	s.lastCode = code
	s.lastExpiry = expiryMinutes
	return s.err
}
