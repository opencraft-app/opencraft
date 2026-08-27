package sandbox

import "time"

// CreateSandboxRequest defines the payload for creating a sandbox.
type CreateSandboxRequest struct {
	TemplateClassID     string            `json:"template_class_id,omitempty"`
	TemplateID          string            `json:"templateID"`
	SKUID               string            `json:"sku_id,omitempty"`
	Timeout             *int32            `json:"timeout,omitempty"`
	AutoPause           *bool             `json:"autoPause,omitempty"`
	Secure              *bool             `json:"secure,omitempty"`
	AllowInternetAccess *bool             `json:"allow_internet_access,omitempty"`
	Metadata            map[string]string `json:"metadata,omitempty"`
	EnvVars             map[string]string `json:"envVars,omitempty"`
}

// ListSandboxesRequest defines the query params for listing sandboxes.
type ListSandboxesRequest struct {
	Metadata  string
	State     []string
	NextToken string
	Limit     *int32
}

// ResumeSandboxRequest defines the payload for resuming a sandbox.
type ResumeSandboxRequest struct {
	Timeout   *int32 `json:"timeout,omitempty"`
	AutoPause *bool  `json:"autoPause,omitempty"`
}

// GetLogsRequest defines the query params for fetching sandbox logs.
type GetLogsRequest struct {
	Start *int64
	Limit *int32
}

// Sandbox represents a sandbox entity returned by the API.
type Sandbox struct {
	TemplateID      string  `json:"templateID"`
	SandboxID       string  `json:"sandboxID"`
	Alias           string  `json:"alias,omitempty"`
	ClientID        string  `json:"clientID,omitempty"`
	EnvdVersion     string  `json:"envdVersion"`
	EnvdAccessToken string  `json:"envdAccessToken,omitempty"`
	Domain          *string `json:"domain,omitempty"`
}

// SandboxDetail represents a detailed sandbox response.
type SandboxDetail struct {
	Sandbox
	StartedAt  time.Time         `json:"startedAt"`
	EndAt      time.Time         `json:"endAt"`
	CPUCount   int32             `json:"cpuCount"`
	MemoryMB   int64             `json:"memoryMB"`
	DiskSizeMB int64             `json:"diskSizeMB"`
	Metadata   map[string]string `json:"metadata,omitempty"`
	State      string            `json:"state"`
}

// ListedSandbox represents an item in sandbox list responses.
type ListedSandbox struct {
	SandboxDetail
}

// SandboxLog represents a raw log line from the sandbox.
type SandboxLog struct {
	Timestamp time.Time `json:"timestamp"`
	Line      string    `json:"line"`
}

// SandboxLogEntry represents a structured sandbox log line.
type SandboxLogEntry struct {
	Timestamp time.Time         `json:"timestamp"`
	Level     string            `json:"level"`
	Message   string            `json:"message"`
	Fields    map[string]string `json:"fields"`
}

// SandboxLogs contains both raw and structured sandbox logs.
type SandboxLogs struct {
	Logs       []SandboxLog      `json:"logs"`
	LogEntries []SandboxLogEntry `json:"logEntries"`
}

// ExecCommandRequest defines the payload for executing a TAT command.
type ExecCommandRequest struct {
	Bash string `json:"bash"`
}

// InvokeCommandRequest invokes an existing TAT command. Parameter values may
// contain credentials and therefore must never be logged by callers.
type InvokeCommandRequest struct {
	CommandID  string            `json:"command_id"`
	Parameters map[string]string `json:"parameters"`
}

// TATCommandResponse represents the sandbox TAT command submission response.
type TATCommandResponse struct {
	SandboxID    string `json:"sandboxID"`
	PoolID       string `json:"poolID"`
	InstanceID   string `json:"instanceID"`
	Region       string `json:"region"`
	CommandID    string `json:"commandID"`
	InvocationID string `json:"invocationID"`
	Status       string `json:"status"`
}

