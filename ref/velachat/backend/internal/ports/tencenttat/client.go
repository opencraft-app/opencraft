// Package tencenttat 定义平台领域与腾讯云 TAT 之间的最小边界。
package tencenttat

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

// OS 是 TAT Agent 已探测出的操作系统。
type OS string

const (
	OSLinux   OS = "linux"
	OSWindows OS = "windows"
	OSMacOS   OS = "macos"
)

// ObservedOSCompatible 判断 TAT wire 上观察到的系统能否代表产品系统。
//
// 当前批准的 Rust macOS Bridge 为兼容 TAT 托管实例协议会报告 Linux，因此只允许
// desired macOS 单向接受 observed Linux；Linux 不能反向接受 macOS。
func ObservedOSCompatible(desired OS, observed OS) bool {
	if desired == OSMacOS {
		return observed == OSMacOS || observed == OSLinux
	}
	return desired == observed
}

// CommandType 是腾讯云 TAT 支持的受限命令类型。
type CommandType string

const (
	CommandShell      CommandType = "SHELL"
	CommandPowerShell CommandType = "POWERSHELL"
	// UsernameCurrentUser 只供受控的 macOS TAT Bridge 将命令绑定到自身用户。
	UsernameCurrentUser = "__chatserver_current_user__"
)

// TemplateKind 是平台唯一允许执行的生命周期模板。
type TemplateKind string

const (
	TemplateDeploy            TemplateKind = "deploy"
	TemplateStart             TemplateKind = "start"
	TemplateStop              TemplateKind = "stop"
	TemplateRestart           TemplateKind = "restart"
	TemplateProbe             TemplateKind = "probe"
	TemplateCredentialInstall TemplateKind = "credential-install"
)

var runtimeCredentialPattern = regexp.MustCompile(`^arc_[A-Za-z0-9._-]{16,}$`)

// Target 是一次调用的精确地域和实例路由。
type Target struct {
	Region     string
	InstanceID string
	OS         OS
}

// Validate 拒绝缺少地域、实例或未知 OS 的目标。
func (target Target) Validate() error {
	if strings.TrimSpace(target.Region) == "" ||
		strings.TrimSpace(target.InstanceID) == "" {
		return errors.New("TAT 目标缺少地域或实例")
	}
	switch target.OS {
	case OSLinux, OSWindows, OSMacOS:
		return nil
	default:
		return errors.New("TAT 目标操作系统无效")
	}
}

// RuntimeCredential 是只允许显式交给一次 TAT 请求的敏感值。
type RuntimeCredential struct{ value string }

// NewRuntimeCredential 校验 Agent 长期凭据的安全字符集。
func NewRuntimeCredential(raw string) (RuntimeCredential, error) {
	if len(raw) > 4096 || !runtimeCredentialPattern.MatchString(raw) {
		return RuntimeCredential{}, errors.New("Runtime Credential 格式无效")
	}
	return RuntimeCredential{value: raw}, nil
}

// RevealForRequest 只供 TAT Adapter 在组装单次请求时调用。
func (credential RuntimeCredential) RevealForRequest() string {
	return credential.value
}

// IsZero 允许编排层校验是否存在，而不读取原文。
func (credential RuntimeCredential) IsZero() bool {
	return credential.value == ""
}

// Format 阻止日志和错误格式化泄漏凭据。
func (RuntimeCredential) Format(state fmt.State, _ rune) {
	_, _ = io.WriteString(state, "[REDACTED]")
}

// MarshalJSON 禁止敏感值进入快照或通用 JSON。
func (RuntimeCredential) MarshalJSON() ([]byte, error) {
	return nil, errors.New("Runtime Credential 禁止通用 JSON 序列化")
}

// Command 是由应用层固定模板编译出的只读命令。
type Command struct {
	template            TemplateKind
	operationID         string
	target              Target
	commandType         CommandType
	content             string
	workingDirectory    string
	username            string
	timeout             time.Duration
	sensitiveParameters map[string]RuntimeCredential
}

