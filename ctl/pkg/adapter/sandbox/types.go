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
