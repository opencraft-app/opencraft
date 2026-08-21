package shadowbinding

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	tcerr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
)

func noBillingWait(context.Context, time.Duration) error { return nil }

type asyncCapture struct{ tasks []func() }

func (a *asyncCapture) run(task func()) { a.tasks = append(a.tasks, task) }

func (a *asyncCapture) runNext(t *testing.T) {
	t.Helper()
	if len(a.tasks) == 0 {
		t.Fatal("expected an async billing task")
	}
	task := a.tasks[0]
	a.tasks = a.tasks[1:]
	task()
}

type recordingClient struct {
	calls                  int
	smsCalls               int
	updateCalls            int
	basicAuthCalls         int
	temporaryCalls         int
	accountInfoCalls       int
	recoveryCalls          int
	lastRegister           CloudRegisterInput
	lastUpdate             CloudUpdatePhoneInput
	lastBasicAuth          CloudSaveBasicAuthInput
	lastTemporary          CloudTemporaryCredentialsInput
	result                 CloudRegisterResult
	temporaryResult        CloudTemporaryCredentials
	accountInfoResult      CloudAccountInfo
	recoveryResult         CloudSaaSTokenResult
	err                    error
	updateErr              error
	basicAuthErr           error
	temporaryCredentialErr error
	recoveryErr            error
}

type recordingBillingClient struct {
	calls   int
	lastUin int64
	result  BillingAccountResult
	results []BillingAccountResult
	err     error
	errs    []error
}

func (c *recordingBillingClient) EnsureBillingAccount(_ context.Context, uin int64) (BillingAccountResult, error) {
	c.calls++
	c.lastUin = uin
	err := c.err
	if len(c.errs) > 0 {
		err = c.errs[0]
		c.errs = c.errs[1:]
	}
	if len(c.results) > 0 {
		result := c.results[0]
		c.results = c.results[1:]
		return result, err
	}
	return c.result, err
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

func (c *recordingClient) DescribeAccountInfo(_ context.Context, credentials CloudTemporaryCredentials) (CloudAccountInfo, error) {
	c.accountInfoCalls++
	result := c.accountInfoResult
	if reflect.DeepEqual(result, CloudAccountInfo{}) {
		result.LoginUin = credentials.Uin
		result.OwnerUin = credentials.OwnerUin
		result.AppID = c.result.AppID
		if result.AppID == 0 {
			result.AppID = 1374210036
		}
	}
	return result, nil
}

func (c *recordingClient) RecoverShadowIdentityForSaaS(_ context.Context, in CloudTemporaryCredentialsInput) (CloudSaaSTokenResult, error) {
	c.recoveryCalls++
	c.lastTemporary = in
	return c.recoveryResult, c.recoveryErr
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
	client := &recordingClient{result: CloudRegisterResult{Uin: 450860000002, OwnerUin: 450860000002}}
	billing := &recordingBillingClient{result: BillingAccountResult{IsOpen: true, RequestID: "billing-request-1"}}
	async := &asyncCapture{}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, SiteKind: SiteKindIntl, BillingAccount: billing, Wait: noBillingWait, RunAsync: async.run})

	binding, err := svc.BindShadowAccount(context.Background(), BindInput{
		UserID: "usr_intl",
		Email:  "verified@example.com",
	})
	if err != nil {
		t.Fatalf("bind international shadow account: %v", err)
	}
	if binding.Status != StatusPending || binding.AppID != 0 || billing.calls != 0 {
		t.Fatalf("registration should return pending before async billing, binding=%+v billing=%+v", binding, billing)
	}
	if client.lastRegister.Email != "verified@example.com" {
		t.Fatalf("expected verified email forwarded to international registration, got %+v", client.lastRegister)
	}
	async.runNext(t)
	active, err := svc.GetBindingByUserID(context.Background(), "usr_intl")
	if err != nil || active.Status != StatusActive || billing.calls != 1 || billing.lastUin != 450860000002 {
		t.Fatalf("expected async billing-open active binding, binding=%+v billing=%+v err=%v", active, billing, err)
	}
}

