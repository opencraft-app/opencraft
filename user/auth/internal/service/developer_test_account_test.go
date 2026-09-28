package service

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/shadowbinding"
)

func TestDeveloperTestAccountLeaseLifecycle(t *testing.T) {
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	store := NewMemoryStore(StoreOptions{Now: clock})
	shadowStore := shadowbinding.NewMemoryStore()
	shadowService := shadowbinding.New(shadowStore, nil, shadowbinding.Options{Enabled: true, Now: clock})
	service := NewWithStore(store, Options{Now: clock, SessionTTL: 24 * time.Hour, ShadowBinding: shadowService})

	firstUserID := seedDeveloperTestAccount(t, service, store, shadowStore, now, "pool-first@example.invalid", "pool_first", 300000000101)
	secondUserID := seedDeveloperTestAccount(t, service, store, shadowStore, now, "pool-second@example.invalid", "pool_second", 300000000102)

	firstLease, firstSession, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{secondUserID, firstUserID, firstUserID}, "sandbox-bj-7:9.1.2.3", "9.1.2.3", 8*time.Hour, "", false,
	)
	if err != nil {
		t.Fatalf("acquire first account: %v", err)
	}
	if firstLease.UserID != firstUserID || firstLease.LeaseVersion != 1 || firstSession.AuthMethod != AuthMethodDeveloperLease {
		t.Fatalf("unexpected first lease/session: lease=%+v session=%+v", firstLease, firstSession)
	}

	_, _, err = service.AcquireDeveloperTestAccount(
		context.Background(), []string{firstUserID, secondUserID}, "sandbox-bj-7:9.1.2.3", "9.1.2.3", 12*time.Hour, "", false,
	)
	assertDeveloperTestAccountError(t, err, "developer_test_account_renewal_requires_session", http.StatusUnauthorized)

	renewed, renewedSession, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{firstUserID, secondUserID}, "sandbox-bj-7:9.1.2.3", "9.1.2.3", 12*time.Hour, firstSession.Token, false,
	)
	if err != nil {
		t.Fatalf("renew first account: %v", err)
	}
	if renewed.UserID != firstUserID || renewed.LeaseVersion != 2 || !renewed.LeaseUntil.Equal(now.Add(12*time.Hour)) {
		t.Fatalf("same DevCloud did not renew its existing lease: %+v", renewed)
	}
	if renewedSession.Token == firstSession.Token {
		t.Fatal("lease renewal reused the previous session token")
	}

	secondLease, secondSession, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{firstUserID, secondUserID}, "sandbox-bj-7:9.9.9.9", "9.9.9.9", 8*time.Hour, "", false,
	)
	if err != nil {
		t.Fatalf("acquire second account: %v", err)
	}
	if secondLease.UserID != secondUserID {
		t.Fatalf("different DevCloud shared an occupied account: %+v", secondLease)
	}

	_, _, err = service.AcquireDeveloperTestAccount(
		context.Background(), []string{firstUserID, secondUserID}, "sandbox-bj-7:9.8.8.8", "9.8.8.8", 8*time.Hour, "", false,
	)
	assertDeveloperTestAccountError(t, err, "developer_test_account_busy", http.StatusConflict)

	store.mu.Lock()
	firstUser := store.usersByID[firstUserID]
	store.mu.Unlock()
	nonLeaseSession, err := store.CreateSession(context.Background(), firstUser, now, time.Hour)
	if err != nil {
		t.Fatalf("create non-lease session: %v", err)
	}
	_, err = service.ReleaseDeveloperTestAccount(context.Background(), nonLeaseSession.Token, "sandbox-bj-7:9.1.2.3")
	assertDeveloperTestAccountError(t, err, "unauthorized", http.StatusUnauthorized)

	_, err = service.ReleaseDeveloperTestAccount(context.Background(), secondSession.Token, "sandbox-bj-7:9.1.2.3")
	assertDeveloperTestAccountError(t, err, "developer_test_account_lease_not_found", http.StatusConflict)

	released, err := service.ReleaseDeveloperTestAccount(context.Background(), renewedSession.Token, "sandbox-bj-7:9.1.2.3")
	if err != nil {
		t.Fatalf("release first account: %v", err)
	}
	if released.UserID != firstUserID || released.LeaseVersion != 3 || released.LeaseOwner != "" || released.TargetIP != "" {
		t.Fatalf("unexpected released lease: %+v", released)
	}
	if _, err := service.CurrentSession(context.Background(), renewedSession.Token); err == nil {
		t.Fatal("released developer lease session remained usable")
	}
	if _, err := service.CurrentSession(context.Background(), firstSession.Token); err == nil {
		t.Fatal("superseded developer lease session remained usable after release")
	}

	reassigned, _, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{firstUserID, secondUserID}, "sandbox-bj-7:9.8.8.8", "9.8.8.8", 8*time.Hour, "", false,
	)
	if err != nil {
		t.Fatalf("reassign released account: %v", err)
	}
	if reassigned.UserID != firstUserID || reassigned.LeaseVersion != 4 {
		t.Fatalf("released account was not reusable: %+v", reassigned)
	}
}

