package shadowbinding

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type recordingClient struct {
	calls          int
	smsCalls       int
	updateCalls    int
	basicAuthCalls int
	lastRegister   CloudRegisterInput
	lastUpdate     CloudUpdatePhoneInput
	lastBasicAuth  CloudSaveBasicAuthInput
	result         CloudRegisterResult
	err            error
	updateErr      error
	basicAuthErr   error
}

func (c *recordingClient) SendSMSVerifyCode(context.Context, CloudSendSMSInput) error {
	c.smsCalls++
	if c.err != nil {
		return c.err
	}
	return nil
}

func (c *recordingClient) RegisterShadowAccount(_ context.Context, in CloudRegisterInput) (CloudRegisterResult, error) {
	c.calls++
	c.lastRegister = in
	if c.err != nil {
		return CloudRegisterResult{}, c.err
	}
	return c.result, nil
}

func (c *recordingClient) UpdatePhoneByAuthCode(_ context.Context, in CloudUpdatePhoneInput) error {
	c.updateCalls++
	c.lastUpdate = in
	return c.updateErr
}

func (c *recordingClient) SaveBasicAuthForSaaS(_ context.Context, in CloudSaveBasicAuthInput) error {
	c.basicAuthCalls++
	c.lastBasicAuth = in
	return c.basicAuthErr
}

func TestBindShadowAccountCreatesActiveBindingAndIsIdempotent(t *testing.T) {
	now := time.Date(2026, 6, 1, 1, 2, 3, 0, time.UTC)
	client := &recordingClient{result: CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, Now: func() time.Time { return now }})

	first, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"})
	if err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}
	if first.Status != StatusActive || first.Uin != 300000000053 || first.AppID != 1250000000 || first.ShadowUserName != "u0825080737" {
		t.Fatalf("unexpected active binding: %+v", first)
	}
	if client.lastRegister.UserName != "u0825080737" {
		t.Fatalf("expected cloud register to use Tencent-compatible username, got %+v", client.lastRegister)
	}
	found, err := svc.GetBindingByShadowUserName(context.Background(), "u0825080737")
	if err != nil || found.UserID != "usr_1" {
		t.Fatalf("expected binding to be queryable by shadow username, binding=%+v err=%v", found, err)
	}

	second, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"})
	if err != nil {
		t.Fatalf("second bind shadow account: %v", err)
	}
	if second.Status != StatusActive || client.calls != 1 {
		t.Fatalf("expected active idempotent binding and one cloud call, binding=%+v calls=%d", second, client.calls)
	}
}

func TestBindShadowAccountRecordsFailureAndAllowsRetry(t *testing.T) {
	now := time.Date(2026, 6, 1, 1, 2, 3, 0, time.UTC)
	client := &recordingClient{err: errors.New("register failed")}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, Now: func() time.Time { return now }})

	failed, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"})
	if err == nil {
		t.Fatal("expected register failure")
	}
	if failed.Status != StatusFailed || failed.LastErrorCode != "tencentcloud_register_failed" {
		t.Fatalf("unexpected failed binding: %+v", failed)
	}

	client.err = nil
	client.result = CloudRegisterResult{Uin: 300000000054, OwnerUin: 300000000054, AppID: 1250000001}
	active, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"})
	if err != nil {
		t.Fatalf("retry bind shadow account: %v", err)
	}
	if active.Status != StatusActive || active.Uin != 300000000054 {
		t.Fatalf("unexpected retried active binding: %+v", active)
	}
}

func TestSyncPhoneChangeUsesExistingActiveBinding(t *testing.T) {
	now := time.Date(2026, 6, 1, 1, 2, 3, 0, time.UTC)
	client := &recordingClient{result: CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, Now: func() time.Time { return now }})

	if _, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}
	binding, err := svc.SyncPhoneChange(context.Background(), PhoneChangeInput{
		UserID:     "usr_1",
		OldPhone:   "13800138000",
		NewPhone:   "13900139000",
		VerifyCode: "123456",
	})
	if err != nil {
		t.Fatalf("sync phone change: %v", err)
	}
	if binding.Status != StatusActive {
		t.Fatalf("expected active binding, got %+v", binding)
	}
	if client.calls != 1 || client.updateCalls != 1 {
		t.Fatalf("expected one register call and one update call, register=%d update=%d", client.calls, client.updateCalls)
	}
	if client.lastUpdate.OldPhoneNumber != "13800138000" || client.lastUpdate.NewPhoneNumber != "13900139000" || client.lastUpdate.VerifyCode != "123456" || client.lastUpdate.AuthCode == "" {
		t.Fatalf("unexpected update payload: %+v", client.lastUpdate)
	}
}

