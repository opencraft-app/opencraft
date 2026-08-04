package accountauth

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"chatserver/internal/apperror"
	accountauthport "chatserver/internal/ports/accountauth"
	tokenport "chatserver/internal/ports/token"
)

const (
	testAccountID = "01989c24-7540-7f12-a27b-c83243215dd1"
	testSessionID = "01989c24-7540-7f12-a27b-c83243215dd2"
	testFamilyID  = "01989c24-7540-7f12-a27b-c83243215dd3"
	testNextID    = "01989c24-7540-7f12-a27b-c83243215dd4"
)

var testNow = time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)

type fakeRepository struct {
	registerInput accountauthport.Registration
	registerErr   error

	credential      accountauthport.CredentialAccount
	findErr         error
	findLogin       accountauthport.LoginIdentity
	createSession   accountauthport.SessionDraft
	createAccountID string
	createErr       error

	rotationInput  accountauthport.Rotation
	rotationResult accountauthport.RotationResult
	rotationErr    error
	onRotate       func()

	revokeAccountID string
	revokeSessionID string
	revokeAt        time.Time
	revokeErr       error
}

func (r *fakeRepository) Register(
	_ context.Context,
	input accountauthport.Registration,
) error {
	r.registerInput = input
	return r.registerErr
}

func (r *fakeRepository) FindCredentialByLogin(
	_ context.Context,
	login accountauthport.LoginIdentity,
) (accountauthport.CredentialAccount, error) {
	r.findLogin = login
	return r.credential, r.findErr
}

func (r *fakeRepository) CreateSession(
	_ context.Context,
	accountID string,
	session accountauthport.SessionDraft,
) error {
	r.createAccountID = accountID
	r.createSession = session
	return r.createErr
}

func (r *fakeRepository) RotateSession(
	_ context.Context,
	rotation accountauthport.Rotation,
) (accountauthport.RotationResult, error) {
	r.rotationInput = rotation
	if r.onRotate != nil {
		r.onRotate()
	}
	return r.rotationResult, r.rotationErr
}

func (r *fakeRepository) RevokeSession(
	_ context.Context,
	accountID string,
	sessionID string,
	at time.Time,
) error {
	r.revokeAccountID = accountID
	r.revokeSessionID = sessionID
	r.revokeAt = at
	return r.revokeErr
}

type fakePasswordHasher struct {
	hash       string
	hashErr    error
	verifyOK   bool
	verifyErr  error
	hashedRaw  string
	verifyHash string
	verifyRaw  string
	dummyRaw   string
}

func (h *fakePasswordHasher) Hash(_ context.Context, raw string) (string, error) {
	h.hashedRaw = raw
	return h.hash, h.hashErr
}

func (h *fakePasswordHasher) Verify(
	_ context.Context,
	encoded string,
	raw string,
) (bool, error) {
	h.verifyHash = encoded
	h.verifyRaw = raw
	return h.verifyOK, h.verifyErr
}

func (h *fakePasswordHasher) DummyVerify(_ context.Context, raw string) error {
	h.dummyRaw = raw
	return h.verifyErr
}

type fakeRefreshTokens struct {
	issued []accountauthport.IssuedRefreshToken
	routes map[string]accountauthport.RefreshTokenRoute
	err    error
}

func (t *fakeRefreshTokens) Issue(
	_ context.Context,
	accountID string,
	sessionID string,
) (accountauthport.IssuedRefreshToken, error) {
	if t.err != nil {
		return accountauthport.IssuedRefreshToken{}, t.err
	}
	index := len(t.issued)
	plain := "refresh-" + sessionID
	digest := sha256.Sum256([]byte(plain))
	token := accountauthport.IssuedRefreshToken{
		Plaintext: plain,
		Digest:    digest,
	}
	t.issued = append(t.issued, token)
	return t.issued[index], nil
}

func (t *fakeRefreshTokens) Parse(
	_ context.Context,
	raw string,
) (accountauthport.RefreshTokenRoute, error) {
	if route, ok := t.routes[raw]; ok {
		return route, nil
	}
	return accountauthport.RefreshTokenRoute{}, accountauthport.ErrInvalidRefreshToken
}

