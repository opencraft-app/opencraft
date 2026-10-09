// Package accountauth 实现自然人账号注册、登录与会话轮换。
package accountauth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"chatserver/internal/apperror"
	accountauthport "chatserver/internal/ports/accountauth"
	clockport "chatserver/internal/ports/clock"
	idport "chatserver/internal/ports/id"
	tokenport "chatserver/internal/ports/token"
)

const emailLoginKind = "email"

// Config 是认证令牌有效期配置。
type Config struct {
	AccessTTL  time.Duration
	RefreshTTL time.Duration
}

// RegisterCommand 是邮箱密码注册命令。
type RegisterCommand struct {
	Email       string
	Password    string
	DisplayName string
}

// LoginCommand 是邮箱密码登录命令。
type LoginCommand struct {
	Email    string
	Password string
}

// Result 是认证成功后返回的一次性令牌和账号快照。
type Result struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	Account      accountauthport.Account
}

// Service 编排认证安全原语与原子 Repository 操作。
type Service struct {
	repository    accountauthport.Repository
	passwords     accountauthport.PasswordHasher
	refreshTokens accountauthport.RefreshTokenCodec
	accessTokens  tokenport.Signer
	ids           idport.Generator
	clock         clockport.Clock
	config        Config
}

// NewService 创建认证应用服务。
func NewService(
	repository accountauthport.Repository,
	passwords accountauthport.PasswordHasher,
	refreshTokens accountauthport.RefreshTokenCodec,
	accessTokens tokenport.Signer,
	ids idport.Generator,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || passwords == nil || refreshTokens == nil ||
		accessTokens == nil || ids == nil || clock == nil ||
		config.AccessTTL <= 0 || config.RefreshTTL <= 0 {
		return nil, errors.New("账号认证服务配置无效")
	}
	return &Service{
		repository:    repository,
		passwords:     passwords,
		refreshTokens: refreshTokens,
		accessTokens:  accessTokens,
		ids:           ids,
		clock:         clock,
		config:        config,
	}, nil
}

// Register 原子创建登录身份、账号和首个 AuthSession。
func (s *Service) Register(
	ctx context.Context,
	command RegisterCommand,
) (Result, error) {
	login, err := normalizeEmail(command.Email)
	if err != nil || !validPassword(command.Password) {
		return Result{}, apperror.New("invalid_request", "注册参数无效", err)
	}
	displayName := strings.TrimSpace(command.DisplayName)
	if displayName == "" || utf8.RuneCountInString(displayName) > 100 {
		return Result{}, apperror.New("invalid_request", "注册参数无效", nil)
	}

	passwordHash, err := s.passwords.Hash(ctx, command.Password)
	if err != nil {
		return Result{}, apperror.New("internal_error", "暂时无法注册账号", err)
	}
	accountID, err := s.ids.New()
	if err != nil {
		return Result{}, apperror.New("internal_error", "暂时无法注册账号", err)
	}
	session, refreshToken, err := s.newSession(ctx, accountID)
	if err != nil {
		return Result{}, err
	}
	now := s.clock.Now().UTC()
	account := accountauthport.Account{
		ID:           accountID,
		Email:        login.Normalized,
		DisplayName:  displayName,
		IMState:      "provisioning",
		TokenVersion: 1,
		Revision:     1,
	}
	result, err := s.signResult(ctx, account, session.ID, refreshToken, now)
	if err != nil {
		return Result{}, err
	}

	err = s.repository.Register(ctx, accountauthport.Registration{
		OccurredAt: now,
		Login:      login,
		Account: accountauthport.AccountDraft{
			Account:         account,
			EmailNormalized: login.Normalized,
			PasswordHash:    passwordHash,
		},
		Session: session,
	})
	if errors.Is(err, accountauthport.ErrLoginConflict) {
		return Result{}, apperror.New(
			"account_already_exists",
			"该邮箱已注册",
			err,
		)
	}
	if err != nil {
		return Result{}, apperror.New("internal_error", "暂时无法注册账号", err)
	}
	return result, nil
}

// Login 校验邮箱密码并创建新的 refresh token family。
func (s *Service) Login(
	ctx context.Context,
	command LoginCommand,
) (Result, error) {
	login, err := normalizeEmail(command.Email)
	if err != nil || strings.TrimSpace(command.Password) == "" {
		return Result{}, invalidCredentials(err)
	}
	credential, err := s.repository.FindCredentialByLogin(ctx, login)
	if errors.Is(err, accountauthport.ErrLoginNotFound) {
		_ = s.passwords.DummyVerify(ctx, command.Password)
		return Result{}, invalidCredentials(err)
	}
	if err != nil {
		return Result{}, apperror.New("internal_error", "暂时无法登录", err)
	}
	ok, err := s.passwords.Verify(ctx, credential.PasswordHash, command.Password)
	if err != nil {
		return Result{}, apperror.New("internal_error", "暂时无法登录", err)
	}
	if !ok {
		return Result{}, invalidCredentials(nil)
	}

	session, refreshToken, err := s.newSession(ctx, credential.ID)
	if err != nil {
		return Result{}, err
	}
	now := s.clock.Now().UTC()
	result, err := s.signResult(
		ctx,
		credential.Account,
		session.ID,
		refreshToken,
		now,
	)
	if err != nil {
		return Result{}, err
	}
	if err := s.repository.CreateSession(ctx, credential.ID, session); err != nil {
		return Result{}, apperror.New("internal_error", "暂时无法登录", err)
	}
	return result, nil
}