// CommandSpec 是固定模板编译器构造 Command 的完整参数。
type CommandSpec struct {
	Template            TemplateKind
	OperationID         string
	Target              Target
	CommandType         CommandType
	Content             string
	WorkingDirectory    string
	Username            string
	Timeout             time.Duration
	SensitiveParameters map[string]RuntimeCredential
}

// NewCommand 创建只读命令；未知模板和非法路由无法越过此边界。
func NewCommand(spec CommandSpec) (Command, error) {
	if !IsTemplateAllowed(spec.Template) ||
		!validUUIDv7(spec.OperationID) ||
		spec.Target.Validate() != nil ||
		strings.TrimSpace(spec.Content) == "" ||
		strings.TrimSpace(spec.WorkingDirectory) == "" ||
		spec.Timeout <= 0 || spec.Timeout > 24*time.Hour {
		return Command{}, errors.New("TAT 固定命令参数无效")
	}
	switch spec.CommandType {
	case CommandShell:
		if spec.Target.OS != OSLinux && spec.Target.OS != OSMacOS {
			return Command{}, errors.New("TAT 命令类型与目标系统不匹配")
		}
	case CommandPowerShell:
		if spec.Target.OS != OSWindows {
			return Command{}, errors.New("TAT 命令类型与目标系统不匹配")
		}
	default:
		return Command{}, errors.New("TAT 命令类型无效")
	}
	parameters := make(map[string]RuntimeCredential, len(spec.SensitiveParameters))
	for key, value := range spec.SensitiveParameters {
		if key != "runtimeCredential" || value.value == "" {
			return Command{}, errors.New("TAT 隐藏参数无效")
		}
		parameters[key] = value
	}
	if spec.Template == TemplateCredentialInstall && len(parameters) != 1 {
		return Command{}, errors.New("凭据安装模板缺少隐藏参数")
	}
	if spec.Template != TemplateCredentialInstall && len(parameters) != 0 {
		return Command{}, errors.New("非凭据模板禁止携带隐藏参数")
	}
	return Command{
		template:            spec.Template,
		operationID:         spec.OperationID,
		target:              spec.Target,
		commandType:         spec.CommandType,
		content:             spec.Content,
		workingDirectory:    spec.WorkingDirectory,
		username:            spec.Username,
		timeout:             spec.Timeout,
		sensitiveParameters: parameters,
	}, nil
}

func (command Command) Template() TemplateKind       { return command.template }
func (command Command) OperationID() string          { return command.operationID }
func (command Command) Target() Target               { return command.target }
func (command Command) CommandType() CommandType     { return command.commandType }
func (command Command) Content() string              { return command.content }
func (command Command) WorkingDirectory() string     { return command.workingDirectory }
func (command Command) Username() string             { return command.username }
func (command Command) Timeout() time.Duration       { return command.timeout }
func (command Command) SensitiveParameterCount() int { return len(command.sensitiveParameters) }

// VisitSensitiveParameters 暂时暴露参数给单次 SDK 请求，调用方不得保存。
func (command Command) VisitSensitiveParameters(
	visit func(string, RuntimeCredential) error,
) error {
	for key, value := range command.sensitiveParameters {
		if err := visit(key, value); err != nil {
			return err
		}
	}
	return nil
}

// CommandSnapshot 是可安全持久化的非敏感操作摘要。
type CommandSnapshot struct {
	Template    TemplateKind `json:"template"`
	OperationID string       `json:"operationId"`
	Region      string       `json:"region"`
	InstanceID  string       `json:"instanceId"`
	OS          OS           `json:"os"`
}

// Snapshot 返回不含脚本和参数名的安全摘要。
func (command Command) Snapshot() CommandSnapshot {
	return CommandSnapshot{
		Template:    command.template,
		OperationID: command.operationID,
		Region:      command.target.Region,
		InstanceID:  command.target.InstanceID,
		OS:          command.target.OS,
	}
}

// Invocation 是 RunCommand 返回的稳定引用。
type Invocation struct {
	InvocationID string
	CommandID    string
	Status       Status
}

// Status 是执行活动/任务归一化状态。
type Status string

