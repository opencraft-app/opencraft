package errcode

// Quota 错误码范围: 10201-10299
var (
	ErrQuotaExceeded      = Register(New("QUOTA_EXCEEDED", 403, "quota exceeded"))
	ErrQuotaInvalid       = Register(New("QUOTA_INVALID", 400, "quota invalid"))
	ErrQuotaReleaseFailed = Register(New("QUOTA_RELEASE_FAILED", 500, "quota release failed"))
)
