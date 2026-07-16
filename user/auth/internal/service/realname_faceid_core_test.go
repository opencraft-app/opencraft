package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

type stubFaceIDVerifier struct {
	detectAuthCalls int
	getInfoCalls    int
	detectAuthIn    RealnameFaceIDDetectAuthInput
	getInfoIn       RealnameFaceIDGetDetectInfoInput
	detectAuthOut   RealnameFaceIDDetectAuthResult
	getInfoOut      RealnameFaceIDProviderCheckResult
	detectAuthErr   error
	getInfoErr      error
}

func (s *stubFaceIDVerifier) DetectAuth(_ context.Context, in RealnameFaceIDDetectAuthInput) (RealnameFaceIDDetectAuthResult, error) {
	s.detectAuthCalls++
	s.detectAuthIn = in
	if s.detectAuthErr != nil {
		return RealnameFaceIDDetectAuthResult{}, s.detectAuthErr
	}
	return s.detectAuthOut, nil
}

func (s *stubFaceIDVerifier) GetDetectInfoEnhanced(_ context.Context, in RealnameFaceIDGetDetectInfoInput) (RealnameFaceIDProviderCheckResult, error) {
	s.getInfoCalls++
	s.getInfoIn = in
	if s.getInfoErr != nil {
		return RealnameFaceIDProviderCheckResult{}, s.getInfoErr
	}
	return s.getInfoOut, nil
}

func TestFaceRequiredCurrentSessionIgnoresLegacyRealnameProjection(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	svc := NewWithStore(store, Options{
		Now: fixedNow,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode: RealnameAssuranceModeFaceRequired,
		},
	})
	session := mustPasswordSessionWithPhone(t, svc, "face-required-legacy@example.invalid", "13800138110")

	store.mu.Lock()
	user := store.usersByID[session.User.ID]
	user.RealnameVerified = true
	user.RealnameLevel = RealnameLevelPhone3FA
	user.realnameVerifiedAt = ptrTime(fixedNow())
	store.usersByID[user.ID] = user
	store.mu.Unlock()

	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current session: %v", err)
	}
	if current.User.RealnameVerified {
		t.Fatalf("expected legacy-only projection to be false in face_required mode, got %+v", current.User)
	}
	if current.User.RealnameLevel != RealnameLevelNone {
		t.Fatalf("expected face_required mode to clear legacy realname level, got %+v", current.User)
	}
	if current.User.RealnameAssuranceMode != string(RealnameAssuranceModeFaceRequired) {
		t.Fatalf("expected face_required mode in session projection, got %+v", current.User)
	}
}

func TestStartRealnameFaceIDAttemptReusesMatchingUnexpiredAttemptWithoutChargingQuota(t *testing.T) {
	provider := &stubFaceIDVerifier{
		detectAuthOut: RealnameFaceIDDetectAuthResult{
			BizToken:  "biz-1",
			VerifyURL: "https://faceid.example.com/biz-1",
			RequestID: "req-start-1",
		},
	}
	svc := NewWithStore(NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true}), Options{
		Now:                    fixedNow,
		RealnameCipher:         stubRealnameCipher{},
		RealnameFaceIDVerifier: provider,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode:        RealnameAssuranceModeObserve,
			RuleID:      "rule-1",
			AccountID:   "acct-1",
			RedirectURL: "https://api.example.com/auth/realname/faceid/callback",
			DigestKey:   []byte("0123456789abcdef0123456789abcdef"),
			DailyQuota:  5,
			AttemptTTL:  2 * time.Hour,
			LeaseTTL:    30 * time.Second,
		},
	})
	session := mustPasswordSessionWithPhone(t, svc, "reuse-faceid@example.invalid", "13800138111")

	first, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name:            "张三",
		IDCard:          "11010519491231002X",
		ClientIP:        "127.0.0.1",
		ClientUA:        "agent",
		ConsentAccepted: true,
	})
	if err != nil {
		t.Fatalf("start first attempt: %v", err)
	}
	second, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name:            "张三",
		IDCard:          "11010519491231002X",
		ClientIP:        "127.0.0.1",
		ClientUA:        "agent",
		ConsentAccepted: true,
	})
	if err != nil {
		t.Fatalf("start second attempt: %v", err)
	}
	if second.AttemptID != first.AttemptID || !second.Reused {
		t.Fatalf("expected reused attempt, first=%+v second=%+v", first, second)
	}
	if provider.detectAuthCalls != 1 {
		t.Fatalf("expected one DetectAuth call for reused attempt, got %d", provider.detectAuthCalls)
	}
}

func TestStartRealnameFaceIDAttemptAllowsUserWithoutPhone(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	svc := NewWithStore(store, Options{
		Now:            fixedNow,
		RealnameCipher: stubRealnameCipher{},
		RealnameFaceIDVerifier: &stubFaceIDVerifier{detectAuthOut: RealnameFaceIDDetectAuthResult{
			BizToken: "biz-clean-user", VerifyURL: "https://faceid.example.invalid/clean-user", RequestID: "req-clean-user",
		}},
		RealnameFaceID: RealnameFaceIDConfig{
			Mode: RealnameAssuranceModeObserve, RuleID: "rule-1", AccountID: "acct-1",
			RedirectURL: "https://api.example.com/auth/realname/faceid/callback",
			DigestKey:   []byte("0123456789abcdef0123456789abcdef"), DailyQuota: 5,
			AttemptTTL: 2 * time.Hour, LeaseTTL: 30 * time.Second,
		},
	})
	session := mustPasswordSession(t, svc, "clean-faceid@example.invalid")

	started, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name: "张三", IDCard: "11010519491231002X", ClientIP: "127.0.0.1", ClientUA: "agent", ConsentAccepted: true,
	})
	if err != nil {
		t.Fatalf("start clean-user attempt: %v", err)
	}
	attempt, err := store.GetRealnameFaceIDAttempt(context.Background(), started.AttemptID)
	if err != nil {
		t.Fatalf("get clean-user attempt: %v", err)
	}
	if attempt.CurrentPhoneHash != "" {
		t.Fatalf("clean-user attempt must not bind a phone before FaceID succeeds, got %q", attempt.CurrentPhoneHash)
	}
}

