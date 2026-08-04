// Package humanaccount 实现 /me 与 Human IM Session 用例。
package humanaccount

import (
	"context"
	"errors"
	"strings"
	"time"

	"chatserver/internal/apperror"
	humanaccountport "chatserver/internal/ports/humanaccount"
	tencentimport "chatserver/internal/ports/tencentim"

	"github.com/google/uuid"
)

// Config 配置 Human IM Session 的公开 SDKAppID 和短期 TTL。
type Config struct {
	SDKAppID   int
	UserSigTTL time.Duration
}

// IMSession 是只在一次 HTTP 响应中存在的短期 IM 登录信息。
type IMSession struct {
	SDKAppID  int
	UserID    string
	UserSig   string
	ExpiresAt time.Time
}

// Service 提供当前账号读取和短期 UserSig 编排。
type Service struct {
	repository humanaccountport.Repository
	issuer     tencentimport.UserSigIssuer
	config     Config
}

// NewService 创建 Human 账号应用服务。
func NewService(
	repository humanaccountport.Repository,
	issuer tencentimport.UserSigIssuer,
	config Config,
) (*Service, error) {
	if repository == nil || issuer == nil ||
		config.SDKAppID <= 0 || config.UserSigTTL <= 0 {
		return nil, errors.New("Human 账号服务配置无效")
	}
	return &Service{
		repository: repository,
		issuer:     issuer,
		config:     config,
	}, nil
}

// Get 返回当前认证账号的最新数据库快照。
func (service *Service) Get(
	ctx context.Context,
	accountID string,
) (humanaccountport.Account, error) {
	if !validAccountID(accountID) {
		return humanaccountport.Account{}, apperror.New(
			"unauthenticated",
			"登录凭证无效",
			nil,
		)
	}
	account, err := service.repository.FindByID(ctx, accountID)
	if errors.Is(err, humanaccountport.ErrNotFound) {
		return humanaccountport.Account{}, apperror.New(
			"session_revoked",
			"登录会话已失效",
			err,
		)
	}
	if err != nil {
		return humanaccountport.Account{}, apperror.New(
			"internal_error",
			"暂时无法读取账号",
			err,
		)
	}
	return account, nil
}

// CreateIMSession 只为当前账号已持久化且 ready 的 IM UserID 签发 UserSig。
func (service *Service) CreateIMSession(
	ctx context.Context,
	accountID string,
) (IMSession, error) {
	account, err := service.Get(ctx, accountID)
	if err != nil {
		return IMSession{}, err
	}
	if account.IMState != "ready" || strings.TrimSpace(account.IMUserID) == "" {
		return IMSession{}, apperror.New(
			"im_session_unavailable",
			"IM 身份尚未就绪",
			nil,
		)
	}
	issued, err := service.issuer.Issue(
		ctx,
		account.IMUserID,
		service.config.UserSigTTL,
	)
	if err != nil {
		return IMSession{}, apperror.New(
			"im_session_unavailable",
			"暂时无法创建 IM 会话",
			err,
		)
	}
	return IMSession{
		SDKAppID:  service.config.SDKAppID,
		UserID:    account.IMUserID,
		UserSig:   issued.Value,
		ExpiresAt: issued.ExpiresAt.UTC(),
	}, nil
}

func validAccountID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil
}
