package platform

import (
	"context"
	"time"
)

type SendRegisterSMSInput struct {
	CountryCode  string
	PhoneNumber  string
	ClientIP     string
	Lang         string
	CaptchaAppID string
	Ticket       string
	Random       string
}

type RegisterShadowAccountInput struct {
	ClientUA        string
	ClientIP        string
	CountryName     string
	CountryCode     string
	RegisterType    string
	Lang            string
	Area            uint64
	AccessLevel     uint64
	PhoneNumber     string
	PhoneVerifyCode string
	UserName        string
	Password        string
}

type RegisterShadowAccountResult struct {
	Uin         int64
	Key         string
	ExpiredTime time.Time
	RequestID   string
}

type SaaSTokenResult struct {
	Uin         int64
	OwnerUin    int64
	Token       string
	ExpiredTime time.Time
	RequestID   string
}

type TemporaryCredentials struct {
	Token        string
	TmpSecretID  string
	TmpSecretKey string
	ExpiredTime  time.Time
	RequestID    string
}

type SaveBasicAuthInput struct {
	AccountType int64
	Name        string
	IDCard      string
	Creds       TemporaryCredentials
}

type AuthenticateUserInput struct {
	AuthUin           int64
	Name              string
	Type              int64
	Area              int64
	Checker           string
	CheckType         string
	Addr              string
	IdcardType        int64
	Idcard            string
	Contact           string
	Province          string
	City              string
	District          string
	CreditCode        string
	OrgCode           string
	LegalPersonIdcard string
}

type DescribeBasicAuthResult struct {
	AccountOwnerUin int64
	AccountType     int64
	Name            string
	Mobile          string
	CountryCode     string
	IDCard          string
}

type UpdatePhoneInput struct {
	OldPhoneCountryCode string
	OldPhoneNumber      string
	NewPhoneCountryCode string
	NewPhoneNumber      string
	AuthCode            string
	VerifyCode          string
}

type CloudProvider interface {
	SendRegisterSMS(ctx context.Context, in SendRegisterSMSInput) error
	RegisterShadowAccount(ctx context.Context, in RegisterShadowAccountInput) (RegisterShadowAccountResult, error)
	GetAppIDByUin(ctx context.Context, uin int64) (int64, error)
	GetSaaSTokenByAuthCode(ctx context.Context, authCode, clientIP, clientUA string) (SaaSTokenResult, error)
	GetSaaSAccessToken(ctx context.Context, token SaaSTokenResult, clientIP, clientUA string) (TemporaryCredentials, error)
	SaveBasicAuth(ctx context.Context, in SaveBasicAuthInput) error
	AuthenticateUser(ctx context.Context, in AuthenticateUserInput) error
	DescribeBasicAuth(ctx context.Context) (DescribeBasicAuthResult, error)
	UpdatePhone(ctx context.Context, in UpdatePhoneInput) error
}
