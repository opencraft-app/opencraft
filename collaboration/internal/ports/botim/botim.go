// Package botim 定义 LightVela Bot IM 身份、IM 路由与平台群的持久化和外部协作边界。
package botim

import (
	"context"
	"errors"
	"time"

	authnport "git.woa.com/wisp/mono2/collaboration/internal/ports/authn"
)

var (
	// ErrNotFound 表示按路由键点查的资源不存在。
	ErrNotFound = errors.New("资源不存在")
	// ErrConflict 表示唯一键或 revision CAS 冲突。
	ErrConflict = errors.New("资源已变化")
	// ErrBotNotOwned 表示宿主确认该实例或 Bot 不属于当前账号。
	ErrBotNotOwned = errors.New("Bot 不属于当前账号")
)

const (
	BotStateProvisioning = "provisioning"
	BotStateReady        = "ready"
	BotStateError        = "error"
	BotStateDeleted      = "deleted"

	CommandPolicyOwner  = "owner"
	CommandPolicyAnyone = "anyone"

	IdentityKindHuman = "human"
	IdentityKindBot   = "bot"

	GroupStateProvisioning = "provisioning"
	GroupStateActive       = "active"
	GroupStateDismissed    = "dismissed"

	ReplyModeMention        = "mention"
	ReplyModeMentionContext = "mention_context"
	ReplyModeAll            = "all"

	RoleOwner  = "owner"
	RoleAdmin  = "admin"
	RoleMember = "member"

	MemberStateActive  = "active"
	MemberStateRemoved = "removed"
)

// BotAgent 是一个 LightVela Bot 的独立 IM 身份。
type BotAgent struct {
	ID                string
	AccountID         string
	InstanceID        string
	BotID             string
	DisplayName       string
	IMUserID          string
	State             string
	LastErrorCode     string
	CommandPolicy     string
	CredentialVersion int64
	CredentialDigest  []byte
	Revision          int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// Route 把腾讯 IM UserID 定位到账号或 Bot。
type Route struct {
	IMUserID     string
	Kind         string
	AccountID    string
	BotAgentID   string
	RestrictedAt *time.Time
}

// Account 是群与 Bot 逻辑需要的最小账号投影。
type Account struct {
	ID       string
	IMUserID string
	IMState  string
}

// Group 是平台群的权威事实。
type Group struct {
	ID                string
	TencentGroupID    string
	OwnerAccountID    string
	CreatedByIMUserID string
	Name              string
	ReplyMode         string
	State             string
	Revision          int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// GroupMember 是平台群成员关系。
type GroupMember struct {
	GroupID         string
	IMUserID        string
	Kind            string
	Role            string
	State           string
	AddedByIMUserID string
}

// Repository 是 Bot、路由、账号投影与平台群的持久化边界。
type Repository interface {
	FindAccount(context.Context, string) (Account, error)

	FindBotByRef(ctx context.Context, accountID, instanceID, botID string) (BotAgent, error)
	FindBot(ctx context.Context, accountID, botAgentID string) (BotAgent, error)
	ListBots(ctx context.Context, accountID string, limit int) ([]BotAgent, error)
	// CountActiveBots 统计账号下未删除的 Bot，即该账号占用的腾讯 Bot 账号数。
	CountActiveBots(ctx context.Context, accountID string) (int, error)
	// InsertBot 插入新 Bot；同一账号下 instance/bot 已存在时返回 ErrConflict。
	InsertBot(context.Context, BotAgent) (BotAgent, error)
	// SaveBot 以 expectedRevision 做 CAS，成功后返回 revision+1 的新事实。
	SaveBot(ctx context.Context, bot BotAgent, expectedRevision int64) (BotAgent, error)

	FindRoute(context.Context, string) (Route, error)
	// EnsureRoute 幂等写入路由；已存在且指向其他目标时返回 ErrConflict。
	EnsureRoute(context.Context, Route) (Route, error)
	SetRouteRestricted(ctx context.Context, imUserID string, restrictedAt *time.Time) (Route, error)

	FindGroup(context.Context, string) (Group, []GroupMember, error)
	// InsertGroup 在一个事务内写入群与初始成员；群 ID 已存在时返回 ErrConflict。
	InsertGroup(context.Context, Group, []GroupMember) error
	SaveGroup(ctx context.Context, group Group, expectedRevision int64) (Group, error)
	// UpsertMember 写入或恢复成员关系，并推进群 revision。
	UpsertMember(context.Context, GroupMember) error
	// MarkMemberRemoved 把成员标记为 removed；成员不存在时视为成功。
	MarkMemberRemoved(ctx context.Context, groupID, imUserID string) error
}

// HostRequest 标识一个 LightVela 实例上的 Bot。
type HostRequest struct {
	AccountSubject string
	InstanceID     string
	BotID          string
	DisplayName    string
}

// HostVerification 是宿主确认归属后返回的 Bot 资料。
type HostVerification struct {
	DisplayName string
}

// Delivery 是交付到 Bot 所在实例的配置；Credential 只允许在交付调用内读取。
type Delivery struct {
	HostRequest
	BotAgentID string
	IMUserID   string
	SDKAppID   int
	APIBaseURL string
	Credential authnport.SensitiveCredential
}

// Host 抽象 Bot 所在实例的宿主控制面（生产为 CTL，开发机为本地命令）。
type Host interface {
	Verify(context.Context, HostRequest) (HostVerification, error)
	Deliver(context.Context, Delivery) error
	Revoke(context.Context, HostRequest) error
}

// TencentGroup 是平台群在腾讯侧的期望状态。
type TencentGroup struct {
	GroupID       string
	Name          string
	OwnerUserID   string
	MemberUserIDs []string
}

// PolicyNotice 是规则变化后发往群内的自定义消息内容；不含聊天正文。
type PolicyNotice struct {
	GroupID   string
	ReplyMode string
	Revision  int64
}

// TencentGroups 是平台群在腾讯云 IM 上的幂等管理面。
type TencentGroups interface {
	EnsureGroup(context.Context, TencentGroup) error
	AddMembers(ctx context.Context, tencentGroupID string, userIDs []string) error
	RemoveMembers(ctx context.Context, tencentGroupID string, userIDs []string) error
	Rename(ctx context.Context, tencentGroupID string, name string) error
	Destroy(ctx context.Context, tencentGroupID string) error
	SendPolicyNotice(ctx context.Context, tencentGroupID string, notice PolicyNotice) error
}
