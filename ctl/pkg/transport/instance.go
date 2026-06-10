package transport

import "time"

const DefaultInstanceTimeoutSeconds int32 = 15
const MaxInstanceTimeoutSeconds int32 = 24 * 60 * 60

// CreateInstanceRequest 创建实例请求
type CreateInstanceRequest struct {
	// 实例超时时间（秒），范围 15~86400，默认 15
	Timeout *int32 `json:"timeout,omitempty" example:"3600"`
	// 用户可见名称，留空时由前端决定默认展示名
	Name string `json:"name,omitempty" example:"我的龙虾"`
	// 预设 SOUL 模板 ID，例如 gentle、humor、pro；为空时保持镜像默认 SOUL
	SoulTemplateID string `json:"soul_template_id,omitempty" example:"gentle"`
}

// UpdateInstanceRequest 更新实例请求
type UpdateInstanceRequest struct {
	// 用户可见名称
	Name *string `json:"name,omitempty" example:"新的名字"`
}

// SoulTemplateResponse 可用 SOUL 模板信息
type SoulTemplateResponse struct {
	// 模板 ID，例如 gentle、humor、pro
	ID string `json:"id" example:"gentle"`
	// 模板名称
	Name string `json:"name" example:"Gentle & Caring"`
	// 模板描述
	Description string `json:"description" example:"Warm, patient, and supportive tone."`
}

// ListSoulTemplatesResponse SOUL 模板列表响应
type ListSoulTemplatesResponse struct {
	Items []*SoulTemplateResponse `json:"items"`
}

// UserUsageResponse 用户用量概览响应
type UserUsageResponse struct {
	// 已消耗积分（token 数）
	UsedCredits int64 `json:"used_credits" example:"128000"`
	// 套餐总积分
	TotalCredits int64 `json:"total_credits" example:"1000000"`
	// 总请求次数
	TotalRequests int64 `json:"total_requests" example:"42"`
}

// ResumeInstanceRequest 恢复实例请求
type ResumeInstanceRequest struct {
	// 实例超时时间（秒），范围 15~86400，可选
	Timeout *int32 `json:"timeout,omitempty" example:"7200"`
}

// SetTimeoutRequest 设置超时请求
type SetTimeoutRequest struct {
	// 实例超时时间（秒），范围 15~86400
	Timeout *int32 `json:"timeout" example:"1800"`
}

// InstanceConfigResetProvider 返回给前端的一次性配置下发材料。
type InstanceConfigResetProvider struct {
	ProviderName string `json:"provider_name" example:"custom"`
	BaseURL      string `json:"base_url" example:"https://api.lightvela.ai/v1"`
	ModelID      string `json:"model_id" example:"lightvela/default"`
	API          string `json:"api" example:"chat_completions"`
	APIKey       string `json:"api_key" example:"sk-xxxx"`
}

// InstanceConfigResetResponse 实例配置重置准备响应。
type InstanceConfigResetResponse struct {
	KeyID     string                       `json:"key_id" example:"550e8400-e29b-41d4-a716-446655440000"`
	KeyPrefix string                       `json:"key_prefix" example:"sk-abcd1"`
	Config    *InstanceConfigResetProvider `json:"config"`
}

// TerminalSessionResponse returns a bot-scoped TAT websocket bootstrap.
// It intentionally omits the underlying sandbox id; callers only need the TAT session fields.
type TerminalSessionResponse struct {
	PoolID         string `json:"poolId,omitempty"`
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
}

// PaginationParams 分页参数
type PaginationParams struct {
	// 页码，从 1 开始，默认 1
	Page int `json:"page,omitempty" example:"1"`
	// 每页条数，默认 10，最大 100
	PageSize int `json:"page_size,omitempty" example:"20"`
}

// InstanceResponse 实例响应
type InstanceResponse struct {
	// 实例 ID (UUID v4 格式)
	InstanceID string `json:"instance_id" example:"550e8400-e29b-41d4-a716-446655440000"`
	// 用户可见名称
	Name string `json:"name,omitempty" example:"我的龙虾"`
	// 沙箱 ID，对应底层 CVM 实例 ID (可选)
	SandboxID string `json:"sandbox_id,omitempty" example:"i-0d94b4c46d7c4d8c"`
	// 实例状态: Creating, Running, Paused, Failed, Deleting, Isolating, Deleted
	Status string `json:"status" example:"Running"`
	// 实例创建时间 (RFC3339 格式)
	CreatedAt time.Time `json:"created_at" example:"2026-03-23T10:30:00Z"`
	// 实例超时时间 (RFC3339 格式，可选)
	TimeoutAt *time.Time `json:"timeout_at,omitempty" example:"2026-03-23T11:30:00Z"`
}