func TestStartRealnameFaceIDAttemptReplacesInvalidReusableBizToken(t *testing.T) {
	provider := &stubFaceIDVerifier{
		detectAuthOut: RealnameFaceIDDetectAuthResult{
			BizToken:  "biz-old",
			VerifyURL: "https://faceid.example.com/biz-old",
			RequestID: "req-start-old",
		},
	}
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	svc := NewWithStore(store, Options{
		Now:                    fixedNow,
		RealnameCipher:         stubRealnameCipher{},
		RealnameFaceIDVerifier: provider,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode:        RealnameAssuranceModeObserve,
			RuleID:      "rule-1",
			AccountID:   "acct-1",
			RedirectURL: "https://api.example.com/auth/realname/faceid/callback",
			DigestKey:   []byte("0123456789abcdef0123456789abcdef"),
			DailyQuota:  5,
			AttemptTTL:  2 * time.Hour,
			LeaseTTL:    30 * time.Second,
		},
	})
	session := mustPasswordSessionWithPhone(t, svc, "rotate-faceid@example.invalid", "13800138119")
	input := RealnameFaceIDStartInput{
		Name: "张三", IDCard: "11010519491231002X", ClientIP: "127.0.0.1", ClientUA: "agent", ConsentAccepted: true,
	}

	first, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, input)
	if err != nil {
		t.Fatalf("start first attempt: %v", err)
	}
	provider.getInfoErr = &RealnameFaceIDProviderRequestError{Code: "InvalidParameter", Message: "非法BizToken。", RequestID: "req-invalid-token"}
	provider.detectAuthOut = RealnameFaceIDDetectAuthResult{
		BizToken: "biz-new", VerifyURL: "https://faceid.example.com/biz-new", RequestID: "req-start-new",
	}

	second, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, input)
	if err != nil {
		t.Fatalf("replace invalid reusable attempt: %v", err)
	}
	if second.AttemptID == first.AttemptID || second.Reused {
		t.Fatalf("expected a new attempt, first=%+v second=%+v", first, second)
	}
	if provider.getInfoCalls != 1 || provider.detectAuthCalls != 2 {
		t.Fatalf("expected one stale-token check and two DetectAuth calls, got get=%d detect=%d", provider.getInfoCalls, provider.detectAuthCalls)
	}
	invalidated, err := store.GetRealnameFaceIDAttempt(context.Background(), first.AttemptID)
	if err != nil {
		t.Fatalf("get invalidated attempt: %v", err)
	}
	if invalidated.State != RealnameFaceIDStateFailed || invalidated.ScrubbedAt == nil || invalidated.BizTokenCiphertext != "" {
		t.Fatalf("expected invalid attempt to be failed and scrubbed, got %+v", invalidated)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	foundAudit := false
	for _, event := range store.realnameFaceIDAuditEvents {
		if event.AttemptID == first.AttemptID && event.EventType == "provider_biztoken_invalidated" {
			foundAudit = true
			break
		}
	}
	if !foundAudit {
		t.Fatal("expected provider_biztoken_invalidated audit event")
	}
}

func TestStartRealnameFaceIDAttemptRejectsSixthNewAttemptPerUTCDay(t *testing.T) {
	provider := &stubFaceIDVerifier{
		detectAuthOut: RealnameFaceIDDetectAuthResult{
			BizToken:  "biz-generic",
			VerifyURL: "https://faceid.example.com/generic",
			RequestID: "req-generic",
		},
	}
	svc := NewWithStore(NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true}), Options{
		Now:                    fixedNow,
		RealnameCipher:         stubRealnameCipher{},
		RealnameFaceIDVerifier: provider,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode:        RealnameAssuranceModeObserve,
			RuleID:      "rule-1",
			AccountID:   "acct-1",
			RedirectURL: "https://api.example.com/auth/realname/faceid/callback",
			DigestKey:   []byte("0123456789abcdef0123456789abcdef"),
			DailyQuota:  5,
			AttemptTTL:  2 * time.Hour,
			LeaseTTL:    30 * time.Second,
		},
	})
	session := mustPasswordSessionWithPhone(t, svc, "quota-faceid@example.invalid", "13800138112")

	for i := 0; i < 5; i++ {
		if _, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
			Name:            "张三",
			IDCard:          fmt.Sprintf("1101051949123100%02d", i),
			ClientIP:        "127.0.0.1",
			ClientUA:        "agent",
			ConsentAccepted: true,
		}); err != nil {
			t.Fatalf("start quota attempt %d: %v", i+1, err)
		}
	}
	_, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name:            "张三",
		IDCard:          "11010519491231009X",
		ClientIP:        "127.0.0.1",
		ClientUA:        "agent",
		ConsentAccepted: true,
	})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "realname_faceid_quota_exceeded" || authErr.Status != http.StatusTooManyRequests {
		t.Fatalf("expected quota error, got %#v", err)
	}
}

func TestVerifyRealnameFaceIDPhoneRejectsChangedCurrentPhone(t *testing.T) {
	provider := &stubFaceIDVerifier{
		detectAuthOut: RealnameFaceIDDetectAuthResult{
			BizToken:  "biz-phone-mismatch",
			VerifyURL: "https://faceid.example.com/phone-mismatch",
			RequestID: "req-phone-mismatch",
		},
	}
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	svc := NewWithStore(store, Options{
		Now:                    fixedNow,
		RealnameCipher:         stubRealnameCipher{},
		RealnameFaceIDVerifier: provider,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode:        RealnameAssuranceModeObserve,
			RuleID:      "rule-1",
			AccountID:   "acct-1",
			RedirectURL: "https://api.example.com/auth/realname/faceid/callback",
			DigestKey:   []byte("0123456789abcdef0123456789abcdef"),
			DailyQuota:  5,
			AttemptTTL:  2 * time.Hour,
			LeaseTTL:    30 * time.Second,
		},
	})
	session := mustPasswordSessionWithPhone(t, svc, "phone-mismatch-faceid@example.invalid", "13800138113")
	started, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name:            "张三",
		IDCard:          "11010519491231002X",
		ClientIP:        "127.0.0.1",
		ClientUA:        "agent",
		ConsentAccepted: true,
	})
	if err != nil {
		t.Fatalf("start attempt: %v", err)
	}

	store.mu.Lock()
	attempt := store.realnameFaceIDAttempts[started.AttemptID]
	faceVerifiedAt := fixedNow()
	attempt.State = RealnameFaceIDStateFaceSucceeded
	attempt.FaceVerifiedAt = &faceVerifiedAt
	store.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	user := store.usersByID[session.User.ID]
	delete(store.usersByPhone, user.Phone)
	user.Phone = "13800138114"
	store.usersByID[user.ID] = user
	store.usersByPhone[user.Phone] = user.ID
	store.mu.Unlock()

	_, err = svc.VerifyRealnameFaceIDPhone(context.Background(), session.Token, RealnameFaceIDPhoneProofInput{
		AttemptID: started.AttemptID,
		Code:      "123456",
	})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "realname_phone_mismatch" || authErr.Status != http.StatusConflict {
		t.Fatalf("expected phone mismatch error, got %#v", err)
	}
}

