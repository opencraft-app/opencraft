package errcode

var (
	ErrPassNotFound              = Register(New("PASS_NOT_FOUND", 404, "pass not found"))
	ErrPassInvalidParam          = Register(New("PASS_INVALID_PARAM", 400, "invalid pass parameters"))
	ErrPassInvalidTimeUnit       = Register(New("PASS_INVALID_TIME_UNIT", 400, "invalid time unit, must be m"))
	ErrPassExpired               = Register(New("PASS_EXPIRED", 403, "pass has expired"))
	ErrPassBundleOffline         = Register(New("PASS_BUNDLE_OFFLINE", 400, "cannot create pass for offline bundle"))
	ErrPassNoFieldToUpdate       = Register(New("PASS_NO_FIELD_TO_UPDATE", 400, "no field to update"))
	ErrPassShadowBindingNotFound = Register(New("PASS_SHADOW_BINDING_NOT_FOUND", 404, "shadow binding not found for user"))
	ErrPassQuotaExceeded         = Register(New("PASS_QUOTA_EXCEEDED", 403, "consumed quota exceeds bundle agent_quota limit"))
	ErrPassAlreadyExists         = Register(New("PASS_ALREADY_EXISTS", 409, "user already has an active pass"))
	ErrPassBundleSoldOut         = Register(New("PASS_BUNDLE_SOLD_OUT", 400, "bundle is sold out"))
)