type fakeSigner struct {
	signedClaims []tokenport.Claims
	err          error
	failCanceled bool
}

func (s *fakeSigner) Sign(ctx context.Context, claims tokenport.Claims) (string, error) {
	s.signedClaims = append(s.signedClaims, claims)
	if s.failCanceled && ctx.Err() != nil {
		return "", ctx.Err()
	}
	if s.err != nil {
		return "", s.err
	}
	return "access-" + claims.SessionID(), nil
}

func (s *fakeSigner) Verify(context.Context, string) (tokenport.Claims, error) {
	return tokenport.Claims{}, errors.New("unused")
}

type sequenceIDs struct {
	values []string
	index  int
}

func (g *sequenceIDs) New() (string, error) {
	if g.index >= len(g.values) {
		return "", errors.New("ID exhausted")
	}
	value := g.values[g.index]
	g.index++
	return value, nil
}

type fixedClock struct{ now time.Time }

func (c fixedClock) Now() time.Time { return c.now }

func newTestService(
	t *testing.T,
	repository *fakeRepository,
	passwords *fakePasswordHasher,
	refreshTokens *fakeRefreshTokens,
	ids ...string,
) *Service {
	t.Helper()
	service, err := NewService(
		repository,
		passwords,
		refreshTokens,
		&fakeSigner{},
		&sequenceIDs{values: ids},
		fixedClock{now: testNow},
		Config{
			AccessTTL:  15 * time.Minute,
			RefreshTTL: 30 * 24 * time.Hour,
		},
	)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service
}

func TestRegisterNormalizesEmailAndCreatesFirstSession(t *testing.T) {
	repository := &fakeRepository{}
	passwords := &fakePasswordHasher{hash: "argon2id-hash"}
	refreshTokens := &fakeRefreshTokens{}
	signer := &fakeSigner{}
	service, err := NewService(
		repository,
		passwords,
		refreshTokens,
		signer,
		&sequenceIDs{values: []string{testAccountID, testSessionID, testFamilyID}},
		fixedClock{now: testNow},
		Config{AccessTTL: 15 * time.Minute, RefreshTTL: 30 * 24 * time.Hour},
	)
	if err != nil {
		t.Fatal(err)
	}

	result, err := service.Register(context.Background(), RegisterCommand{
		Email:       " Alice@Example.COM ",
		Password:    "correct horse battery staple",
		DisplayName: " 爱丽丝 ",
	})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	if got := repository.registerInput.Login.Normalized; got != "alice@example.com" {
		t.Fatalf("normalized email = %q", got)
	}
	const wantLoginHash = "7bbad615f82b19fbd522cd0cd2255adf97842ff4a9a57b720a6ef3e912234ba3"
	if got := repository.registerInput.Login.Hash; got != wantLoginHash {
		t.Fatalf("login hash = %q, want %q", got, wantLoginHash)
	}
	if got := repository.registerInput.Account.PasswordHash; got != "argon2id-hash" {
		t.Fatalf("password hash = %q", got)
	}
	if got := repository.registerInput.Account.DisplayName; got != "爱丽丝" {
		t.Fatalf("display name = %q", got)
	}
	if got := repository.registerInput.Account.IMState; got != "provisioning" {
		t.Fatalf("IM state = %q", got)
	}
	if !repository.registerInput.OccurredAt.Equal(testNow) {
		t.Fatalf("registration occurredAt = %v", repository.registerInput.OccurredAt)
	}
	if result.Account.ID != testAccountID ||
		result.Account.Email != "alice@example.com" ||
		result.RefreshToken == "" ||
		result.AccessToken == "" {
		t.Fatalf("Register() result = %#v", result)
	}
	if !result.ExpiresAt.Equal(testNow.Add(15 * time.Minute)) {
		t.Fatalf("access expiresAt = %v", result.ExpiresAt)
	}
	if len(signer.signedClaims) != 1 ||
		signer.signedClaims[0].SessionID() != testSessionID {
		t.Fatalf("signed claims = %#v", signer.signedClaims)
	}
}

