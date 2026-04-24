package response

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// OpenAI-compatible error response format
type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code"`
}

// ErrorResponse writes an OpenAI-compatible error JSON response.
func ErrorResponse(c *gin.Context, httpStatus int, errType, code, message string) {
	c.JSON(httpStatus, errorBody{
		Error: errorDetail{
			Message: message,
			Type:    errType,
			Code:    code,
		},
	})
	c.Abort()
}

// ErrInvalidAPIKey responds with 401 for invalid API key.
func ErrInvalidAPIKey(c *gin.Context) {
	ErrorResponse(c, http.StatusUnauthorized,
		"authentication_error", "invalid_api_key",
		"Invalid API key provided.")
}

// ErrQuotaExceeded responds with 429 for token quota exceeded.
func ErrQuotaExceeded(c *gin.Context) {
	ErrorResponse(c, http.StatusTooManyRequests,
		"insufficient_quota", "quota_exceeded",
		"You have exceeded your token quota.")
}

// ErrModelNotAllowed responds with 403 for model not in plan.
func ErrModelNotAllowed(c *gin.Context) {
	ErrorResponse(c, http.StatusForbidden,
		"permission_error", "model_not_allowed",
		"The requested model is not available in your current plan.")
}

// ErrRateLimitExceeded responds with 429 for rate limit exceeded.
func ErrRateLimitExceeded(c *gin.Context, retryAfter int) {
	c.Header("Retry-After", formatInt(retryAfter))
	ErrorResponse(c, http.StatusTooManyRequests,
		"rate_limit_error", "rate_limit_exceeded",
		"Rate limit exceeded. Please retry after the specified time.")
}

// ErrRateLimitDetail responds with 429 and detailed rate limit info.
func ErrRateLimitDetail(c *gin.Context, label string, window string, maxRequests int, retryAfterSec int) {
	c.Header("Retry-After", formatInt(retryAfterSec))
	c.JSON(http.StatusTooManyRequests, gin.H{
		"error": gin.H{
			"message": "已超过" + label + "请求限制（" + formatInt(maxRequests) + " 次），请稍后重试。",
			"type":    "rate_limit_error",
			"code":    "rate_limit_exceeded",
		},
		"detail": gin.H{
			"window":       window,
			"label":        label,
			"max_requests": maxRequests,
			"retry_after":  retryAfterSec,
		},
	})
	c.Abort()
}

// ErrUpstreamError responds with 502 for upstream provider errors.
func ErrUpstreamError(c *gin.Context, msg string) {
	ErrorResponse(c, http.StatusBadGateway,
		"upstream_error", "upstream_failure",
		msg)
}

// ErrProviderUnavailable responds with 503 when no provider is available.
func ErrProviderUnavailable(c *gin.Context) {
	ErrorResponse(c, http.StatusServiceUnavailable,
		"server_error", "provider_unavailable",
		"No available provider for the requested model.")
}

// ErrOverloaded responds when the gateway rejects new requests to protect availability.
func ErrOverloaded(c *gin.Context, httpStatus int) {
	ErrorResponse(c, httpStatus,
		"server_error", "gateway_overloaded",
		"Gateway overload protection is active. Please retry later.")
}

// ErrBadRequest responds with 400 for malformed requests.
func ErrBadRequest(c *gin.Context, msg string) {
	ErrorResponse(c, http.StatusBadRequest,
		"invalid_request_error", "bad_request",
		msg)
}

// ErrNotFound responds with 404.
func ErrNotFound(c *gin.Context, msg string) {
	ErrorResponse(c, http.StatusNotFound,
		"not_found_error", "not_found",
		msg)
}

// ErrInternal responds with 500 for internal errors.
func ErrInternal(c *gin.Context) {
	ErrorResponse(c, http.StatusInternalServerError,
		"server_error", "internal_error",
		"An internal error occurred. Please try again later.")
}

// SuccessResponse writes a standard JSON success response.
func SuccessResponse(c *gin.Context, data interface{}) {
	c.JSON(http.StatusOK, data)
}

// formatInt converts int to string without importing strconv.
func formatInt(n int) string {
	if n == 0 {
		return "0"
	}
	result := ""
	negative := false
	if n < 0 {
		negative = true
		n = -n
	}
	for n > 0 {
		result = string(rune('0'+n%10)) + result
		n /= 10
	}
	if negative {
		result = "-" + result
	}
	return result
}
