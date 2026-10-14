// Package botagent 编排 LightVela Bot 的 IM 身份开通、凭据交付和短期运行会话。
package botagent

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	authnport "git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
	clockport "git.woa.com/wisp/mono2/collaboration/internal/ports/clock"
	idport "git.woa.com/wisp/mono2/collaboration/internal/ports/id"
	tencentimport "git.woa.com/wisp/mono2/collaboration/internal/ports/tencentim"
	tokenport "git.woa.com/wisp/mono2/collaboration/internal/ports/token"
)

// CredentialPrefix 是 Bot 长期凭据的固定前缀；随后是账号分片键。
const CredentialPrefix = "vbc_"

const maxBotsPerAccount = 200

// IdentityDeriver 把 Bot UUIDv7 派生为稳定 IM UserID。
type IdentityDeriver interface {
	AgentUserID(string) (string, error)
}

// IdentityManager 是 Bot 腾讯账号的导入、下线与删除能力。
type IdentityManager interface {
	EnsureIdentity(context.Context, tencentimport.Identity) error
	KickIdentity(context.Context, string) error
	DeleteIdentity(context.Context, string) error
}

// Config 控制凭据交付与短期会话。
type Config struct {
	SDKAppID   int
	APIBaseURL string
	AccessTTL  time.Duration
	UserSigTTL time.Duration
	// MaxActiveBots 是每个账号同时占用的腾讯 Bot 账号上限；删除 Bot 会释放名额。
	MaxActiveBots int
}

// Human 是发起管理操作的 LightVela 账号。
type Human struct {
	AccountID string
	Subject   string
}

// ProvisionInput 标识要开通的 Bot。
type ProvisionInput struct {
	InstanceID  string
	BotID       string
	DisplayName string
}

// Identity 是返回给 Bot 运行时的身份与控制信息。
type Identity struct {
	ID            string
	UserID        string
	DisplayName   string
	CommandPolicy string
	OwnerUserIDs  []string
}

// Session 是一次性返回给 Bot 的短期会话。
type Session struct {
	AccessToken      string
	ExpiresAt        time.Time
	Bot              Identity
	SDKAppID         int
	UserSig          string
	UserSigExpiresAt time.Time
}

// Service 是 Bot IM 身份的应用服务。
type Service struct {
	repository botimport.Repository
	deriver    IdentityDeriver
	identities IdentityManager
	host       botimport.Host
	tokens     tokenport.Signer
	userSigs   tencentimport.UserSigIssuer
	ids        idport.Generator
	clock      clockport.Clock
	random     io.Reader
	config     Config
}

func NewService(
	repository botimport.Repository,
	deriver IdentityDeriver,
	identities IdentityManager,
	host botimport.Host,
	tokens tokenport.Signer,
	userSigs tencentimport.UserSigIssuer,
	ids idport.Generator,
	clock clockport.Clock,
	random io.Reader,
	config Config,
) (*Service, error) {
	if repository == nil || deriver == nil || identities == nil || host == nil ||
		tokens == nil || userSigs == nil || ids == nil || clock == nil || random == nil ||
		config.SDKAppID <= 0 || config.AccessTTL <= 0 || config.UserSigTTL <= 0 ||
		config.MaxActiveBots <= 0 || config.MaxActiveBots > maxBotsPerAccount ||
		strings.TrimSpace(config.APIBaseURL) == "" {
		return nil, errors.New("Bot IM 身份服务配置无效")
	}
	return &Service{
		repository: repository, deriver: deriver, identities: identities, host: host,
		tokens: tokens, userSigs: userSigs, ids: ids, clock: clock, random: random, config: config,
	}, nil
}

// Listed 是列表中的 Bot，附带管理员是否限制了它的 IM 身份，供主人在界面上看到原因。
type Listed struct {
	botimport.BotAgent
	Restricted bool
}

// List 返回当前账号的 Bot IM 身份。
func (s *Service) List(ctx context.Context, human Human) ([]Listed, error) {
	bots, err := s.repository.ListBots(ctx, human.AccountID, maxBotsPerAccount)
	if err != nil {
		return nil, internal("暂时无法读取 Bot 列表", err)
	}
	listed := make([]Listed, 0, len(bots))
	for _, bot := range bots {
		route, err := s.repository.FindRoute(ctx, bot.IMUserID)
		if err != nil && !errors.Is(err, botimport.ErrNotFound) {
			return nil, internal("暂时无法读取 Bot IM 路由", err)
		}
		listed = append(listed, Listed{BotAgent: bot, Restricted: err == nil && route.RestrictedAt != nil})
	}
	return listed, nil
}