func TestEnsureBindingAppIDRepairsActiveInternationalBinding(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	if _, err := store.SavePendingBinding(context.Background(), "usr_intl", "sgprod_u1", now); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkBindingActive(context.Background(), "usr_intl", 450850000004, 450850000004, 0, now); err != nil {
		t.Fatal(err)
	}
	client := &recordingClient{
		temporaryResult: CloudTemporaryCredentials{
			Uin: 450850000004, OwnerUin: 450850000004,
			TmpSecretID: "tmp-id", TmpSecretKey: "tmp-key", Token: "tmp-token", ExpiredTime: now.Add(time.Hour),
		},
		accountInfoResult: CloudAccountInfo{LoginUin: 450850000004, OwnerUin: 450850000004, AppID: 1471748557},
	}
	svc := New(store, client, Options{Enabled: true, SiteKind: SiteKindIntl, Now: func() time.Time { return now }})

	binding, err := svc.EnsureBindingAppID(context.Background(), "usr_intl", "192.0.2.1", "lightvela-trade")
	if err != nil {
		t.Fatalf("EnsureBindingAppID: %v", err)
	}
	if binding.AppID != 1471748557 || client.temporaryCalls != 1 || client.accountInfoCalls != 1 {
		t.Fatalf("unexpected repaired binding=%+v temporary_calls=%d account_info_calls=%d", binding, client.temporaryCalls, client.accountInfoCalls)
	}
}

func TestEnsureBindingAppIDRejectsMismatchedShadowIdentity(t *testing.T) {
	now := time.Date(2026, 8, 21, 10, 0, 0, 0, time.UTC)
	store := NewMemoryStore()
	_, _ = store.SavePendingBinding(context.Background(), "usr_intl", "sgprod_u1", now)
	_, _ = store.MarkBindingActive(context.Background(), "usr_intl", 450850000004, 450850000004, 0, now)
	client := &recordingClient{
		temporaryResult: CloudTemporaryCredentials{
			Uin: 450850000004, OwnerUin: 450850000004,
			TmpSecretID: "tmp-id", TmpSecretKey: "tmp-key", Token: "tmp-token", ExpiredTime: now.Add(time.Hour),
		},
		accountInfoResult: CloudAccountInfo{LoginUin: 450850000099, OwnerUin: 450850000099, AppID: 1471748557},
	}
	svc := New(store, client, Options{Enabled: true, SiteKind: SiteKindIntl, Now: func() time.Time { return now }})

	if _, err := svc.EnsureBindingAppID(context.Background(), "usr_intl", "", "lightvela-trade"); err == nil || !strings.Contains(err.Error(), "identity mismatch") {
		t.Fatalf("EnsureBindingAppID error = %v, want identity mismatch", err)
	}
	binding, _ := store.GetBindingByUserID(context.Background(), "usr_intl")
	if binding.AppID != 0 {
		t.Fatalf("mismatched AppID was persisted: %+v", binding)
	}
}

