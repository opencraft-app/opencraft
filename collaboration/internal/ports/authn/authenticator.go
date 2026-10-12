// Package authn 定义凭证认证边界及已认证主体值对象。
package authn

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/google/uuid"
)

var (
	// ErrInvalidCandidate 表示请求携带的候选凭证不完整。
	ErrInvalidCandidate = errors.New("无效的候选凭证")
	// ErrInvalidPrincipal 表示认证结果中的主体标识不合法。
	ErrInvalidPrincipal = errors.New("无效的已认证主体")
)

// CandidateKind 标识候选凭证类型。
type CandidateKind string

const (
	CandidateAnonymous          CandidateKind = "anonymous"
	CandidateHumanBearer        CandidateKind = "human_bearer"
	CandidateGatewayHuman       CandidateKind = "gateway_human"
	CandidateRuntimeBearer      CandidateKind = "runtime_bearer"
	CandidateAgentCredential    CandidateKind = "agent_credential"
	CandidateComputerBearer     CandidateKind = "computer_bearer"
	CandidateComputerCredential CandidateKind = "computer_credential"
	CandidateBotCredential      CandidateKind = "bot_credential"
	CandidateBotRuntimeBearer   CandidateKind = "bot_runtime_bearer"
	CandidateAdminBearer        CandidateKind = "admin_bearer"
)

// PrincipalKind 标识已经过 currentness 校验的主体类型。
type PrincipalKind string

const (
	PrincipalAnonymous       PrincipalKind = "anonymous"
	PrincipalHuman           PrincipalKind = "human"
	PrincipalRuntime         PrincipalKind = "runtime"
	PrincipalAgentCredential PrincipalKind = "agent_credential"
	PrincipalComputer        PrincipalKind = "computer"
	PrincipalBotCredential   PrincipalKind = "bot_credential"
	PrincipalBotRuntime      PrincipalKind = "bot_runtime"
	PrincipalAdmin           PrincipalKind = "admin"
)

// SensitiveCredential 包装只允许在认证调用期间显式读取的 Secret。
//
// 所有 fmt 格式化和 JSON 序列化都不得暴露原文。
type SensitiveCredential struct {
	value string
}

const redactedCredential = "[REDACTED]"

// Reveal 显式返回 Secret 原文。调用方不得记录返回值。
func (s SensitiveCredential) Reveal() string {
	return s.value
}

// Format 无论调用方使用哪个 fmt verb 都只输出脱敏标记。
func (SensitiveCredential) Format(state fmt.State, _ rune) {
	_, _ = io.WriteString(state, redactedCredential)
}

// MarshalJSON 拒绝把敏感凭据放进 JSON。
func (SensitiveCredential) MarshalJSON() ([]byte, error) {
	return nil, errors.New("敏感凭据禁止 JSON 序列化")
}

// CredentialCandidate 是尚未认证、不能用于授权的请求凭证。
type CredentialCandidate interface {
	Kind() CandidateKind
	credentialCandidate()
}

// AnonymousCandidate 表示无需凭证的公开请求。
type AnonymousCandidate struct{}

// NewAnonymousCandidate 创建匿名候选。
func NewAnonymousCandidate() AnonymousCandidate {
	return AnonymousCandidate{}
}

func (AnonymousCandidate) Kind() CandidateKind {
	return CandidateAnonymous
}

func (AnonymousCandidate) credentialCandidate() {}

// HumanBearerCandidate 是 HumanBearer 的请求局部候选。
type HumanBearerCandidate struct {
	credential SensitiveCredential
}

// GatewayHumanCandidate 是 service-gateway 已验证 Human 身份的内部候选。
type GatewayHumanCandidate struct {
	credential SensitiveCredential
	subject    string
}

// NewGatewayHumanCandidate 创建带内部服务凭证的 LightVela Human 候选。
func NewGatewayHumanCandidate(
	rawToken string,
	subject string,
) (GatewayHumanCandidate, error) {
	credential, err := newSensitiveCredential(rawToken)
	subject = strings.TrimSpace(subject)
	if err != nil || !validExternalSubject(subject) {
		return GatewayHumanCandidate{}, ErrInvalidCandidate
	}
	return GatewayHumanCandidate{credential: credential, subject: subject}, nil
}

func (GatewayHumanCandidate) Kind() CandidateKind { return CandidateGatewayHuman }

func (GatewayHumanCandidate) credentialCandidate() {}