func TestAutomaticRealnameFaceIDCompletionHonorsSyncGateAndReplacesStaleShadowCorrelation(t *testing.T) {
	provider := &stubFaceIDVerifier{
		detectAuthOut: RealnameFaceIDDetectAuthResult{
			BizToken:  "biz-finalize",
			VerifyURL: "https://faceid.example.com/finalize",
			RequestID: "req-finalize",
		},
	}
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	shadowStore := shadowbinding.NewMemoryStore()
	shadowClient := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{Uin: 300000000058, OwnerUin: 300000000058, AppID: 1250000000}}
	shadowSvc := shadowbinding.New(shadowStore, shadowClient, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{
		Now:                        fixedNow,
		RealnameCipher:             stubRealnameCipher{},
		RealnameFaceIDVerifier:     provider,
		ShadowBinding:              shadowSvc,
		ShadowBasicAuthSyncEnabled: true,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode:        RealnameAssuranceModeFaceRequired,
			RuleID:      "rule-1",
			AccountID:   "acct-1",
			RedirectURL: "https://api.example.com/auth/realname/faceid/callback",
			DigestKey:   []byte("0123456789abcdef0123456789abcdef"),
			DailyQuota:  5,
			AttemptTTL:  2 * time.Hour,
			LeaseTTL:    30 * time.Second,
		},
	})
	session := mustPasswordSessionWithPhone(t, svc, "finalize-faceid@example.invalid", "13800138115")
	started, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name:            "张三",
		IDCard:          "11010519491231002X",
		ClientIP:        "127.0.0.1",
		ClientUA:        "agent",
		ConsentAccepted: true,
	})
	if err != nil {
		t.Fatalf("start attempt: %v", err)
	}
	store.mu.Lock()
	attempt := store.realnameFaceIDAttempts[started.AttemptID]
	faceVerifiedAt := fixedNow()
	attempt.State = RealnameFaceIDStateFaceSucceeded
	attempt.FaceVerifiedAt = &faceVerifiedAt
	store.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	store.mu.Unlock()
	if _, err := svc.SendRealnameFaceIDPhoneCode(context.Background(), session.Token, RealnameFaceIDPhoneCodeInput{
		AttemptID: started.AttemptID,
		ClientIP:  "127.0.0.1",
	}); err != nil {
		t.Fatalf("send FaceID phone code: %v", err)
	}
	svc.shadowBasicAuthSyncEnabled = false
	_, err = svc.VerifyRealnameFaceIDPhone(context.Background(), session.Token, RealnameFaceIDPhoneProofInput{
		AttemptID: started.AttemptID,
		Code:      "888888",
		ClientIP:  "127.0.0.1",
		ClientUA:  "agent",
	})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "shadow_basic_auth_sync_disabled" || authErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("expected automatic completion to honor disabled sync gate, got %#v", err)
	}
	if shadowClient.basicAuthCalls != 0 {
		t.Fatalf("disabled sync gate must prevent cloud calls, got %d", shadowClient.basicAuthCalls)
	}
	if _, err := shadowStore.MarkBasicAuthSucceeded(context.Background(), session.User.ID, "different-attempt", "wrong-identity", "wrong-phone", fixedNow()); err != nil {
		t.Fatalf("seed wrong basic auth correlation: %v", err)
	}

	svc.shadowBasicAuthSyncEnabled = true
	result, err := svc.FinalizeRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDFinalizeInput{
		AttemptID: started.AttemptID,
		ClientIP:  "127.0.0.1",
		ClientUA:  "agent",
	})
	if err != nil {
		t.Fatalf("finalize with stale correlation: %v", err)
	}
	if !result.Verified || shadowClient.basicAuthCalls != 1 {
		t.Fatalf("expected one replacement sync and final verification, result=%+v calls=%d", result, shadowClient.basicAuthCalls)
	}
	binding, err := shadowSvc.GetBindingByUserID(context.Background(), session.User.ID)
	if err != nil {
		t.Fatalf("get replaced binding: %v", err)
	}
	storedAttempt, err := store.GetRealnameFaceIDAttempt(context.Background(), started.AttemptID)
	if err != nil {
		t.Fatalf("get finalized attempt: %v", err)
	}
	if binding.BasicAuthSourceAttemptID != started.AttemptID || binding.BasicAuthIdentityHash != storedAttempt.IdentityHash || binding.BasicAuthPhoneHash != storedAttempt.PhoneVerifiedHash {
		t.Fatalf("expected current attempt correlation, got %+v", binding)
	}
}

func TestValidateRealnameFaceIDStartupRequiresCompleteNonLegacyRuntime(t *testing.T) {
	cfg := RealnameFaceIDConfig{Mode: RealnameAssuranceModeFaceRequired}
	err := ValidateRealnameFaceIDStartup(cfg, nil, nil, nil, false, false)
	if err == nil || !strings.Contains(err.Error(), "Tencent FaceID client") || !strings.Contains(err.Error(), "Shadow basic-auth sync") {
		t.Fatalf("expected actionable missing-config error, got %v", err)
	}
	if err := ValidateRealnameFaceIDStartup(RealnameFaceIDConfig{Mode: RealnameAssuranceModeLegacy}, nil, nil, nil, false, false); err != nil {
		t.Fatalf("legacy mode must remain available without FaceID config: %v", err)
	}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), &stubShadowRegisterClient{}, shadowbinding.Options{Enabled: true})
	ready := RealnameFaceIDConfig{
		Mode:        RealnameAssuranceModeObserve,
		RuleID:      "rule-ready",
		AccountID:   "account-ready",
		RedirectURL: "https://api.example.com/auth/realname/faceid/callback",
		DigestKey:   []byte("0123456789abcdef0123456789abcdef"),
	}
	if err := ValidateRealnameFaceIDStartup(ready, &stubFaceIDVerifier{}, stubRealnameCipher{}, shadowSvc, true, true); err != nil {
		t.Fatalf("complete FaceID runtime must pass startup validation: %v", err)
	}
	unavailableShadow := shadowbinding.New(
		shadowbinding.NewMemoryStore(),
		shadowbinding.NewUnavailableClient("missing credentials"),
		shadowbinding.Options{Enabled: true},
	)
	if err := ValidateRealnameFaceIDStartup(ready, &stubFaceIDVerifier{}, stubRealnameCipher{}, unavailableShadow, true, true); err == nil {
		t.Fatal("unavailable Shadow client must fail FaceID startup validation")
	}
	if err := ValidateRealnameFaceIDStartup(ready, &stubFaceIDVerifier{}, stubRealnameCipher{}, shadowSvc, true, false); err == nil {
		t.Fatal("non-durable store must fail FaceID startup validation")
	}
}

