package errcode

var ErrInstanceConfigResetMultiBot = Register(New("INSTANCE_CONFIG_RESET_MULTI_BOT", 409, "model reset requires a single default Bot"))

var (
	ErrInstanceBotNotFound       = Register(New("INSTANCE_BOT_NOT_FOUND", 404, "instance bot not found"))
	ErrInstanceBotInvalidParam   = Register(New("INSTANCE_BOT_INVALID_PARAM", 400, "invalid instance bot parameters"))
	ErrInstanceBotConflict       = Register(New("INSTANCE_BOT_CONFLICT", 409, "instance bot operation conflict"))
	ErrInstanceBotQuotaExceeded  = Register(New("INSTANCE_BOT_QUOTA_EXCEEDED", 403, "instance bot quota exceeded"))
	ErrInstanceBotDefaultDelete  = Register(New("INSTANCE_BOT_DEFAULT_DELETE", 409, "default instance bot cannot be deleted"))
	ErrInstanceBotsRemain        = Register(New("INSTANCE_BOTS_REMAIN", 409, "delete other bots before deleting the instance"))
	ErrInstanceBotProfileFailed  = Register(New("INSTANCE_BOT_PROFILE_FAILED", 500, "Hermes profile operation failed"))
	ErrInstanceBotProfileMissing = Register(New("INSTANCE_BOT_PROFILE_MISSING", 409, "Hermes profile is unavailable"))
	ErrInstanceBotDisabled       = Register(New("INSTANCE_BOT_DISABLED", 503, "multi bot is disabled"))
	ErrInstanceBotUnsupported    = Register(New("INSTANCE_BOT_UNSUPPORTED", 409, "Hermes profile capability is unavailable"))
)