const (
	StatusPending   Status = "pending"
	StatusRunning   Status = "running"
	StatusSucceeded Status = "succeeded"
	StatusFailed    Status = "failed"
	StatusTimedOut  Status = "timed_out"
	StatusCancelled Status = "cancelled"
)

// AgentStatus 是 TAT Automation Agent 的最小探测结果。
type AgentStatus struct {
	Online bool
	OS     OS
}

// RegistrationRequest 创建只允许一台外部机器使用的短期注册码。
type RegistrationRequest struct {
	Region        string
	Description   string
	NamePrefix    string
	RegisterLimit int64
	EffectiveTime time.Duration
}

// Registration 是只在当前 HTTP 请求内存中存在的一次性注册码。
type Registration struct {
	CodeID    string
	CodeValue string
	ExpiresAt time.Time
}

// ManagedInstance 是按平台 Computer 标签发现的 Rust TAT Bridge。
type ManagedInstance struct {
	InstanceID string
	OS         OS
	Online     bool
}

// Registrar 创建 TAT 托管实例注册码。实现不得记录 CodeValue。
type Registrar interface {
	CreateRegistration(context.Context, RegistrationRequest) (Registration, error)
}

// ManagedInstanceFinder 按平台写入的 Computer 标签读取唯一托管实例事实。
type ManagedInstanceFinder interface {
	FindManagedByComputerTag(
		context.Context,
		string,
		string,
	) (ManagedInstance, bool, error)
}

// TerminalTarget 是内部 Session Issuer 使用的稳定 Computer/TAT locator。
// sandboxId、poolId 等供应商私有字段不得进入该结构。
type TerminalTarget struct {
	ComputerID   string
	Region       string
	InstanceKind string
	InstanceID   string
	OS           OS
}

// Validate 拒绝无法精确路由到单台 Computer 的签发目标。
func (target TerminalTarget) Validate() error {
	if !validUUIDv7(target.ComputerID) ||
		(Target{
			Region: target.Region, InstanceID: target.InstanceID, OS: target.OS,
		}).Validate() != nil {
		return errors.New("TAT 终端目标无效")
	}
	switch target.InstanceKind {
	case "cvm", "lighthouse", "managed":
		return nil
	default:
		return errors.New("TAT 终端实例类型无效")
	}
}

// TerminalSession 是签发给 Human 客户端的一次性短期数据面引导信息。
// 它不应被持久化或写入日志。
type TerminalSession struct {
	SessionID      string
	WebSocketURL   string
	ExpiresAt      time.Time
	OwnerUIN       string
	AppID          int64
	InstanceID     string
	Cols           int
	Rows           int
	MaxIdleSeconds int
}

// TerminalSessionIssuer 只负责创建短期 PTY；它不代理终端字节。
type TerminalSessionIssuer interface {
	Issue(context.Context, TerminalTarget) (TerminalSession, error)
}

// Client 执行固定命令并查询云端事实。
type Client interface {
	ManagedInstanceFinder
	Run(context.Context, Command) (Invocation, error)
	FindByOperation(context.Context, Target, string) (Invocation, bool, error)
	Inspect(context.Context, Target, string) (Invocation, error)
	Probe(context.Context, Target) (AgentStatus, error)
}

type classifiedError interface {
	error
	TATCode() string
	Retryable() bool
	Uncertain() bool
}

func CodeOf(err error) string {
	var classified classifiedError
	if errors.As(err, &classified) {
		return classified.TATCode()
	}
	return ""
}

func IsRetryable(err error) bool {
	var classified classifiedError
	return errors.As(err, &classified) && classified.Retryable()
}

func IsUncertain(err error) bool {
	var classified classifiedError
	return errors.As(err, &classified) && classified.Uncertain()
}

// IsTemplateAllowed 是固定模板白名单的唯一判断。
func IsTemplateAllowed(kind TemplateKind) bool {
	switch kind {
	case TemplateDeploy, TemplateStart, TemplateStop, TemplateRestart,
		TemplateProbe, TemplateCredentialInstall:
		return true
	default:
		return false
	}
}

func validUUIDv7(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 7
}
