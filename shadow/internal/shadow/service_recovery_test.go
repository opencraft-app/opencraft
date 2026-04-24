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
	recoveryUserID30 = "usr_00000000-0000-4000-8000-000000000030"
	recoveryUserID31 = "usr_00000000-0000-4000-8000-000000000031"
)

func TestRegisterFreeTrial_RecoversAfterShadowAccountAlreadyRegistered(t *testing.T) {
	store := newSQLiteStore(t)
	cloud := &recoveryCloudProvider{failSaveBasicAuthOnce: true}
	bill := &recoveryBillingProvider{}
	svc := shadow.NewService(store, cloud, bill, 10*time.Minute, "shadow_test")

	input := shadow.RegisterFreeTrialInput{
		UserID:          recoveryUserID30,
		CountryCode:     "+86",
		PhoneNumber:     "13800000030",
		PhoneVerifyCode: "123456",
		OrgName:         "shadow-demo",
		ClientIP:        "127.0.0.1",
		ClientUA:        "recovery-test",
	}

	if _, err := svc.RegisterFreeTrial(context.Background(), input); err == nil {
		t.Fatalf("expected first register to fail")
	}

	if _, err := svc.RegisterFreeTrial(context.Background(), input); err != nil {
		t.Fatalf("second register failed: %v", err)
	}

	if cloud.registerCalls != 1 {
		t.Fatalf("expected register cloud call once, got %d", cloud.registerCalls)
	}
	if cloud.saveBasicAuthCalls != 2 {
		t.Fatalf("expected save basic auth calls twice, got %d", cloud.saveBasicAuthCalls)
	}
	if bill.calls != 1 {
		t.Fatalf("expected billing called once, got %d", bill.calls)
	}
}

func TestRegisterFreeTrial_ReusesOrderCheckpointAfterBindingFailure(t *testing.T) {
	baseStore := newSQLiteStore(t)
	store := &failSaveBindingStore{Store: baseStore, failOnce: true}
	cloud := &recoveryCloudProvider{}
	bill := &recoveryBillingProvider{}
	svc := shadow.NewService(store, cloud, bill, 10*time.Minute, "shadow_test")

	input := shadow.RegisterFreeTrialInput{
		UserID:          recoveryUserID31,
		CountryCode:     "+86",
		PhoneNumber:     "13800000031",
		PhoneVerifyCode: "123456",
		OrgName:         "shadow-demo",
		ClientIP:        "127.0.0.1",
		ClientUA:        "recovery-test",
	}

	if _, err := svc.RegisterFreeTrial(context.Background(), input); err == nil {
		t.Fatalf("expected first register to fail on binding save")
	}

	if _, err := svc.RegisterFreeTrial(context.Background(), input); err != nil {
		t.Fatalf("second register failed: %v", err)
	}

	if cloud.registerCalls != 1 {
		t.Fatalf("expected register cloud call once, got %d", cloud.registerCalls)
	}
	if cloud.saveBasicAuthCalls != 1 {
		t.Fatalf("expected save basic auth once, got %d", cloud.saveBasicAuthCalls)
	}
	if bill.calls != 1 {
		t.Fatalf("expected billing called once due to checkpoint reuse, got %d", bill.calls)
	}
}

func newSQLiteStore(t *testing.T) storage.Store {
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

type recoveryCloudProvider struct {
	registerCalls         int
	saveBasicAuthCalls    int
	failSaveBasicAuthOnce bool
	lastIssuedUIN         int64
}

func (p *recoveryCloudProvider) SendRegisterSMS(context.Context, platform.SendRegisterSMSInput) error {
	return nil
}

func (p *recoveryCloudProvider) RegisterShadowAccount(context.Context, platform.RegisterShadowAccountInput) (platform.RegisterShadowAccountResult, error) {
	p.registerCalls++
	p.lastIssuedUIN = 300000000001
	return platform.RegisterShadowAccountResult{
		Uin:         p.lastIssuedUIN,
		Key:         "key-1",
		ExpiredTime: time.Now().Add(time.Hour),
		RequestID:   "req-register",
	}, nil
}

func (p *recoveryCloudProvider) GetSaaSTokenByAuthCode(context.Context, string, string, string) (platform.SaaSTokenResult, error) {
	if p.lastIssuedUIN == 0 {
		p.lastIssuedUIN = 300000000001
	}
	return platform.SaaSTokenResult{
		Uin:         p.lastIssuedUIN,
		OwnerUin:    p.lastIssuedUIN,
		Token:       "saas-token",
		ExpiredTime: time.Now().Add(time.Hour),
		RequestID:   "req-cam",
	}, nil
}

func (p *recoveryCloudProvider) GetAppIDByUin(context.Context, int64) (int64, error) {
	return 1000000001, nil
}

func (p *recoveryCloudProvider) GetSaaSAccessToken(context.Context, platform.SaaSTokenResult, string, string) (platform.TemporaryCredentials, error) {
	return platform.TemporaryCredentials{
		Token:        "tmp-token",
		TmpSecretID:  "tmp-secret-id",
		TmpSecretKey: "tmp-secret-key",
		ExpiredTime:  time.Now().Add(time.Hour),
		RequestID:    "req-sts",
	}, nil
}

func (p *recoveryCloudProvider) SaveBasicAuth(context.Context, platform.SaveBasicAuthInput) error {
	p.saveBasicAuthCalls++
	if p.failSaveBasicAuthOnce {
		p.failSaveBasicAuthOnce = false
		return errors.New("save basic auth failed")
	}
	return nil
}

func (p *recoveryCloudProvider) AuthenticateUser(context.Context, platform.AuthenticateUserInput) error {
	return nil
}

func (p *recoveryCloudProvider) DescribeBasicAuth(context.Context) (platform.DescribeBasicAuthResult, error) {
	return platform.DescribeBasicAuthResult{}, nil
}

func (p *recoveryCloudProvider) UpdatePhone(context.Context, platform.UpdatePhoneInput) error {
	return nil
}

type recoveryBillingProvider struct {
	calls int
}

func (p *recoveryBillingProvider) CreateFreeTrialOrderAndPay(context.Context, billing.FreeTrialOrderInput) (billing.FreeTrialOrderResult, error) {
	p.calls++
	return billing.FreeTrialOrderResult{
		BigDealID:  "bigdeal-000001",
		DealName:   "deal-000001",
		InstanceID: "ins-000001",
	}, nil
}

type failSaveBindingStore struct {
	storage.Store
	failOnce bool
}

func (s *failSaveBindingStore) SaveBinding(ctx context.Context, binding storage.Binding) error {
	if s.failOnce {
		s.failOnce = false
		return errors.New("save binding failed")
	}
	return s.Store.SaveBinding(ctx, binding)
}