func TestRealnameFaceIDReconcileRejectsStaleLeaseResult(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	attempt := RealnameFaceIDAttempt{
		AttemptID: "rfid-stale", UserID: "user-stale", State: RealnameFaceIDStatePending,
		BizTokenHash: "token-hash", BusinessExpiresAt: fixedNow().Add(time.Hour), CreatedAt: fixedNow(), UpdatedAt: fixedNow(),
	}
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), attempt); err != nil {
		t.Fatalf("create attempt: %v", err)
	}
	first, ok, err := store.ClaimRealnameFaceIDAttempt(context.Background(), attempt.AttemptID, "", "worker-1", time.Second, fixedNow())
	if err != nil || !ok {
		t.Fatalf("claim first lease: ok=%v err=%v", ok, err)
	}
	second, ok, err := store.ClaimRealnameFaceIDAttempt(context.Background(), attempt.AttemptID, "", "worker-2", time.Second, fixedNow().Add(2*time.Second))
	if err != nil || !ok || second.LeaseVersion <= first.LeaseVersion {
		t.Fatalf("claim replacement lease: first=%+v second=%+v ok=%v err=%v", first, second, ok, err)
	}
	first.State = RealnameFaceIDStateFaceSucceeded
	first.LeaseOwner = ""
	first.LeaseUntil = nil
	applied, err := store.ApplyRealnameFaceIDReconcile(context.Background(), first, first.LeaseVersion, "worker-1")
	if err != nil {
		t.Fatalf("apply stale result: %v", err)
	}
	if applied {
		t.Fatal("expected stale lease result to be rejected")
	}
}

func TestRealnameFaceIDReconcilePreservesMaterialForPendingAndFaceSuccess(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	provider := &stubFaceIDVerifier{getInfoOut: RealnameFaceIDProviderCheckResult{RequestID: "req-pending"}}
	svc := NewWithStore(store, Options{
		Now:                    fixedNow,
		RealnameCipher:         stubRealnameCipher{},
		RealnameFaceIDVerifier: provider,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode: RealnameAssuranceModeObserve, RuleID: "rule-1", AccountID: "acct-1",
			DigestKey: []byte("0123456789abcdef0123456789abcdef"), LeaseTTL: time.Minute,
		},
	})
	attempt := RealnameFaceIDAttempt{
		AttemptID: "rfid-polling", UserID: "usr-polling", State: RealnameFaceIDStatePending,
		NameCiphertext: "enc(name)", IDCardCiphertext: "enc(id-card)",
		BizTokenCiphertext: "enc(provider-token)", BizTokenHash: bizTokenHash("provider-token"),
		VerifyURLCiphertext: "enc(https://faceid.example.invalid)", RuleID: "rule-1", AccountID: "acct-1",
		BusinessExpiresAt: fixedNow().Add(time.Hour), CreatedAt: fixedNow(), UpdatedAt: fixedNow(),
	}
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), attempt); err != nil {
		t.Fatalf("create polling attempt: %v", err)
	}

	pending, err := svc.ReconcileRealnameFaceIDAttempt(context.Background(), attempt.AttemptID, "", "worker-pending")
	if err != nil {
		t.Fatalf("reconcile pending attempt: %v", err)
	}
	if pending.State != RealnameFaceIDStatePending || pending.ScrubbedAt != nil || pending.NameCiphertext == "" || pending.BizTokenCiphertext == "" || pending.FaceVerifiedAt != nil {
		t.Fatalf("pending reconcile must preserve material, got %+v", pending)
	}

	provider.getInfoOut = RealnameFaceIDProviderCheckResult{Completed: true, Success: true, RequestID: "req-success"}
	succeeded, err := svc.ReconcileRealnameFaceIDAttempt(context.Background(), attempt.AttemptID, "", "worker-success")
	if err != nil {
		t.Fatalf("reconcile successful attempt: %v", err)
	}
	if succeeded.State != RealnameFaceIDStateFaceSucceeded || succeeded.FaceVerifiedAt == nil || succeeded.ScrubbedAt != nil || succeeded.NameCiphertext == "" || succeeded.BizTokenCiphertext == "" {
		t.Fatalf("face success must preserve material for phone and Shadow verification, got %+v", succeeded)
	}
	if len(store.realnameFaceIDAuditEvents) != 2 || store.realnameFaceIDAuditEvents[0].EventType != "provider_reconciled" || store.realnameFaceIDAuditEvents[1].EventType != "provider_reconciled" {
		t.Fatalf("expected one atomic audit per provider result, got %+v", store.realnameFaceIDAuditEvents)
	}
}

