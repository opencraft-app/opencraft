package humanaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	"chatserver/internal/apperror"
	humanaccountport "chatserver/internal/ports/humanaccount"
	tencentimport "chatserver/internal/ports/tencentim"
)

const humanAccountID = "01989c24-7540-7f12-a27b-c83243215dd1"

var humanSessionExpiry = time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC)

type fakeHumanAccountRepository struct {
	account   humanaccountport.Account
	accountID string
	err       error
}

func (repository *fakeHumanAccountRepository) FindByID(
	_ context.Context,
	accountID string,
) (humanaccountport.Account, error) {
	repository.accountID = accountID
	return repository.account, repository.err
}

type fakeHumanUserSigIssuer struct {
	userID string
	ttl    time.Duration
	result tencentimport.UserSig
	err    error
}

func (issuer *fakeHumanUserSigIssuer) Issue(
	_ context.Context,
	userID string,
	ttl time.Duration,
) (tencentimport.UserSig, error) {
	issuer.userID = userID
	issuer.ttl = ttl
	return issuer.result, issuer.err
}

func TestGetReturnsCurrentAccountSnapshot(t *testing.T) {
	repository := &fakeHumanAccountRepository{account: readyHumanAccount()}
	service := newHumanAccountService(t, repository, &fakeHumanUserSigIssuer{})

	account, err := service.Get(context.Background(), humanAccountID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if repository.accountID != humanAccountID || account != repository.account {
		t.Fatalf("Get() = %#v", account)
	}
}

func TestCreateIMSessionSignsOnlyStoredReadyIdentity(t *testing.T) {
	repository := &fakeHumanAccountRepository{account: readyHumanAccount()}
	issuer := &fakeHumanUserSigIssuer{result: tencentimport.UserSig{
		Value:     "short-lived-user-sig",
		ExpiresAt: humanSessionExpiry,
	}}
	service := newHumanAccountService(t, repository, issuer)

	session, err := service.CreateIMSession(context.Background(), humanAccountID)
	if err != nil {
		t.Fatalf("CreateIMSession() error = %v", err)
	}
	if issuer.userID != "u_OPAQUE" || issuer.ttl != time.Hour {
		t.Fatalf("Issue(%q, %v)", issuer.userID, issuer.ttl)
	}
	if session.SDKAppID != 1600000000 ||
		session.UserID != "u_OPAQUE" ||
		session.UserSig != "short-lived-user-sig" ||
		!session.ExpiresAt.Equal(humanSessionExpiry) {
		t.Fatalf("session = %#v", session)
	}
}

func TestCreateIMSessionRejectsProvisioningOrMissingIdentity(t *testing.T) {
	tests := []humanaccountport.Account{
		{
			ID:      humanAccountID,
			IMState: "provisioning",
		},
		{
			ID:      humanAccountID,
			IMState: "ready",
		},
	}
	for _, account := range tests {
		repository := &fakeHumanAccountRepository{account: account}
		issuer := &fakeHumanUserSigIssuer{}
		service := newHumanAccountService(t, repository, issuer)

		_, err := service.CreateIMSession(context.Background(), humanAccountID)
		if got := apperror.CodeOf(err); got != "im_session_unavailable" {
			t.Fatalf("CreateIMSession(%#v) code = %q; err=%v", account, got, err)
		}
		if issuer.userID != "" {
			t.Fatal("unready account reached UserSig issuer")
		}
	}
}

func TestCreateIMSessionHidesIssuerFailure(t *testing.T) {
	repository := &fakeHumanAccountRepository{account: readyHumanAccount()}
	issuer := &fakeHumanUserSigIssuer{
		err: errors.New("secret signing implementation detail"),
	}
	service := newHumanAccountService(t, repository, issuer)

	_, err := service.CreateIMSession(context.Background(), humanAccountID)
	if got := apperror.CodeOf(err); got != "im_session_unavailable" {
		t.Fatalf("CreateIMSession() code = %q; err=%v", got, err)
	}
	if err == nil || err.Error() == issuer.err.Error() {
		t.Fatalf("CreateIMSession() leaked issuer error: %v", err)
	}
}

func newHumanAccountService(
	t *testing.T,
	repository *fakeHumanAccountRepository,
	issuer *fakeHumanUserSigIssuer,
) *Service {
	t.Helper()
	service, err := NewService(repository, issuer, Config{
		SDKAppID:   1600000000,
		UserSigTTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service
}

func readyHumanAccount() humanaccountport.Account {
	return humanaccountport.Account{
		ID:          humanAccountID,
		Email:       "alice@example.com",
		DisplayName: "爱丽丝",
		IMUserID:    "u_OPAQUE",
		IMState:     "ready",
		Revision:    2,
	}
}