// ListInstancesResponse 实例列表响应
type ListInstancesResponse struct {
	// 实例总数
	Total int64 `json:"total" example:"42"`
	// 当前页码
	Page int `json:"page" example:"1"`
	// 每页条数
	PageSize int `json:"page_size" example:"20"`
	// 实例列表
	Items []*InstanceResponse `json:"items"`
}

// BotSummaryResponse 只读 bot 归属摘要
type BotSummaryResponse struct {
	// Bot 对应的 ctl instance_id
	InstanceID string `json:"instance_id" example:"ins_123"`
	// 用户可见名称
	Name string `json:"name,omitempty" example:"我的龙虾"`
	// Bot 所属用户
	UserID string `json:"user_id" example:"usr_123"`
	// 关联的 sandbox id
	SandboxID string `json:"sandbox_id,omitempty" example:"sbx_123"`
	// 实例状态
	Status string `json:"status" example:"Running"`
	// 创建时间
	CreatedAt time.Time `json:"created_at" example:"2026-03-29T12:00:00Z"`
	// 最近更新时间
	UpdatedAt time.Time `json:"updated_at" example:"2026-03-29T12:30:00Z"`
	// 超时时间
	TimeoutAt *time.Time `json:"timeout_at,omitempty" example:"2026-03-29T13:00:00Z"`
	// 北京时间出生日期
	BornDateForChina string `json:"born_date_for_china,omitempty" example:"2026-03-30"`
	// 北京时间当天第几只出生
	BornNumberForChina *int `json:"born_number_for_china,omitempty" example:"12"`
}

// ListBotsResponse bot 归属列表
type ListBotsResponse struct {
	Total    int64                 `json:"total" example:"42"`
	Page     int                   `json:"page" example:"1"`
	PageSize int                   `json:"page_size" example:"20"`
	Items    []*BotSummaryResponse `json:"items"`
}

// BotBornCardResponse bot 出生卡
type BotBornCardResponse struct {
	InstanceID         string     `json:"instance_id" example:"ins_123"`
	Name               string     `json:"name,omitempty" example:"我的龙虾"`
	UserID             string     `json:"user_id" example:"usr_123"`
	SandboxID          string     `json:"sandbox_id,omitempty" example:"sbx_123"`
	Status             string     `json:"status" example:"Running"`
	CreatedAt          time.Time  `json:"created_at" example:"2026-03-29T12:00:00Z"`
	UpdatedAt          time.Time  `json:"updated_at" example:"2026-03-29T12:30:00Z"`
	TimeoutAt          *time.Time `json:"timeout_at,omitempty" example:"2026-03-29T13:00:00Z"`
	BornDateForChina   string     `json:"born_date_for_china" example:"2026-03-30"`
	BornNumberForChina int        `json:"born_number_for_china" example:"12"`
}

// OperationResponse 操作记录响应
type OperationResponse struct {
	// 操作记录 ID (UUID v4 格式)
	OperationID string `json:"operation_id" example:"550e8400-e29b-41d4-a716-446655440001"`
	// 操作类型: Create, Delete, Pause, Resume, SetTimeout, ExecCommand
	OperationType string `json:"operation_type" example:"Create"`
	// 关联的实例 ID
	InstanceID string `json:"instance_id" example:"550e8400-e29b-41d4-a716-446655440000"`
	// 操作状态: Pending, InProgress, Succeeded, Failed
	Status string `json:"status" example:"Succeeded"`
	// 错误信息，状态为 Failed 时显示 (可选)
	ErrorMessage string `json:"error_message,omitempty" example:"Failed to create CVM instance"`
	// 操作创建时间 (RFC3339 格式)
	CreatedAt time.Time `json:"created_at" example:"2026-03-23T10:30:00Z"`
	// 操作最后更新时间 (RFC3339 格式)
	UpdatedAt time.Time `json:"updated_at" example:"2026-03-23T10:31:00Z"`
}

// ListOperationsResponse 操作记录列表响应
type ListOperationsResponse struct {
	// 操作记录总数
	Total int64 `json:"total" example:"100"`
	// 当前页码
	Page int `json:"page" example:"1"`
	// 每页条数
	PageSize int `json:"page_size" example:"20"`
	// 操作记录列表
	Items []*OperationResponse `json:"items"`
}