func TestGetOwnedRealnameFaceIDAttemptReusesActiveShadowPhoneProof(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	shadowStore := shadowbinding.NewMemoryStore()
	shadowClient := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{
		Uin: 300000000061, OwnerUin: 300000000061, AppID: 1250000000,
	}}
	shadowSvc := shadowbinding.New(shadowStore, shadowClient, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{
		Now:                        fixedNow,
		RealnameCipher:             stubRealnameCipher{},
		ShadowBasicAuthSyncEnabled: true,
		RealnameFaceIDVerifier: &stubFaceIDVerifier{detectAuthOut: RealnameFaceIDDetectAuthResult{
			BizToken: "biz-reuse-shadow", VerifyURL: "https://faceid.example.invalid/reuse-shadow", RequestID: "req-reuse-shadow",
		}},
		ShadowBinding: shadowSvc,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode: RealnameAssuranceModeObserve, RuleID: "rule-1", AccountID: "acct-1",
			RedirectURL: "https://api.example.com/auth/realname/faceid/callback",
			DigestKey:   []byte("0123456789abcdef0123456789abcdef"), DailyQuota: 5,
			AttemptTTL: 2 * time.Hour, LeaseTTL: 30 * time.Second,
		},
	})
	session := mustPasswordSessionWithPhone(t, svc, "reuse-shadow-faceid@example.invalid", "13800138120")
	if _, err := shadowSvc.BindShadowAccount(context.Background(), shadowbinding.BindInput{
		UserID: session.User.ID, Phone: session.User.Phone, VerifyCode: "888888",
	}); err != nil {
		t.Fatalf("seed active Shadow binding: %v", err)
	}
	started, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name: "张三", IDCard: "11010519491231002X", ClientIP: "127.0.0.1", ClientUA: "agent", ConsentAccepted: true,
	})
	if err != nil {
		t.Fatalf("start attempt: %v", err)
	}
	store.mu.Lock()
	attempt := store.realnameFaceIDAttempts[started.AttemptID]
	faceVerifiedAt := fixedNow()
	attempt.State = RealnameFaceIDStateFaceSucceeded
	attempt.FaceVerifiedAt = &faceVerifiedAt
	store.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	store.mu.Unlock()
	shadowClient.calls = 0
	shadowClient.smsCalls = 0
	shadowClient.basicAuthCalls = 0

	got, err := svc.GetOwnedRealnameFaceIDAttempt(context.Background(), session.Token, started.AttemptID, true)
	if err != nil {
		t.Fatalf("get owned attempt: %v", err)
	}
	if got.State != RealnameFaceIDStateSucceeded || got.PhoneVerifiedAt == nil || got.PhoneVerifiedHash != got.CurrentPhoneHash {
		t.Fatalf("active Shadow binding must complete current-phone FaceID verification, got %+v", got)
	}
	if shadowClient.calls != 0 || shadowClient.smsCalls != 0 || shadowClient.basicAuthCalls != 1 {
		t.Fatalf("active Shadow binding must skip registration and synchronously save basic auth: register=%d sms=%d basicAuth=%d", shadowClient.calls, shadowClient.smsCalls, shadowClient.basicAuthCalls)
	}
}

func TestSendRealnameFaceIDPhoneCodeUsesShadowSMS(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	shadowClient := &stubShadowRegisterClient{}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), shadowClient, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{
		Now:                        fixedNow,
		RealnameCipher:             stubRealnameCipher{},
		ShadowBasicAuthSyncEnabled: true,
		RealnameFaceIDVerifier: &stubFaceIDVerifier{detectAuthOut: RealnameFaceIDDetectAuthResult{
			BizToken: "biz-send-shadow", VerifyURL: "https://faceid.example.invalid/send-shadow", RequestID: "req-send-shadow",
		}},
		ShadowBinding: shadowSvc,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode: RealnameAssuranceModeObserve, RuleID: "rule-1", AccountID: "acct-1",
			RedirectURL: "https://api.example.com/auth/realname/faceid/callback",
			DigestKey:   []byte("0123456789abcdef0123456789abcdef"), DailyQuota: 5,
			AttemptTTL: 2 * time.Hour, LeaseTTL: 30 * time.Second,
		},
	})
	session := mustPasswordSessionWithPhone(t, svc, "send-shadow-faceid@example.invalid", "13800138121")
	started, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name: "张三", IDCard: "11010519491231002X", ClientIP: "127.0.0.1", ClientUA: "agent", ConsentAccepted: true,
	})
	if err != nil {
		t.Fatalf("start attempt: %v", err)
	}
	store.mu.Lock()
	attempt := store.realnameFaceIDAttempts[started.AttemptID]
	faceVerifiedAt := fixedNow()
	attempt.State = RealnameFaceIDStateFaceSucceeded
	attempt.FaceVerifiedAt = &faceVerifiedAt
	store.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	store.mu.Unlock()

	cooldown, err := svc.SendRealnameFaceIDPhoneCode(context.Background(), session.Token, RealnameFaceIDPhoneCodeInput{
		AttemptID: started.AttemptID, ClientIP: "127.0.0.1",
	})
	if err != nil {
		t.Fatalf("send FaceID phone code: %v", err)
	}
	if cooldown <= 0 || shadowClient.smsCalls != 1 || shadowClient.lastSMS.Phone != session.User.Phone {
		t.Fatalf("expected Tencent Shadow SMS for current phone, cooldown=%s calls=%d input=%+v", cooldown, shadowClient.smsCalls, shadowClient.lastSMS)
	}
}

func TestVerifyRealnameFaceIDPhoneUsesShadowBindingCode(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	shadowClient := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{
		Uin: 300000000062, OwnerUin: 300000000062, AppID: 1250000000,
	}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), shadowClient, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{
		Now:                        fixedNow,
		RealnameCipher:             stubRealnameCipher{},
		ShadowBasicAuthSyncEnabled: true,
		RealnameFaceIDVerifier: &stubFaceIDVerifier{detectAuthOut: RealnameFaceIDDetectAuthResult{
			BizToken: "biz-verify-shadow", VerifyURL: "https://faceid.example.invalid/verify-shadow", RequestID: "req-verify-shadow",
		}},
		ShadowBinding: shadowSvc,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode: RealnameAssuranceModeObserve, RuleID: "rule-1", AccountID: "acct-1",
			RedirectURL: "https://api.example.com/auth/realname/faceid/callback",
			DigestKey:   []byte("0123456789abcdef0123456789abcdef"), DailyQuota: 5,
			AttemptTTL: 2 * time.Hour, LeaseTTL: 30 * time.Second,
		},
	})
	session := mustPasswordSessionWithPhone(t, svc, "verify-shadow-faceid@example.invalid", "13800138122")
	started, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name: "张三", IDCard: "11010519491231002X", ClientIP: "127.0.0.1", ClientUA: "agent", ConsentAccepted: true,
	})
	if err != nil {
		t.Fatalf("start attempt: %v", err)
	}
	store.mu.Lock()
	attempt := store.realnameFaceIDAttempts[started.AttemptID]
	faceVerifiedAt := fixedNow()
	attempt.State = RealnameFaceIDStateFaceSucceeded
	attempt.FaceVerifiedAt = &faceVerifiedAt
	store.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	store.mu.Unlock()
	if _, err := svc.SendRealnameFaceIDPhoneCode(context.Background(), session.Token, RealnameFaceIDPhoneCodeInput{
		AttemptID: started.AttemptID,
		ClientIP:  "127.0.0.1",
	}); err != nil {
		t.Fatalf("send FaceID phone code: %v", err)
	}

	verified, err := svc.VerifyRealnameFaceIDPhone(context.Background(), session.Token, RealnameFaceIDPhoneProofInput{
		AttemptID: started.AttemptID, Code: "888888", ClientIP: "127.0.0.1", ClientUA: "agent",
	})
	if err != nil {
		t.Fatalf("verify FaceID phone: %v", err)
	}
	if verified.State != RealnameFaceIDStateSucceeded || verified.PhoneVerifiedAt == nil {
		t.Fatalf("expected phone proof to complete FaceID verification, got %+v", verified)
	}
	if shadowClient.calls != 1 || shadowClient.basicAuthCalls != 1 || shadowClient.lastRegister.VerifyCode != "888888" || shadowClient.lastRegister.Phone != session.User.Phone {
		t.Fatalf("expected Tencent Shadow registration and basic auth to complete synchronously, registerCalls=%d basicAuthCalls=%d input=%+v", shadowClient.calls, shadowClient.basicAuthCalls, shadowClient.lastRegister)
	}
}

