package service

import (
	"context"
	"time"
)

type StoreOptions struct {
	Now                 func() time.Time
	SeedDefaultInvites  bool
	SeedDemoUser        bool
	ContentAuditEnabled bool
}

type Store interface {
	ValidateInvite(ctx context.Context, code string) (InviteValidation, error)
	SendVerificationCode(ctx context.Context, phone string, code string, now time.Time, ttl time.Duration, cooldown time.Duration) (time.Duration, error)
	CompleteSMSVerification(ctx context.Context, input VerifySMSInput, now time.Time, sessionTTL time.Duration) (*AuthSession, error)
	CreatePasswordSession(ctx context.Context, input PasswordSignUpInput, passwordHash []byte, now time.Time, sessionTTL time.Duration) (*AuthSession, error)
	CreateOAuthSession(ctx context.Context, input OAuthSignInInput, now time.Time, sessionTTL time.Duration) (*AuthSession, error)
	ActivateInviteForCurrentUser(ctx context.Context, token string, code string, now time.Time) (User, error)
	BindOAuthSession(ctx context.Context, token string, input OAuthSignInInput, now time.Time, sessionTTL time.Duration) (*AuthSession, error)
	GetPasswordUser(ctx context.Context, email string) (User, []byte, error)
	CreateSession(ctx context.Context, user User, now time.Time, sessionTTL time.Duration) (*AuthSession, error)
	CreateImpersonationSession(ctx context.Context, user User, reason string, now time.Time, sessionTTL time.Duration) (*AuthSession, error)
	CurrentSession(ctx context.Context, token string, now time.Time) (*AuthSession, error)
	CurrentProfile(ctx context.Context, token string, now time.Time) (User, error)
	FindUserByID(ctx context.Context, userID string) (User, error)
	UpdateRealname(ctx context.Context, token string, input UpdateRealnameInput) error
	UpdateProfile(ctx context.Context, token string, name string, now time.Time) (User, error)
	QueueNameAudit(ctx context.Context, token string, input CreateNameAuditInput, now time.Time) (User, error)
	ListPendingContentAuditTasks(ctx context.Context, limit int) ([]ContentAuditTask, error)
	ListTimeoutContentAuditTasks(ctx context.Context, cutoff time.Time, limit int) ([]ContentAuditTask, error)
	FindContentAuditTaskByRequestID(ctx context.Context, requestID string) (*ContentAuditTask, error)
	MarkContentAuditTaskSubmitted(ctx context.Context, taskID int64, requestID string, now time.Time) error
	MarkContentAuditTaskPassed(ctx context.Context, taskID int64, requestID string, passSource string, now time.Time) error
	MarkContentAuditTaskFailed(ctx context.Context, taskID int64, requestID string, resultCode int, resultType int, resultDetail string, now time.Time) error
	MarkContentAuditTaskError(ctx context.Context, taskID int64, errMsg string, now time.Time) error
	SetUserAvatar(ctx context.Context, userID string, objectKey string, source string, now time.Time) (User, error)
	CurrentSubscription(ctx context.Context, token string, now time.Time) (*PlanSelection, error)
	UpdateSubscription(ctx context.Context, token string, tier string, now time.Time) (*PlanSelection, error)
	ConfirmFreePlan(ctx context.Context, token string, now time.Time) (*PlanSelection, error)
	DeleteSession(ctx context.Context, token string) error
	DeleteCurrentUser(ctx context.Context, token string, now time.Time) error
	DeleteAdminUser(ctx context.Context, userID string, now time.Time) error
	ListAdminUsers(ctx context.Context, search string, limit int) ([]AdminUser, error)
	ListAdminSMSChallenges(ctx context.Context, search string, limit int) ([]AdminSMSChallenge, error)
	DeleteAdminSMSChallenge(ctx context.Context, phone string) error
	ListAdminInvites(ctx context.Context, search string, state string, limit int) ([]AdminInvite, error)
	CreateAdminInvite(ctx context.Context, code string, message string, now time.Time) (*AdminInvite, error)
	DisableAdminInvite(ctx context.Context, code string, now time.Time) error
}

type CreateNameAuditInput struct {
	Name      string
	ProductID string
	SID       string
}

type ContentAuditTask struct {
	ID           int64
	BizType      string
	BizID        string
	BizDetail    string
	ProductID    string
	SID          string
	ContentText  string
	Status       string
	RequestID    string
	ResultCode   int
	ResultType   int
	ResultDetail string
	PassSource   string
	Attempts     int
	LastError    string
	SubmittedAt  *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}