func (candidate GatewayHumanCandidate) Credential() SensitiveCredential {
	return candidate.credential
}

func (candidate GatewayHumanCandidate) ExternalSubject() string {
	return candidate.subject
}

// NewHumanBearerCandidate 创建 Human Bearer 候选。
func NewHumanBearerCandidate(rawToken string) (HumanBearerCandidate, error) {
	credential, err := newSensitiveCredential(rawToken)
	if err != nil {
		return HumanBearerCandidate{}, err
	}
	return HumanBearerCandidate{credential: credential}, nil
}

func (HumanBearerCandidate) Kind() CandidateKind {
	return CandidateHumanBearer
}

func (HumanBearerCandidate) credentialCandidate() {}

// Credential 返回需要交给认证器验证的敏感 Token。
func (c HumanBearerCandidate) Credential() SensitiveCredential {
	return c.credential
}

// RuntimeBearerCandidate 是 RuntimeBearer 的请求局部候选。
type RuntimeBearerCandidate struct {
	credential SensitiveCredential
}

// NewRuntimeBearerCandidate 创建 Runtime Bearer 候选。
func NewRuntimeBearerCandidate(rawToken string) (RuntimeBearerCandidate, error) {
	credential, err := newSensitiveCredential(rawToken)
	if err != nil {
		return RuntimeBearerCandidate{}, err
	}
	return RuntimeBearerCandidate{credential: credential}, nil
}

func (RuntimeBearerCandidate) Kind() CandidateKind {
	return CandidateRuntimeBearer
}

func (RuntimeBearerCandidate) credentialCandidate() {}

// Credential 返回需要交给认证器验证的敏感 Token。
func (c RuntimeBearerCandidate) Credential() SensitiveCredential {
	return c.credential
}

// AgentCredentialCandidate 是 Agent credential 的请求局部候选。
type AgentCredentialCandidate struct {
	credential  SensitiveCredential
	routePrefix string
}

// ComputerBearerCandidate 是 Computer 短期 Bearer 的请求局部候选。
type ComputerBearerCandidate struct {
	credential SensitiveCredential
}

func NewComputerBearerCandidate(rawToken string) (ComputerBearerCandidate, error) {
	credential, err := newSensitiveCredential(rawToken)
	if err != nil {
		return ComputerBearerCandidate{}, err
	}
	return ComputerBearerCandidate{credential: credential}, nil
}

func (ComputerBearerCandidate) Kind() CandidateKind { return CandidateComputerBearer }

func (ComputerBearerCandidate) credentialCandidate() {}

func (c ComputerBearerCandidate) Credential() SensitiveCredential {
	return c.credential
}

// ComputerCredentialCandidate 是 Computer 长期 credential 的请求局部候选。
type ComputerCredentialCandidate struct {
	credential  SensitiveCredential
	routePrefix string
}

func NewComputerCredentialCandidate(
	rawSecret string,
	routePrefix string,
) (ComputerCredentialCandidate, error) {
	credential, err := newSensitiveCredential(rawSecret)
	if err != nil {
		return ComputerCredentialCandidate{}, err
	}
	return ComputerCredentialCandidate{
		credential:  credential,
		routePrefix: strings.TrimSpace(routePrefix),
	}, nil
}

func (ComputerCredentialCandidate) Kind() CandidateKind {
	return CandidateComputerCredential
}

func (ComputerCredentialCandidate) credentialCandidate() {}

func (c ComputerCredentialCandidate) Credential() SensitiveCredential {
	return c.credential
}

func (c ComputerCredentialCandidate) RoutePrefix() string {
	return c.routePrefix
}

// NewAgentCredentialCandidate 创建 Agent credential 候选。
func NewAgentCredentialCandidate(
	rawSecret string,
	routePrefix string,
) (AgentCredentialCandidate, error) {
	credential, err := newSensitiveCredential(rawSecret)
	if err != nil {
		return AgentCredentialCandidate{}, err
	}
	return AgentCredentialCandidate{
		credential:  credential,
		routePrefix: strings.TrimSpace(routePrefix),
	}, nil
}

func (AgentCredentialCandidate) Kind() CandidateKind {
	return CandidateAgentCredential
}

func (AgentCredentialCandidate) credentialCandidate() {}

// Credential 返回需要交给认证器验证的敏感 Secret。
func (c AgentCredentialCandidate) Credential() SensitiveCredential {
	return c.credential
}

