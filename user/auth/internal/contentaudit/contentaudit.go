package contentaudit

const (
	StatusPending   = "pending"
	StatusSubmitted = "submitted"
	StatusPassed    = "passed"
	StatusFailed    = "failed"
	StatusCancelled = "cancelled"
	StatusError     = "error"
)

const (
	BizTypeUserName   = "user_name"
	BizTypeUserAvatar = "user_avatar"
)

const (
	MediaTypeText  = "text"
	MediaTypeImage = "image"
)

const (
	ResultCodeMalicious = 1
	ResultCodePass      = 2
)

const (
	DefaultTimeoutMinutes = 15
)
