package errcode

// Instance 错误码范围: 10101-10199
var (
	ErrInstanceInvalidParam          = Register(New("INSTANCE_INVALID_PARAM", 400, "invalid request parameters"))
	ErrInstanceMissingUserID         = Register(New("INSTANCE_MISSING_USER_ID", 400, "missing user id"))
	ErrInstanceQuotaExceeded         = Register(New("INSTANCE_QUOTA_EXCEEDED", 403, "user instance quota exceeded"))
	ErrInstanceChurnLimited          = Register(New("INSTANCE_CHURN_LIMITED", 429, "instance creation temporarily limited by churn guard"))
	ErrInstanceNotFound              = Register(New("INSTANCE_NOT_FOUND", 404, "instance not found"))
	ErrInstanceCreationFailed        = Register(New("INSTANCE_CREATION_FAILED", 500, "instance creation failed"))
	ErrInstanceOperationConflict     = Register(New("INSTANCE_OPERATION_CONFLICT", 409, "instance operation conflict"))
	ErrInstanceStatusInvalid         = Register(New("INSTANCE_STATUS_INVALID", 409, "instance status does not allow this operation"))
	ErrInstanceAutomationUnavailable = Register(New("INSTANCE_AUTOMATION_UNAVAILABLE", 409, "automation unavailable for this instance"))
	ErrChannelInvalidParam           = Register(New("CHANNEL_INVALID_PARAM", 400, "invalid channel configuration parameters"))
	ErrChannelConfigFailed           = Register(New("CHANNEL_CONFIG_FAILED", 500, "channel configuration failed"))
)