// ExecDebugCommandRequest 调试命令请求
type ExecDebugCommandRequest struct {
	// 调试命令。支持内置别名（如 openclaw_version）或直接传 bash 命令（如 hostname -I）
	Command string `json:"command" example:"openclaw_version"`
	// 可选：使用指定系统用户执行命令。目前仅允许白名单用户。
	RunAsUser string `json:"run_as_user,omitempty" example:"agentuser"`
}

// ExecDebugCommandResponse 调试命令响应
type ExecDebugCommandResponse struct {
	// 命令状态: Running, Succeeded, Failed, Timeout
	Status string `json:"status" example:"Succeeded"`
	// 实际执行命令的系统用户（若指定）
	RunAsUser string `json:"run_as_user,omitempty" example:"agentuser"`
	// 命令退出码 (0 表示成功)
	ExitCode int64 `json:"exit_code" example:"0"`
	// 命令输出内容
	Output string `json:"output" example:"openclaw version 1.2.3"`
	// 标准输出内容
	Stdout string `json:"stdout,omitempty" example:"openclaw version 1.2.3"`
	// 标准错误内容
	Stderr string `json:"stderr,omitempty" example:"openclaw config not found"`
	// 人类可读的失败摘要
	Detail string `json:"detail,omitempty" example:"exit code 1: openclaw config not found"`
	// 腾讯云 TAT 命令 ID (可选)
	CommandID string `json:"command_id,omitempty" example:"cmd-0d94b4c46d7c4d8c"`
	// 腾讯云 TAT 调用 ID (可选)
	InvocationID string `json:"invocation_id,omitempty" example:"inv-0d94b4c46d7c4d8c"`
	// 命令开始时间 (RFC3339 格式，可选)
	StartTime string `json:"start_time,omitempty" example:"2026-03-23T10:30:00Z"`
	// 命令结束时间 (RFC3339 格式，可选)
	EndTime string `json:"end_time,omitempty" example:"2026-03-23T10:30:05Z"`
}

// ExecDebugCommandStreamEvent 调试命令流式事件
type ExecDebugCommandStreamEvent struct {
	// 事件类型：started / stdout / stderr / finished / error
	Type string `json:"type" example:"stdout"`
	// 输出流名称，仅 stdout/stderr 事件有值
	Stream string `json:"stream,omitempty" example:"stdout"`
	// 当前事件的文本分片
	Chunk string `json:"chunk,omitempty" example:"hello world\n"`
	// 合成 invocation id，started/finished 事件可用
	InvocationID string `json:"invocation_id,omitempty" example:"pid:1234"`
	// 合成 command id，started/finished 事件可用
	CommandID string `json:"command_id,omitempty" example:"pid:1234"`
	// 实际执行用户
	RunAsUser string `json:"run_as_user,omitempty" example:"agentuser"`
	// 结束事件时的完整聚合结果
	Response *ExecDebugCommandResponse `json:"response,omitempty"`
}

// WorkspaceFileResponse 实例 workspace 文件
type WorkspaceFileResponse struct {
	// 文件名，例如 SOUL.md
	Name string `json:"name" example:"SOUL.md"`
	// 文件内容
	Content string `json:"content"`
	// 文件是否存在
	Exists bool `json:"exists" example:"true"`
}

// WorkspaceFilesResponse workspace 文件列表
type WorkspaceFilesResponse struct {
	Items []*WorkspaceFileResponse `json:"items"`
}

type ChatClawAgentResponse struct {
	ID            string    `json:"id" example:"agent_123"`
	Name          string    `json:"name" example:"Research Agent"`
	Description   string    `json:"description" example:"Investigates and summarizes evidence."`
	Specialty     string    `json:"specialty" example:"research"`
	WorkspacePath string    `json:"workspace_path,omitempty" example:"/home/lightclaw/.openclaw/workspace-agent_123"`
	CreatedAt     time.Time `json:"created_at" example:"2026-04-11T06:30:00Z"`
	UpdatedAt     time.Time `json:"updated_at" example:"2026-04-11T06:30:00Z"`
}

type ChatClawTeamResponse struct {
	ID          string    `json:"id" example:"team_123"`
	Name        string    `json:"name" example:"Review Team"`
	Description string    `json:"description,omitempty" example:"Shared review lane"`
	AgentIDs    []string  `json:"agent_ids"`
	CreatedAt   time.Time `json:"created_at" example:"2026-04-11T06:30:00Z"`
	UpdatedAt   time.Time `json:"updated_at" example:"2026-04-11T06:30:00Z"`
}

