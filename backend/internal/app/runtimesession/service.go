// Package runtimesession 编排 Runtime Token、Agent UserSig 与当前数据库事实。
package runtimesession

import (
	"context"
	"errors"
	"strings"
	"time"

	"chatserver/internal/apperror"
	clockport "chatserver/internal/ports/clock"
	runtimesessionport "chatserver/internal/ports/runtimesession"
	tencentimport "chatserver/internal/ports/tencentim"
	tokenport "chatserver/internal/ports/token"
)

// Config 控制 Runtime Session 两类短期凭据的生命周期。
type Config struct {
	SDKAppID       int
	AccessTTL      time.Duration
	UserSigTTL     time.Duration
	AllowedRuntime []string
}

// Identity 是向 Runtime 返回的当前 Agent 身份与配置。
type Identity struct {
	ID           string
	ServerID     string
	UserID       string
	Capabilities []string
	ReplyPolicy  string
	RuntimeKind  string
	RuntimeModel string
}

// IMSession 是 Agent 自身的腾讯云 IM 短期登录信息。
type IMSession struct {
	SDKAppID  int
	UserID    string
	UserSig   string
	ExpiresAt time.Time
}

// Session 是一次性返回给 Agent Host 的短期会话。
type Session struct {
	AccessToken string
	ExpiresAt   time.Time
	Agent       Identity
	IM          IMSession
}

type LaunchFence struct {
	LaunchID          string
	AssignmentEpoch   string
	ConfigGeneration  int64
	CredentialVersion uint64
	Attempt           int64
}

// Service 提供 Runtime Session 创建和当前 Runtime 读取。
type Service struct {
	repository      runtimesessionport.Repository
	tokens          tokenport.Signer
	userSigs        tencentimport.UserSigIssuer
	clock           clockport.Clock
	config          Config
	allowedRuntimes map[string]struct{}
}

// NewService 创建 Runtime Session 应用服务。
func NewService(
	repository runtimesessionport.Repository,
	tokens tokenport.Signer,
	userSigs tencentimport.UserSigIssuer,
	clock clockport.Clock,
	config Config,
) (*Service, error) {
	if repository == nil || tokens == nil || userSigs == nil || clock == nil ||
		config.SDKAppID <= 0 ||
		config.AccessTTL <= 0 ||
		config.UserSigTTL <= 0 ||
		len(config.AllowedRuntime) == 0 {
		return nil, errors.New("Runtime Session 服务配置无效")
	}
	allowed := make(map[string]struct{}, len(config.AllowedRuntime))
	for _, kind := range config.AllowedRuntime {
		kind = strings.TrimSpace(kind)
		if kind == "" {
			return nil, errors.New("Runtime Session 运行时白名单无效")
		}
		allowed[kind] = struct{}{}
	}
	return &Service{
		repository:      repository,
		tokens:          tokens,
		userSigs:        userSigs,
		clock:           clock,
		config:          config,
		allowedRuntimes: allowed,
	}, nil
}

// CreateForLaunch signs both platform access and IM material for one exact
// server-issued Launch Fence.
func (s *Service) CreateForLaunch(
	ctx context.Context,
	serverID string,
	computerID string,
	agentID string,
	fence LaunchFence,
) (Session, error) {
	return s.create(ctx, serverID, computerID, agentID, fence)
}

func (s *Service) create(
	ctx context.Context,
	serverID string,
	computerID string,
	agentID string,
	launch LaunchFence,
) (Session, error) {
	agent, identity, err := s.currentIdentity(
		ctx,
		serverID,
		agentID,
		launch.CredentialVersion,
	)
	if err != nil {
		return Session{}, err
	}
	if agent.ComputerID != computerID {
		return Session{}, apperror.New(
			"stale_launch", "Agent 已不属于当前 Computer", nil,
		)
	}
	now := s.clock.Now().UTC()
	expiresAt := now.Add(s.config.AccessTTL)
	claims, err := tokenport.NewRuntimeLaunchClaims(
		agent.ServerID, computerID, agent.ID, launch.LaunchID,
		launch.AssignmentEpoch, launch.ConfigGeneration,
		launch.CredentialVersion, launch.Attempt, now, expiresAt,
	)
	if err != nil {
		return Session{}, apperror.New(
			"internal_error",
			"Runtime 身份数据无效",
			err,
		)
	}
	accessToken, err := s.tokens.Sign(ctx, claims)
	if err != nil || strings.TrimSpace(accessToken) == "" {
		return Session{}, apperror.New(
			"runtime_unavailable",
			"暂时无法创建 Runtime 会话",
			err,
		)
	}
	userSig, err := s.userSigs.Issue(
		ctx,
		agent.IMUserID,
		s.config.UserSigTTL,
	)
	if err != nil ||
		strings.TrimSpace(userSig.Value) == "" ||
		!userSig.ExpiresAt.After(now) {
		return Session{}, apperror.New(
			"runtime_unavailable",
			"暂时无法创建 Agent IM 会话",
			err,
		)
	}
	current, err := s.repository.MarkCredentialUsed(
		ctx,
		agent.ServerID,
		agent.ID,
		agent.CredentialVersion,
		now,
	)
	if err != nil {
		return Session{}, apperror.New(
			"internal_error",
			"暂时无法确认 Runtime credential",
			err,
		)
	}
	if !current {
		return Session{}, apperror.New(
			"runtime_credential_revoked",
			"Runtime credential 已失效",
			runtimesessionport.ErrNotCurrent,
		)
	}
	return Session{
		AccessToken: accessToken,
		ExpiresAt:   expiresAt,
		Agent:       identity,
		IM: IMSession{
			SDKAppID:  s.config.SDKAppID,
			UserID:    agent.IMUserID,
			UserSig:   userSig.Value,
			ExpiresAt: userSig.ExpiresAt.UTC(),
		},
	}, nil
}