// Provision 幂等开通 Bot：确认归属、导入腾讯账号、签发并交付凭据。
func (s *Service) Provision(
	ctx context.Context,
	human Human,
	input ProvisionInput,
) (botimport.BotAgent, error) {
	input.InstanceID = strings.TrimSpace(input.InstanceID)
	input.BotID = strings.TrimSpace(input.BotID)
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.InstanceID == "" || input.BotID == "" || input.DisplayName == "" {
		return botimport.BotAgent{}, apperror.New("invalid_request", "实例、Bot 和名称不能为空", nil)
	}
	existing, err := s.repository.FindBotByRef(ctx, human.AccountID, input.InstanceID, input.BotID)
	switch {
	case err == nil && existing.State == botimport.BotStateReady:
		return existing, nil
	case err != nil && !errors.Is(err, botimport.ErrNotFound):
		return botimport.BotAgent{}, internal("暂时无法读取 Bot", err)
	}
	if existing.ID == "" || existing.State == botimport.BotStateDeleted {
		active, err := s.repository.CountActiveBots(ctx, human.AccountID)
		if err != nil {
			return botimport.BotAgent{}, internal("暂时无法统计 Bot", err)
		}
		if active >= s.config.MaxActiveBots {
			return botimport.BotAgent{}, apperror.New(
				"bot_quota_exceeded",
				fmt.Sprintf("每个账号最多为 %d 个 Bot 开通 IM 身份，请先停用不用的 Bot", s.config.MaxActiveBots),
				nil,
			)
		}
	}

	request := botimport.HostRequest{
		AccountSubject: human.Subject,
		InstanceID:     input.InstanceID,
		BotID:          input.BotID,
		DisplayName:    input.DisplayName,
	}
	verified, err := s.host.Verify(ctx, request)
	if err != nil {
		return botimport.BotAgent{}, hostError(err)
	}
	if name := strings.TrimSpace(verified.DisplayName); name != "" {
		request.DisplayName = truncateRunes(name, 64)
	}

	bot := existing
	if bot.ID == "" {
		bot, err = s.insert(ctx, human.AccountID, input, request.DisplayName)
		if err != nil {
			return botimport.BotAgent{}, err
		}
	}
	if _, err := s.repository.EnsureRoute(ctx, botimport.Route{
		IMUserID:   bot.IMUserID,
		Kind:       botimport.IdentityKindBot,
		AccountID:  bot.AccountID,
		BotAgentID: bot.ID,
	}); err != nil {
		return botimport.BotAgent{}, internal("暂时无法登记 Bot IM 路由", err)
	}
	if err := s.identities.EnsureIdentity(ctx, tencentimport.Identity{
		UserID: bot.IMUserID,
		Nick:   request.DisplayName,
	}); err != nil {
		bot, _ = s.markError(ctx, bot, "tencent_identity_failed")
		return botimport.BotAgent{}, apperror.New("tencent_unavailable", "暂时无法创建 Bot 的 IM 账号", err)
	}
	return s.issueAndDeliver(ctx, bot, request, func(next *botimport.BotAgent) {
		next.DisplayName = request.DisplayName
	})
}

// UpdateCommandPolicy 修改谁可以给 Bot 发运行时命令。
func (s *Service) UpdateCommandPolicy(
	ctx context.Context,
	human Human,
	botAgentID string,
	policy string,
) (botimport.BotAgent, error) {
	if policy != botimport.CommandPolicyOwner && policy != botimport.CommandPolicyAnyone {
		return botimport.BotAgent{}, apperror.New("invalid_request", "命令权限只能是 owner 或 anyone", nil)
	}
	bot, err := s.ownedBot(ctx, human, botAgentID)
	if err != nil {
		return botimport.BotAgent{}, err
	}
	if bot.CommandPolicy == policy {
		return bot, nil
	}
	expected := bot.Revision
	bot.CommandPolicy = policy
	bot.UpdatedAt = s.clock.Now().UTC()
	return s.save(ctx, bot, expected)
}