type ChatClawConversationResponse struct {
	ID        string    `json:"id" example:"conv_123"`
	Kind      string    `json:"kind" example:"conversation"`
	AgentID   string    `json:"agent_id,omitempty" example:"agent_123"`
	TeamID    string    `json:"team_id,omitempty" example:"team_123"`
	Title     string    `json:"title" example:"New conversation"`
	CreatedAt time.Time `json:"created_at" example:"2026-04-11T06:30:00Z"`
	UpdatedAt time.Time `json:"updated_at" example:"2026-04-11T06:30:00Z"`
}

type ChatClawRuntimeBootstrapResponse struct {
	UserID             string   `json:"user_id" example:"usr_123"`
	InstanceID         string   `json:"instance_id" example:"ins_123"`
	ConversationID     string   `json:"conversation_id" example:"conv_123"`
	ConversationKind   string   `json:"conversation_kind" example:"conversation"`
	AgentID            string   `json:"agent_id,omitempty" example:"main"`
	TeamID             string   `json:"team_id,omitempty" example:"team_123"`
	TeamAgentIDs       []string `json:"team_agent_ids,omitempty"`
	SessionID          string   `json:"session_id" example:"ses_123"`
	SessionTitle       string   `json:"session_title" example:"New conversation"`
	UpstreamSessionKey string   `json:"upstream_session_key" example:"agent:main:chatclaw:123"`
	GatewayURL         string   `json:"gateway_url" example:"wss://18789-sandbox-123.sandbox.lightclaw.tech"`
	GatewayToken       string   `json:"gateway_token" example:"gw_123"`
}

type AgentChatLaunchTokenResponse struct {
	LaunchToken string `json:"launch_token" example:"eyJ1c2VyX2lkIjoi..."`
	ExpiresAt   int64  `json:"expires_at" example:"1800000300"`
}

type AgentChatIntrospectRequest struct {
	LaunchToken  string `json:"launch_token"`
	BusinessCode string `json:"businessCode"`
	Timestamp    int64  `json:"timestamp"`
	Sign         string `json:"sign"`
}

type AgentChatIntrospectResponse struct {
	UserID     string `json:"user_id" example:"usr_123"`
	InstanceID string `json:"instance_id" example:"ins_123"`
}

type ChatClawStateResponse struct {
	Agents        []*ChatClawAgentResponse        `json:"agents"`
	Teams         []*ChatClawTeamResponse         `json:"teams"`
	Conversations []*ChatClawConversationResponse `json:"conversations"`
}

type CreateChatClawAgentRequest struct {
	Name        string `json:"name" example:"Research Agent"`
	Description string `json:"description,omitempty" example:"Investigates and summarizes evidence."`
	Specialty   string `json:"specialty" example:"research"`
}

type UpdateChatClawAgentRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	Specialty   *string `json:"specialty,omitempty"`
}

type CreateChatClawTeamRequest struct {
	Name        string   `json:"name" example:"Review Team"`
	Description string   `json:"description,omitempty" example:"Shared review lane"`
	AgentIDs    []string `json:"agent_ids"`
}

type UpdateChatClawTeamRequest struct {
	Name        *string  `json:"name,omitempty"`
	Description *string  `json:"description,omitempty"`
	AgentIDs    []string `json:"agent_ids,omitempty"`
}

type CreateChatClawConversationRequest struct {
	Kind    string `json:"kind" example:"conversation"`
	AgentID string `json:"agent_id,omitempty" example:"agent_123"`
	TeamID  string `json:"team_id,omitempty" example:"team_123"`
	Title   string `json:"title,omitempty" example:"New conversation"`
}

type UpdateChatClawConversationRequest struct {
	AgentID *string `json:"agent_id,omitempty"`
	Title   *string `json:"title,omitempty"`
}

// UpdateWorkspaceFileRequest 更新 workspace 文件
type UpdateWorkspaceFileRequest struct {
	// 文件名，例如 SOUL.md
	Name string `json:"name" example:"SOUL.md"`
	// 文件内容
	Content string `json:"content"`
}

type UploadWorkspaceAttachmentRequest struct {
	OwnerType      string `json:"owner_type" example:"agent"`
	OwnerID        string `json:"owner_id" example:"agent_123"`
	ConversationID string `json:"conversation_id,omitempty" example:"conv_123"`
	FileName       string `json:"file_name" example:"spec.md"`
	MediaType      string `json:"media_type" example:"text/markdown"`
	SizeBytes      int64  `json:"size_bytes" example:"1024"`
	Content        []byte `json:"-"`
}

