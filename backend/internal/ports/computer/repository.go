// Package computer 定义 Computer 管理用例与持久化之间的最小边界。
package computer

import (
	"context"
	"errors"
	"time"
)

var (
	ErrServerNotFound                   = errors.New("Server 不存在")
	ErrComputerNotFound                 = errors.New("Computer 不存在")
	ErrComputerNameConflict             = errors.New("Computer 名称冲突")
	ErrInstanceConflict                 = errors.New("TAT 实例已绑定")
	ErrIdempotencyConflict              = errors.New("幂等请求冲突")
	ErrRegistrationActive               = errors.New("Computer 注册流程进行中")
	ErrAdminRequired                    = errors.New("需要 Server 管理权限")
	ErrCredentialExists                 = errors.New("Computer Runtime Credential 已存在")
	ErrCredentialNotCurrent             = errors.New("Computer Runtime Credential 已失效")
	ErrEnrollmentRevisionConflict       = errors.New("Computer enrollment revision 冲突")
	ErrComputerAlreadyClaimed           = errors.New("Computer 已完成 claim")
	ErrEnrollmentInvalid                = errors.New("Computer enrollment token 无效")
	ErrEnrollmentExpired                = errors.New("Computer enrollment token 已过期")
	ErrEnrollmentClaimConflict          = errors.New("Computer enrollment digest 冲突")
	ErrSetupCodeInvalid                 = errors.New("Computer setup code 无效")
	ErrComputerInstallTargetUnsupported = errors.New("Computer install target 不支持")
	ErrSetupCodeTargetConflict          = errors.New("Computer setup code target 冲突")
	ErrComputerHasBoundAgents           = errors.New("Computer 仍有绑定 Agent")
	ErrTATBindingInconsistent           = errors.New("Computer TAT binding 状态不一致")
	ErrCredentialInspectionNotFound     = errors.New("Computer credential inspection 不存在")
	ErrReplacementIdentityMismatch      = errors.New("Computer replacement identity 不匹配")
	ErrReplacementBindingMissing        = errors.New("Computer replacement binding 缺失")
	ErrProviderIdentityGone             = errors.New("Computer provider identity 已销毁")
	ErrReplacementReleaseMismatch       = errors.New("Computer replacement release 不匹配")
)

// Computer 是平台保存的 TAT 执行资源映射，不包含腾讯云凭据。
type Computer struct {
	ID                    string
	ServerID              string
	Name                  string
	TATRegion             string
	TATInstanceID         *string
	TATInstanceKind       string
	OSType                string
	LifecycleState        string
	TATAgentState         string
	RegistrationExpiresAt *time.Time
	HostLastSeenAt        *time.Time
	LastObservedAt        *time.Time
	LastErrorCode         string
	Revision              int64
	EnrollmentGeneration  uint64
	EnrollmentClaimedAt   *time.Time
}

// ArtifactBinding 是签发 setup generation 时固化的不可变对象描述。
type ArtifactBinding struct {
	ObjectKey string   `json:"objectKey"`
	SHA256    [32]byte `json:"sha256"`
	Size      int64    `json:"size"`
}

// ReleaseBinding 是一次 enrollment 可访问的完整发布对象集合。
type ReleaseBinding struct {
	Version      string          `json:"version"`
	Target       string          `json:"target"`
	OSType       string          `json:"osType"`
	Architecture string          `json:"architecture"`
	SigningKeyID string          `json:"signingKeyId"`
	Manifest     ArtifactBinding `json:"manifest"`
	Signature    ArtifactBinding `json:"signature"`
	Installer    ArtifactBinding `json:"installer"`
	Program      ArtifactBinding `json:"program"`
}

// ReleaseSet 是生成 setup generation 时固化的完整多目标发布快照。
type ReleaseSet struct {
	Version  string           `json:"version"`
	Releases []ReleaseBinding `json:"releases"`
}

// BeginEnrollmentCommand 在现有 Computer 行上以 revision/generation 做单分片 CAS。
type BeginEnrollmentCommand struct {
	AccountID          string
	ServerID           string
	ComputerID         string
	ExpectedRevision   int64
	ExpectedGeneration uint64
	Generation         uint64
	TokenHash          [32]byte
	ExpiresAt          time.Time
	Release            ReleaseBinding
	ReleaseSet         ReleaseSet
	CreatedAt          time.Time
}

