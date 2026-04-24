package model

import "errors"

var (
	ErrUserNotFound         = errors.New("user not found")
	ErrPlanNotFound         = errors.New("plan not found")
	ErrSubscriptionNotFound = errors.New("subscription not found")
	ErrProviderNotFound     = errors.New("provider not found")
	ErrApiKeyNotFound       = errors.New("api key not found")
	ErrQuotaExceeded        = errors.New("token quota exceeded")
	ErrRateLimitExceeded    = errors.New("rate limit exceeded")
	ErrModelNotAllowed      = errors.New("model not allowed")
	ErrInvalidApiKey        = errors.New("invalid api key")
	ErrProviderUnavailable  = errors.New("no available provider")
	ErrInsufficientReserve  = errors.New("insufficient balance for reservation")
)