func TestSyncPhoneChangeFailureKeepsExistingBindingActive(t *testing.T) {
	now := time.Date(2026, 6, 1, 1, 2, 3, 0, time.UTC)
	client := &recordingClient{
		result:    CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000},
		updateErr: errors.New("update phone failed"),
	}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, Now: func() time.Time { return now }})

	if _, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}
	if _, err := svc.SyncPhoneChange(context.Background(), PhoneChangeInput{
		UserID:     "usr_1",
		OldPhone:   "13800138000",
		NewPhone:   "13900139000",
		VerifyCode: "123456",
	}); err == nil {
		t.Fatal("expected update phone failure")
	}
	binding, err := svc.GetBindingByUserID(context.Background(), "usr_1")
	if err != nil {
		t.Fatalf("get binding: %v", err)
	}
	if binding.Status != StatusActive || binding.Uin != 300000000053 || binding.LastErrorCode != "" {
		t.Fatalf("expected existing binding to remain active, got %+v", binding)
	}
}

func TestSyncPhoneChangeUpgradesSyntheticBindingByRegisteringShadowAccount(t *testing.T) {
	now := time.Date(2026, 6, 1, 1, 2, 3, 0, time.UTC)
	client := &recordingClient{result: CloudRegisterResult{Uin: 300000000099, OwnerUin: 300000000099, AppID: 1250000099}}
	store := NewMemoryStore()
	svc := New(store, client, Options{Enabled: true, Now: func() time.Time { return now }})

	if _, err := store.SavePendingBinding(context.Background(), "usr_1", "mock_usr_1", now); err != nil {
		t.Fatalf("save synthetic binding: %v", err)
	}
	if _, err := store.MarkBindingActive(context.Background(), "usr_1", 700000164995, 700000164995, 251202221, now); err != nil {
		t.Fatalf("mark synthetic binding active: %v", err)
	}

	binding, err := svc.SyncPhoneChange(context.Background(), PhoneChangeInput{
		UserID:     "usr_1",
		OldPhone:   "13800138000",
		NewPhone:   "13900139000",
		ClientIP:   "127.0.0.1",
		ClientUA:   "test-agent",
		VerifyCode: "654321",
	})
	if err != nil {
		t.Fatalf("sync synthetic phone change: %v", err)
	}
	if binding.Status != StatusActive || binding.Uin != 300000000099 || IsSyntheticBinding(binding) {
		t.Fatalf("expected synthetic binding to be replaced with real active binding, got %+v", binding)
	}
	if client.calls != 1 || client.updateCalls != 0 {
		t.Fatalf("expected one register call and no update call, register=%d update=%d", client.calls, client.updateCalls)
	}
	if client.lastRegister.Phone != "13900139000" || client.lastRegister.VerifyCode != "654321" || client.lastRegister.ClientIP != "127.0.0.1" || client.lastRegister.ClientUA != "test-agent" {
		t.Fatalf("unexpected register payload: %+v", client.lastRegister)
	}
	if client.lastRegister.UserName != "u0825080737" {
		t.Fatalf("expected cloud register to use Tencent-compatible username, got %+v", client.lastRegister)
	}
}

func TestSyncPhoneChangeKeepsSyntheticBindingRetryableWhenRegisterFails(t *testing.T) {
	now := time.Date(2026, 6, 1, 1, 2, 3, 0, time.UTC)
	client := &recordingClient{err: errors.New("verify code mismatch")}
	store := NewMemoryStore()
	svc := New(store, client, Options{Enabled: true, Now: func() time.Time { return now }})

	if _, err := store.SavePendingBinding(context.Background(), "usr_1", "mock_usr_1", now); err != nil {
		t.Fatalf("save synthetic binding: %v", err)
	}
	if _, err := store.MarkBindingActive(context.Background(), "usr_1", 700000164995, 700000164995, 251202221, now); err != nil {
		t.Fatalf("mark synthetic binding active: %v", err)
	}

	if _, err := svc.SyncPhoneChange(context.Background(), PhoneChangeInput{
		UserID:     "usr_1",
		NewPhone:   "13900139000",
		ClientIP:   "127.0.0.1",
		ClientUA:   "test-agent",
		VerifyCode: "bad-code",
	}); err == nil {
		t.Fatal("expected register failure")
	}
	binding, err := svc.GetBindingByUserID(context.Background(), "usr_1")
	if err != nil {
		t.Fatalf("get binding: %v", err)
	}
	if binding.Status != StatusActive || !IsSyntheticBinding(binding) || binding.LastErrorCode != "" {
		t.Fatalf("expected synthetic binding to stay retryable, got %+v", binding)
	}
	if client.calls != 1 || client.updateCalls != 0 {
		t.Fatalf("expected one register call and no update call, register=%d update=%d", client.calls, client.updateCalls)
	}
}