type ListWorkspaceUploadsRequest struct {
	OwnerType      string `json:"owner_type,omitempty" example:"agent"`
	OwnerID        string `json:"owner_id,omitempty" example:"agent_123"`
	ConversationID string `json:"conversation_id,omitempty" example:"conv_123"`
	Limit          int    `json:"limit,omitempty" example:"50"`
}

type WorkspaceUploadResponse struct {
	ID             string    `json:"id" example:"upload_123"`
	Store          string    `json:"store,omitempty" example:"workspace-upload"`
	StoreKey       string    `json:"store_key,omitempty" example:"upload_123"`
	OwnerType      string    `json:"owner_type" example:"agent"`
	OwnerID        string    `json:"owner_id" example:"agent_123"`
	AgentID        string    `json:"agent_id" example:"agent_123"`
	ConversationID string    `json:"conversation_id,omitempty" example:"conv_123"`
	FileName       string    `json:"file_name" example:"spec.md"`
	MediaType      string    `json:"media_type" example:"text/markdown"`
	SizeBytes      int64     `json:"size_bytes" example:"1024"`
	WorkspacePath  string    `json:"workspace_path" example:"/home/lightclaw/.openclaw/workspace-agent_123"`
	RelativePath   string    `json:"relative_path" example:"uploads/upload_123-spec.md"`
	ContentURL     string    `json:"content_url,omitempty" example:"/v1/instances/ins_123/workspace/uploads/upload_123/content"`
	CreatedAt      time.Time `json:"created_at" example:"2026-04-11T06:30:00Z"`
	UpdatedAt      time.Time `json:"updated_at" example:"2026-04-11T06:30:00Z"`
}

type WorkspaceUploadsResponse struct {
	Items []*WorkspaceUploadResponse `json:"items"`
}

type AutomationScheduleState struct {
	NextRunAtMs        *int64 `json:"next_run_at_ms,omitempty"`
	RunningAtMs        *int64 `json:"running_at_ms,omitempty"`
	LastRunAtMs        *int64 `json:"last_run_at_ms,omitempty"`
	LastRunStatus      string `json:"last_run_status,omitempty"`
	LastError          string `json:"last_error,omitempty"`
	LastDeliveryStatus string `json:"last_delivery_status,omitempty"`
}

type AutomationSchedule struct {
	ID             string                   `json:"id"`
	Title          string                   `json:"title,omitempty"`
	Prompt         string                   `json:"prompt,omitempty"`
	Cron           string                   `json:"cron,omitempty"`
	Timezone       string                   `json:"timezone,omitempty"`
	AgentID        string                   `json:"agent_id,omitempty"`
	SessionKey     string                   `json:"session_key,omitempty"`
	Name           string                   `json:"name"`
	Description    string                   `json:"description,omitempty"`
	Enabled        bool                     `json:"enabled"`
	DeleteAfterRun bool                     `json:"delete_after_run,omitempty"`
	SessionTarget  string                   `json:"session_target"`
	WakeMode       string                   `json:"wake_mode"`
	PromptSummary  string                   `json:"prompt_summary,omitempty"`
	Status         string                   `json:"status,omitempty"`
	LastRunAt      string                   `json:"last_run_at,omitempty"`
	LastRunStatus  string                   `json:"last_run_status,omitempty"`
	LastError      string                   `json:"last_error,omitempty"`
	NextRunAt      string                   `json:"next_run_at,omitempty"`
	Schedule       map[string]interface{}   `json:"schedule"`
	Payload        map[string]interface{}   `json:"payload"`
	Delivery       map[string]interface{}   `json:"delivery,omitempty"`
	State          *AutomationScheduleState `json:"state,omitempty"`
	CreatedAtMs    int64                    `json:"created_at_ms"`
	UpdatedAtMs    int64                    `json:"updated_at_ms"`
}

type AutomationSchedulesResponse struct {
	Items  []*AutomationSchedule `json:"items"`
	Total  int64                 `json:"total"`
	Limit  int64                 `json:"limit,omitempty"`
	Offset int64                 `json:"offset,omitempty"`
}