func TestBindShadowAccountWaitsForAsyncBillingActivation(t *testing.T) {
	client := &recordingClient{result: CloudRegisterResult{Uin: 450860000002, OwnerUin: 450860000002, AppID: 1374210036}}
	billing := &recordingBillingClient{results: []BillingAccountResult{{IsOpen: false}, {IsOpen: false}, {IsOpen: true}}}
	var waits []time.Duration
	async := &asyncCapture{}
	svc := New(NewMemoryStore(), client, Options{
		Enabled:             true,
		SiteKind:            SiteKindIntl,
		BillingAccount:      billing,
		BillingInitialDelay: 10 * time.Second,
		BillingOpenTimeout:  time.Minute,
		BillingPollInterval: time.Second,
		Wait: func(_ context.Context, delay time.Duration) error {
			waits = append(waits, delay)
			return nil
		},
		RunAsync: async.run,
	})

	binding, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err != nil {
		t.Fatalf("wait for billing activation: %v", err)
	}
	if binding.Status != StatusPending || billing.calls != 0 || len(waits) != 0 {
		t.Fatalf("registration did not return before billing task: binding=%+v calls=%d waits=%v", binding, billing.calls, waits)
	}
	async.runNext(t)
	active, err := svc.GetBindingByUserID(context.Background(), "usr_intl")
	if err != nil || active.Status != StatusActive || billing.calls != 3 {
		t.Fatalf("expected active binding after billing propagation, binding=%+v calls=%d err=%v", active, billing.calls, err)
	}
	if want := []time.Duration{10 * time.Second, time.Second, 2 * time.Second}; !reflect.DeepEqual(waits, want) {
		t.Fatalf("billing waits = %v, want %v", waits, want)
	}
}

func TestBindShadowAccountRetriesBillingWhileUINBaseInfoPropagates(t *testing.T) {
	client := &recordingClient{result: CloudRegisterResult{Uin: 450860000003, OwnerUin: 450860000003}}
	baseInfoPending := func() error {
		return tcerr.NewTencentCloudSDKError(
			"FailedOperation.UinNeedBaseInfo",
			"failed to query mdmId",
			"billing-request-id",
		)
	}
	billing := &recordingBillingClient{
		results: []BillingAccountResult{{}, {}, {}, {}, {IsOpen: true}},
		errs:    []error{baseInfoPending(), baseInfoPending(), baseInfoPending(), baseInfoPending(), nil},
	}
	var waits []time.Duration
	async := &asyncCapture{}
	svc := New(NewMemoryStore(), client, Options{
		Enabled:             true,
		SiteKind:            SiteKindIntl,
		BillingAccount:      billing,
		BillingInitialDelay: 10 * time.Second,
		BillingOpenTimeout:  30 * time.Second,
		BillingPollInterval: time.Second,
		Wait: func(_ context.Context, delay time.Duration) error {
			waits = append(waits, delay)
			return nil
		},
		RunAsync: async.run,
	})

	pending, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err != nil || pending.Status != StatusPending {
		t.Fatalf("registration should return pending: binding=%+v err=%v", pending, err)
	}
	async.runNext(t)

	active, err := svc.GetBindingByUserID(context.Background(), "usr_intl")
	if err != nil || active.Status != StatusActive || billing.calls != 5 {
		t.Fatalf("expected active binding after base info propagation, binding=%+v calls=%d err=%v", active, billing.calls, err)
	}
	if want := []time.Duration{10 * time.Second, time.Second, 2 * time.Second, 3 * time.Second, 4 * time.Second}; !reflect.DeepEqual(waits, want) {
		t.Fatalf("billing waits = %v, want %v", waits, want)
	}
}

func TestBindShadowAccountRetriesBillingWithoutRegisteringAgain(t *testing.T) {
	client := &recordingClient{result: CloudRegisterResult{Uin: 450860000002, OwnerUin: 450860000002}}
	billing := &recordingBillingClient{err: errors.New("billing unavailable")}
	var waits []time.Duration
	async := &asyncCapture{}
	svc := New(NewMemoryStore(), client, Options{
		Enabled:             true,
		SiteKind:            SiteKindIntl,
		BillingAccount:      billing,
		BillingInitialDelay: 10 * time.Second,
		Wait: func(_ context.Context, delay time.Duration) error {
			waits = append(waits, delay)
			return nil
		},
		RunAsync: async.run,
	})

	pending, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err != nil || pending.Status != StatusPending {
		t.Fatalf("registration should return pending: binding=%+v err=%v", pending, err)
	}
	async.runNext(t)
	failed, err := svc.GetBindingByUserID(context.Background(), "usr_intl")
	if failed.Status != StatusFailed || failed.Uin != 450860000002 || failed.LastErrorCode != "billing_account_open_failed" {
		t.Fatalf("expected registered UIN retained for billing retry, got %+v err=%v", failed, err)
	}
	if want := []time.Duration{10 * time.Second}; !reflect.DeepEqual(waits, want) {
		t.Fatalf("initial billing waits = %v, want %v", waits, want)
	}

	billing.err = nil
	billing.result = BillingAccountResult{IsOpen: true, RequestID: "billing-request-2"}
	waits = nil
	active, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err != nil {
		t.Fatalf("retry billing account: %v", err)
	}
	if active.Status != StatusActive || client.calls != 1 || billing.calls != 2 {
		t.Fatalf("expected retry to skip registration, binding=%+v register_calls=%d billing_calls=%d", active, client.calls, billing.calls)
	}
	if len(waits) != 0 {
		t.Fatalf("billing retry repeated initial wait: %v", waits)
	}
}