func TestSaveBasicAuthIssuesAuthCodeForActiveBinding(t *testing.T) {
	now := time.Date(2026, 6, 1, 1, 2, 3, 0, time.UTC)
	client := &recordingClient{result: CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, Now: func() time.Time { return now }})

	if _, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}
	if err := svc.SaveBasicAuth(context.Background(), BasicAuthInput{
		UserID:      "usr_1",
		AccountType: 0,
		Name:        "张三",
		IDCard:      "11010519491231002X",
		ClientIP:    "127.0.0.1",
		ClientUA:    "agent",
	}); err != nil {
		t.Fatalf("save basic auth: %v", err)
	}
	if client.basicAuthCalls != 1 {
		t.Fatalf("expected one basic auth call, got %d", client.basicAuthCalls)
	}
	if client.lastBasicAuth.AuthCode == "" || client.lastBasicAuth.Name != "张三" || client.lastBasicAuth.IDCard != "11010519491231002X" {
		t.Fatalf("unexpected basic auth input: %+v", client.lastBasicAuth)
	}
	if client.lastBasicAuth.ClientIP != "127.0.0.1" || client.lastBasicAuth.ClientUA != "agent" {
		t.Fatalf("expected client context to be forwarded, got %+v", client.lastBasicAuth)
	}
	binding, err := svc.GetBindingByUserID(context.Background(), "usr_1")
	if err != nil {
		t.Fatalf("get binding: %v", err)
	}
	if binding.BasicAuthStatus != BasicAuthStatusSucceeded || binding.BasicAuthSyncedAt == nil {
		t.Fatalf("expected successful basic auth status, got %+v", binding)
	}
}

func TestAuthCodeIsOneTimeAndExpires(t *testing.T) {
	now := time.Date(2026, 6, 1, 1, 2, 3, 0, time.UTC)
	current := now
	svc := New(NewMemoryStore(), nil, Options{Enabled: false, Now: func() time.Time { return current }, AuthCodeTTL: time.Minute})

	code, err := svc.IssueAuthCode(context.Background(), "usr_1", "")
	if err != nil {
		t.Fatalf("issue auth code: %v", err)
	}
	consumed, err := svc.ConsumeAuthCode(context.Background(), code.Code)
	if err != nil {
		t.Fatalf("consume auth code: %v", err)
	}
	if consumed.UserID != "usr_1" || consumed.Purpose != AuthCodePurposeSaaSCallback {
		t.Fatalf("unexpected consumed code: %+v", consumed)
	}
	if _, err := svc.ConsumeAuthCode(context.Background(), code.Code); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected replay to return ErrNotFound, got %v", err)
	}

	expiring, err := svc.IssueAuthCode(context.Background(), "usr_2", "")
	if err != nil {
		t.Fatalf("issue expiring auth code: %v", err)
	}
	current = now.Add(2 * time.Minute)
	if _, err := svc.ConsumeAuthCode(context.Background(), expiring.Code); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected expired code to return ErrNotFound, got %v", err)
	}
}

func TestShadowUserNameForUserUsesTencentSafeName(t *testing.T) {
	if got := shadowUserNameForUser("usr_aa8deff8dcbd814b27b37799"); got != "u6505083861" {
		t.Fatalf("unexpected safe shadow username: %q", got)
	}
	if got := shadowUserNameForUser("USER_With-Mixed.Symbols"); got != "u8071733073" {
		t.Fatalf("unexpected hashed shadow username: %q", got)
	}
	long := shadowUserNameForUser("usr_" + strings.Repeat("abcdef", 10))
	if len(long) != 11 || strings.Contains(long, "_") || !strings.HasPrefix(long, "u") {
		t.Fatalf("expected hashed safe username, got %q len=%d", long, len(long))
	}
}
