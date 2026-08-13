package shadowbinding

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type recordingClient struct {
	calls                  int
	smsCalls               int
	updateCalls            int
	basicAuthCalls         int
	temporaryCalls         int
	lastRegister           CloudRegisterInput
	lastUpdate             CloudUpdatePhoneInput
	lastBasicAuth          CloudSaveBasicAuthInput
	lastTemporary          CloudTemporaryCredentialsInput
	result                 CloudRegisterResult
	temporaryResult        CloudTemporaryCredentials
	err                    error
	updateErr              error
	basicAuthErr           error
	temporaryCredentialErr error
}

type recordingBillingClient struct {
	calls   int
	lastUin int64
	result  BillingAccountResult
	results []BillingAccountResult
	err     error
}

func (c *recordingBillingClient) EnsureBillingAccount(_ context.Context, uin int64) (BillingAccountResult, error) {
	c.calls++
	c.lastUin = uin
	if len(c.results) > 0 {
		result := c.results[0]
		c.results = c.results[1:]
		return result, c.err
	}
	return c.result, c.err
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

func (c *recordingClient) GetTemporaryCredentialsForSaaS(_ context.Context, in CloudTemporaryCredentialsInput) (CloudTemporaryCredentials, error) {
	c.temporaryCalls++
	c.lastTemporary = in
	return c.temporaryResult, c.temporaryCredentialErr
}

func TestIssueTemporaryCredentialsUsesActiveBinding(t *testing.T) {
	now := time.Date(2026, 8, 13, 3, 0, 0, 0, time.UTC)
	client := &recordingClient{
		result: CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000},
		temporaryResult: CloudTemporaryCredentials{
			Uin:          300000000053,
			OwnerUin:     300000000053,
			Token:        "tmp-token",
			TmpSecretID:  "tmp-id",
			TmpSecretKey: "tmp-key",
			ExpiredTime:  now.Add(time.Hour),
			RequestID:    "sts-request-id",
		},
	}
	svc := New(NewMemoryStore(), client, Options{
		Enabled:        true,
		Now:            func() time.Time { return now },
		AuthCodePrefix: "krsbx",
	})
	if _, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}

	got, err := svc.IssueTemporaryCredentials(context.Background(), "usr_1", "10.0.0.1", "lightvela-trade")
	if err != nil {
		t.Fatalf("IssueTemporaryCredentials: %v", err)
	}
	if client.temporaryCalls != 1 {
		t.Fatalf("temporary credential calls = %d, want 1", client.temporaryCalls)
	}
	if !strings.HasPrefix(client.lastTemporary.AuthCode, "krsbx.") {
		t.Fatalf("auth code = %q, want krsbx prefix", client.lastTemporary.AuthCode)
	}
	if client.lastTemporary.ClientIP != "10.0.0.1" || client.lastTemporary.ClientUA != "lightvela-trade" {
		t.Fatalf("unexpected client metadata: %+v", client.lastTemporary)
	}
	if got.TmpSecretID != "tmp-id" || got.TmpSecretKey != "tmp-key" || got.Token != "tmp-token" {
		t.Fatalf("unexpected temporary credentials: %+v", got)
	}
}

func TestIssueTemporaryCredentialsRejectsBindingUINMismatch(t *testing.T) {
	client := &recordingClient{
		result: CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000},
		temporaryResult: CloudTemporaryCredentials{
			Uin:          300000000054,
			OwnerUin:     300000000054,
			Token:        "tmp-token",
			TmpSecretID:  "tmp-id",
			TmpSecretKey: "tmp-key",
		},
	}
	svc := New(NewMemoryStore(), client, Options{Enabled: true})
	if _, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}

	_, err := svc.IssueTemporaryCredentials(context.Background(), "usr_1", "", "lightvela-trade")
	if err == nil || !strings.Contains(err.Error(), "uin mismatch") {
		t.Fatalf("IssueTemporaryCredentials error = %v, want uin mismatch", err)
	}
	if strings.Contains(err.Error(), "tmp-token") || strings.Contains(err.Error(), "tmp-key") {
		t.Fatalf("error leaked temporary credentials: %v", err)
	}
}

func TestIssueTemporaryCredentialsRejectsIncompleteCredentials(t *testing.T) {
	client := &recordingClient{
		result: CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000},
		temporaryResult: CloudTemporaryCredentials{
			Uin:      300000000053,
			OwnerUin: 300000000053,
			Token:    "tmp-token",
		},
	}
	svc := New(NewMemoryStore(), client, Options{Enabled: true})
	if _, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}

	_, err := svc.IssueTemporaryCredentials(context.Background(), "usr_1", "", "lightvela-trade")
	if err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("IssueTemporaryCredentials error = %v, want incomplete credentials", err)
	}
}