func TestCleanUserCompletesFaceIDWithNewPhoneAndShadowBinding(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	shadowClient := &stubShadowRegisterClient{result: shadowbinding.CloudRegisterResult{
		Uin: 300000000063, OwnerUin: 300000000063, AppID: 1250000000,
	}}
	shadowSvc := shadowbinding.New(shadowbinding.NewMemoryStore(), shadowClient, shadowbinding.Options{Enabled: true, Now: fixedNow})
	svc := NewWithStore(store, Options{
		Now:                        fixedNow,
		RealnameCipher:             stubRealnameCipher{},
		ShadowBasicAuthSyncEnabled: true,
		RealnameFaceIDVerifier: &stubFaceIDVerifier{detectAuthOut: RealnameFaceIDDetectAuthResult{
			BizToken: "biz-clean-full", VerifyURL: "https://faceid.example.invalid/clean-full", RequestID: "req-clean-full",
		}},
		ShadowBinding: shadowSvc,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode: RealnameAssuranceModeObserve, RuleID: "rule-1", AccountID: "acct-1",
			RedirectURL: "https://api.example.com/auth/realname/faceid/callback",
			DigestKey:   []byte("0123456789abcdef0123456789abcdef"), DailyQuota: 5,
			AttemptTTL: 2 * time.Hour, LeaseTTL: 30 * time.Second,
		},
	})
	session := mustPasswordSession(t, svc, "clean-full-faceid@example.invalid")
	phone := "13800138123"
	started, err := svc.StartRealnameFaceIDAttempt(context.Background(), session.Token, RealnameFaceIDStartInput{
		Name: "张三", IDCard: "11010519491231002X", ClientIP: "127.0.0.1", ClientUA: "agent", ConsentAccepted: true,
	})
	if err != nil {
		t.Fatalf("start clean-user attempt: %v", err)
	}
	store.mu.Lock()
	attempt := store.realnameFaceIDAttempts[started.AttemptID]
	faceVerifiedAt := fixedNow()
	attempt.State = RealnameFaceIDStateFaceSucceeded
	attempt.FaceVerifiedAt = &faceVerifiedAt
	store.realnameFaceIDAttempts[attempt.AttemptID] = attempt
	store.mu.Unlock()

	cooldown, err := svc.SendRealnameFaceIDPhoneCode(context.Background(), session.Token, RealnameFaceIDPhoneCodeInput{
		AttemptID: started.AttemptID, Phone: phone, ClientIP: "127.0.0.1",
	})
	if err != nil {
		t.Fatalf("send clean-user phone code: %v", err)
	}
	if cooldown <= 0 || shadowClient.lastSMS.Phone != phone {
		t.Fatalf("expected Shadow SMS for candidate phone, cooldown=%s input=%+v", cooldown, shadowClient.lastSMS)
	}
	_, err = svc.VerifyRealnameFaceIDPhone(context.Background(), session.Token, RealnameFaceIDPhoneProofInput{
		AttemptID: started.AttemptID, Phone: "13800138124", Code: "888888", ClientIP: "127.0.0.1", ClientUA: "agent",
	})
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "realname_phone_mismatch" || shadowClient.calls != 0 {
		t.Fatalf("candidate phone must not change after SMS, err=%#v registerCalls=%d", err, shadowClient.calls)
	}

	verified, err := svc.VerifyRealnameFaceIDPhone(context.Background(), session.Token, RealnameFaceIDPhoneProofInput{
		AttemptID: started.AttemptID, Phone: phone, Code: "888888", ClientIP: "127.0.0.1", ClientUA: "agent",
	})
	if err != nil {
		t.Fatalf("verify clean-user phone: %v", err)
	}
	if verified.State != RealnameFaceIDStateSucceeded || verified.PhoneVerifiedHash != svc.hashRealnamePhone(phone) {
		t.Fatalf("expected completed phone proof, got %+v", verified)
	}
	current, err := svc.CurrentSession(context.Background(), session.Token)
	if err != nil {
		t.Fatalf("current clean-user session: %v", err)
	}
	if current.User.Phone != phone || current.User.RealnameLevel != RealnameLevelPhone3FA || !current.User.RealnameVerified {
		t.Fatalf("expected phone_3fa user with bound phone, got %+v", current.User)
	}
	if shadowClient.calls != 1 || shadowClient.basicAuthCalls != 1 || shadowClient.lastRegister.Phone != phone {
		t.Fatalf("expected Shadow binding and basic auth for candidate phone, register=%d basicAuth=%d input=%+v", shadowClient.calls, shadowClient.basicAuthCalls, shadowClient.lastRegister)
	}
}