func TestRetryBillingAccountOpeningRetriesOnlyBillingOpenFailure(t *testing.T) {
	client := &recordingClient{result: CloudRegisterResult{Uin: 450860000002, OwnerUin: 450860000002}}
	billing := &recordingBillingClient{err: errors.New("billing unavailable")}
	async := &asyncCapture{}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, SiteKind: SiteKindIntl, BillingAccount: billing, Wait: noBillingWait, RunAsync: async.run})

	pending, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err != nil || pending.Status != StatusPending {
		t.Fatalf("registration should return pending: binding=%+v err=%v", pending, err)
	}
	async.runNext(t)
	failed, err := svc.GetBindingByUserID(context.Background(), "usr_intl")
	if err != nil || failed.LastErrorCode != "billing_account_open_failed" {
		t.Fatalf("expected async billing-open failure, binding=%+v err=%v", failed, err)
	}
	billing.err = nil
	billing.result = BillingAccountResult{IsOpen: true, RequestID: "billing-request-retry"}

	active, err := svc.RetryBillingAccountOpening(context.Background(), "usr_intl")
	if err != nil {
		t.Fatalf("retry billing account opening: %v", err)
	}
	if active.Status != StatusActive || billing.calls != 2 || client.calls != 1 {
		t.Fatalf("expected billing-only retry, binding=%+v billing_calls=%d register_calls=%d", active, billing.calls, client.calls)
	}
}

func TestBindIntlRecoversRegisteredShadowUINAfterUncertainRegisterFailure(t *testing.T) {
	client := &recordingClient{
		err: errors.New("register response lost"),
		recoveryResult: CloudSaaSTokenResult{
			Uin:       450850000001,
			OwnerUin:  450850000001,
			RequestID: "saas-token-request-id",
		},
	}
	billing := &recordingBillingClient{result: BillingAccountResult{IsOpen: true, RequestID: "billing-request-id"}}
	async := &asyncCapture{}
	svc := New(NewMemoryStore(), client, Options{
		Enabled:        true,
		SiteKind:       SiteKindIntl,
		BillingAccount: billing,
		AuthCodePrefix: "jpsbx",
		Wait:           noBillingWait,
		RunAsync:       async.run,
	})

	binding, err := svc.BindShadowAccount(context.Background(), BindInput{
		UserID: "usr_intl",
		Email:  "verified@example.com",
	})
	if err != nil {
		t.Fatalf("recover registered shadow identity: %v", err)
	}
	if binding.Status != StatusPending || binding.Uin != 450850000001 || binding.OwnerUin != 450850000001 || binding.AppID != 0 {
		t.Fatalf("unexpected recovered binding: %+v", binding)
	}
	if client.calls != 1 || client.recoveryCalls != 1 || billing.calls != 0 {
		t.Fatalf("calls: register=%d recovery=%d billing=%d", client.calls, client.recoveryCalls, billing.calls)
	}
	if !strings.HasPrefix(client.lastTemporary.AuthCode, "jpsbx.") {
		t.Fatalf("recovery auth code = %q, want jpsbx prefix", client.lastTemporary.AuthCode)
	}
	async.runNext(t)
	active, err := svc.GetBindingByUserID(context.Background(), "usr_intl")
	if err != nil || active.Status != StatusActive || billing.calls != 1 {
		t.Fatalf("expected recovered binding to activate asynchronously: binding=%+v calls=%d err=%v", active, billing.calls, err)
	}
}