// Delete 吊销凭据、使 Bot 的腾讯登录态失效并删除其腾讯账号；重新开通时以同一 UserID 再导入。
func (s *Service) Delete(ctx context.Context, human Human, botAgentID string) error {
	bot, err := s.ownedBot(ctx, human, botAgentID)
	if err != nil {
		return err
	}
	if bot.State != botimport.BotStateDeleted {
		expected := bot.Revision
		bot.State = botimport.BotStateDeleted
		bot.CredentialVersion++
		bot.CredentialDigest = nil
		bot.LastErrorCode = ""
		bot.UpdatedAt = s.clock.Now().UTC()
		if bot, err = s.save(ctx, bot, expected); err != nil {
			return err
		}
	}
	if err := s.identities.KickIdentity(ctx, bot.IMUserID); err != nil {
		return apperror.New("tencent_unavailable", "暂时无法使 Bot 的 IM 登录态失效", err)
	}
	if err := s.identities.DeleteIdentity(ctx, bot.IMUserID); err != nil {
		return apperror.New("tencent_unavailable", "暂时无法删除 Bot 的腾讯 IM 账号", err)
	}
	// 实例上的残留凭据已经失效；清理失败不影响吊销结果。
	_ = s.host.Revoke(ctx, botimport.HostRequest{
		AccountSubject: human.Subject, InstanceID: bot.InstanceID, BotID: bot.BotID,
		DisplayName: bot.DisplayName,
	})
	return nil
}

// AdminDelete 由管理后台停用某账号下的 Bot，效果与用户删除相同。
func (s *Service) AdminDelete(ctx context.Context, accountID, subject, botAgentID string) error {
	return s.Delete(ctx, Human{AccountID: accountID, Subject: subject}, botAgentID)
}

// Rotate 轮换凭据版本并重新交付到实例；旧版本立即失效。
func (s *Service) Rotate(ctx context.Context, human Human, botAgentID string) (botimport.BotAgent, error) {
	bot, err := s.ownedBot(ctx, human, botAgentID)
	if err != nil {
		return botimport.BotAgent{}, err
	}
	if bot.State == botimport.BotStateDeleted {
		return botimport.BotAgent{}, apperror.New("bot_agent_not_ready", "Bot IM 身份已停用", nil)
	}
	return s.issueAndDeliver(ctx, bot, botimport.HostRequest{
		AccountSubject: human.Subject, InstanceID: bot.InstanceID, BotID: bot.BotID,
		DisplayName: bot.DisplayName,
	}, nil)
}

// CreateSession 为凭据对应的 Bot 签发短期运行 Token 与 UserSig。
func (s *Service) CreateSession(ctx context.Context, principal authnport.CurrentBotPrincipal) (Session, error) {
	bot, err := s.currentBot(ctx, principal)
	if err != nil {
		return Session{}, err
	}
	identity, err := s.identity(ctx, bot)
	if err != nil {
		return Session{}, err
	}
	now := s.clock.Now().UTC()
	expiresAt := now.Add(s.config.AccessTTL)
	claims, err := tokenport.NewBotRuntimeClaims(
		bot.AccountID, bot.ID, uint64(bot.CredentialVersion), now, expiresAt,
	)
	if err != nil {
		return Session{}, internal("Bot 身份数据无效", err)
	}
	accessToken, err := s.tokens.Sign(ctx, claims)
	if err != nil || strings.TrimSpace(accessToken) == "" {
		return Session{}, apperror.New("runtime_unavailable", "暂时无法创建 Bot 会话", err)
	}
	userSig, err := s.userSigs.Issue(ctx, bot.IMUserID, s.config.UserSigTTL)
	if err != nil || strings.TrimSpace(userSig.Value) == "" || !userSig.ExpiresAt.After(now) {
		return Session{}, apperror.New("im_session_unavailable", "暂时无法创建 Bot 的 IM 会话", err)
	}
	return Session{
		AccessToken:      accessToken,
		ExpiresAt:        expiresAt,
		Bot:              identity,
		SDKAppID:         s.config.SDKAppID,
		UserSig:          userSig.Value,
		UserSigExpiresAt: userSig.ExpiresAt.UTC(),
	}, nil
}

// RuntimeIdentity 返回当前 Bot 的身份、主人和命令权限。
func (s *Service) RuntimeIdentity(ctx context.Context, principal authnport.CurrentBotPrincipal) (Identity, error) {
	bot, err := s.currentBot(ctx, principal)
	if err != nil {
		return Identity{}, err
	}
	return s.identity(ctx, bot)
}

