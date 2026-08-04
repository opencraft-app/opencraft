package authn

import (
	"context"
	"errors"
	"testing"
	"time"

	"chatserver/internal/apperror"
	accountauthport "chatserver/internal/ports/accountauth"
	authnport "chatserver/internal/ports/authn"
	tokenport "chatserver/internal/ports/token"
)

const (
	humanAccountID = "01989c24-7540-7f12-a27b-c83243215dd1"
	humanSessionID = "01989c24-7540-7f12-a27b-c83243215dd2"
	humanServerID  = "01989c24-7540-7f12-a27b-c83243215dd3"
	humanAgentID   = "01989c24-7540-7f12-a27b-c83243215dd4"
)

var humanNow = time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)

type fakeTokenSigner struct {
	claims tokenport.Claims
	err    error
	raw    string
}

func (*fakeTokenSigner) Sign(context.Context, tokenport.Claims) (string, error) {
	return "", errors.New("unused")
}

func (s *fakeTokenSigner) Verify(
	_ context.Context,
	raw string,
) (tokenport.Claims, error) {
	s.raw = raw
	return s.claims, s.err
}

type fakeCurrentnessStore struct {
	result    accountauthport.CurrentSession
	err       error
	accountID string
	sessionID string
	at        time.Time
}

func (s *fakeCurrentnessStore) FindCurrentSession(
	_ context.Context,
	accountID string,
	sessionID string,
	at time.Time,
) (accountauthport.CurrentSession, error) {
	s.accountID = accountID
	s.sessionID = sessionID
	s.at = at
	return s.result, s.err
}

type authClock struct{ now time.Time }

func (c authClock) Now() time.Time { return c.now }

func TestHumanAuthenticatorReturnsCurrentPrincipal(t *testing.T) {
	claims := humanClaims(t, 7)
	signer := &fakeTokenSigner{claims: claims}
	store := &fakeCurrentnessStore{
		result: accountauthport.CurrentSession{
			Status: accountauthport.SessionCurrent,
			Account: accountauthport.Account{
				ID:           humanAccountID,
				TokenVersion: 7,
			},
		},
	}
	authenticator, err := NewHumanAuthenticator(
		signer,
		store,
		authClock{now: humanNow},
	)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := authnport.NewHumanBearerCandidate("signed-access-token")
	if err != nil {
		t.Fatal(err)
	}

	principal, err := authenticator.Authenticate(context.Background(), candidate)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	human, ok := principal.(authnport.CurrentHumanPrincipal)
	if !ok {
		t.Fatalf("principal type = %T", principal)
	}
	if human.AccountID() != humanAccountID ||
		human.AuthSessionID() != humanSessionID ||
		human.TokenVersion() != 7 {
		t.Fatalf("principal = %#v", human)
	}
	if signer.raw != "signed-access-token" ||
		store.accountID != humanAccountID ||
		store.sessionID != humanSessionID ||
		!store.at.Equal(humanNow) {
		t.Fatalf("signer/store inputs = %#v %#v", signer, store)
	}
}

func TestHumanAuthenticatorMapsTokenAndSessionFailures(t *testing.T) {
	tests := []struct {
		name      string
		signer    *fakeTokenSigner
		store     *fakeCurrentnessStore
		candidate func(t *testing.T) authnport.CredentialCandidate
		wantCode  string
	}{
		{
			name:      "expired access token",
			signer:    &fakeTokenSigner{err: tokenport.ErrExpiredToken},
			store:     &fakeCurrentnessStore{},
			candidate: humanCandidate,
			wantCode:  "token_expired",
		},
		{
			name:      "invalid access token",
			signer:    &fakeTokenSigner{err: tokenport.ErrInvalidToken},
			store:     &fakeCurrentnessStore{},
			candidate: humanCandidate,
			wantCode:  "unauthenticated",
		},
		{
			name: "wrong token purpose",
			signer: &fakeTokenSigner{
				claims: runtimeClaims(t),
			},
			store:     &fakeCurrentnessStore{},
			candidate: humanCandidate,
			wantCode:  "unauthenticated",
		},
		{
			name:   "wrong candidate kind",
			signer: &fakeTokenSigner{},
			store:  &fakeCurrentnessStore{},
			candidate: func(t *testing.T) authnport.CredentialCandidate {
				t.Helper()
				candidate, err := authnport.NewRuntimeBearerCandidate("runtime")
				if err != nil {
					t.Fatal(err)
				}
				return candidate
			},
			wantCode: "unauthenticated",
		},
		{
			name:   "revoked session",
			signer: &fakeTokenSigner{claims: humanClaims(t, 7)},
			store: &fakeCurrentnessStore{result: accountauthport.CurrentSession{
				Status: accountauthport.SessionRevoked,
			}},
			candidate: humanCandidate,
			wantCode:  "session_revoked",
		},
		{
			name:   "token version changed",
			signer: &fakeTokenSigner{claims: humanClaims(t, 7)},
			store: &fakeCurrentnessStore{result: accountauthport.CurrentSession{
				Status: accountauthport.SessionCurrent,
				Account: accountauthport.Account{
					ID:           humanAccountID,
					TokenVersion: 8,
				},
			}},
			candidate: humanCandidate,
			wantCode:  "session_revoked",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			authenticator, err := NewHumanAuthenticator(
				test.signer,
				test.store,
				authClock{now: humanNow},
			)
			if err != nil {
				t.Fatal(err)
			}
			principal, err := authenticator.Authenticate(
				context.Background(),
				test.candidate(t),
			)
			if principal != nil {
				t.Fatalf("principal = %#v, want nil", principal)
			}
			if got := apperror.CodeOf(err); got != test.wantCode {
				t.Fatalf("Authenticate() code = %q, want %q; err=%v", got, test.wantCode, err)
			}
		})
	}
}

func humanCandidate(t *testing.T) authnport.CredentialCandidate {
	t.Helper()
	candidate, err := authnport.NewHumanBearerCandidate("human-access")
	if err != nil {
		t.Fatal(err)
	}
	return candidate
}

func humanClaims(t *testing.T, version uint64) tokenport.Claims {
	t.Helper()
	claims, err := tokenport.NewHumanClaims(
		humanAccountID,
		humanSessionID,
		version,
		humanNow.Add(-time.Minute),
		humanNow.Add(time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	return claims
}

func runtimeClaims(t *testing.T) tokenport.Claims {
	t.Helper()
	claims, err := tokenport.NewRuntimeClaims(
		humanServerID,
		humanAgentID,
		1,
		humanNow.Add(-time.Minute),
		humanNow.Add(time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	return claims
}