type CreateAutomationScheduleRequest struct {
	Title          string                 `json:"title,omitempty"`
	Prompt         string                 `json:"prompt,omitempty"`
	Cron           string                 `json:"cron,omitempty"`
	Timezone       string                 `json:"timezone,omitempty"`
	Name           string                 `json:"name"`
	Description    string                 `json:"description,omitempty"`
	Enabled        *bool                  `json:"enabled,omitempty"`
	DeleteAfterRun *bool                  `json:"delete_after_run,omitempty"`
	AgentID        string                 `json:"agent_id,omitempty"`
	SessionKey     string                 `json:"session_key,omitempty"`
	SessionTarget  string                 `json:"session_target"`
	WakeMode       string                 `json:"wake_mode"`
	Schedule       map[string]interface{} `json:"schedule"`
	Payload        map[string]interface{} `json:"payload"`
	Delivery       map[string]interface{} `json:"delivery,omitempty"`
}

type UpdateAutomationScheduleRequest struct {
	Title          *string                `json:"title,omitempty"`
	Prompt         *string                `json:"prompt,omitempty"`
	Cron           *string                `json:"cron,omitempty"`
	Timezone       *string                `json:"timezone,omitempty"`
	Name           *string                `json:"name,omitempty"`
	Description    *string                `json:"description,omitempty"`
	Enabled        *bool                  `json:"enabled,omitempty"`
	DeleteAfterRun *bool                  `json:"delete_after_run,omitempty"`
	AgentID        *string                `json:"agent_id,omitempty"`
	SessionKey     *string                `json:"session_key,omitempty"`
	SessionTarget  *string                `json:"session_target,omitempty"`
	WakeMode       *string                `json:"wake_mode,omitempty"`
	Schedule       map[string]interface{} `json:"schedule,omitempty"`
	Payload        map[string]interface{} `json:"payload,omitempty"`
	Delivery       map[string]interface{} `json:"delivery,omitempty"`
}

type AutomationRunResponse struct {
	ID                 string `json:"id"`
	Status             string `json:"status,omitempty"`
	Summary            string `json:"summary,omitempty"`
	LastRunAtMs        *int64 `json:"last_run_at_ms,omitempty"`
	LastDeliveryStatus string `json:"last_delivery_status,omitempty"`
}

type CreateWeixinLoginSessionResponse struct {
	SessionID string `json:"session_id" example:"wxlogin_123"`
	Status    string `json:"status" example:"starting"`
}

type WeixinLoginSessionResponse struct {
	SessionID     string     `json:"session_id" example:"wxlogin_123"`
	Status        string     `json:"status" example:"waiting_qr"`
	QRURL         string     `json:"qr_url,omitempty" example:"https://example.com/qr"`
	QRASCII       string     `json:"qr_ascii,omitempty"`
	LastOutput    string     `json:"last_output,omitempty"`
	StartedAt     time.Time  `json:"started_at" example:"2026-03-23T10:30:00Z"`
	ExpiresAt     time.Time  `json:"expires_at" example:"2026-03-23T10:35:00Z"`
	FinishedAt    *time.Time `json:"finished_at,omitempty" example:"2026-03-23T10:31:00Z"`
	ErrorMessage  string     `json:"error_message,omitempty"`
	RestartStatus string     `json:"restart_status,omitempty" example:"success"`
	RestartError  string     `json:"restart_error,omitempty"`
}

// ConfigureChannelRequest 配置通道请求
type ConfigureChannelRequest struct {
	// 通道名称，如 qqbot、openclaw-weixin、feishu 等
	Channel string `json:"channel" example:"qqbot"`
	// 通道凭证
	Token string `json:"token" example:"123456789:app-secret"`
	// 同通道多账号标识（可选）
	Account string `json:"account,omitempty" example:"bot1"`
}

// ConfigureChannelResponse 配置通道响应
type ConfigureChannelResponse struct {
	// 操作状态: Succeeded, Failed
	Status string `json:"status" example:"Succeeded"`
	// 通道名称
	Channel string `json:"channel" example:"qqbot"`
	// Gateway 是否已重启
	GatewayRestarted bool `json:"gateway_restarted" example:"true"`
	// 命令输出内容
	Output string `json:"output,omitempty"`
}

type WeixinLoginSessionEvent struct {
	Type    string                      `json:"type" example:"status"`
	Status  string                      `json:"status,omitempty" example:"waiting_qr"`
	QRURL   string                      `json:"qr_url,omitempty"`
	QRASCII string                      `json:"qr_ascii,omitempty"`
	Output  string                      `json:"output,omitempty"`
	Error   string                      `json:"error,omitempty"`
	Data    *WeixinLoginSessionResponse `json:"data,omitempty"`
}
