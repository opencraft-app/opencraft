package errcode

// Sandbox 错误码范围: 14001-14099
var (
	ErrSandboxInvalidParam   = Register(New("SANDBOX_INVALID_PARAM", 400, "invalid parameters"))
	ErrSandboxAuthFailed     = Register(New("SANDBOX_AUTH_FAILED", 401, "authentication failed"))
	ErrSandboxNotFound       = Register(New("SANDBOX_NOT_FOUND", 404, "sandbox not found"))
	ErrSandboxStatusConflict = Register(New("SANDBOX_STATUS_CONFLICT", 409, "sandbox status conflict"))
	ErrSandboxServiceError   = Register(New("SANDBOX_SERVICE_ERROR", 502, "sandbox service error"))
	ErrSandboxTimeout        = Register(New("SANDBOX_TIMEOUT", 504, "sandbox service timeout"))
)
