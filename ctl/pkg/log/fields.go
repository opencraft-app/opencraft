// Package log 定义统一的日志字段常量，确保三服务（API/Service/Bypass）日志格式一致
package log

const (
	FieldTraceID    = "trace_id"
	FieldUserID     = "user_id"
	FieldAction     = "action"
	FieldTaskID     = "task_id"
	FieldTaskName   = "task_name"
	FieldTaskState  = "task_state"
	FieldBypassName = "bypass_name"
	FieldLatencyMs  = "latency_ms"
	FieldStatusCode = "status_code"
	FieldInstanceID = "instance_id"
	FieldSandboxID  = "sandbox_id"
	FieldMethod     = "method"
	FieldPath       = "path"
	FieldError      = "error"
)