// TATCommandResult represents the full TAT command execution result.
type TATCommandResult struct {
	TATCommandResponse
	ExitCode      int64  `json:"exitCode"`
	Output        string `json:"output"`
	ErrorInfo     string `json:"errorInfo,omitempty"`
	StartTime     string `json:"startTime,omitempty"`
	EndTime       string `json:"endTime,omitempty"`
	ExecutionTime string `json:"executionTime,omitempty"`
}

// TATCommandMetadataResult is the output-free status contract used for
// credential-bearing internal TAT invocations.
type TATCommandMetadataResult struct {
	TATCommandResponse
	ExitCode      int64  `json:"exitCode"`
	StartTime     string `json:"startTime,omitempty"`
	EndTime       string `json:"endTime,omitempty"`
	ExecutionTime string `json:"executionTime,omitempty"`
}

// TerminalSession is the browser bootstrap payload for a Tencent TAT websocket session.
type TerminalSession struct {
	SandboxID      string `json:"sandboxId"`
	PoolID         string `json:"poolId"`
	SessionID      string `json:"sessionId"`
	Region         string `json:"region"`
	InstanceID     string `json:"instanceId"`
	OwnerUin       string `json:"ownerUin"`
	LoginUin       string `json:"loginUin"`
	AppID          int64  `json:"appId"`
	WsURL          string `json:"wsUrl"`
	Cols           int    `json:"cols"`
	Rows           int    `json:"rows"`
	TimeoutSeconds int    `json:"timeoutSeconds,omitempty"`
	Username       string `json:"username,omitempty"`
	WorkingDir     string `json:"workingDirectory,omitempty"`
}

// ExecCommandResult is the business-layer abstraction of a command execution result.
type ExecCommandResult struct {
	InvocationID string
	CommandID    string
	Status       string // SUCCESS, FAILED, TIMEOUT
	ExitCode     int64
	Output       string
	Stdout       string
	Stderr       string
	ErrorInfo    string
	StartTime    string
	EndTime      string
}

type ProcessStartRequest struct {
	Cmd  string
	Args []string
	Env  map[string]string
	Pty  bool
	Cols uint32
	Rows uint32
}

type ProcessStreamEvent struct {
	PID      uint32
	Stdout   string
	Stderr   string
	ExitCode int32
	Status   string
	Error    string
	Ended    bool
}

type PtyExecStreamRequest struct {
	Command          string `json:"command"`
	Username         string `json:"username"`
	WorkingDirectory string `json:"working_directory"`
	TimeoutSeconds   int    `json:"timeout_seconds"`
}

type PtyExecStreamEvent struct {
	Type        string `json:"type"`
	ExecutionID string `json:"execution_id,omitempty"`
	Index       int    `json:"index,omitempty"`
	Chunk       string `json:"chunk,omitempty"`
	Status      string `json:"status,omitempty"`
	ExitCode    int64  `json:"exit_code,omitempty"`
	Code        string `json:"code,omitempty"`
	Message     string `json:"message,omitempty"`
}

type PtyExecStreamError struct {
	Code    string
	Message string
}

func (e *PtyExecStreamError) Error() string {
	if e == nil {
		return "tat pty command stream failed"
	}
	if e.Message == "" {
		return "tat pty command stream failed: " + e.Code
	}
	return "tat pty command stream failed: " + e.Message
}

// APIError is the upstream API error response format.
type APIError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type Pool struct {
	ID                        string   `json:"id"`
	Name                      string   `json:"name"`
	Description               string   `json:"description,omitempty"`
	BaseImage                 string   `json:"base_image"`
	DesiredCapacity           int      `json:"desired_capacity"`
	InstanceType              string   `json:"instance_type"`
	Status                    string   `json:"status"`
	PauseReason               string   `json:"pause_reason,omitempty"`
	ConsecutiveRefillFailures int      `json:"consecutive_refill_failures,omitempty"`
	LastRefillErrorCode       string   `json:"last_refill_error_code,omitempty"`
	LastRefillError           string   `json:"last_refill_error,omitempty"`
	VpcID                     string   `json:"vpc_id"`
	SubnetID                  string   `json:"subnet_id"`
	Zone                      string   `json:"zone"`
	SecurityGroups            []string `json:"security_groups,omitempty"`
	TemplateClassID           string   `json:"template_class_id,omitempty"`
	SKUID                     string   `json:"sku_id,omitempty"`
	CapacityState             string   `json:"capacity_state,omitempty"`
}