func TestRealnameFaceIDTransitionRejectsDeletionAndExpiryRaces(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	svc := NewWithStore(store, Options{Now: fixedNow})
	session := mustPasswordSessionWithPhone(t, svc, "faceid-transition-race@example.invalid", "13800138119")
	created := RealnameFaceIDAttempt{
		AttemptID: "rfid-delete-race", UserID: session.User.ID, State: RealnameFaceIDStateCreated,
		NameCiphertext: "sensitive", BusinessExpiresAt: fixedNow().Add(time.Hour), CreatedAt: fixedNow(), UpdatedAt: fixedNow(),
	}
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), created); err != nil {
		t.Fatalf("create deletion-race attempt: %v", err)
	}
	if err := store.DeleteCurrentUser(context.Background(), session.Token, fixedNow().Add(time.Minute)); err != nil {
		t.Fatalf("delete current user: %v", err)
	}
	created.State = RealnameFaceIDStatePending
	applied, err := store.ApplyRealnameFaceIDTransitionWithAudit(context.Background(), created, RealnameFaceIDStateCreated, 0, RealnameFaceIDAuditEvent{EventType: "stale_start"})
	if err != nil || applied {
		t.Fatalf("deleted attempt must reject stale start transition: applied=%v err=%v", applied, err)
	}
	deleted, err := store.GetRealnameFaceIDAttempt(context.Background(), created.AttemptID)
	if err != nil || deleted.State != RealnameFaceIDStateRevoked || deleted.ScrubbedAt == nil || deleted.NameCiphertext != "" || deleted.LeaseVersion == 0 {
		t.Fatalf("deletion must remain authoritative, attempt=%+v err=%v", deleted, err)
	}

	expiring := RealnameFaceIDAttempt{
		AttemptID: "rfid-expiry-race", UserID: "usr-expiry-race", State: RealnameFaceIDStateFaceSucceeded,
		NameCiphertext: "sensitive", BusinessExpiresAt: fixedNow().Add(-time.Second), CreatedAt: fixedNow(), UpdatedAt: fixedNow(),
	}
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), expiring); err != nil {
		t.Fatalf("create expiry-race attempt: %v", err)
	}
	if count, err := store.ExpireRealnameFaceIDAttempts(context.Background(), fixedNow(), 10); err != nil || count != 1 {
		t.Fatalf("expire race attempt: count=%d err=%v", count, err)
	}
	expiring.State = RealnameFaceIDStateShadowPending
	applied, err = store.ApplyRealnameFaceIDTransitionWithAudit(context.Background(), expiring, RealnameFaceIDStateFaceSucceeded, 0, RealnameFaceIDAuditEvent{EventType: "stale_phone"})
	if err != nil || applied {
		t.Fatalf("expired attempt must reject stale phone transition: applied=%v err=%v", applied, err)
	}
	expired, err := store.GetRealnameFaceIDAttempt(context.Background(), expiring.AttemptID)
	if err != nil || expired.State != RealnameFaceIDStateExpired || expired.ScrubbedAt == nil || expired.NameCiphertext != "" {
		t.Fatalf("expiry must remain authoritative, attempt=%+v err=%v", expired, err)
	}
}

func TestRealnameFaceIDReconcileTerminallyAuditsProviderIntegrityMismatch(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	provider := &stubFaceIDVerifier{getInfoErr: &RealnameFaceIDProviderIntegrityError{RequestID: "req-integrity", Reason: "extra mismatch"}}
	svc := NewWithStore(store, Options{
		Now:                    fixedNow,
		RealnameCipher:         stubRealnameCipher{},
		RealnameFaceIDVerifier: provider,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode:      RealnameAssuranceModeObserve,
			RuleID:    "rule-1",
			AccountID: "acct-1",
			DigestKey: []byte("0123456789abcdef0123456789abcdef"),
			LeaseTTL:  time.Minute,
		},
	})
	attempt := RealnameFaceIDAttempt{
		AttemptID:           "rfid-integrity",
		UserID:              "usr-integrity",
		State:               RealnameFaceIDStatePending,
		IdentityHash:        "identity-integrity",
		CurrentPhoneHash:    "phone-integrity",
		BizTokenCiphertext:  "enc(provider-token)",
		BizTokenHash:        bizTokenHash("provider-token"),
		VerifyURLCiphertext: "enc(https://faceid.example.invalid)",
		RuleID:              "rule-1",
		AccountID:           "acct-1",
		BusinessExpiresAt:   fixedNow().Add(time.Hour),
		CreatedAt:           fixedNow(),
		UpdatedAt:           fixedNow(),
	}
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), attempt); err != nil {
		t.Fatalf("create integrity attempt: %v", err)
	}
	got, err := svc.ReconcileRealnameFaceIDAttempt(context.Background(), attempt.AttemptID, "", "worker-integrity")
	var authErr *Error
	if !errors.As(err, &authErr) || authErr.Code != "realname_faceid_provider_integrity_failed" || authErr.Status != http.StatusConflict {
		t.Fatalf("expected terminal integrity conflict, got attempt=%+v err=%#v", got, err)
	}
	if got.State != RealnameFaceIDStateFailed || got.ScrubbedAt == nil || got.BizTokenCiphertext != "" {
		t.Fatalf("integrity mismatch must fail and scrub attempt, got %+v", got)
	}
	if len(store.realnameFaceIDAuditEvents) != 1 || store.realnameFaceIDAuditEvents[0].EventType != "provider_integrity_rejected" || store.realnameFaceIDAuditEvents[0].RequestID != "req-integrity" {
		t.Fatalf("expected integrity audit event, got %+v", store.realnameFaceIDAuditEvents)
	}
}

func TestRealnameFaceIDReconcileRejectsStoredRuleOrAccountDriftBeforeProviderCall(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	provider := &stubFaceIDVerifier{}
	svc := NewWithStore(store, Options{
		Now:                    fixedNow,
		RealnameCipher:         stubRealnameCipher{},
		RealnameFaceIDVerifier: provider,
		RealnameFaceID: RealnameFaceIDConfig{
			Mode:      RealnameAssuranceModeObserve,
			RuleID:    "rule-current",
			AccountID: "acct-current",
			DigestKey: []byte("0123456789abcdef0123456789abcdef"),
		},
	})
	attempt := RealnameFaceIDAttempt{
		AttemptID: "rfid-config-drift", UserID: "usr-drift", State: RealnameFaceIDStatePending,
		BizTokenCiphertext: "enc(provider-token)", BizTokenHash: bizTokenHash("provider-token"),
		RuleID: "rule-foreign", AccountID: "acct-current", BusinessExpiresAt: fixedNow().Add(time.Hour),
		CreatedAt: fixedNow(), UpdatedAt: fixedNow(),
	}
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), attempt); err != nil {
		t.Fatalf("create drift attempt: %v", err)
	}
	if _, err := svc.ReconcileRealnameFaceIDAttempt(context.Background(), attempt.AttemptID, "", "worker-drift"); err == nil {
		t.Fatal("expected stored provider config drift to fail")
	}
	if provider.getInfoCalls != 0 {
		t.Fatalf("provider must not be called for stored config drift, calls=%d", provider.getInfoCalls)
	}
}

