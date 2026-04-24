package errcode

var (
	ErrChannelLoginConflict   = Register(New("CHANNEL_LOGIN_CONFLICT", 409, "channel login session already exists"))
	ErrChannelLoginNotFound   = Register(New("CHANNEL_LOGIN_NOT_FOUND", 404, "channel login session not found"))
	ErrChannelLoginExecFailed = Register(New("CHANNEL_LOGIN_EXEC_FAILED", 500, "channel login execution failed"))
	ErrChannelLoginNotRunning = Register(New("CHANNEL_LOGIN_NOT_RUNNING", 409, "channel login session is not running"))
)