func TestRegisterMapsUniqueLoginConflict(t *testing.T) {
	repository := &fakeRepository{registerErr: accountauthport.ErrLoginConflict}
	service := newTestService(
		t,
		repository,
		&fakePasswordHasher{hash: "hash"},
		&fakeRefreshTokens{},
		testAccountID,
		testSessionID,
		testFamilyID,
	)

	_, err := service.Register(context.Background(), RegisterCommand{
		Email:       "alice@example.com",
		Password:    "password-123",
		DisplayName: "Alice",
	})
	if got := apperror.CodeOf(err); got != "account_already_exists" {
		t.Fatalf("Register() code = %q, want account_already_exists; err=%v", got, err)
	}
}

func TestLoginUsesSameUnauthenticatedErrorForMissingAndWrongPassword(t *testing.T) {
	tests := []struct {
		name       string
		repository *fakeRepository
		passwords  *fakePasswordHasher
	}{
		{
			name:       "missing account",
			repository: &fakeRepository{findErr: accountauthport.ErrLoginNotFound},
			passwords:  &fakePasswordHasher{},
		},
		{
			name:       "wrong password",
			repository: &fakeRepository{credential: testCredentialAccount()},
			passwords:  &fakePasswordHasher{verifyOK: false},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := newTestService(
				t,
				test.repository,
				test.passwords,
				&fakeRefreshTokens{},
				testSessionID,
				testFamilyID,
			)
			_, err := service.Login(context.Background(), LoginCommand{
				Email:    "alice@example.com",
				Password: "wrong-password",
			})
			if got := apperror.CodeOf(err); got != "unauthenticated" {
				t.Fatalf("Login() code = %q, want unauthenticated; err=%v", got, err)
			}
			if test.repository.createSession.ID != "" {
				t.Fatalf("CreateSession() called for invalid credentials")
			}
			if test.name == "missing account" && test.passwords.dummyRaw != "wrong-password" {
				t.Fatalf("DummyVerify() raw = %q", test.passwords.dummyRaw)
			}
		})
	}
}

func TestLoginCreatesSessionAndReturnsTokens(t *testing.T) {
	repository := &fakeRepository{credential: testCredentialAccount()}
	passwords := &fakePasswordHasher{verifyOK: true}
	refreshTokens := &fakeRefreshTokens{}
	signer := &fakeSigner{}
	service, err := NewService(
		repository,
		passwords,
		refreshTokens,
		signer,
		&sequenceIDs{values: []string{testSessionID, testFamilyID}},
		fixedClock{now: testNow},
		Config{AccessTTL: 15 * time.Minute, RefreshTTL: 30 * 24 * time.Hour},
	)
	if err != nil {
		t.Fatal(err)
	}

	result, err := service.Login(context.Background(), LoginCommand{
		Email:    "ALICE@example.com",
		Password: "password-123",
	})
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	if repository.createAccountID != testAccountID ||
		repository.createSession.ID != testSessionID ||
		repository.createSession.FamilyID != testFamilyID {
		t.Fatalf(
			"CreateSession(account=%q, session=%#v)",
			repository.createAccountID,
			repository.createSession,
		)
	}
	if passwords.verifyHash != "stored-hash" || passwords.verifyRaw != "password-123" {
		t.Fatalf("Verify(hash=%q, raw=%q)", passwords.verifyHash, passwords.verifyRaw)
	}
	if result.Account.ID != testAccountID ||
		result.AccessToken == "" ||
		result.RefreshToken == "" {
		t.Fatalf("Login() result = %#v", result)
	}
}

func TestRefreshRotatesSingleUseToken(t *testing.T) {
	oldDigest := sha256.Sum256([]byte("old-refresh"))
	repository := &fakeRepository{
		rotationResult: accountauthport.RotationResult{
			Status:  accountauthport.RotationSucceeded,
			Account: testCredentialAccount().Account,
		},
	}
	refreshTokens := &fakeRefreshTokens{
		routes: map[string]accountauthport.RefreshTokenRoute{
			"old-refresh": {
				AccountID: testAccountID,
				SessionID: testSessionID,
				Digest:    oldDigest,
			},
		},
	}
	service := newTestService(
		t,
		repository,
		&fakePasswordHasher{},
		refreshTokens,
		testNextID,
	)

	result, err := service.Refresh(context.Background(), "old-refresh")
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if repository.rotationInput.AccountID != testAccountID ||
		repository.rotationInput.SessionID != testSessionID ||
		repository.rotationInput.Next.ID != testNextID ||
		repository.rotationInput.PresentedDigest != oldDigest {
		t.Fatalf("RotateSession() input = %#v", repository.rotationInput)
	}
	if result.RefreshToken != "refresh-"+testNextID ||
		result.AccessToken != "access-"+testNextID {
		t.Fatalf("Refresh() result = %#v", result)
	}
}