func TestIssueTemporaryCredentialsRejectsExpiredCredentials(t *testing.T) {
	now := time.Date(2026, 8, 13, 3, 0, 0, 0, time.UTC)
	client := &recordingClient{
		result: CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000},
		temporaryResult: CloudTemporaryCredentials{
			Uin:          300000000053,
			OwnerUin:     300000000053,
			Token:        "tmp-token",
			TmpSecretID:  "tmp-id",
			TmpSecretKey: "tmp-key",
			ExpiredTime:  now.Add(-time.Minute),
		},
	}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, Now: func() time.Time { return now }})
	if _, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"}); err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}

	_, err := svc.IssueTemporaryCredentials(context.Background(), "usr_1", "", "lightvela-trade")
	if err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("IssueTemporaryCredentials error = %v, want expired credentials", err)
	}
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

func TestBindShadowAccountUsesConfiguredUserNamePrefix(t *testing.T) {
	client := &recordingClient{result: CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, UserNamePrefix: "bjsbx_"})

	binding, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_1", Phone: "13800138000"})
	if err != nil {
		t.Fatalf("bind shadow account: %v", err)
	}
	if got, want := binding.ShadowUserName, "bjsbx_u0825080737"; got != want {
		t.Fatalf("binding shadow username = %q, want %q", got, want)
	}
	if got, want := client.lastRegister.UserName, "bjsbx_u0825080737"; got != want {
		t.Fatalf("cloud register username = %q, want %q", got, want)
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

func TestBindShadowAccountOpensBillingBeforeActivatingIntlBinding(t *testing.T) {
	client := &recordingClient{result: CloudRegisterResult{Uin: 450860000002, OwnerUin: 450860000002, AppID: 1374210036}}
	billing := &recordingBillingClient{result: BillingAccountResult{IsOpen: true, RequestID: "billing-request-1"}}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, SiteKind: SiteKindIntl, BillingAccount: billing})

	binding, err := svc.BindShadowAccount(context.Background(), BindInput{
		UserID: "usr_intl",
		Email:  "verified@example.com",
	})
	if err != nil {
		t.Fatalf("bind international shadow account: %v", err)
	}
	if binding.Status != StatusActive || billing.calls != 1 || billing.lastUin != 450860000002 {
		t.Fatalf("expected billing-open active binding, binding=%+v billing=%+v", binding, billing)
	}
	if client.lastRegister.Email != "verified@example.com" {
		t.Fatalf("expected verified email forwarded to international registration, got %+v", client.lastRegister)
	}
}

func TestBindShadowAccountWaitsForAsyncBillingActivation(t *testing.T) {
	client := &recordingClient{result: CloudRegisterResult{Uin: 450860000002, OwnerUin: 450860000002, AppID: 1374210036}}
	billing := &recordingBillingClient{results: []BillingAccountResult{{IsOpen: false}, {IsOpen: true}}}
	svc := New(NewMemoryStore(), client, Options{
		Enabled:             true,
		SiteKind:            SiteKindIntl,
		BillingAccount:      billing,
		BillingOpenTimeout:  time.Second,
		BillingPollInterval: time.Millisecond,
	})

	binding, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err != nil {
		t.Fatalf("wait for billing activation: %v", err)
	}
	if binding.Status != StatusActive || billing.calls != 2 {
		t.Fatalf("expected active binding after billing propagation, binding=%+v calls=%d", binding, billing.calls)
	}
}

func TestBindShadowAccountRetriesBillingWithoutRegisteringAgain(t *testing.T) {
	client := &recordingClient{result: CloudRegisterResult{Uin: 450860000002, OwnerUin: 450860000002, AppID: 1374210036}}
	billing := &recordingBillingClient{err: errors.New("billing unavailable")}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, SiteKind: SiteKindIntl, BillingAccount: billing})

	failed, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err == nil {
		t.Fatal("expected billing failure")
	}
	if failed.Status != StatusFailed || failed.Uin != 450860000002 || failed.LastErrorCode != "billing_account_open_failed" {
		t.Fatalf("expected registered UIN retained for billing retry, got %+v", failed)
	}

	billing.err = nil
	billing.result = BillingAccountResult{IsOpen: true, RequestID: "billing-request-2"}
	active, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err != nil {
		t.Fatalf("retry billing account: %v", err)
	}
	if active.Status != StatusActive || client.calls != 1 || billing.calls != 2 {
		t.Fatalf("expected retry to skip registration, binding=%+v register_calls=%d billing_calls=%d", active, client.calls, billing.calls)
	}
}