func TestDeveloperTestAccountLeaseRequiresCNRealnameAndActiveBinding(t *testing.T) {
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	store := NewMemoryStore(StoreOptions{Now: clock})
	shadowStore := shadowbinding.NewMemoryStore()
	shadowService := shadowbinding.New(shadowStore, nil, shadowbinding.Options{Enabled: true, Now: clock})
	service := NewWithStore(store, Options{Now: clock, ShadowBinding: shadowService})

	unverified := mustPasswordSession(t, service, "pool-unverified@example.invalid")
	_, _ = shadowStore.SavePendingBinding(context.Background(), unverified.User.ID, "pool_unverified", now)
	_, _ = shadowStore.MarkBindingActive(context.Background(), unverified.User.ID, 300000000103, 300000000103, 1250000103, now)
	inactive := mustPasswordSession(t, service, "pool-inactive@example.invalid")
	store.mu.Lock()
	user := store.usersByID[inactive.User.ID]
	user.RealnameVerified = true
	store.usersByID[user.ID] = user
	store.mu.Unlock()

	_, _, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{unverified.User.ID, inactive.User.ID}, "sandbox-bj-7:9.1.2.3", "9.1.2.3", 8*time.Hour, "", false,
	)
	assertDeveloperTestAccountError(t, err, "developer_test_account_unavailable", http.StatusServiceUnavailable)
}

func TestDeveloperTestAccountLeaseAllowsIntlActiveBindingWithoutCNRealname(t *testing.T) {
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	store := NewMemoryStore(StoreOptions{Now: clock})
	shadowStore := shadowbinding.NewMemoryStore()
	shadowService := shadowbinding.New(shadowStore, nil, shadowbinding.Options{Enabled: true, Now: clock})
	service := NewWithStore(store, Options{
		Now:           clock,
		SiteKind:      shadowbinding.SiteKindIntl,
		ShadowBinding: shadowService,
	})

	session := mustPasswordSession(t, service, "pool-intl@example.invalid")
	if _, err := shadowStore.SavePendingBinding(context.Background(), session.User.ID, "pool_intl", now); err != nil {
		t.Fatalf("save intl pending binding: %v", err)
	}
	if _, err := shadowStore.MarkBindingActive(context.Background(), session.User.ID, 450860000023, 450860000023, 1374222817, now); err != nil {
		t.Fatalf("activate intl binding: %v", err)
	}

	lease, leasedSession, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{session.User.ID}, "sandbox-kr-1:21.214.48.147", "21.214.48.147", 8*time.Hour, "", false,
	)
	if err != nil {
		t.Fatalf("acquire intl account: %v", err)
	}
	if lease.UserID != session.User.ID || leasedSession.AuthMethod != AuthMethodDeveloperLease {
		t.Fatalf("unexpected intl lease/session: lease=%+v session=%+v", lease, leasedSession)
	}
}

