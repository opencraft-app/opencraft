package authn

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	authnport "git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
	tokenport "git.woa.com/wisp/mono2/collaboration/internal/ports/token"
)

const botCredentialPrefix = "vbc_"

// BotLookup 按账号分片键点查 Bot 当前事实。
type BotLookup interface {
	FindBot(ctx context.Context, accountID, botAgentID string) (botimport.BotAgent, error)
}

// BotCredentialAuthenticator 校验 Bot 长期凭据的完整摘要与当前版本。
type BotCredentialAuthenticator struct {
	bots BotLookup
}

func NewBotCredentialAuthenticator(bots BotLookup) (*BotCredentialAuthenticator, error) {
	if bots == nil {
		return nil, errors.New("Bot 凭据认证器配置无效")
	}
	return &BotCredentialAuthenticator{bots: bots}, nil
}

func (a *BotCredentialAuthenticator) Authenticate(
	ctx context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	typed, ok := candidate.(authnport.BotCredentialCandidate)
	if !ok || a == nil {
		return nil, invalidBotCredential(nil)
	}
	raw := typed.Credential().Reveal()
	accountID, botAgentID, version, err := parseBotCredential(raw)
	if err != nil {
		return nil, invalidBotCredential(err)
	}
	bot, err := a.bots.FindBot(ctx, accountID, botAgentID)
	if errors.Is(err, botimport.ErrNotFound) {
		return nil, invalidBotCredential(err)
	}
	if err != nil {
		return nil, apperror.New("internal_error", "暂时无法验证 Bot 凭据", err)
	}
	actual := sha256.Sum256([]byte(raw))
	if len(bot.CredentialDigest) != sha256.Size ||
		subtle.ConstantTimeCompare(actual[:], bot.CredentialDigest) != 1 {
		return nil, invalidBotCredential(nil)
	}
	if bot.State == botimport.BotStateDeleted || bot.CredentialVersion != int64(version) {
		return nil, apperror.New("runtime_credential_revoked", "Bot 凭据已失效", nil)
	}
	principal, err := authnport.NewCurrentBotCredentialPrincipal(accountID, botAgentID, version)
	if err != nil {
		return nil, invalidBotCredential(err)
	}
	return principal, nil
}

// BotRuntimeBearerAuthenticator 校验 Bot 短期运行 Token，并实时复核凭据版本。
type BotRuntimeBearerAuthenticator struct {
	tokens tokenport.Signer
	bots   BotLookup
}

func NewBotRuntimeBearerAuthenticator(
	tokens tokenport.Signer,
	bots BotLookup,
) (*BotRuntimeBearerAuthenticator, error) {
	if tokens == nil || bots == nil {
		return nil, errors.New("Bot Runtime 认证器配置无效")
	}
	return &BotRuntimeBearerAuthenticator{tokens: tokens, bots: bots}, nil
}

func (a *BotRuntimeBearerAuthenticator) Authenticate(
	ctx context.Context,
	candidate authnport.CredentialCandidate,
) (authnport.CurrentPrincipal, error) {
	typed, ok := candidate.(authnport.BotRuntimeBearerCandidate)
	if !ok || a == nil {
		return nil, invalidBotCredential(nil)
	}
	claims, err := a.tokens.Verify(ctx, typed.Credential().Reveal())
	if err != nil || claims.Kind() != tokenport.ClaimsBotRuntimeAccess {
		return nil, invalidBotCredential(err)
	}
	bot, err := a.bots.FindBot(ctx, claims.AccountID(), claims.AgentID())
	if errors.Is(err, botimport.ErrNotFound) {
		return nil, apperror.New("runtime_credential_revoked", "Bot 会话对应凭据已失效", err)
	}
	if err != nil {
		return nil, apperror.New("internal_error", "暂时无法验证 Bot 会话", err)
	}
	if bot.State == botimport.BotStateDeleted || uint64(bot.CredentialVersion) != claims.Version() {
		return nil, apperror.New("runtime_credential_revoked", "Bot 会话对应凭据已失效", nil)
	}
	principal, err := authnport.NewCurrentBotRuntimePrincipal(
		claims.AccountID(), claims.AgentID(), claims.Version(),
	)
	if err != nil {
		return nil, invalidBotCredential(err)
	}
	return principal, nil
}

func parseBotCredential(raw string) (string, string, uint64, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 4 || !strings.HasPrefix(parts[0], botCredentialPrefix) {
		return "", "", 0, errors.New("Bot 凭据格式无效")
	}
	accountID := strings.TrimPrefix(parts[0], botCredentialPrefix)
	if !isUUIDv7(accountID) || !isUUIDv7(parts[1]) {
		return "", "", 0, errors.New("Bot 凭据路由无效")
	}
	version, err := strconv.ParseUint(parts[2], 10, 63)
	if err != nil || version == 0 || strconv.FormatUint(version, 10) != parts[2] {
		return "", "", 0, errors.New("Bot 凭据版本无效")
	}
	secret, err := base64.RawURLEncoding.Strict().DecodeString(parts[3])
	if err != nil || len(secret) != 32 {
		return "", "", 0, errors.New("Bot 凭据密钥无效")
	}
	return accountID, parts[1], version, nil
}

func invalidBotCredential(cause error) error {
	return apperror.New("runtime_credential_invalid", "Bot 凭据无效或已失效", cause)
}
