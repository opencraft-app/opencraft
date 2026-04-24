package errcode

// Debug 错误码
var (
	ErrDebugInvalidCommand = Register(New("DEBUG_INVALID_COMMAND", 400, "invalid debug command"))
	ErrDebugExecFailed     = Register(New("DEBUG_EXEC_FAILED", 500, "command execution failed"))
	ErrDebugExecTimeout    = Register(New("DEBUG_EXEC_TIMEOUT", 504, "command execution timeout"))
	ErrDebugNotSupported   = Register(New("DEBUG_NOT_SUPPORTED", 409, "debug command not supported in this instance state"))
	ErrDebugInvalidRunAs   = Register(New("DEBUG_INVALID_RUN_AS_USER", 400, "invalid debug run_as_user"))
)