// RoutePrefix 返回可用于数据库路由的非授权提示。
func (c AgentCredentialCandidate) RoutePrefix() string {
	return c.routePrefix
}

func newSensitiveCredential(raw string) (SensitiveCredential, error) {
	if strings.TrimSpace(raw) == "" {
		return SensitiveCredential{}, ErrInvalidCandidate
	}
	return SensitiveCredential{value: raw}, nil
}

// CurrentPrincipal 是已经过签名、到期和数据库 currentness 校验的主体。
type CurrentPrincipal interface {
	Kind() PrincipalKind
	currentPrincipal()
}

// CurrentAnonymousPrincipal 表示已确认允许匿名访问。
type CurrentAnonymousPrincipal struct{}

// NewCurrentAnonymousPrincipal 创建匿名主体。
func NewCurrentAnonymousPrincipal() CurrentAnonymousPrincipal {
	return CurrentAnonymousPrincipal{}
}

func (CurrentAnonymousPrincipal) Kind() PrincipalKind {
	return PrincipalAnonymous
}

func (CurrentAnonymousPrincipal) currentPrincipal() {}

// CurrentHumanPrincipal 表示当前有效的自然人登录会话。
type CurrentHumanPrincipal struct {
	accountID       string
	authSessionID   string
	tokenVersion    uint64
	externalSubject string
}

// NewCurrentGatewayHumanPrincipal 创建由 LightVela 身份映射的自然人主体。
func NewCurrentGatewayHumanPrincipal(
	accountID string,
	externalSubject string,
) (CurrentHumanPrincipal, error) {
	if !validID(accountID) || !validExternalSubject(externalSubject) {
		return CurrentHumanPrincipal{}, ErrInvalidPrincipal
	}
	return CurrentHumanPrincipal{
		accountID:       accountID,
		externalSubject: strings.TrimSpace(externalSubject),
	}, nil
}

// NewCurrentHumanPrincipal 创建自然人主体。
func NewCurrentHumanPrincipal(
	accountID string,
	authSessionID string,
	tokenVersion uint64,
) (CurrentHumanPrincipal, error) {
	if !validID(accountID) || !validID(authSessionID) {
		return CurrentHumanPrincipal{}, ErrInvalidPrincipal
	}
	return CurrentHumanPrincipal{
		accountID:     accountID,
		authSessionID: authSessionID,
		tokenVersion:  tokenVersion,
	}, nil
}

func (CurrentHumanPrincipal) Kind() PrincipalKind {
	return PrincipalHuman
}

func (CurrentHumanPrincipal) currentPrincipal() {}

func (p CurrentHumanPrincipal) AccountID() string {
	return p.accountID
}

func (p CurrentHumanPrincipal) AuthSessionID() string {
	return p.authSessionID
}

func (p CurrentHumanPrincipal) TokenVersion() uint64 {
	return p.tokenVersion
}

// ExternalSubject 返回 LightVela 权威用户 ID；本地登录主体为空。
func (p CurrentHumanPrincipal) ExternalSubject() string {
	return p.externalSubject
}

func validExternalSubject(value string) bool {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, "usr_") || len(value) <= len("usr_") || len(value) > 64 {
		return false
	}
	for _, character := range value[len("usr_"):] {
		if (character < 'a' || character > 'z') &&
			(character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') && character != '-' && character != '_' {
			return false
		}
	}
	return true
}

// CurrentRuntimePrincipal 表示当前有效的 Agent Runtime 会话。
type CurrentRuntimePrincipal struct {
	serverID          string
	computerID        string
	agentID           string
	launchID          string
	assignmentEpoch   string
	configGeneration  int64
	credentialVersion uint64
	attempt           int64
}

// NewCurrentRuntimePrincipal 创建 Runtime 主体。
func NewCurrentRuntimePrincipal(
	serverID string,
	agentID string,
	credentialVersion uint64,
) (CurrentRuntimePrincipal, error) {
	if !validID(serverID) || !validID(agentID) {
		return CurrentRuntimePrincipal{}, ErrInvalidPrincipal
	}
	return CurrentRuntimePrincipal{
		serverID:          serverID,
		agentID:           agentID,
		credentialVersion: credentialVersion,
	}, nil
}

