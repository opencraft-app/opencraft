package errcode

// Website 错误码
var (
	ErrWebsiteNotFound              = Register(New("WEBSITE_NOT_FOUND", 404, "website not found"))
	ErrWebsiteQuotaExceeded         = Register(New("WEBSITE_QUOTA_EXCEEDED", 403, "website quota exceeded"))
	ErrWebsiteInvalidParam          = Register(New("WEBSITE_INVALID_PARAM", 400, "invalid website parameters"))
	ErrWebsiteArtifactTooLarge      = Register(New("WEBSITE_ARTIFACT_TOO_LARGE", 413, "artifact size exceeds limit"))
	ErrWebsiteFileCountExceeded     = Register(New("WEBSITE_FILE_COUNT_EXCEEDED", 413, "file count exceeds limit"))
	ErrWebsiteNotActive             = Register(New("WEBSITE_NOT_ACTIVE", 403, "website is not active"))
	ErrWebsiteOperationNotFound     = Register(New("WEBSITE_OPERATION_NOT_FOUND", 404, "operation not found"))
	ErrWebsiteReleaseNotFound       = Register(New("WEBSITE_RELEASE_NOT_FOUND", 404, "release not found"))
	ErrWebsitePassInactive          = Register(New("WEBSITE_PASS_INACTIVE", 403, "user pass is not active, cannot manage websites"))
	ErrWebsiteNoQuota               = Register(New("WEBSITE_NO_QUOTA", 403, "user bundle does not include website quota"))
	ErrWebsiteNoAvailableEnv        = Register(New("WEBSITE_NO_AVAILABLE_ENV", 503, "no available TCB environment"))
	ErrWebsiteOperationNotClaimed   = Register(New("WEBSITE_OPERATION_NOT_CLAIMED", 409, "operation is not owned by this worker"))
	ErrWebsiteOperationNotRevivable = Register(New("WEBSITE_OPERATION_NOT_REVIVABLE", 409, "operation cannot be revived"))
)
