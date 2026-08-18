package shadowbinding

import (
	"context"
	"errors"
	"strings"
)

type UnavailableClient struct{ reason string }

func NewUnavailableClient(reason string) *UnavailableClient {
	return &UnavailableClient{reason: strings.TrimSpace(reason)}
}

func (*UnavailableClient) Available() bool { return false }

func (c *UnavailableClient) SendSMSVerifyCode(context.Context, CloudSendSMSInput) error {
	if c == nil || c.reason == "" {
		return errors.New("shadow binding client unavailable")
	}
	return errors.New(c.reason)
}

func (c *UnavailableClient) RegisterShadowAccount(context.Context, CloudRegisterInput) (CloudRegisterResult, error) {
	if c == nil || c.reason == "" {
		return CloudRegisterResult{}, errors.New("shadow binding client unavailable")
	}
	return CloudRegisterResult{}, errors.New(c.reason)
}

func (c *UnavailableClient) UpdatePhoneByAuthCode(context.Context, CloudUpdatePhoneInput) error {
	if c == nil || c.reason == "" {
		return errors.New("shadow binding client unavailable")
	}
	return errors.New(c.reason)
}

func (c *UnavailableClient) SaveBasicAuthForSaaS(context.Context, CloudSaveBasicAuthInput) error {
	if c == nil || c.reason == "" {
		return errors.New("shadow binding client unavailable")
	}
	return errors.New(c.reason)
}

func (c *UnavailableClient) GetTemporaryCredentialsForSaaS(context.Context, CloudTemporaryCredentialsInput) (CloudTemporaryCredentials, error) {
	if c == nil || c.reason == "" {
		return CloudTemporaryCredentials{}, errors.New("shadow binding client unavailable")
	}
	return CloudTemporaryCredentials{}, errors.New(c.reason)
}