// NewCurrentRuntimeLaunchPrincipal 创建绑定完整当前 Launch Fence 的 Runtime 主体。
func NewCurrentRuntimeLaunchPrincipal(
	serverID string,
	computerID string,
	agentID string,
	launchID string,
	assignmentEpoch string,
	configGeneration int64,
	credentialVersion uint64,
	attempt int64,
) (CurrentRuntimePrincipal, error) {
	if !validID(serverID) || !validID(computerID) || !validID(agentID) ||
		!validID(launchID) || !validID(assignmentEpoch) ||
		configGeneration < 1 || credentialVersion == 0 || attempt < 1 {
		return CurrentRuntimePrincipal{}, ErrInvalidPrincipal
	}
	return CurrentRuntimePrincipal{
		serverID: serverID, computerID: computerID, agentID: agentID,
		launchID: launchID, assignmentEpoch: assignmentEpoch,
		configGeneration:  configGeneration,
		credentialVersion: credentialVersion, attempt: attempt,
	}, nil
}

func (CurrentRuntimePrincipal) Kind() PrincipalKind {
	return PrincipalRuntime
}

func (CurrentRuntimePrincipal) currentPrincipal() {}

func (p CurrentRuntimePrincipal) ServerID() string {
	return p.serverID
}

func (p CurrentRuntimePrincipal) AgentID() string {
	return p.agentID
}

func (p CurrentRuntimePrincipal) ComputerID() string { return p.computerID }

func (p CurrentRuntimePrincipal) LaunchID() string { return p.launchID }

func (p CurrentRuntimePrincipal) AssignmentEpoch() string { return p.assignmentEpoch }

func (p CurrentRuntimePrincipal) ConfigGeneration() int64 { return p.configGeneration }

func (p CurrentRuntimePrincipal) Attempt() int64 { return p.attempt }

func (p CurrentRuntimePrincipal) CredentialVersion() uint64 {
	return p.credentialVersion
}

// CurrentAgentCredentialPrincipal 表示当前有效的长期 Agent credential。
type CurrentAgentCredentialPrincipal struct {
	serverID          string
	agentID           string
	credentialVersion uint64
}

// NewCurrentAgentCredentialPrincipal 创建 Agent credential 主体。
func NewCurrentAgentCredentialPrincipal(
	serverID string,
	agentID string,
	credentialVersion uint64,
) (CurrentAgentCredentialPrincipal, error) {
	if !validID(serverID) || !validID(agentID) {
		return CurrentAgentCredentialPrincipal{}, ErrInvalidPrincipal
	}
	return CurrentAgentCredentialPrincipal{
		serverID:          serverID,
		agentID:           agentID,
		credentialVersion: credentialVersion,
	}, nil
}

func (CurrentAgentCredentialPrincipal) Kind() PrincipalKind {
	return PrincipalAgentCredential
}

func (CurrentAgentCredentialPrincipal) currentPrincipal() {}

func (p CurrentAgentCredentialPrincipal) ServerID() string {
	return p.serverID
}

func (p CurrentAgentCredentialPrincipal) AgentID() string {
	return p.agentID
}

func (p CurrentAgentCredentialPrincipal) CredentialVersion() uint64 {
	return p.credentialVersion
}

// CurrentComputerPrincipal 表示已通过长期或短期凭据 currentness 校验的 Computer。
type CurrentComputerPrincipal struct {
	serverID          string
	computerID        string
	credentialVersion uint64
}

func NewCurrentComputerPrincipal(
	serverID string,
	computerID string,
	credentialVersion uint64,
) (CurrentComputerPrincipal, error) {
	if !validID(serverID) || !validID(computerID) || credentialVersion == 0 {
		return CurrentComputerPrincipal{}, ErrInvalidPrincipal
	}
	return CurrentComputerPrincipal{
		serverID:          serverID,
		computerID:        computerID,
		credentialVersion: credentialVersion,
	}, nil
}

func (CurrentComputerPrincipal) Kind() PrincipalKind { return PrincipalComputer }

func (CurrentComputerPrincipal) currentPrincipal() {}

func (p CurrentComputerPrincipal) ServerID() string { return p.serverID }

func (p CurrentComputerPrincipal) ComputerID() string { return p.computerID }

func (p CurrentComputerPrincipal) CredentialVersion() uint64 {
	return p.credentialVersion
}

// BotCredentialCandidate 是 LightVela Bot 长期凭据的请求局部候选。
type BotCredentialCandidate struct {
	credential SensitiveCredential
}

