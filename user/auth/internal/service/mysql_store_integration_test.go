package service

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	internalmigrations "github.com/openclaw/openclaw/mono/backend/auth/internal/migrations"
)

func TestMySQLStorePersistsImpersonationSessionMetadata(t *testing.T) {
	dsn := os.Getenv("LIGHTCLAW_AUTH_TEST_DSN")
	if dsn == "" {
		t.Skip("LIGHTCLAW_AUTH_TEST_DSN is not set")
	}

	if err := internalmigrations.Run(dsn); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	store, err := NewMySQLStore(dsn, StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	if err != nil {
		t.Fatalf("open mysql store: %v", err)
	}
	t.Cleanup(func() { _ = store.db.Close() })

	now := fixedNow().Add(time.Duration(time.Now().UnixNano()%1_000_000) * time.Nanosecond)
	normalSession, err := store.CreatePasswordSession(context.Background(), PasswordSignUpInput{
		Name:  "MySQL Impersonation",
		Email: "impersonation-mysql-" + time.Now().Format("20060102150405.000000000") + "@example.com",
	}, []byte("hash"), now, 24*time.Hour)
	if err != nil {
		t.Fatalf("create password session: %v", err)
	}
	if normalSession.Impersonated {
		t.Fatal("normal mysql session should not be impersonated")
	}

	impersonated, err := store.CreateImpersonationSession(context.Background(), normalSession.User, "MySQL round trip", now, 30*time.Minute)
	if err != nil {
		t.Fatalf("create impersonation session: %v", err)
	}
	current, err := store.CurrentSession(context.Background(), impersonated.Token, now)
	if err != nil {
		t.Fatalf("load impersonation session: %v", err)
	}
	if !current.Impersonated || current.ImpersonationReason != "MySQL round trip" {
		t.Fatalf("expected mysql impersonation metadata, got impersonated=%v reason=%q", current.Impersonated, current.ImpersonationReason)
	}
}

func TestMySQLApplyRealnameFaceIDPhoneProofBindsCleanUserAtomically(t *testing.T) {
	dsn := os.Getenv("LIGHTCLAW_AUTH_TEST_DSN")
	if dsn == "" {
		t.Skip("LIGHTCLAW_AUTH_TEST_DSN is not set")
	}
	if err := internalmigrations.Run(dsn); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	store, err := NewMySQLStore(dsn, StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	if err != nil {
		t.Fatalf("open mysql store: %v", err)
	}
	t.Cleanup(func() { _ = store.db.Close() })
	now := fixedNow().Add(time.Duration(time.Now().UnixNano()%1_000_000) * time.Nanosecond)
	session, err := store.CreatePasswordSession(context.Background(), PasswordSignUpInput{
		Name: "Clean FaceID MySQL", Email: "clean-faceid-mysql-" + time.Now().Format("20060102150405.000000000") + "@example.com",
	}, []byte("hash"), now, time.Hour)
	if err != nil {
		t.Fatalf("create clean faceid user: %v", err)
	}
	attemptID := "rfid-clean-phone-" + time.Now().Format("150405.000000000")
	faceAt, phoneAt := now.Add(-time.Minute), now
	attempt := RealnameFaceIDAttempt{
		AttemptID: attemptID, UserID: session.User.ID, State: RealnameFaceIDStateFaceSucceeded,
		IdentityHash:      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		BusinessExpiresAt: now.Add(time.Hour), FaceVerifiedAt: &faceAt, CreatedAt: now, UpdatedAt: now,
	}
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), attempt); err != nil {
		t.Fatalf("create clean phone attempt: %v", err)
	}
	phone := fmt.Sprintf("138%08d", time.Now().UnixNano()%100000000)
	attempt.CurrentPhoneHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	attempt.PhoneVerifiedHash = attempt.CurrentPhoneHash
	attempt.PhoneVerifiedAt = &phoneAt
	attempt.State = RealnameFaceIDStateShadowPending
	user, applied, err := store.ApplyRealnameFaceIDPhoneProof(context.Background(), attempt, RealnameFaceIDStateFaceSucceeded, 0, phone, RealnameFaceIDAuditEvent{
		AttemptID: attemptID, UserID: session.User.ID, EventType: "phone_verified_via_shadow", State: attempt.State,
		IdentityHash: attempt.IdentityHash, PhoneHash: attempt.PhoneVerifiedHash, CreatedAt: now,
	})
	if err != nil || !applied || user.Phone != phone {
		t.Fatalf("apply clean-user phone proof: applied=%v user=%+v err=%v", applied, user, err)
	}
	stored, err := store.GetRealnameFaceIDAttempt(context.Background(), attemptID)
	if err != nil || stored.State != RealnameFaceIDStateShadowPending || stored.PhoneVerifiedHash != attempt.PhoneVerifiedHash {
		t.Fatalf("load clean-user phone proof: attempt=%+v err=%v", stored, err)
	}
	var auditCount int
	if err := store.db.QueryRowContext(context.Background(), `SELECT COUNT(1) FROM realname_faceid_audit_events WHERE attempt_id = ? AND event_type = 'phone_verified_via_shadow'`, attemptID).Scan(&auditCount); err != nil {
		t.Fatalf("count clean-user phone audits: %v", err)
	}
	if auditCount != 1 {
		t.Fatalf("expected one clean-user phone audit, got %d", auditCount)
	}
}