func TestDeveloperTestAccountExpiredOwnerReclaimsSameAccount(t *testing.T) {
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	store := NewMemoryStore(StoreOptions{Now: clock})
	shadowStore := shadowbinding.NewMemoryStore()
	shadowService := shadowbinding.New(shadowStore, nil, shadowbinding.Options{Enabled: true, Now: clock})
	service := NewWithStore(store, Options{Now: clock, SessionTTL: 24 * time.Hour, ShadowBinding: shadowService})

	firstUserID := seedDeveloperTestAccount(t, service, store, shadowStore, now, "pool-expired-first@example.invalid", "pool_expired_first", 300000000111)
	secondUserID := seedDeveloperTestAccount(t, service, store, shadowStore, now, "pool-expired-second@example.invalid", "pool_expired_second", 300000000112)
	owner := "sandbox-bj-7:9.7.7.7"
	initial, _, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{secondUserID}, owner, "9.7.7.7", time.Minute, "", false,
	)
	if err != nil || initial.UserID != secondUserID {
		t.Fatalf("acquire initial owner account: lease=%+v err=%v", initial, err)
	}

	now = now.Add(2 * time.Minute)
	reclaimed, _, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{firstUserID, secondUserID}, owner, "9.7.7.7", time.Hour, "", false,
	)
	if err != nil {
		t.Fatalf("reclaim expired owner account: %v", err)
	}
	if reclaimed.UserID != secondUserID || reclaimed.LeaseVersion != 2 {
		t.Fatalf("expired owner moved to a different account: %+v", reclaimed)
	}
}

func TestDeveloperTestAccountActiveOwnerCannotMoveWhenPoolChanges(t *testing.T) {
	now := time.Date(2026, 9, 22, 8, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	store := NewMemoryStore(StoreOptions{Now: clock})
	shadowStore := shadowbinding.NewMemoryStore()
	shadowService := shadowbinding.New(shadowStore, nil, shadowbinding.Options{Enabled: true, Now: clock})
	service := NewWithStore(store, Options{Now: clock, SessionTTL: 24 * time.Hour, ShadowBinding: shadowService})

	firstUserID := seedDeveloperTestAccount(t, service, store, shadowStore, now, "pool-change-first@example.invalid", "pool_change_first", 300000000121)
	secondUserID := seedDeveloperTestAccount(t, service, store, shadowStore, now, "pool-change-second@example.invalid", "pool_change_second", 300000000122)
	owner := "sandbox-bj-7:9.6.6.6"
	if _, _, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{firstUserID}, owner, "9.6.6.6", time.Hour, "", false,
	); err != nil {
		t.Fatalf("acquire original pool account: %v", err)
	}

	_, _, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{secondUserID}, owner, "9.6.6.6", time.Hour, "", false,
	)
	assertDeveloperTestAccountError(t, err, "developer_test_account_unavailable", http.StatusServiceUnavailable)
}