// ClaimEnrollmentCommand 只携带客户端生成 credential 的摘要，不携带 secret。
type ClaimEnrollmentCommand struct {
	ServerID            string
	ComputerID          string
	Generation          uint64
	TokenHash           [32]byte
	OSType              string
	Architecture        string
	InstallerVersion    string
	CredentialID        string
	CredentialDigest    [32]byte
	CredentialExpiresAt time.Time
	ClaimedAt           time.Time
	Replacement         *ReplacementClaim
}

type ReplacementClaim struct {
	OldServerID          string
	OldComputerID        string
	OldCredentialVersion uint64
	OldComputerRevision  int64
	BindingHash          string
	TATRegion            string
	TATInstanceID        string
	NewServerID          string
	NewComputerID        string
	NewGeneration        uint64
	NewTokenHash         [32]byte
	ReleaseVersion       string
	Target               string
	ProgramSHA256        [32]byte
	ProviderAttested     bool
	GrantExpired         bool
}

// EnrollmentClaim 是客户端组合 crc_ credential 所需的非 Secret 路由。
type EnrollmentClaim struct {
	ServerID          string
	ComputerID        string
	CredentialID      string
	CredentialVersion uint64
	ExpiresAt         time.Time
	Created           bool
}

// InspectCredentialCommand 是 preflight 的精确、只读 credential 路由。
type InspectCredentialCommand struct {
	ServerID   string
	ComputerID string
	Version    uint64
}

// CredentialInspection 返回分类所需的非明文事实；它不恢复 credential currentness。
type CredentialInspection struct {
	ServerID         string
	ComputerID       string
	Version          uint64
	SecretDigest     [32]byte
	CredentialState  string
	ExpiresAt        time.Time
	GraceExpiresAt   *time.Time
	RevokedAt        *time.Time
	ComputerState    string
	ComputerRevision int64
}

type AuthorizeReplacementCommand struct {
	OldServerID          string
	OldComputerID        string
	OldCredentialVersion uint64
	NewServerID          string
	NewComputerID        string
	NewGeneration        uint64
	NewTokenHash         [32]byte
	TATRegion            string
	TATInstanceID        string
	ReleaseVersion       string
	Target               string
	ProgramSHA256        [32]byte
	RequestedAt          time.Time
}

type ReplacementAuthorization struct {
	OldComputerRevision int64
	BindingHash         string
	ProviderAttested    bool
	OSType              string
	ReleaseVersion      string
	Target              string
	ProgramSHA256       [32]byte
}

// StoreSetupCodeCommand 只保存不可逆摘要和稳定路由，不保存短码明文。
type StoreSetupCodeCommand struct {
	ID         string
	CodeHash   string
	ServerID   string
	ComputerID string
	Generation uint64
	ExpiresAt  time.Time
	CreatedAt  time.Time
}

// ResolveSetupCodeCommand 在全局短码索引中解析单个路由。
type ResolveSetupCodeCommand struct {
	CodeHash    string
	RequestedAt time.Time
}

type SetupCodeRoute struct {
	ServerID   string
	ComputerID string
	Generation uint64
	ExpiresAt  time.Time
}

// ValidateSetupCodeCommand 在 server_id 分片内验证当前 enrollment generation。
type BindEnrollmentTargetCommand struct {
	ServerID    string
	ComputerID  string
	Generation  uint64
	TokenHash   [32]byte
	Target      string
	RequestedAt time.Time
}

type SetupCodeRedemption struct {
	ServerID   string
	ComputerID string
	Generation uint64
	ExpiresAt  time.Time
	Release    SetupCodeRelease
}

type SetupCodeRelease struct {
	Version         string
	Target          string
	InstallerSHA256 [32]byte
}

// EnrollmentRepository 保存 setup generation 并完成幂等 claim。
type EnrollmentRepository interface {
	GetForAdmin(context.Context, string, string, string) (Computer, error)
	BeginEnrollment(context.Context, BeginEnrollmentCommand) (Computer, error)
	StoreSetupCode(context.Context, StoreSetupCodeCommand) error
	ResolveSetupCode(context.Context, ResolveSetupCodeCommand) (SetupCodeRoute, error)
	BindEnrollmentTarget(context.Context, BindEnrollmentTargetCommand) (SetupCodeRedemption, error)
	InspectCredential(context.Context, InspectCredentialCommand) (CredentialInspection, error)
	AuthorizeReplacement(context.Context, AuthorizeReplacementCommand) (ReplacementAuthorization, error)
	ClaimEnrollment(context.Context, ClaimEnrollmentCommand) (EnrollmentClaim, error)
}