func TestMySQLDeleteCurrentUserScrubsFaceIDDataAndRemovesShadowCorrelation(t *testing.T) {
	dsn := os.Getenv("LIGHTCLAW_AUTH_TEST_DSN")
	if dsn == "" {
		t.Skip("LIGHTCLAW_AUTH_TEST_DSN is not set")
	}
	if err := internalmigrations.Run(dsn); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	store, err := NewMySQLStore(dsn, StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	if err != nil {
		t.Fatalf("open mysql store: %v", err)
	}
	t.Cleanup(func() { _ = store.db.Close() })

	now := fixedNow().Add(time.Duration(time.Now().UnixNano()%1_000_000) * time.Nanosecond)
	session, err := store.CreatePasswordSession(context.Background(), PasswordSignUpInput{
		Name:  "MySQL FaceID Delete",
		Email: "faceid-delete-mysql-" + time.Now().Format("20060102150405.000000000") + "@example.com",
	}, []byte("hash"), now, 24*time.Hour)
	if err != nil {
		t.Fatalf("create password session: %v", err)
	}
	attemptID := "rfid-delete-" + time.Now().Format("150405.000000000")
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), RealnameFaceIDAttempt{
		AttemptID:           attemptID,
		UserID:              session.User.ID,
		State:               RealnameFaceIDStatePending,
		NameCiphertext:      "sensitive-name",
		IDCardCiphertext:    "sensitive-id-card",
		IdentityHash:        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		CurrentPhoneHash:    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		PhoneVerifiedHash:   "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		BizTokenCiphertext:  "sensitive-token",
		VerifyURLCiphertext: "sensitive-url",
		BusinessExpiresAt:   now.Add(time.Hour),
		CreatedAt:           now,
		UpdatedAt:           now,
	}); err != nil {
		t.Fatalf("create faceid attempt: %v", err)
	}
	startAttemptID := attemptID + "-start"
	startAttempt := RealnameFaceIDAttempt{
		AttemptID: startAttemptID, UserID: session.User.ID, State: RealnameFaceIDStateCreated,
		NameCiphertext:    "sensitive-start-name",
		IdentityHash:      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		CurrentPhoneHash:  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		BusinessExpiresAt: now.Add(time.Hour), CreatedAt: now.Add(time.Nanosecond), UpdatedAt: now,
	}
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), startAttempt); err != nil {
		t.Fatalf("create start-race attempt: %v", err)
	}
	claimed, ok, err := store.ClaimRealnameFaceIDAttempt(context.Background(), attemptID, "", "delete-race", time.Minute, now)
	if err != nil || !ok {
		t.Fatalf("claim faceid attempt before delete: ok=%v err=%v", ok, err)
	}
	if _, err := store.db.ExecContext(context.Background(), `
		INSERT INTO shadow_bindings (
			user_id, shadow_user_name, status, basic_auth_status, basic_auth_source_attempt_id,
			basic_auth_identity_hash, basic_auth_phone_hash, created_at, updated_at
		) VALUES (?, ?, 'active', 'succeeded', ?, ?, ?, ?, ?)
	`, session.User.ID, "shadow-"+session.User.ID, attemptID,
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", now, now); err != nil {
		t.Fatalf("create shadow correlation: %v", err)
	}

	if err := store.DeleteCurrentUser(context.Background(), session.Token, now.Add(time.Minute)); err != nil {
		t.Fatalf("delete current user: %v", err)
	}
	claimed.State = RealnameFaceIDStateFaceSucceeded
	claimed.LeaseOwner = ""
	claimed.LeaseUntil = nil
	applied, err := store.ApplyRealnameFaceIDReconcile(context.Background(), claimed, claimed.LeaseVersion, "delete-race")
	if err != nil {
		t.Fatalf("apply stale post-delete reconcile: %v", err)
	}
	if applied {
		t.Fatal("account deletion must invalidate an in-flight reconciliation lease")
	}
	startAttempt.State = RealnameFaceIDStatePending
	applied, err = store.ApplyRealnameFaceIDTransitionWithAudit(context.Background(), startAttempt, RealnameFaceIDStateCreated, 0, RealnameFaceIDAuditEvent{AttemptID: startAttemptID, EventType: "stale_start", CreatedAt: now.Add(time.Minute)})
	if err != nil || applied {
		t.Fatalf("account deletion must reject stale start transition: applied=%v err=%v", applied, err)
	}
	var shadowCount, sensitiveAttemptCount, auditCount int
	if err := store.db.QueryRowContext(context.Background(), `SELECT COUNT(1) FROM shadow_bindings WHERE user_id = ?`, session.User.ID).Scan(&shadowCount); err != nil {
		t.Fatalf("count shadow bindings: %v", err)
	}
	if err := store.db.QueryRowContext(context.Background(), `
		SELECT COUNT(1) FROM realname_faceid_attempts
		WHERE attempt_id = ? AND state = ? AND name_ciphertext IS NOT NULL
	`, attemptID, RealnameFaceIDStateRevoked).Scan(&sensitiveAttemptCount); err != nil {
		t.Fatalf("check scrubbed attempt: %v", err)
	}
	if err := store.db.QueryRowContext(context.Background(), `
		SELECT COUNT(1) FROM realname_faceid_audit_events
		WHERE attempt_id = ? AND event_type = 'account_deleted_scrubbed'
	`, attemptID).Scan(&auditCount); err != nil {
		t.Fatalf("check retained audit: %v", err)
	}
	if shadowCount != 0 || sensitiveAttemptCount != 0 || auditCount != 1 {
		t.Fatalf("unexpected delete result: shadow=%d sensitive_attempt=%d audit=%d", shadowCount, sensitiveAttemptCount, auditCount)
	}
}

