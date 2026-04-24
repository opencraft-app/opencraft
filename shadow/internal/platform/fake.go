package platform

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"
)

type FakeCloudProvider struct {
	uinSeed atomic.Int64
}

func NewFakeCloudProvider() *FakeCloudProvider {
	p := &FakeCloudProvider{}
	p.uinSeed.Store(300000000000)
	return p
}

func (p *FakeCloudProvider) SendRegisterSMS(context.Context, SendRegisterSMSInput) error {
	return nil
}

func (p *FakeCloudProvider) RegisterShadowAccount(_ context.Context, _ RegisterShadowAccountInput) (RegisterShadowAccountResult, error) {
	uin := p.uinSeed.Add(1)
	return RegisterShadowAccountResult{
		Uin:         uin,
		Key:         fmt.Sprintf("key-%d", uin),
		ExpiredTime: time.Now().Add(time.Hour),
		RequestID:   fmt.Sprintf("req-register-%d", uin),
	}, nil
}

func (p *FakeCloudProvider) GetAppIDByUin(_ context.Context, uin int64) (int64, error) {
	return uin%100000000 + 1000000000, nil
}

func (p *FakeCloudProvider) GetSaaSTokenByAuthCode(_ context.Context, authCode, _ string, _ string) (SaaSTokenResult, error) {
	uin := p.uinSeed.Load()
	return SaaSTokenResult{
		Uin:         uin,
		OwnerUin:    uin,
		Token:       "saas-token-" + authCode,
		ExpiredTime: time.Now().Add(time.Hour),
		RequestID:   "req-cam-" + authCode,
	}, nil
}

func (p *FakeCloudProvider) GetSaaSAccessToken(_ context.Context, token SaaSTokenResult, _ string, _ string) (TemporaryCredentials, error) {
	return TemporaryCredentials{
		Token:        "tmp-token",
		TmpSecretID:  fmt.Sprintf("tmp-secret-id-%d", token.Uin),
		TmpSecretKey: fmt.Sprintf("tmp-secret-key-%d", token.Uin),
		ExpiredTime:  time.Now().Add(2 * time.Hour),
		RequestID:    "req-sts",
	}, nil
}

func (p *FakeCloudProvider) SaveBasicAuth(context.Context, SaveBasicAuthInput) error {
	return nil
}

func (p *FakeCloudProvider) AuthenticateUser(context.Context, AuthenticateUserInput) error {
	return nil
}

func (p *FakeCloudProvider) DescribeBasicAuth(context.Context) (DescribeBasicAuthResult, error) {
	return DescribeBasicAuthResult{}, nil
}

func (p *FakeCloudProvider) UpdatePhone(context.Context, UpdatePhoneInput) error {
	return nil
}