func TestRefreshRejectsInvalidAndReplayedTokens(t *testing.T) {
	tests := []struct {
		name       string
		rawToken   string
		tokens     *fakeRefreshTokens
		repository *fakeRepository
		wantCode   string
	}{
		{
			name:       "invalid format",
			rawToken:   "invalid",
			tokens:     &fakeRefreshTokens{},
			repository: &fakeRepository{},
			wantCode:   "unauthenticated",
		},
		{
			name:     "replayed",
			rawToken: "replayed",
			tokens: &fakeRefreshTokens{routes: map[string]accountauthport.RefreshTokenRoute{
				"replayed": {
					AccountID: testAccountID,
					SessionID: testSessionID,
				},
			}},
			repository: &fakeRepository{rotationResult: accountauthport.RotationResult{
				Status: accountauthport.RotationReplayed,
			}},
			wantCode: "session_revoked",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := newTestService(
				t,
				test.repository,
				&fakePasswordHasher{},
				test.tokens,
				testNextID,
			)
			_, err := service.Refresh(context.Background(), test.rawToken)
			if got := apperror.CodeOf(err); got != test.wantCode {
				t.Fatalf("Refresh() code = %q, want %q; err=%v", got, test.wantCode, err)
			}
		})
	}
}

func TestRefreshCompletesLocalSigningAfterCommittedRotation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	oldDigest := sha256.Sum256([]byte("old-refresh"))
	repository := &fakeRepository{
		rotationResult: accountauthport.RotationResult{
			Status:  accountauthport.RotationSucceeded,
			Account: testCredentialAccount().Account,
		},
		onRotate: cancel,
	}
	refreshTokens := &fakeRefreshTokens{
		routes: map[string]accountauthport.RefreshTokenRoute{
			"old-refresh": {
				AccountID: testAccountID,
				SessionID: testSessionID,
				Digest:    oldDigest,
			},
		},
	}
	signer := &fakeSigner{failCanceled: true}
	service, err := NewService(
		repository,
		&fakePasswordHasher{},
		refreshTokens,
		signer,
		&sequenceIDs{values: []string{testNextID}},
		fixedClock{now: testNow},
		Config{AccessTTL: 15 * time.Minute, RefreshTTL: 30 * 24 * time.Hour},
	)
	if err != nil {
		t.Fatal(err)
	}

	result, err := service.Refresh(ctx, "old-refresh")
	if err != nil {
		t.Fatalf("Refresh() error after commit = %v", err)
	}
	if result.AccessToken != "access-"+testNextID {
		t.Fatalf("Refresh() result = %#v", result)
	}
}

func TestLogoutRevokesCurrentSessionIdempotently(t *testing.T) {
	repository := &fakeRepository{}
	service := newTestService(
		t,
		repository,
		&fakePasswordHasher{},
		&fakeRefreshTokens{},
	)

	if err := service.Logout(context.Background(), testAccountID, testSessionID); err != nil {
		t.Fatalf("Logout() error = %v", err)
	}
	if repository.revokeAccountID != testAccountID ||
		repository.revokeSessionID != testSessionID ||
		!repository.revokeAt.Equal(testNow) {
		t.Fatalf(
			"RevokeSession(account=%q, session=%q, at=%v)",
			repository.revokeAccountID,
			repository.revokeSessionID,
			repository.revokeAt,
		)
	}
}

func testCredentialAccount() accountauthport.CredentialAccount {
	return accountauthport.CredentialAccount{
		Account: accountauthport.Account{
			ID:           testAccountID,
			Email:        "alice@example.com",
			DisplayName:  "Alice",
			IMState:      "provisioning",
			TokenVersion: 1,
			Revision:     1,
		},
		PasswordHash: "stored-hash",
	}
}
