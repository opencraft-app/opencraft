package shadow_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"shadow/internal/billing"
	"shadow/internal/platform"
	"shadow/internal/shadow"
	"shadow/internal/storage"
	storagesqlite "shadow/internal/storage/sqlite"
)

const (
	testUserID50 = "usr_00000000-0000-4000-8000-000000000050"
	testUserID51 = "usr_00000000-0000-4000-8000-000000000051"
	testUserID53 = "usr_00000000-0000-4000-8000-000000000053"
)

func TestCheckSaaSAccountExist_RequiresExistingUser(t *testing.T) {
	store := newServiceSQLiteStore(t)
	user, _, err := store.EnsureUser(context.Background(), testUserID50, "+86", "13800000050")
	if err != nil {
		t.Fatalf("ensure user: %v", err)
	}
	svc := shadow.NewService(store, platform.NewFakeCloudProvider(), billing.NewFakeProvider(), 10*time.Minute, "shadow_test")

	exists, err := svc.CheckSaaSAccountExist(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("check account exist: %v", err)
	}
	if !exists {
		t.Fatalf("expected existing saas user to be valid")
	}
}

func TestUpdatePhone_RollsBackLocalPhoneWhenCloudUpdateFails(t *testing.T) {
	store := newServiceSQLiteStore(t)
	user, _, err := store.EnsureUser(context.Background(), testUserID51, "+86", "13800000051")
	if err != nil {
		t.Fatalf("ensure user: %v", err)
	}
	if err := store.MarkShadowAccountRegistered(context.Background(), user.ID); err != nil {
		t.Fatalf("mark registered: %v", err)
	}
	if err := store.SaveBinding(context.Background(), storage.Binding{
		UserID:         user.ID,
		ShadowUserName: user.ID,
		Uin:            300000000051,
		OwnerUin:       300000000051,
		AppID:          1000000051,
		InstanceID:     "ins-51",
		CountryCode:    "+86",
		PhoneNumber:    "13800000051",
		CreatedAt:      time.Now().UTC(),
	}); err != nil {
		t.Fatalf("save binding: %v", err)
	}
	if err := store.SaveAppPhoneBinding(context.Background(), 1000000051, "+86", "13800000051"); err != nil {
		t.Fatalf("save app phone binding: %v", err)
	}

	cloud := &phoneUpdateCloudProvider{updatePhoneErr: errors.New("cloud update failed")}
	svc := shadow.NewService(store, cloud, billing.NewFakeProvider(), 10*time.Minute, "shadow_test")

	err = svc.UpdatePhone(context.Background(), shadow.UpdatePhoneInput{
		UserID:              user.ID,
		NewPhoneCountryCode: "+86",
		NewPhoneNumber:      "13800000052",
		VerifyCode:          "123456",
	})
	if err == nil {
		t.Fatalf("expected update phone to fail")
	}

	gotUser, err := store.GetUserByID(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if gotUser.PhoneNumber != "13800000051" {
		t.Fatalf("expected phone rollback, got=%s", gotUser.PhoneNumber)
	}
	gotBinding, err := store.GetBindingByUserID(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("get binding: %v", err)
	}
	if gotBinding.PhoneNumber != "13800000051" {
		t.Fatalf("expected binding phone rollback, got=%s", gotBinding.PhoneNumber)
	}
}

func TestRegisterFreeTrial_UsesShadowUserNameForTencentRegistration(t *testing.T) {
	store := newServiceSQLiteStore(t)
	cloud := &registerCloudProvider{}
	svc := shadow.NewService(store, cloud, billing.NewFakeProvider(), 10*time.Minute, "shadow_test")

	out, err := svc.RegisterFreeTrial(context.Background(), shadow.RegisterFreeTrialInput{
		UserID:          testUserID53,
		CountryCode:     "86",
		PhoneNumber:     "13800000053",
		PhoneVerifyCode: "123456",
		OrgName:         "shadow-demo",
		ClientIP:        "127.0.0.1",
		ClientUA:        "go-test",
	})
	if err != nil {
		t.Fatalf("register free trial: %v", err)
	}

	if cloud.registerInput.UserName != out.UserID {
		t.Fatalf("unexpected register username=%s want=%s", cloud.registerInput.UserName, out.UserID)
	}
}

func newServiceSQLiteStore(t *testing.T) storage.Store {
	t.Helper()
	store, err := storagesqlite.NewStore(filepath.Join(t.TempDir(), "shadow.db"))
	if err != nil {
		t.Fatalf("new sqlite store: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Fatalf("close sqlite store: %v", err)
		}
	})
	return store
}