func NewBotCredentialCandidate(rawSecret string) (BotCredentialCandidate, error) {
	credential, err := newSensitiveCredential(rawSecret)
	if err != nil {
		return BotCredentialCandidate{}, err
	}
	return BotCredentialCandidate{credential: credential}, nil
}

func (BotCredentialCandidate) Kind() CandidateKind { return CandidateBotCredential }

func (BotCredentialCandidate) credentialCandidate() {}

func (c BotCredentialCandidate) Credential() SensitiveCredential { return c.credential }

// BotRuntimeBearerCandidate 是 Bot 短期运行 Token 的请求局部候选。
type BotRuntimeBearerCandidate struct {
	credential SensitiveCredential
}

func NewBotRuntimeBearerCandidate(rawToken string) (BotRuntimeBearerCandidate, error) {
	credential, err := newSensitiveCredential(rawToken)
	if err != nil {
		return BotRuntimeBearerCandidate{}, err
	}
	return BotRuntimeBearerCandidate{credential: credential}, nil
}

func (BotRuntimeBearerCandidate) Kind() CandidateKind { return CandidateBotRuntimeBearer }

func (BotRuntimeBearerCandidate) credentialCandidate() {}

func (c BotRuntimeBearerCandidate) Credential() SensitiveCredential { return c.credential }

// CurrentBotPrincipal 是已确认凭据版本仍为当前版本的 LightVela Bot。
//
// Kind 区分它来自长期凭据还是短期运行 Token；两者授权面互不重叠。
type CurrentBotPrincipal struct {
	kind              PrincipalKind
	accountID         string
	botAgentID        string
	credentialVersion uint64
}

func NewCurrentBotCredentialPrincipal(
	accountID string,
	botAgentID string,
	credentialVersion uint64,
) (CurrentBotPrincipal, error) {
	return newCurrentBotPrincipal(PrincipalBotCredential, accountID, botAgentID, credentialVersion)
}

func NewCurrentBotRuntimePrincipal(
	accountID string,
	botAgentID string,
	credentialVersion uint64,
) (CurrentBotPrincipal, error) {
	return newCurrentBotPrincipal(PrincipalBotRuntime, accountID, botAgentID, credentialVersion)
}

func newCurrentBotPrincipal(
	kind PrincipalKind,
	accountID string,
	botAgentID string,
	credentialVersion uint64,
) (CurrentBotPrincipal, error) {
	if !validID(accountID) || !validID(botAgentID) || credentialVersion == 0 {
		return CurrentBotPrincipal{}, ErrInvalidPrincipal
	}
	return CurrentBotPrincipal{
		kind:              kind,
		accountID:         accountID,
		botAgentID:        botAgentID,
		credentialVersion: credentialVersion,
	}, nil
}

func (p CurrentBotPrincipal) Kind() PrincipalKind { return p.kind }

func (CurrentBotPrincipal) currentPrincipal() {}

func (p CurrentBotPrincipal) AccountID() string { return p.accountID }

func (p CurrentBotPrincipal) BotAgentID() string { return p.botAgentID }

func (p CurrentBotPrincipal) CredentialVersion() uint64 { return p.credentialVersion }

// Authenticator 把候选凭证验证为当前有效主体。
type Authenticator interface {
	Authenticate(context.Context, CredentialCandidate) (CurrentPrincipal, error)
}

func validID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil
}

// AdminBearerCandidate 是管理后台 BFF 的服务端 Token 候选。
type AdminBearerCandidate struct {
	credential SensitiveCredential
}

func NewAdminBearerCandidate(rawToken string) (AdminBearerCandidate, error) {
	credential, err := newSensitiveCredential(rawToken)
	if err != nil {
		return AdminBearerCandidate{}, err
	}
	return AdminBearerCandidate{credential: credential}, nil
}

func (AdminBearerCandidate) Kind() CandidateKind { return CandidateAdminBearer }

func (AdminBearerCandidate) credentialCandidate() {}

func (c AdminBearerCandidate) Credential() SensitiveCredential { return c.credential }

// CurrentAdminPrincipal 是已通过管理员 Token 校验的管理后台调用方；它不代表任何账号。
type CurrentAdminPrincipal struct{}

func NewCurrentAdminPrincipal() CurrentAdminPrincipal { return CurrentAdminPrincipal{} }

func (CurrentAdminPrincipal) Kind() PrincipalKind { return PrincipalAdmin }

func (CurrentAdminPrincipal) currentPrincipal() {}