type PoolInstance struct {
	ID        string    `json:"id"`
	PoolID    string    `json:"pool_id"`
	State     string    `json:"state"`
	CloudID   string    `json:"cloud_id,omitempty"`
	Address   string    `json:"address,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// === trade-pass-destroy 设计稿落地（§5.2 sandbox snapshot 端点 DTO）===
// 设计稿：.tmp/trade-pass-destroy-design.md §5.2 / §11-A Q4 / Q4-b / Q9 / Q9-fix / Q25
//
// 销毁链路 ctl → sandbox 的两个新增端点 DTO：
//   - POST /sandboxes/{sandboxID}/snapshot           → CreateSnapshotRequest / CreateSnapshotResponse
//   - GET  /sandboxes/{sandboxID}/snapshot-status    → GetSnapshotStatusResponse
//
// 单实例单系统盘单快照模型（Q9）：sandbox 端内部 DescribeDisks 反查 SystemDiskId 后调
// cbs.CreateSnapshot；ctl 不感知系统盘维度，只拿到一个 snapshotID。

// CreateSnapshotRequest 销毁子 task 阶段 1 调 sandbox `POST /sandboxes/{sandboxID}/snapshot` 入参
//
// 字段含义：
//   - InstanceID：与 sandboxID 等价的业务实例标识（Q9-fix：snapshot 表唯一键含 instance_id）
//   - PassID：用于 sandbox 拼快照名 `{passID}-{instanceID}`
//   - UserID：审计回写 + ctl snapshot 表镜像
//   - Region：Q21 拍板，本期 ctl 取 config.ServerConf.MiscConfig.Region
//   - RetentionSeconds：Q7 拍板，由 ctl 配置 [snapshot] retention 转秒数传入；sandbox 透传给 cbs Deadline
//
// 注：原协议曾有 Uin / AppID 字段（资源 owner 的腾讯云 UIN/AppID），2026-05-25 拍板移除：
// sandbox 调 cbs 用的是 sandbox 服务自身配置的腾讯云 AK/SK，资源 owner 由该 AK/SK 自动决定，
// 与 ctl 业务侧 uin（uin_jifei_05 → 700000164995）不是同一概念，原透传无任何下游消费。
type CreateSnapshotRequest struct {
	InstanceID       string `json:"instanceID"`
	PassID           string `json:"passID"`
	UserID           string `json:"userID"`
	Region           string `json:"region"`
	RetentionSeconds int64  `json:"retentionSeconds"`
}

// CreateSnapshotResponse 销毁子 task 阶段 1 sandbox 返回
//
// SnapshotID 为 cbs 真实 snapshot id（如 `snap-xxxxxxxx`），ctl 据此入 snapshot 表 + 后续轮询。
type CreateSnapshotResponse struct {
	SnapshotID string `json:"snapshotID"`
}

// GetSnapshotStatusResponse 销毁子 task 阶段 2 调 sandbox `GET .../snapshot-status?snapshotID=...` 返回
//
// Status 取值（已抽象，不暴露 cbs 原生枚举给 ctl，与 ctl snapshot.Entity.SnapshotState 字段值对齐）：
//   - "ready"        → cbs NORMAL（快照已就绪可用）
//   - "in_progress"  → cbs CREATING / CREATING_PERCENT
//   - "failed"       → cbs ERROR（Reason 字段附原因；ctl 子 task 据此走终态失败分支）
type GetSnapshotStatusResponse struct {
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}
