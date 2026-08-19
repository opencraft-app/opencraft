package service

import (
	"context"
	"errors"
	"testing"
)

func TestRegistrationEmailSuffixBlacklistRejectsPasswordSignUp(t *testing.T) {
	svc := newServiceWithRegistrationEmailSuffixBlacklist(t, NewMemoryStore(StoreOptions{Now: fixedNow}), "blocked.example")

	_, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Email:    "new-user@blocked.example",
		Password: "secure2026!",
		Name:     "Blocked User",
	})
	requireServiceErrorCode(t, err, "registration_email_suffix_blocked")

	session, err := svc.SignUpWithPassword(context.Background(), PasswordSignUpInput{
		Email:    "new-user@allowed.example",
		Password: "secure2026!",
		Name:     "Allowed User",
	})
	if err != nil {
		t.Fatalf("allowed suffix should sign up: %v", err)
	}
	if session.User.Email != "new-user@allowed.example" {
		t.Fatalf("expected allowed user email to be normalized and stored, got %q", session.User.Email)
	}
}

func TestRegistrationEmailSuffixBlacklistRejectsOnlyNewOAuthUsers(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	openSvc := NewWithStore(store, Options{Now: fixedNow})
	lockedSvc := newServiceWithRegistrationEmailSuffixBlacklist(t, store, "blocked.example")

	existingSession, err := openSvc.SignInWithOAuth(ctx, OAuthSignInInput{
		Provider:        "github",
		ProviderSubject: "github-existing-blocked",
		Email:           "existing@blocked.example",
		EmailVerified:   true,
		Name:            "Existing GitHub User",
	})
	if err != nil {
		t.Fatalf("seed existing GitHub identity: %v", err)
	}

	returningSession, err := lockedSvc.SignInWithOAuth(ctx, OAuthSignInInput{
		Provider:        "github",
		ProviderSubject: "github-existing-blocked",
		Email:           "existing@blocked.example",
		EmailVerified:   true,
		Name:            "Existing GitHub User",
	})
	if err != nil {
		t.Fatalf("existing GitHub identity should still sign in: %v", err)
	}
	if returningSession.User.ID != existingSession.User.ID {
		t.Fatalf("expected returning GitHub user %q, got %q", existingSession.User.ID, returningSession.User.ID)
	}

	_, err = lockedSvc.SignInWithOAuth(ctx, OAuthSignInInput{
		Provider:        "github",
		ProviderSubject: "github-new-blocked",
		Email:           "new@blocked.example",
		EmailVerified:   true,
		Name:            "New GitHub User",
	})
	requireServiceErrorCode(t, err, "registration_email_suffix_blocked")
}

func TestRegistrationEmailSuffixBlacklistAllowsExistingEmailAutoLink(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	openSvc := NewWithStore(store, Options{Now: fixedNow})
	lockedSvc := newServiceWithRegistrationEmailSuffixBlacklist(t, store, "blocked.example")

	passwordSession, err := openSvc.SignUpWithPassword(ctx, PasswordSignUpInput{
		Email:    "existing-email@blocked.example",
		Password: "secure2026!",
		Name:     "Existing Email User",
	})
	if err != nil {
		t.Fatalf("seed existing password user: %v", err)
	}

	linkedSession, err := lockedSvc.SignInWithOAuth(ctx, OAuthSignInInput{
		Provider:        "github",
		ProviderSubject: "github-links-existing-blocked-email",
		Email:           "existing-email@blocked.example",
		EmailVerified:   true,
		Name:            "GitHub Profile",
	})
	if err != nil {
		t.Fatalf("verified OAuth email should link existing user instead of registering: %v", err)
	}
	if linkedSession.User.ID != passwordSession.User.ID {
		t.Fatalf("expected linked user %q, got %q", passwordSession.User.ID, linkedSession.User.ID)
	}
}

func TestGitHubRegistrationRequiresEmailForNewUsers(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore(StoreOptions{Now: fixedNow})
	svc := NewWithStore(store, Options{Now: fixedNow})

	legacyUserID := seedLegacyGitHubOAuthIdentityWithoutEmail(t, store, "github-legacy-emailless")
	returningSession, err := svc.SignInWithOAuth(ctx, OAuthSignInInput{
		Provider:        "github",
		ProviderSubject: "github-legacy-emailless",
		Name:            "Legacy GitHub User",
	})
	if err != nil {
		t.Fatalf("legacy GitHub identity without email should still sign in: %v", err)
	}
	if returningSession.User.ID != legacyUserID {
		t.Fatalf("expected legacy GitHub user %q, got %q", legacyUserID, returningSession.User.ID)
	}

	_, err = svc.SignInWithOAuth(ctx, OAuthSignInInput{
		Provider:        "github",
		ProviderSubject: "github-new-emailless",
		Name:            "New GitHub User",
	})
	requireServiceErrorCode(t, err, "oauth_registration_email_required")

	qqSession, err := svc.SignInWithOAuth(ctx, OAuthSignInInput{
		Provider:        "qq",
		ProviderSubject: "qq-new-emailless",
		Name:            "QQ User",
	})
	if err != nil {
		t.Fatalf("non-GitHub OAuth without email should remain allowed: %v", err)
	}
	if qqSession.User.ID == "" {
		t.Fatal("expected non-GitHub OAuth sign-in to create a user")
	}
}

func TestRegistrationEmailSuffixBlacklistMatchesDomainSuffixBoundary(t *testing.T) {
	blacklist := newRegistrationEmailSuffixBlacklist([]string{"@blocked.example", "owner@parent.example", "MiXeD.Example"})

	for _, email := range []string{
		"user@blocked.example",
		"user@team.blocked.example",
		"user@parent.example",
		"user@child.parent.example",
		"user@mixed.example",
	} {
		if !blacklist.blocksEmail(email) {
			t.Fatalf("expected %q to match suffix blacklist", email)
		}
	}

	for _, email := range []string{
		"user@notblocked.example",
		"user@blocked.example.evil",
		"user@otherparent.example",
		"user@allowed.example",
	} {
		if blacklist.blocksEmail(email) {
			t.Fatalf("expected %q not to match suffix blacklist", email)
		}
	}
}

func newServiceWithRegistrationEmailSuffixBlacklist(t *testing.T, store Store, suffixes ...string) *Service {
	t.Helper()
	return newWithStoreAndRegistrationEmailSuffixBlacklist(store, Options{Now: fixedNow}, newRegistrationEmailSuffixBlacklist(suffixes))
}

func seedLegacyGitHubOAuthIdentityWithoutEmail(t *testing.T, store *MemoryStore, providerSubject string) string {
	t.Helper()

	store.mu.Lock()
	defer store.mu.Unlock()

	user := store.newUserLocked("Legacy GitHub User", "", "", fixedNow())
	store.oauthUsers[oauthIdentityKey("github", providerSubject)] = user.ID
	return user.ID
}

func requireServiceErrorCode(t *testing.T, err error, code string) {
	t.Helper()

	if err == nil {
		t.Fatalf("expected service error %q, got nil", code)
	}
	var authErr *Error
	if !errors.As(err, &authErr) {
		t.Fatalf("expected service error %q, got %T %v", code, err, err)
	}
	if authErr.Code != code {
		t.Fatalf("expected service error %q, got %q", code, authErr.Code)
	}
}