// Get 返回短期 Runtime Token 对应的当前 Agent 身份与配置。
func (s *Service) Get(
	ctx context.Context,
	serverID string,
	agentID string,
	credentialVersion uint64,
) (Identity, error) {
	_, identity, err := s.currentIdentity(
		ctx,
		serverID,
		agentID,
		credentialVersion,
	)
	return identity, err
}

func (s *Service) currentIdentity(
	ctx context.Context,
	serverID string,
	agentID string,
	credentialVersion uint64,
) (runtimesessionport.Agent, Identity, error) {
	if s == nil || s.repository == nil {
		return runtimesessionport.Agent{}, Identity{}, apperror.New(
			"internal_error",
			"Runtime Session 服务暂不可用",
			nil,
		)
	}
	agent, err := s.repository.FindCurrentAgent(
		ctx,
		serverID,
		agentID,
		credentialVersion,
	)
	switch {
	case errors.Is(err, runtimesessionport.ErrNotCurrent):
		return runtimesessionport.Agent{}, Identity{}, apperror.New(
			"runtime_credential_revoked",
			"Runtime credential 已失效",
			err,
		)
	case err != nil:
		return runtimesessionport.Agent{}, Identity{}, apperror.New(
			"internal_error",
			"暂时无法读取 Runtime Agent",
			err,
		)
	case agent.ServerID != serverID ||
		agent.ID != agentID ||
		agent.CredentialVersion != credentialVersion:
		return runtimesessionport.Agent{}, Identity{}, apperror.New(
			"runtime_credential_revoked",
			"Runtime credential 已失效",
			runtimesessionport.ErrNotCurrent,
		)
	}
	if agent.IMState != "ready" || strings.TrimSpace(agent.IMUserID) == "" {
		return runtimesessionport.Agent{}, Identity{}, apperror.New(
			"agent_not_ready",
			"Agent IM 身份尚未就绪",
			nil,
		)
	}
	if strings.TrimSpace(agent.ComputerID) == "" || !agent.ComputerReady {
		return runtimesessionport.Agent{}, Identity{}, apperror.New(
			"computer_not_ready",
			"Agent 尚未绑定可用 Computer",
			nil,
		)
	}
	// ObservedState is a projection reported only after the runtime starts.
	// Requiring it here would create a bootstrap cycle: a fresh runtime needs
	// this session before it can report starting/running. DesiredState plus the
	// active Computer and assignment fences remain the authorization boundary.
	if agent.DesiredState != "running" {
		return runtimesessionport.Agent{}, Identity{}, apperror.New(
			"runtime_unavailable",
			"Agent 当前不可运行",
			nil,
		)
	}
	if _, ok := s.allowedRuntimes[agent.RuntimeKind]; !ok ||
		!validReplyPolicy(agent.ReplyPolicy) {
		return runtimesessionport.Agent{}, Identity{}, apperror.New(
			"internal_error",
			"Agent Runtime 配置无效",
			nil,
		)
	}
	return agent, Identity{
		ID:       agent.ID,
		ServerID: agent.ServerID,
		UserID:   agent.IMUserID,
		Capabilities: []string{
			"read", "send", "server", "channels", "threads", "tasks",
			"reactions", "attachments", "reminders",
		},
		ReplyPolicy:  agent.ReplyPolicy,
		RuntimeKind:  agent.RuntimeKind,
		RuntimeModel: agent.RuntimeModel,
	}, nil
}

func validReplyPolicy(value string) bool {
	switch value {
	case "mention_and_dm", "all_channel_messages", "dm_only":
		return true
	default:
		return false
	}
}