type phoneUpdateCloudProvider struct {
	updatePhoneErr error
}

type registerCloudProvider struct {
	registerInput platform.RegisterShadowAccountInput
}

func (p *phoneUpdateCloudProvider) SendRegisterSMS(context.Context, platform.SendRegisterSMSInput) error {
	return nil
}

func (p *phoneUpdateCloudProvider) RegisterShadowAccount(context.Context, platform.RegisterShadowAccountInput) (platform.RegisterShadowAccountResult, error) {
	return platform.RegisterShadowAccountResult{}, nil
}

func (p *registerCloudProvider) SendRegisterSMS(context.Context, platform.SendRegisterSMSInput) error {
	return nil
}

func (p *registerCloudProvider) RegisterShadowAccount(_ context.Context, in platform.RegisterShadowAccountInput) (platform.RegisterShadowAccountResult, error) {
	p.registerInput = in
	return platform.RegisterShadowAccountResult{Uin: 300000000053}, nil
}

func (p *registerCloudProvider) GetAppIDByUin(context.Context, int64) (int64, error) {
	return 1000000053, nil
}

func (p *registerCloudProvider) GetSaaSTokenByAuthCode(context.Context, string, string, string) (platform.SaaSTokenResult, error) {
	return platform.SaaSTokenResult{
		Uin:      300000000053,
		OwnerUin: 300000000053,
		Token:    "saas-token",
	}, nil
}

func (p *registerCloudProvider) GetSaaSAccessToken(context.Context, platform.SaaSTokenResult, string, string) (platform.TemporaryCredentials, error) {
	return platform.TemporaryCredentials{
		Token:        "tmp-token",
		TmpSecretID:  "tmp-secret-id",
		TmpSecretKey: "tmp-secret-key",
	}, nil
}

func (p *registerCloudProvider) SaveBasicAuth(context.Context, platform.SaveBasicAuthInput) error {
	return nil
}

func (p *registerCloudProvider) AuthenticateUser(context.Context, platform.AuthenticateUserInput) error {
	return nil
}

func (p *registerCloudProvider) DescribeBasicAuth(context.Context) (platform.DescribeBasicAuthResult, error) {
	return platform.DescribeBasicAuthResult{}, nil
}

func (p *registerCloudProvider) UpdatePhone(context.Context, platform.UpdatePhoneInput) error {
	return nil
}

func (p *phoneUpdateCloudProvider) GetAppIDByUin(context.Context, int64) (int64, error) {
	return 1000000051, nil
}

func (p *phoneUpdateCloudProvider) GetSaaSTokenByAuthCode(context.Context, string, string, string) (platform.SaaSTokenResult, error) {
	return platform.SaaSTokenResult{
		Uin:      300000000051,
		OwnerUin: 300000000051,
		Token:    "saas-token",
	}, nil
}

func (p *phoneUpdateCloudProvider) GetSaaSAccessToken(context.Context, platform.SaaSTokenResult, string, string) (platform.TemporaryCredentials, error) {
	return platform.TemporaryCredentials{}, nil
}

func (p *phoneUpdateCloudProvider) SaveBasicAuth(context.Context, platform.SaveBasicAuthInput) error {
	return nil
}

func (p *phoneUpdateCloudProvider) AuthenticateUser(context.Context, platform.AuthenticateUserInput) error {
	return nil
}

func (p *phoneUpdateCloudProvider) DescribeBasicAuth(context.Context) (platform.DescribeBasicAuthResult, error) {
	return platform.DescribeBasicAuthResult{}, nil
}

func (p *phoneUpdateCloudProvider) UpdatePhone(context.Context, platform.UpdatePhoneInput) error {
	return p.updatePhoneErr
}