func TestRealnameFaceIDClaimDoesNotReopenTerminalAttempt(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	attempt := RealnameFaceIDAttempt{
		AttemptID: "rfid-terminal", UserID: "user-terminal", State: RealnameFaceIDStateSucceeded,
		BizTokenHash: "terminal-token-hash", BusinessExpiresAt: fixedNow().Add(time.Hour), CreatedAt: fixedNow(), UpdatedAt: fixedNow(),
	}
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), attempt); err != nil {
		t.Fatalf("create terminal attempt: %v", err)
	}
	claimed, ok, err := store.ClaimRealnameFaceIDAttempt(context.Background(), attempt.AttemptID, "", "callback", time.Second, fixedNow())
	if err != nil {
		t.Fatalf("claim terminal attempt: %v", err)
	}
	if ok || claimed.State != RealnameFaceIDStateSucceeded {
		t.Fatalf("terminal attempt must remain immutable, got ok=%v attempt=%+v", ok, claimed)
	}
}

func TestExpireRealnameFaceIDAttemptsScrubsEveryActiveStage(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	states := []string{
		RealnameFaceIDStateCreated,
		RealnameFaceIDStatePending,
		RealnameFaceIDStateFaceSucceeded,
		RealnameFaceIDStateShadowPending,
	}
	for index, state := range states {
		attempt := RealnameFaceIDAttempt{
			AttemptID: fmt.Sprintf("rfid-expired-%d", index), UserID: "usr-expired", State: state,
			NameCiphertext: "sensitive-name", BizTokenCiphertext: "sensitive-token",
			BusinessExpiresAt: fixedNow().Add(-time.Minute), CreatedAt: fixedNow().Add(time.Duration(index) * time.Second), UpdatedAt: fixedNow(),
		}
		if err := store.CreateRealnameFaceIDAttempt(context.Background(), attempt); err != nil {
			t.Fatalf("create expired attempt: %v", err)
		}
	}
	count, err := store.ExpireRealnameFaceIDAttempts(context.Background(), fixedNow(), 20)
	if err != nil || count != len(states) {
		t.Fatalf("expire active attempts: count=%d err=%v", count, err)
	}
	for index := range states {
		attempt, err := store.GetRealnameFaceIDAttempt(context.Background(), fmt.Sprintf("rfid-expired-%d", index))
		if err != nil || attempt.State != RealnameFaceIDStateExpired || attempt.ScrubbedAt == nil || attempt.NameCiphertext != "" || attempt.BizTokenCiphertext != "" {
			t.Fatalf("attempt was not expired and scrubbed: %+v err=%v", attempt, err)
		}
	}
	if len(store.realnameFaceIDAuditEvents) != len(states) {
		t.Fatalf("expected one immutable expiry audit per attempt, got %+v", store.realnameFaceIDAuditEvents)
	}
}

func TestPhoneChangeClearsFinalFaceIDProjection(t *testing.T) {
	store := NewMemoryStore(StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	svc := NewWithStore(store, Options{Now: fixedNow, RealnameFaceID: RealnameFaceIDConfig{Mode: RealnameAssuranceModeFaceRequired}})
	session := mustPasswordSessionWithPhone(t, svc, "faceid-phone-change@example.invalid", "13800138116")
	store.mu.Lock()
	user := store.usersByID[session.User.ID]
	verifiedAt := fixedNow()
	user.realnameFinalAttemptID = "rfid-old"
	user.realnameFaceVerifiedAt = &verifiedAt
	user.realnamePhoneVerifiedAt = &verifiedAt
	user.realnameIdentityHash = "identity-old"
	user.realnamePhoneHash = "phone-old"
	store.usersByID[user.ID] = user
	store.realnameFaceIDAttempts["rfid-active"] = RealnameFaceIDAttempt{
		AttemptID: "rfid-active", UserID: user.ID, State: RealnameFaceIDStateFaceSucceeded,
		NameCiphertext: "sensitive-name", IDCardCiphertext: "sensitive-id", BizTokenCiphertext: "sensitive-token",
		VerifyURLCiphertext: "sensitive-url", IdentityHash: "identity-old", CurrentPhoneHash: "phone-old",
		BusinessExpiresAt: fixedNow().Add(time.Hour), CreatedAt: fixedNow(), UpdatedAt: fixedNow(),
	}
	store.mu.Unlock()

	updated, err := store.UpdateCurrentUserPhone(context.Background(), session.Token, "13800138117", fixedNow())
	if err != nil {
		t.Fatalf("update current phone: %v", err)
	}
	if updated.realnameFinalAttemptID != "" || updated.realnameFaceVerifiedAt != nil || updated.realnamePhoneVerifiedAt != nil || updated.realnameIdentityHash != "" || updated.realnamePhoneHash != "" {
		t.Fatalf("phone change must clear FaceID projection, got %+v", updated)
	}
	revoked, err := store.GetRealnameFaceIDAttempt(context.Background(), "rfid-active")
	if err != nil {
		t.Fatalf("get revoked attempt: %v", err)
	}
	if revoked.State != RealnameFaceIDStateRevoked || revoked.ScrubbedAt == nil || revoked.NameCiphertext != "" || revoked.BizTokenCiphertext != "" {
		t.Fatalf("phone change must revoke and scrub active attempt, got %+v", revoked)
	}
	if len(store.realnameFaceIDAuditEvents) != 1 || store.realnameFaceIDAuditEvents[0].EventType != "phone_changed_revoked" {
		t.Fatalf("phone change must append revocation audit, got %+v", store.realnameFaceIDAuditEvents)
	}
	if _, err := store.FindCurrentRealnameFaceIDAttempt(context.Background(), user.ID, fixedNow()); err == nil {
		t.Fatal("revoked old-phone attempt must not be recoverable")
	}
}

func ptrTime(v time.Time) *time.Time { return &v }