func TestMySQLPhoneChangeRevokesActiveFaceIDAttempt(t *testing.T) {
	dsn := os.Getenv("LIGHTCLAW_AUTH_TEST_DSN")
	if dsn == "" {
		t.Skip("LIGHTCLAW_AUTH_TEST_DSN is not set")
	}
	if err := internalmigrations.Run(dsn); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	store, err := NewMySQLStore(dsn, StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	if err != nil {
		t.Fatalf("open mysql store: %v", err)
	}
	t.Cleanup(func() { _ = store.db.Close() })

	now := fixedNow().Add(time.Duration(time.Now().UnixNano()%1_000_000) * time.Nanosecond)
	session, err := store.CreatePasswordSession(context.Background(), PasswordSignUpInput{
		Name:  "MySQL FaceID Phone Change",
		Email: "faceid-phone-mysql-" + time.Now().Format("20060102150405.000000000") + "@example.com",
	}, []byte("hash"), now, 24*time.Hour)
	if err != nil {
		t.Fatalf("create password session: %v", err)
	}
	if _, err := store.db.ExecContext(context.Background(), `UPDATE users SET phone = ? WHERE id = ?`, "13800138201", session.User.ID); err != nil {
		t.Fatalf("seed current phone: %v", err)
	}
	if _, err := store.db.ExecContext(context.Background(), `
		INSERT INTO sms_challenges (phone, code, expires_at, cooldown_until, remaining_retries, created_at, updated_at)
		VALUES (?, '123456', ?, ?, 5, ?, ?)
	`, "13800138201", now.Add(5*time.Minute), now, now, now); err != nil {
		t.Fatalf("seed current-phone challenge: %v", err)
	}
	if _, err := store.ConsumeCurrentUserPhoneChallenge(context.Background(), session.Token, "123456", now); err != nil {
		t.Fatalf("new FaceID user must consume current-phone challenge without legacy realname: %v", err)
	}
	attemptID := "rfid-phone-" + time.Now().Format("150405.000000000")
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), RealnameFaceIDAttempt{
		AttemptID:           attemptID,
		UserID:              session.User.ID,
		State:               RealnameFaceIDStateFaceSucceeded,
		NameCiphertext:      "sensitive-name",
		IDCardCiphertext:    "sensitive-id-card",
		IdentityHash:        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		CurrentPhoneHash:    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		BizTokenCiphertext:  "sensitive-token",
		VerifyURLCiphertext: "sensitive-url",
		BusinessExpiresAt:   now.Add(time.Hour),
		CreatedAt:           now,
		UpdatedAt:           now,
	}); err != nil {
		t.Fatalf("create faceid attempt: %v", err)
	}
	if _, err := store.UpdateCurrentUserPhone(context.Background(), session.Token, "13800138202", now.Add(time.Minute)); err != nil {
		t.Fatalf("update current phone: %v", err)
	}
	attempt, err := store.GetRealnameFaceIDAttempt(context.Background(), attemptID)
	if err != nil {
		t.Fatalf("get revoked attempt: %v", err)
	}
	var auditCount int
	if err := store.db.QueryRowContext(context.Background(), `
		SELECT COUNT(1) FROM realname_faceid_audit_events
		WHERE attempt_id = ? AND event_type = 'phone_changed_revoked'
	`, attemptID).Scan(&auditCount); err != nil {
		t.Fatalf("count phone-change audits: %v", err)
	}
	if attempt.State != RealnameFaceIDStateRevoked || attempt.ScrubbedAt == nil || attempt.NameCiphertext != "" || attempt.BizTokenCiphertext != "" || auditCount != 1 {
		t.Fatalf("unexpected phone-change revocation: attempt=%+v audit=%d", attempt, auditCount)
	}
	stalePhone := attempt
	stalePhone.State = RealnameFaceIDStateShadowPending
	stalePhone.ScrubbedAt = nil
	stalePhone.NameCiphertext = "sensitive-name"
	applied, err := store.ApplyRealnameFaceIDTransitionWithAudit(context.Background(), stalePhone, RealnameFaceIDStateFaceSucceeded, 0, RealnameFaceIDAuditEvent{AttemptID: attemptID, EventType: "stale_phone", CreatedAt: now.Add(time.Minute)})
	if err != nil || applied {
		t.Fatalf("phone change must reject stale phone-proof transition: applied=%v err=%v", applied, err)
	}
	expiredID := attemptID + "-expired"
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), RealnameFaceIDAttempt{
		AttemptID: expiredID, UserID: session.User.ID, State: RealnameFaceIDStateCreated,
		NameCiphertext: "stale-name", IdentityHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		CurrentPhoneHash:  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		BusinessExpiresAt: now.Add(-time.Minute), CreatedAt: now.Add(time.Second), UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create expired attempt: %v", err)
	}
	if count, err := store.ExpireRealnameFaceIDAttempts(context.Background(), now, 20); err != nil || count != 1 {
		t.Fatalf("expire mysql attempts: count=%d err=%v", count, err)
	}
	expiredAttempt, err := store.GetRealnameFaceIDAttempt(context.Background(), expiredID)
	if err != nil || expiredAttempt.State != RealnameFaceIDStateExpired || expiredAttempt.ScrubbedAt == nil || expiredAttempt.NameCiphertext != "" {
		t.Fatalf("mysql expiry sweep did not scrub created attempt: %+v err=%v", expiredAttempt, err)
	}
	staleExpiry := expiredAttempt
	staleExpiry.State = RealnameFaceIDStatePending
	staleExpiry.ScrubbedAt = nil
	staleExpiry.NameCiphertext = "stale-name"
	applied, err = store.ApplyRealnameFaceIDTransitionWithAudit(context.Background(), staleExpiry, RealnameFaceIDStateCreated, 0, RealnameFaceIDAuditEvent{AttemptID: expiredID, EventType: "stale_expiry", CreatedAt: now})
	if err != nil || applied {
		t.Fatalf("expiry sweep must reject stale start transition: applied=%v err=%v", applied, err)
	}
}