func TestBindShadowAccountResumesRegisteredPendingBinding(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 8, 10, 1, 2, 3, 0, time.UTC)
	if _, err := store.SavePendingBinding(context.Background(), "usr_intl", "krsbx_u8674708900", now); err != nil {
		t.Fatalf("save pending binding: %v", err)
	}
	if _, err := store.MarkBindingRegistered(context.Background(), "usr_intl", 450860000002, 450860000002, 1374210036, now); err != nil {
		t.Fatalf("mark registered binding: %v", err)
	}
	client := &recordingClient{}
	billing := &recordingBillingClient{result: BillingAccountResult{IsOpen: true}}
	svc := New(store, client, Options{Enabled: true, SiteKind: SiteKindIntl, BillingAccount: billing})

	binding, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err != nil {
		t.Fatalf("resume registered pending binding: %v", err)
	}
	if binding.Status != StatusActive || client.calls != 0 || billing.calls != 1 {
		t.Fatalf("expected pending binding to resume at billing stage, binding=%+v register_calls=%d billing_calls=%d", binding, client.calls, billing.calls)
	}
}

func TestBindShadowAccountDoesNotReactivateDisabledIntlBinding(t *testing.T) {
	store := NewMemoryStore()
	now := time.Date(2026, 8, 10, 1, 2, 3, 0, time.UTC)
	if _, err := store.SavePendingBinding(context.Background(), "usr_intl", "krsbx_u8674708900", now); err != nil {
		t.Fatalf("save pending binding: %v", err)
	}
	if _, err := store.MarkBindingRegistered(context.Background(), "usr_intl", 450860000002, 450860000002, 1374210036, now); err != nil {
		t.Fatalf("mark registered binding: %v", err)
	}
	store.mu.Lock()
	disabled := store.bindings["usr_intl"]
	disabled.Status = StatusDisabled
	store.bindings["usr_intl"] = disabled
	store.mu.Unlock()
	billing := &recordingBillingClient{result: BillingAccountResult{IsOpen: true}}
	svc := New(store, &recordingClient{}, Options{Enabled: true, SiteKind: SiteKindIntl, BillingAccount: billing})

	binding, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err != nil {
		t.Fatalf("read disabled binding: %v", err)
	}
	if binding.Status != StatusDisabled || billing.calls != 0 {
		t.Fatalf("disabled binding must remain disabled, binding=%+v billing_calls=%d", binding, billing.calls)
	}
}

func TestSyncPhoneChangeUsesExistingActiveBinding(t *testing.T) {
	now := time.Date(2026, 6, 1, 1, 2, 3, 0, time.UTC)
	client := &recordingClient{result: CloudRegisterResult{Uin: 300000000053, OwnerUin: 300000000053, AppID: 1250000000}}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, Now: func() time.Time { return now }, AuthCodePrefix: "bjsbx"})

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
	const prefix = "bjsbx."
	if !strings.HasPrefix(client.lastUpdate.AuthCode, prefix) {
		t.Fatalf("expected outgoing auth code prefix %q, got %q", prefix, client.lastUpdate.AuthCode)
	}
	if _, err := svc.ConsumeAuthCode(context.Background(), strings.TrimPrefix(client.lastUpdate.AuthCode, prefix)); err != nil {
		t.Fatalf("expected raw auth code stored without routing prefix to be consumable: %v", err)
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
	svc := New(NewMemoryStore(), client, Options{Enabled: true, Now: func() time.Time { return now }, AuthCodePrefix: "shprod"})

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
	if !strings.HasPrefix(client.lastBasicAuth.AuthCode, "shprod.") {
		t.Fatalf("expected outgoing auth code prefix, got %q", client.lastBasicAuth.AuthCode)
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

func TestIssueExternalAuthCodeAddsRoutingPrefixWithoutChangingStoredCode(t *testing.T) {
	now := time.Date(2026, 6, 1, 1, 2, 3, 0, time.UTC)
	svc := New(NewMemoryStore(), nil, Options{
		Enabled:        true,
		Now:            func() time.Time { return now },
		AuthCodePrefix: ".bjsbx.",
	})

	code, err := svc.IssueExternalAuthCode(context.Background(), "usr_1", "")
	if err != nil {
		t.Fatalf("issue external auth code: %v", err)
	}
	if !strings.HasPrefix(code.Code, "bjsbx.") {
		t.Fatalf("expected external auth code to contain routing prefix, got %q", code.Code)
	}

	rawCode := strings.TrimPrefix(code.Code, "bjsbx.")
	consumed, err := svc.ConsumeAuthCode(context.Background(), rawCode)
	if err != nil {
		t.Fatalf("consume stored raw auth code: %v", err)
	}
	if consumed.UserID != "usr_1" {
		t.Fatalf("expected auth code for usr_1, got %+v", consumed)
	}
	if _, err := svc.ConsumeAuthCode(context.Background(), code.Code); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected prefixed transport code not to be stored directly, got %v", err)
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
