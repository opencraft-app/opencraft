package shadowbinding

import (
	"context"
	"errors"
	"time"
)

const (
	SiteKindCN   = "cn"
	SiteKindIntl = "intl"

	StatusPending  = "pending"
	StatusActive   = "active"
	StatusFailed   = "failed"
	StatusDisabled = "disabled"

	BasicAuthStatusSucceeded = "succeeded"
	BasicAuthStatusFailed    = "failed"

	AuthCodePurposeSaaSCallback = "saas_callback"
)

var ErrNotFound = errors.New("shadow binding not found")

type Binding struct {
	UserID                    string
	ShadowUserName            string
	Uin                       int64
	OwnerUin                  int64
	AppID                     int64
	Status                    string
	LastErrorCode             string
	LastErrorMessage          string
	BasicAuthStatus           string
	BasicAuthSyncedAt         *time.Time
	BasicAuthSourceAttemptID  string
	BasicAuthIdentityHash     string
	BasicAuthPhoneHash        string
	BasicAuthLastErrorCode    string
	BasicAuthLastErrorMessage string
	CreatedAt                 time.Time
	UpdatedAt                 time.Time
}

type AuthCode struct {
	Code       string
	UserID     string
	Purpose    string
	ExpiresAt  time.Time
	ConsumedAt *time.Time
	CreatedAt  time.Time
}

type Store interface {
	SavePendingBinding(ctx context.Context, userID string, shadowUserName string, now time.Time) (Binding, error)
	GetBindingByUserID(ctx context.Context, userID string) (Binding, error)
	GetBindingByShadowUserName(ctx context.Context, shadowUserName string) (Binding, error)
	MarkBindingRegistered(ctx context.Context, userID string, uin, ownerUin, appID int64, now time.Time) (Binding, error)
	MarkBindingActive(ctx context.Context, userID string, uin, ownerUin, appID int64, now time.Time) (Binding, error)
	MarkBindingFailed(ctx context.Context, userID string, code string, message string, now time.Time) (Binding, error)
	MarkBasicAuthSucceeded(ctx context.Context, userID string, sourceAttemptID string, identityHash string, phoneHash string, now time.Time) (Binding, error)
	MarkBasicAuthFailed(ctx context.Context, userID string, code string, message string, now time.Time) (Binding, error)
	IssueAuthCode(ctx context.Context, userID string, purpose string, ttl time.Duration, now time.Time) (AuthCode, error)
	ConsumeAuthCode(ctx context.Context, code string, now time.Time) (AuthCode, error)
}

type BindInput struct {
	UserID     string
	Email      string
	Phone      string
	ClientIP   string
	ClientUA   string
	VerifyCode string
	Force      bool
}

type PhoneChangeInput struct {
	UserID     string
	OldPhone   string
	NewPhone   string
	ClientIP   string
	ClientUA   string
	VerifyCode string
}

type BasicAuthInput struct {
	UserID          string
	AccountType     int64
	Name            string
	IDCard          string
	ClientIP        string
	ClientUA        string
	SourceAttemptID string
	IdentityHash    string
	PhoneHash       string
}

type CloudRegisterInput struct {
	UserName   string
	Email      string
	Phone      string
	ClientIP   string
	ClientUA   string
	VerifyCode string
}

type CloudUpdatePhoneInput struct {
	OldPhoneCountryCode string
	OldPhoneNumber      string
	NewPhoneCountryCode string
	NewPhoneNumber      string
	AuthCode            string
	VerifyCode          string
}

type CloudSendSMSInput struct {
	CountryCode string
	Phone       string
	ClientIP    string
	Lang        string
}

type CloudSaveBasicAuthInput struct {
	AuthCode    string
	AccountType int64
	Name        string
	IDCard      string
	ClientIP    string
	ClientUA    string
}

type CloudSaaSTokenResult struct {
	Uin         int64
	OwnerUin    int64
	Token       string
	ExpiredTime time.Time
	RequestID   string
}

type CloudTemporaryCredentials struct {
	Uin          int64
	OwnerUin     int64
	Token        string
	TmpSecretID  string
	TmpSecretKey string
	ExpiredTime  time.Time
	RequestID    string
}

type CloudTemporaryCredentialsInput struct {
	AuthCode string
	ClientIP string
	ClientUA string
}

type CloudRegisterResult struct {
	Uin      int64
	OwnerUin int64
	AppID    int64
}

type BillingAccountResult struct {
	IsOpen    bool
	RequestID string
}

type BillingAccountClient interface {
	EnsureBillingAccount(ctx context.Context, uin int64) (BillingAccountResult, error)
}

type TencentCloudClient interface {
	SendSMSVerifyCode(ctx context.Context, in CloudSendSMSInput) error
	RegisterShadowAccount(ctx context.Context, in CloudRegisterInput) (CloudRegisterResult, error)
	UpdatePhoneByAuthCode(ctx context.Context, in CloudUpdatePhoneInput) error
	SaveBasicAuthForSaaS(ctx context.Context, in CloudSaveBasicAuthInput) error
}

type TemporaryCredentialsClient interface {
	GetTemporaryCredentialsForSaaS(ctx context.Context, in CloudTemporaryCredentialsInput) (CloudTemporaryCredentials, error)
}