func TestMySQLActivateFaceIDPersistsCandidateIdentityAndAtomicAudit(t *testing.T) {
	dsn := os.Getenv("LIGHTCLAW_AUTH_TEST_DSN")
	if dsn == "" {
		t.Skip("LIGHTCLAW_AUTH_TEST_DSN is not set")
	}
	if err := internalmigrations.Run(dsn); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	store, err := NewMySQLStore(dsn, StoreOptions{Now: fixedNow, SeedDefaultInvites: true})
	if err != nil {
		t.Fatalf("open mysql store: %v", err)
	}
	t.Cleanup(func() { _ = store.db.Close() })
	now := fixedNow().Add(time.Duration(time.Now().UnixNano()%1_000_000) * time.Nanosecond)
	session, err := store.CreatePasswordSession(context.Background(), PasswordSignUpInput{
		Name: "FaceID Activation", Email: "faceid-activate-mysql-" + time.Now().Format("20060102150405.000000000") + "@example.com",
	}, []byte("hash"), now, time.Hour)
	if err != nil {
		t.Fatalf("create activation user: %v", err)
	}
	const phone = "13800138211"
	if _, err := store.db.ExecContext(context.Background(), `UPDATE users SET phone = ? WHERE id = ?`, phone, session.User.ID); err != nil {
		t.Fatalf("seed activation phone: %v", err)
	}
	attemptID := "rfid-activate-" + time.Now().Format("150405.000000000")
	identityHash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	phoneHash := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	faceAt, phoneAt := now.Add(-2*time.Minute), now.Add(-time.Minute)
	if err := store.CreateRealnameFaceIDAttempt(context.Background(), RealnameFaceIDAttempt{
		AttemptID: attemptID, UserID: session.User.ID, State: RealnameFaceIDStateShadowPending,
		NameCiphertext: "candidate-name", IDCardCiphertext: "candidate-id", NameMasked: "张*", IDCardMasked: "110***********002X",
		IdentityHash: identityHash, CurrentPhoneHash: phoneHash, PhoneVerifiedHash: phoneHash,
		BizTokenHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		RuleID:       "rule-1", AccountID: "account-1", LastGetInfoRequestID: "req-final",
		FaceVerifiedAt: &faceAt, PhoneVerifiedAt: &phoneAt, BusinessExpiresAt: now.Add(time.Hour), CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create activation attempt: %v", err)
	}
	if _, err := store.db.ExecContext(context.Background(), `
		INSERT INTO shadow_bindings (
			user_id, shadow_user_name, status, basic_auth_status, basic_auth_source_attempt_id,
			basic_auth_identity_hash, basic_auth_phone_hash, created_at, updated_at
		) VALUES (?, ?, 'active', 'succeeded', ?, ?, ?, ?, ?)
	`, session.User.ID, "shadow-"+session.User.ID, attemptID, identityHash, phoneHash, now, now); err != nil {
		t.Fatalf("create activation shadow correlation: %v", err)
	}
	if _, _, err := store.ActivateRealnameFaceIDAttempt(context.Background(), session.User.ID, attemptID, phone, identityHash, phoneHash, faceAt, phoneAt, now); err != nil {
		t.Fatalf("activate faceid attempt: %v", err)
	}
	stored, err := store.GetUserRealname(context.Background(), session.User.ID)
	if err != nil || stored.NameCiphertext != "candidate-name" || stored.IDCardCiphertext != "candidate-id" {
		t.Fatalf("candidate identity was not projected: %+v err=%v", stored, err)
	}
	var historyCount, auditCount int
	if err := store.db.QueryRowContext(context.Background(), `SELECT COUNT(1) FROM user_realname_history WHERE user_id = ? AND realname_request_id = 'req-final'`, session.User.ID).Scan(&historyCount); err != nil {
		t.Fatalf("count activation history: %v", err)
	}
	if err := store.db.QueryRowContext(context.Background(), `SELECT COUNT(1) FROM realname_faceid_audit_events WHERE attempt_id = ? AND event_type = 'activated'`, attemptID).Scan(&auditCount); err != nil {
		t.Fatalf("count activation audits: %v", err)
	}
	if historyCount != 1 || auditCount != 1 {
		t.Fatalf("expected atomic history and audit, history=%d audit=%d", historyCount, auditCount)
	}
}
