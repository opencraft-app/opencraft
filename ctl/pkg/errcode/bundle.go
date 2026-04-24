package errcode

var (
	ErrBundleNotFound        = Register(New("BUNDLE_NOT_FOUND", 404, "bundle not found"))
	ErrBundleStateInvalid    = Register(New("BUNDLE_STATE_INVALID", 400, "invalid bundle state"))
	ErrBundleConfigInvalid   = Register(New("BUNDLE_CONFIG_INVALID", 400, "invalid bundle config"))
	ErrBundleNoFieldToUpdate = Register(New("BUNDLE_NO_FIELD_TO_UPDATE", 400, "no field to update"))
	ErrBundleIDsEmpty        = Register(New("BUNDLE_IDS_EMPTY", 400, "bundle_ids cannot be empty"))
	ErrBundlePartialNotFound = Register(New("BUNDLE_PARTIAL_NOT_FOUND", 400, "some bundle_ids not found"))
	ErrBundleSalesQuotaEmpty = Register(New("BUNDLE_SALES_QUOTA_EMPTY", 400, "bundle sales quota is exhausted"))

	// credit / plan / period 三项强一致性校验错误码（ImportBundle / ModifyBundles 时触发）
	ErrBundlePlanMismatch         = Register(New("BUNDLE_PLAN_MISMATCH", 400, "ai_gateway_plan_id must be empty when credit=0, and non-empty when credit>0"))
	ErrBundlePlanNotFound         = Register(New("BUNDLE_PLAN_NOT_FOUND", 400, "ai-gateway plan not found"))
	ErrBundleCreditTokenMismatch  = Register(New("BUNDLE_CREDIT_TOKEN_MISMATCH", 400, "plan.monthly_tokens does not match credit × credit_token_ratio"))
	ErrBundlePeriodMismatch       = Register(New("BUNDLE_PERIOD_MISMATCH", 400, "plan.period does not match bundle.time_span/time_unit"))
	ErrBundleAiGatewayUnavailable = Register(New("BUNDLE_AIGATEWAY_UNAVAILABLE", 502, "ai-gateway unavailable, cannot validate plan"))
)