// ResolveArtifactCommand 使用 token 自带路由精确读取某一 generation 的固化制品。
type ResolveArtifactCommand struct {
	ServerID    string
	ComputerID  string
	Generation  uint64
	TokenHash   [32]byte
	Version     string
	Target      string
	File        string
	RequestedAt time.Time
}

// ArtifactAccess 是通过 enrollment 鉴权后的单个私有对象，不包含签名 URL。
type ArtifactAccess struct {
	ObjectKey string
	SHA256    [32]byte
	Size      int64
	ExpiresAt time.Time
}

type ArtifactRepository interface {
	ResolveEnrollmentArtifact(context.Context, ResolveArtifactCommand) (ArtifactAccess, error)
}

// ArtifactURLSigner 只为后台选定的 object key 生成短期 GET 地址。
type ArtifactURLSigner interface {
	PresignGet(context.Context, string, time.Duration) (string, error)
}

// Draft 是创建事务中的新 Computer。
type Draft struct {
	ID              string
	Name            string
	TATRegion       string
	TATInstanceID   *string
	TATInstanceKind string
	OSType          string
	LifecycleState  string
}

// CreateCommand 携带幂等创建所需的全部稳定事实。
type CreateCommand struct {
	AccountID      string
	ServerID       string
	IdempotencyKey string
	RequestHash    [32]byte
	Computer       Draft
	CreatedAt      time.Time
}

// ReleaseCommand 解除平台映射；真实实例不在该事务中销毁。
type ReleaseCommand struct {
	AccountID      string
	ServerID       string
	ComputerID     string
	IdempotencyKey string
	ReleasedAt     time.Time
}

// Operation 是公开给管理面的脱敏异步操作。
type Operation struct {
	ID            string
	ServerID      string
	Service       string
	Kind          string
	State         string
	CreatedAt     time.Time
	CompletedAt   *time.Time
	LastErrorCode string
}

// RefreshCommand 创建一个可靠、幂等的 TAT 状态刷新操作。
type RefreshCommand struct {
	AccountID        string
	ServerID         string
	ComputerID       string
	ComputerRevision int64
	OperationID      string
	IdempotencyKey   string
	CreatedAt        time.Time
}

// RegistrationCommand 在注册码签发后启动标签对账，不保存注册码明文。
type RegistrationCommand struct {
	AccountID        string
	ServerID         string
	ComputerID       string
	ComputerRevision int64
	OperationID      string
	ExpiresAt        time.Time
	CreatedAt        time.Time
}

type CredentialCommand struct {
	AccountID        string
	ServerID         string
	ComputerID       string
	Mode             string
	CredentialID     string
	SecretHash       [32]byte
	IdempotencyKey   string
	RequestHash      [32]byte
	ExpiresAt        time.Time
	HandoffExpiresAt time.Time
	CreatedAt        time.Time
}

// CredentialRotationCommand carries the authenticated current version and
// all timestamps needed to rotate the credential atomically.
type CredentialRotationCommand struct {
	ServerID         string
	ComputerID       string
	CurrentVersion   uint64
	CredentialID     string
	SecretHash       [32]byte
	IdempotencyKey   string
	RequestHash      [32]byte
	ExpiresAt        time.Time
	GraceExpiresAt   time.Time
	HandoffExpiresAt time.Time
	CreatedAt        time.Time
}

type Credential struct {
	ID             string
	ServerID       string
	ComputerID     string
	Version        uint64
	ExpiresAt      time.Time
	GraceExpiresAt *time.Time
	Created        bool
}

type CredentialRepository interface {
	IssueCredential(context.Context, CredentialCommand) (Credential, error)
	RotateCredential(context.Context, CredentialRotationCommand) (Credential, error)
}

// Repository 在 active Human membership 授权后读写 Computer。
type Repository interface {
	Create(context.Context, CreateCommand) (Computer, error)
	Release(context.Context, ReleaseCommand) error
	List(context.Context, string, string) ([]Computer, error)
	Get(context.Context, string, string, string) (Computer, error)
	GetForAdmin(context.Context, string, string, string) (Computer, error)
	EnqueueRefresh(context.Context, RefreshCommand) (Operation, error)
	BeginRegistration(context.Context, RegistrationCommand) (Operation, error)
}