// Refresh 单次轮换 refresh token，并签发新的 access token。
func (s *Service) Refresh(ctx context.Context, rawToken string) (Result, error) {
	route, err := s.refreshTokens.Parse(ctx, rawToken)
	if err != nil {
		return Result{}, invalidCredentials(err)
	}
	nextSessionID, err := s.ids.New()
	if err != nil {
		return Result{}, apperror.New("internal_error", "暂时无法刷新会话", err)
	}
	issued, err := s.refreshTokens.Issue(ctx, route.AccountID, nextSessionID)
	if err != nil {
		return Result{}, apperror.New("internal_error", "暂时无法刷新会话", err)
	}
	now := s.clock.Now().UTC()
	next := accountauthport.SessionDraft{
		ID:          nextSessionID,
		TokenDigest: issued.Digest,
		ExpiresAt:   now.Add(s.config.RefreshTTL),
	}
	rotation, err := s.repository.RotateSession(ctx, accountauthport.Rotation{
		AccountID:       route.AccountID,
		SessionID:       route.SessionID,
		PresentedDigest: route.Digest,
		Next:            next,
		RotatedAt:       now,
	})
	if err != nil {
		return Result{}, apperror.New("internal_error", "暂时无法刷新会话", err)
	}
	switch rotation.Status {
	case accountauthport.RotationSucceeded:
		signingContext := ctx
		if ctx != nil {
			// 数据库轮换已经提交。本地确定性签名必须完成，否则客户端只能重放
			// 已消费的旧 token，并会触发整个 family 的安全撤销。
			signingContext = context.WithoutCancel(ctx)
		}
		return s.signResult(
			signingContext,
			rotation.Account,
			nextSessionID,
			issued.Plaintext,
			now,
		)
	case accountauthport.RotationRevoked, accountauthport.RotationReplayed:
		return Result{}, apperror.New("session_revoked", "登录会话已失效", nil)
	default:
		return Result{}, invalidCredentials(nil)
	}
}

// Logout 幂等撤销当前 access token 绑定的 AuthSession。
func (s *Service) Logout(
	ctx context.Context,
	accountID string,
	sessionID string,
) error {
	if strings.TrimSpace(accountID) == "" || strings.TrimSpace(sessionID) == "" {
		return apperror.New("unauthenticated", "登录凭证无效", nil)
	}
	if err := s.repository.RevokeSession(
		ctx,
		accountID,
		sessionID,
		s.clock.Now().UTC(),
	); err != nil {
		return apperror.New("internal_error", "暂时无法退出登录", err)
	}
	return nil
}

func (s *Service) newSession(
	ctx context.Context,
	accountID string,
) (accountauthport.SessionDraft, string, error) {
	sessionID, err := s.ids.New()
	if err != nil {
		return accountauthport.SessionDraft{}, "", apperror.New(
			"internal_error",
			"暂时无法创建登录会话",
			err,
		)
	}
	familyID, err := s.ids.New()
	if err != nil {
		return accountauthport.SessionDraft{}, "", apperror.New(
			"internal_error",
			"暂时无法创建登录会话",
			err,
		)
	}
	issued, err := s.refreshTokens.Issue(ctx, accountID, sessionID)
	if err != nil {
		return accountauthport.SessionDraft{}, "", apperror.New(
			"internal_error",
			"暂时无法创建登录会话",
			err,
		)
	}
	return accountauthport.SessionDraft{
		ID:          sessionID,
		FamilyID:    familyID,
		TokenDigest: issued.Digest,
		ExpiresAt:   s.clock.Now().UTC().Add(s.config.RefreshTTL),
	}, issued.Plaintext, nil
}

func (s *Service) signResult(
	ctx context.Context,
	account accountauthport.Account,
	sessionID string,
	refreshToken string,
	now time.Time,
) (Result, error) {
	expiresAt := now.Add(s.config.AccessTTL)
	claims, err := tokenport.NewHumanClaims(
		account.ID,
		sessionID,
		account.TokenVersion,
		now,
		expiresAt,
	)
	if err != nil {
		return Result{}, apperror.New("internal_error", "无法创建访问凭证", err)
	}
	accessToken, err := s.accessTokens.Sign(ctx, claims)
	if err != nil {
		return Result{}, apperror.New("internal_error", "无法创建访问凭证", err)
	}
	return Result{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresAt:    expiresAt,
		Account:      account,
	}, nil
}

func normalizeEmail(raw string) (accountauthport.LoginIdentity, error) {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	at := strings.LastIndexByte(normalized, '@')
	if at <= 0 || at == len(normalized)-1 ||
		strings.ContainsAny(normalized, " \t\r\n") ||
		len(normalized) > 320 {
		return accountauthport.LoginIdentity{}, errors.New("邮箱格式无效")
	}
	digest := sha256.Sum256([]byte(emailLoginKind + "\x00" + normalized))
	return accountauthport.LoginIdentity{
		Kind:       emailLoginKind,
		Hash:       hex.EncodeToString(digest[:]),
		Normalized: normalized,
	}, nil
}

func validPassword(password string) bool {
	length := utf8.RuneCountInString(password)
	return length >= 8 && length <= 200
}

func invalidCredentials(cause error) error {
	return apperror.New("unauthenticated", "邮箱或密码不正确", cause)
}