func TestBillingCardRequiredBindingCanIssueTemporaryCredentials(t *testing.T) {
	now := time.Date(2026, 8, 19, 4, 30, 0, 0, time.UTC)
	client := &recordingClient{
		result: CloudRegisterResult{Uin: 450850000001, OwnerUin: 450850000001},
		temporaryResult: CloudTemporaryCredentials{
			Uin:          450850000001,
			OwnerUin:     450850000001,
			TmpSecretID:  "tmp-id",
			TmpSecretKey: "tmp-key",
			Token:        "tmp-token",
			ExpiredTime:  now.Add(time.Hour),
		},
	}
	billing := &recordingBillingClient{err: tcerr.NewTencentCloudSDKError(
		"FailedOperation.UinNeedBindCard",
		"No default payment method",
		"billing-request-id",
	)}
	async := &asyncCapture{}
	svc := New(NewMemoryStore(), client, Options{
		Enabled:        true,
		SiteKind:       SiteKindIntl,
		BillingAccount: billing,
		Now:            func() time.Time { return now },
		Wait:           noBillingWait,
		RunAsync:       async.run,
	})

	pending, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err != nil || pending.Status != StatusPending {
		t.Fatalf("registration should return pending: binding=%+v err=%v", pending, err)
	}
	async.runNext(t)
	binding, err := svc.GetBindingByUserID(context.Background(), "usr_intl")
	if binding.Status != StatusFailed || binding.LastErrorCode != "billing_account_card_required" || binding.Uin != 450850000001 {
		t.Fatalf("unexpected card-required binding: %+v err=%v", binding, err)
	}
	if _, err := svc.IssueTemporaryCredentials(context.Background(), "usr_intl", "127.0.0.1", "payment-method"); err != nil {
		t.Fatalf("card-required binding should issue temporary credentials: %v", err)
	}
}

func TestRetryBillingAccountOpeningSkipsNonBillingFailure(t *testing.T) {
	client := &recordingClient{err: errors.New("register unavailable")}
	billing := &recordingBillingClient{result: BillingAccountResult{IsOpen: true}}
	svc := New(NewMemoryStore(), client, Options{Enabled: true, SiteKind: SiteKindIntl, BillingAccount: billing, Wait: noBillingWait})

	failed, err := svc.BindShadowAccount(context.Background(), BindInput{UserID: "usr_intl", Email: "verified@example.com"})
	if err == nil || failed.LastErrorCode != "tencentcloud_register_failed" {
		t.Fatalf("expected registration failure, binding=%+v err=%v", failed, err)
	}

	unchanged, err := svc.RetryBillingAccountOpening(context.Background(), "usr_intl")
	if err != nil {
		t.Fatalf("non-billing failure should be returned unchanged: %v", err)
	}
	if unchanged.LastErrorCode != "tencentcloud_register_failed" || billing.calls != 0 || client.calls != 1 {
		t.Fatalf("unexpected retry for non-billing failure, binding=%+v billing_calls=%d register_calls=%d", unchanged, billing.calls, client.calls)
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
	svc := New(store, client, Options{Enabled: true, SiteKind: SiteKindIntl, BillingAccount: billing, Wait: noBillingWait})

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
	svc := New(store, &recordingClient{}, Options{Enabled: true, SiteKind: SiteKindIntl, BillingAccount: billing, Wait: noBillingWait})

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