func TestDeveloperTestAccountForceTakeoverRecoversOwnLease(t *testing.T) {
	now := time.Date(2026, 9, 24, 8, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	store := NewMemoryStore(StoreOptions{Now: clock})
	shadowStore := shadowbinding.NewMemoryStore()
	shadowService := shadowbinding.New(shadowStore, nil, shadowbinding.Options{Enabled: true, Now: clock})
	service := NewWithStore(store, Options{Now: clock, SessionTTL: 24 * time.Hour, ShadowBinding: shadowService})

	firstUserID := seedDeveloperTestAccount(t, service, store, shadowStore, now, "pool-force-first@example.invalid", "pool_force_first", 300000000131)
	secondUserID := seedDeveloperTestAccount(t, service, store, shadowStore, now, "pool-force-second@example.invalid", "pool_force_second", 300000000132)
	candidates := []string{firstUserID, secondUserID}
	owner := "sandbox-kr-1:21.214.48.147"

	original, originalSession, err := service.AcquireDeveloperTestAccount(
		context.Background(), candidates, owner, "21.214.48.147", 8*time.Hour, "", false,
	)
	if err != nil {
		t.Fatalf("acquire original lease: %v", err)
	}

	// The DevCloud host lost its local session (wiped private state) but its own
	// lease is still inside the TTL: without force it stays locked out.
	_, _, err = service.AcquireDeveloperTestAccount(
		context.Background(), candidates, owner, "21.214.48.147", 8*time.Hour, "", false,
	)
	assertDeveloperTestAccountError(t, err, "developer_test_account_renewal_requires_session", http.StatusUnauthorized)

	reclaimed, reclaimedSession, err := service.AcquireDeveloperTestAccount(
		context.Background(), candidates, owner, "21.214.48.147", 8*time.Hour, "", true,
	)
	if err != nil {
		t.Fatalf("force takeover of own lease: %v", err)
	}
	if reclaimed.UserID != original.UserID || reclaimed.LeaseVersion != original.LeaseVersion+1 {
		t.Fatalf("force takeover changed account or did not advance version: before=%+v after=%+v", original, reclaimed)
	}
	if reclaimedSession.Token == originalSession.Token {
		t.Fatal("force takeover reused the previous session token")
	}
	if _, err := service.CurrentSession(context.Background(), originalSession.Token); err == nil {
		t.Fatal("stale lease session remained usable after force takeover")
	}
	if _, err := service.CurrentSession(context.Background(), reclaimedSession.Token); err != nil {
		t.Fatalf("new lease session unusable after force takeover: %v", err)
	}

	// force must never let a different DevCloud steal an active lease.
	_, _, err = service.AcquireDeveloperTestAccount(
		context.Background(), candidates, "sandbox-kr-1:21.214.48.148", "21.214.48.148", 8*time.Hour, "", true,
	)
	if err != nil {
		t.Fatalf("second owner should take the other free account: %v", err)
	}
	_, _, err = service.AcquireDeveloperTestAccount(
		context.Background(), candidates, "sandbox-kr-1:21.214.48.149", "21.214.48.149", 8*time.Hour, "", true,
	)
	assertDeveloperTestAccountError(t, err, "developer_test_account_busy", http.StatusConflict)
}

func TestDeveloperTestAccountForceTakeoverKeepsRenewalTokenPath(t *testing.T) {
	now := time.Date(2026, 9, 24, 8, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	store := NewMemoryStore(StoreOptions{Now: clock})
	shadowStore := shadowbinding.NewMemoryStore()
	shadowService := shadowbinding.New(shadowStore, nil, shadowbinding.Options{Enabled: true, Now: clock})
	service := NewWithStore(store, Options{Now: clock, SessionTTL: 24 * time.Hour, ShadowBinding: shadowService})

	userID := seedDeveloperTestAccount(t, service, store, shadowStore, now, "pool-force-renew@example.invalid", "pool_force_renew", 300000000141)
	owner := "sandbox-bj-7:9.5.5.5"
	lease, session, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{userID}, owner, "9.5.5.5", time.Hour, "", false,
	)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}

	renewed, _, err := service.AcquireDeveloperTestAccount(
		context.Background(), []string{userID}, owner, "9.5.5.5", time.Hour, session.Token, true,
	)
	if err != nil {
		t.Fatalf("renew with token while force is set: %v", err)
	}
	if renewed.UserID != lease.UserID || renewed.LeaseVersion != lease.LeaseVersion+1 {
		t.Fatalf("renewal with force flag did not behave like a renewal: %+v", renewed)
	}
}

func seedDeveloperTestAccount(
	t *testing.T,
	service *Service,
	store *MemoryStore,
	shadowStore shadowbinding.Store,
	now time.Time,
	email string,
	shadowUserName string,
	uin int64,
) string {
	t.Helper()
	session := mustPasswordSession(t, service, email)
	store.mu.Lock()
	user := store.usersByID[session.User.ID]
	user.RealnameVerified = true
	store.usersByID[user.ID] = user
	store.mu.Unlock()
	if _, err := shadowStore.SavePendingBinding(context.Background(), user.ID, shadowUserName, now); err != nil {
		t.Fatalf("save pending binding for %s: %v", user.ID, err)
	}
	if _, err := shadowStore.MarkBindingActive(context.Background(), user.ID, uin, uin, 1250000000+uin%1000, now); err != nil {
		t.Fatalf("activate binding for %s: %v", user.ID, err)
	}
	return user.ID
}

func assertDeveloperTestAccountError(t *testing.T, err error, code string, status int) {
	t.Helper()
	var authErr *Error
	if !errors.As(err, &authErr) {
		t.Fatalf("expected service error %s, got %v", code, err)
	}
	if authErr.Code != code || authErr.Status != status {
		t.Fatalf("unexpected service error: %+v", authErr)
	}
}
