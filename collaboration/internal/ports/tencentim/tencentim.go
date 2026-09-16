// Package tencentim 定义平台与腾讯云 IM 之间的最小边界。
package tencentim

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"
)

// Identity 是需要确保存在的普通腾讯云 IM 账号。
type Identity struct {
	UserID string
	Nick   string
}

// IdentityProvisioner 幂等确保一个普通 IM 账号存在。
type IdentityProvisioner interface {
	EnsureIdentity(context.Context, Identity) error
}

// IdentityDeprovisioner 先使既有登录态失效，再永久删除普通 IM 账号。
// 两个调用均须幂等；账号不存在视为成功。
type IdentityDeprovisioner interface {
	KickIdentity(context.Context, string) error
	DeleteIdentity(context.Context, string) error
}

// Community 是一个 Server 在腾讯云 IM 中的稳定资源投影。
type Community struct {
	GroupID      string
	OwnerUserID  string
	Name         string
	Introduction string
}

// CommunityProvisioner 幂等确保 Server 对应的 Community 存在且身份一致。
type CommunityProvisioner interface {
	EnsureCommunity(context.Context, Community) error
}

// DirectGroup 是一个 Server 内私信在腾讯云 IM 中的双人 Work 群投影。
// 群不设置 Owner_Account，成员只能由平台后台收敛。
type DirectGroup struct {
	GroupID       string
	Name          string
	MemberAUserID string
	MemberBUserID string
}

// DirectGroupProvisioner 幂等确保 Server 内私信对应的双人 Work 群存在且身份一致。
type DirectGroupProvisioner interface {
	EnsureDirectGroup(context.Context, DirectGroup) error
}

// Topic 是一个普通 Channel 在 Community 中的稳定资源投影。
type Topic struct {
	GroupID      string
	TopicID      string
	TopicName    string
	OwnerUserID  string
	Introduction string
	Private      bool
}

// TopicProvisioner 幂等确保 Channel 对应的 Topic 存在且身份一致。
type TopicProvisioner interface {
	EnsureTopic(context.Context, Topic) error
}

// Membership 是 Community 或私密 Topic 的单个成员目标。
type Membership struct {
	GroupID string
	TopicID string
	UserID  string
}

// MembershipProvisioner 幂等收敛 Community/私密 Topic 成员关系。
type MembershipProvisioner interface {
	EnsureMember(context.Context, Membership) error
	RemoveMember(context.Context, Membership) error
}

// UserSig 是只在一次响应中存在的腾讯云 IM 短期登录凭证。
type UserSig struct {
	Value     string
	ExpiresAt time.Time
}

// Format 防止 UserSig 被日志格式化输出。
func (UserSig) Format(state fmt.State, _ rune) {
	_, _ = io.WriteString(state, "[REDACTED]")
}

// MarshalJSON 禁止直接序列化领域凭据；响应层必须显式映射一次性字段。
func (UserSig) MarshalJSON() ([]byte, error) {
	return nil, errors.New("UserSig 禁止通用 JSON 序列化")
}

// UserSigIssuer 只为调用方明确给出的稳定 UserID 签发短期凭证。
type UserSigIssuer interface {
	Issue(context.Context, string, time.Duration) (UserSig, error)
}

// AgentNotification is a lossy wake hint. It contains only stable resource
// references; the Runtime fetches durable Task/Reminder truth over HTTP.
type AgentNotification struct {
	ToUserID   string
	Type       string
	ServerID   string
	AgentID    string
	ResourceID string
	Revision   int64
	EventID    string
}

// AgentNotificationSender sends a machine-only CustomElem to one Agent IM
// identity. Repeating an identical EventID must be safe.
type AgentNotificationSender interface {
	SendAgentNotification(context.Context, AgentNotification) error
}

type classifiedError interface {
	error
	TencentCode() string
	Retryable() bool
}

// IsRetryable 判断腾讯云调用是否可以按相同幂等操作安全重试。
func IsRetryable(err error) bool {
	var classified classifiedError
	return errors.As(err, &classified) && classified.Retryable()
}

// CodeOf 返回不包含腾讯响应原文的稳定诊断码。
func CodeOf(err error) string {
	var classified classifiedError
	if errors.As(err, &classified) {
		return classified.TencentCode()
	}
	return ""
}