// Actor 返回 Bot 主体对应的当前 Bot，供群服务确定操作者身份。
func (s *Service) Actor(ctx context.Context, principal authnport.CurrentBotPrincipal) (botimport.BotAgent, error) {
	return s.currentBot(ctx, principal)
}

func (s *Service) insert(
	ctx context.Context,
	accountID string,
	input ProvisionInput,
	displayName string,
) (botimport.BotAgent, error) {
	id, err := s.ids.New()
	if err != nil {
		return botimport.BotAgent{}, internal("无法生成 Bot ID", err)
	}
	imUserID, err := s.deriver.AgentUserID(id)
	if err != nil {
		return botimport.BotAgent{}, internal("无法派生 Bot IM 身份", err)
	}
	now := s.clock.Now().UTC()
	bot, err := s.repository.InsertBot(ctx, botimport.BotAgent{
		ID:            id,
		AccountID:     accountID,
		InstanceID:    input.InstanceID,
		BotID:         input.BotID,
		DisplayName:   displayName,
		IMUserID:      imUserID,
		State:         botimport.BotStateProvisioning,
		CommandPolicy: botimport.CommandPolicyOwner,
		Revision:      1,
		CreatedAt:     now,
		UpdatedAt:     now,
	})
	if errors.Is(err, botimport.ErrConflict) {
		existing, findErr := s.repository.FindBotByRef(ctx, accountID, input.InstanceID, input.BotID)
		if findErr != nil {
			return botimport.BotAgent{}, internal("暂时无法读取 Bot", findErr)
		}
		return existing, nil
	}
	if err != nil {
		return botimport.BotAgent{}, internal("暂时无法保存 Bot", err)
	}
	return bot, nil
}

func (s *Service) issueAndDeliver(
	ctx context.Context,
	bot botimport.BotAgent,
	request botimport.HostRequest,
	mutate func(*botimport.BotAgent),
) (botimport.BotAgent, error) {
	secret := make([]byte, 32)
	if _, err := io.ReadFull(s.random, secret); err != nil {
		return botimport.BotAgent{}, internal("无法生成 Bot 凭据", err)
	}
	version := bot.CredentialVersion + 1
	raw := CredentialPrefix + bot.AccountID + "." + bot.ID + "." +
		strconv.FormatInt(version, 10) + "." + base64.RawURLEncoding.EncodeToString(secret)
	digest := sha256.Sum256([]byte(raw))
	credential, err := authnport.NewBotCredentialCandidate(raw)
	if err != nil {
		return botimport.BotAgent{}, internal("Bot 凭据无效", err)
	}

	expected := bot.Revision
	bot.CredentialVersion = version
	bot.CredentialDigest = digest[:]
	bot.State = botimport.BotStateProvisioning
	bot.LastErrorCode = ""
	bot.UpdatedAt = s.clock.Now().UTC()
	if mutate != nil {
		mutate(&bot)
	}
	bot, err = s.save(ctx, bot, expected)
	if err != nil {
		return botimport.BotAgent{}, err
	}
	// 状态已是 provisioning：调用方断开或超时也要把交付做完，并落到 ready 或 error，否则 Bot 会一直停在开通中。
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deliveryFinishTimeout)
	defer cancel()
	owner := ""
	if account, err := s.repository.FindAccount(ctx, bot.AccountID); err == nil && account.IMState == "ready" {
		owner = account.IMUserID
	}
	if err := s.host.Deliver(ctx, botimport.Delivery{
		HostRequest:   request,
		BotAgentID:    bot.ID,
		IMUserID:      bot.IMUserID,
		OwnerIMUserID: owner,
		SDKAppID:      s.config.SDKAppID,
		APIBaseURL:    s.config.APIBaseURL,
		Credential:    credential.Credential(),
	}); err != nil {
		bot, _ = s.markError(ctx, bot, "bot_host_delivery_failed")
		return botimport.BotAgent{}, hostError(err)
	}
	expected = bot.Revision
	bot.State = botimport.BotStateReady
	bot.UpdatedAt = s.clock.Now().UTC()
	return s.save(ctx, bot, expected)
}

// deliveryFinishTimeout 限制调用方离开后交付与状态落库还能持续多久。
const deliveryFinishTimeout = 2 * time.Minute

func (s *Service) markError(ctx context.Context, bot botimport.BotAgent, code string) (botimport.BotAgent, error) {
	expected := bot.Revision
	bot.State = botimport.BotStateError
	bot.LastErrorCode = code
	bot.UpdatedAt = s.clock.Now().UTC()
	return s.repository.SaveBot(ctx, bot, expected)
}

func (s *Service) save(ctx context.Context, bot botimport.BotAgent, expected int64) (botimport.BotAgent, error) {
	saved, err := s.repository.SaveBot(ctx, bot, expected)
	if errors.Is(err, botimport.ErrConflict) {
		return botimport.BotAgent{}, apperror.New("revision_conflict", "Bot 已被并发修改，请重试", err)
	}
	if err != nil {
		return botimport.BotAgent{}, internal("暂时无法保存 Bot", err)
	}
	return saved, nil
}

func (s *Service) ownedBot(ctx context.Context, human Human, botAgentID string) (botimport.BotAgent, error) {
	bot, err := s.repository.FindBot(ctx, human.AccountID, botAgentID)
	if errors.Is(err, botimport.ErrNotFound) {
		return botimport.BotAgent{}, apperror.New("bot_agent_not_found", "Bot IM 身份不存在", err)
	}
	if err != nil {
		return botimport.BotAgent{}, internal("暂时无法读取 Bot", err)
	}
	return bot, nil
}

func (s *Service) currentBot(ctx context.Context, principal authnport.CurrentBotPrincipal) (botimport.BotAgent, error) {
	bot, err := s.repository.FindBot(ctx, principal.AccountID(), principal.BotAgentID())
	if errors.Is(err, botimport.ErrNotFound) {
		return botimport.BotAgent{}, revoked(err)
	}
	if err != nil {
		return botimport.BotAgent{}, internal("暂时无法读取 Bot", err)
	}
	if bot.State != botimport.BotStateReady && bot.State != botimport.BotStateProvisioning ||
		uint64(bot.CredentialVersion) != principal.CredentialVersion() {
		return botimport.BotAgent{}, revoked(nil)
	}
	route, err := s.repository.FindRoute(ctx, bot.IMUserID)
	if err != nil && !errors.Is(err, botimport.ErrNotFound) {
		return botimport.BotAgent{}, internal("暂时无法读取 Bot IM 路由", err)
	}
	if err == nil && route.RestrictedAt != nil {
		return botimport.BotAgent{}, apperror.New("im_identity_restricted", "该 Bot 已被限制", nil)
	}
	return bot, nil
}

// identity 汇总主人名下全部身份：主人的 Human IM 身份与其全部可用 Bot。
func (s *Service) identity(ctx context.Context, bot botimport.BotAgent) (Identity, error) {
	owners := make([]string, 0, 4)
	account, err := s.repository.FindAccount(ctx, bot.AccountID)
	if err != nil && !errors.Is(err, botimport.ErrNotFound) {
		return Identity{}, internal("暂时无法读取 Bot 主人", err)
	}
	if err == nil && account.IMState == "ready" && account.IMUserID != "" {
		owners = append(owners, account.IMUserID)
	}
	siblings, err := s.repository.ListBots(ctx, bot.AccountID, maxBotsPerAccount)
	if err != nil {
		return Identity{}, internal("暂时无法读取 Bot 主人", err)
	}
	for _, sibling := range siblings {
		if sibling.State != botimport.BotStateDeleted && sibling.IMUserID != "" {
			owners = append(owners, sibling.IMUserID)
		}
	}
	return Identity{
		ID:            bot.ID,
		UserID:        bot.IMUserID,
		DisplayName:   bot.DisplayName,
		CommandPolicy: bot.CommandPolicy,
		OwnerUserIDs:  owners,
	}, nil
}

func hostError(err error) error {
	if errors.Is(err, botimport.ErrBotNotOwned) {
		return apperror.New("bot_instance_not_owned", "LightVela 实例或 Bot 不属于当前账号", err)
	}
	return apperror.New("bot_host_unavailable", "暂时无法把凭据交付到 Bot 所在实例", err)
}

func revoked(cause error) error {
	return apperror.New("runtime_credential_revoked", "Bot 凭据已失效", cause)
}

func internal(message string, cause error) error {
	return apperror.New("internal_error", message, cause)
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
