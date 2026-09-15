package runtimeapi

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var (
	runtimeBearerPattern = regexp.MustCompile(
		`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}`,
	)
	runtimeTokenPattern = regexp.MustCompile(
		`(?i)\b(?:sk|sk-ant|sk-proj|xox[baprs]?)-[A-Za-z0-9_-]{8,}\b`,
	)
	runtimeEmailPattern = regexp.MustCompile(
		`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`,
	)
	runtimeURLPattern     = regexp.MustCompile(`(?i)https?://[^\s"'<>]+`)
	runtimeMacHomePattern = regexp.MustCompile(
		`/Users/[^\s"'<>:]+(?:/[^\s"'<>:]+)*`,
	)
	runtimeLinuxHomePattern = regexp.MustCompile(
		`/home/[^\s"'<>:]+(?:/[^\s"'<>:]+)*`,
	)
	runtimeWindowsHomePattern = regexp.MustCompile(
		`(?i)[A-Za-z]:\\Users\\[^\s"'<>:]+(?:\\[^\s"'<>:]+)*`,
	)
	runtimeLongHexPattern       = regexp.MustCompile(`[0-9a-f]{12,}`)
	runtimeIntegerPattern       = regexp.MustCompile(`\b\d+\b`)
	runtimeWhitespacePattern    = regexp.MustCompile(`\s+`)
	runtimeExplicitErrorPattern = regexp.MustCompile(
		`\b([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b`,
	)
	runtimeHTTPStatusPattern = regexp.MustCompile(
		`(?i)\b(?:HTTP|status(?:\s+code)?|API\s+Error)[:\s]+([45]\d{2})\b`,
	)
	runtimeHTTPPhrasePattern = regexp.MustCompile(
		`(?i)\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Too Many Requests|Internal Server Error|Service Unavailable)\b`,
	)
	runtimeInputTooLargePattern = regexp.MustCompile(
		`(?i)(?:\bINPUT_TOO_LARGE\b|\binput too large\b|\bexceeds the maximum allowed\b)`,
	)
	runtimeModelConfigurationPattern = regexp.MustCompile(
		`(?i)(?:\bmodel\b.*\bnot supported\b|\bunsupported\b.*\bmodel\b|\bmodel\b.*\bnot available\b)`,
	)
	runtimeTimeoutPattern = regexp.MustCompile(
		`(?i)\b(?:ETIMEDOUT|timeout|timed out)\b`,
	)
	runtimeConnectionPattern = regexp.MustCompile(
		`(?i)(?:\b(?:ECONNRESET|EPIPE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|\bUnable to connect to API\b)`,
	)
	runtimeStreamPattern = regexp.MustCompile(
		`(?i)(?:stream closed before response\.completed|error decoding response body)`,
	)
	runtimeRateLimitPattern = regexp.MustCompile(
		`(?i)(?:\brate.?limit|too many requests\b)`,
	)
	runtimeNotFoundPattern = regexp.MustCompile(`(?i)\bnot found\b`)

	runtimeAuthActionPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)access token could not be refreshed`),
		regexp.MustCompile(`(?i)\btoken_(?:revoked|invalidated)\b`),
		regexp.MustCompile(`(?i)refresh token was already used`),
		regexp.MustCompile(`(?i)access token.*invalidated`),
		regexp.MustCompile(`(?i)authentication token has been invalidated`),
		regexp.MustCompile(`(?i)logged out or signed in to another account`),
		regexp.MustCompile(`(?i)not logged in`),
		regexp.MustCompile(`(?i)not signed in`),
		regexp.MustCompile(`(?i)login required`),
		regexp.MustCompile(`(?i)log in first`),
		regexp.MustCompile(`(?i)please log in`),
		regexp.MustCompile(`(?i)authentication failed`),
		regexp.MustCompile(`(?i)auth(?:entication)? failed`),
		regexp.MustCompile(`(?i)authentication timed out`),
		regexp.MustCompile(`(?i)missing (?:api )?token`),
		regexp.MustCompile(`(?i)no (?:api )?token`),
		regexp.MustCompile(`(?i)missing credentials`),
		regexp.MustCompile(`(?i)credentials? not found`),
		regexp.MustCompile(`(?i)invalid api key`),
		regexp.MustCompile(`(?i)api key (?:is )?not set`),
	}
	runtimeZeroEvidencePattern = regexp.MustCompile(
		`(?i)\bcodex_zero_evidence_turn_completed\b`,
	)
	runtimeUnsupportedModelPattern = regexp.MustCompile(
		`(?i)(?:\bmodel\b.*\bnot supported\b|\bunsupported\b.*\bmodel\b)`,
	)
)

type RuntimeErrorDiagnostic struct {
	ErrorClass       string `json:"errorClass"`
	ErrorReason      string `json:"errorReason"`
	Fingerprint      string `json:"fingerprint"`
	ReasonProvenance string `json:"reasonProvenance"`
	NativeReason     *bool  `json:"nativeReasonPresent,omitempty"`
}

func FingerprintRuntimeError(message string) string {
	scrubbed := scrubRuntimeErrorText(message)
	normalized := strings.ToLower(scrubbed)
	normalized = runtimeLongHexPattern.ReplaceAllString(normalized, "<hex>")
	normalized = runtimeIntegerPattern.ReplaceAllString(normalized, "<num>")
	normalized = strings.TrimSpace(runtimeWhitespacePattern.ReplaceAllString(normalized, " "))
	digest := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(digest[:])[:16]
}

func RuntimeErrorFingerprintFenceEligible(message string) bool {
	for _, pattern := range runtimeAuthActionPatterns {
		if pattern.MatchString(message) {
			return false
		}
	}
	return !runtimeZeroEvidencePattern.MatchString(message) &&
		!runtimeUnsupportedModelPattern.MatchString(message)
}

func RuntimeErrorIsStickyTerminal(message string) bool {
	return runtimeZeroEvidencePattern.MatchString(message) ||
		runtimeUnsupportedModelPattern.MatchString(message)
}

func RuntimeErrorActivityDiagnostic(message string) RuntimeErrorDiagnostic {
	errorClass := classifyRuntimeError(message)
	normalizedClass, reason := normalizeRuntimeErrorClassification(errorClass)
	return RuntimeErrorDiagnostic{
		ErrorClass:       normalizedClass,
		ErrorReason:      reason,
		Fingerprint:      FingerprintRuntimeError(message),
		ReasonProvenance: "runtime_error_event",
	}
}

func classifyRuntimeError(message string) string {
	if runtimeInputTooLargePattern.MatchString(message) {
		return "InputTooLargeError"
	}
	if explicit := runtimeExplicitErrorPattern.FindStringSubmatch(message); len(explicit) > 1 {
		return explicit[1]
	}
	if status, ok := runtimeErrorHTTPStatus(message); ok {
		switch {
		case status == 429:
			return "RateLimitError"
		case status == 401 || status == 403:
			return "AuthError"
		case status == 404:
			return "NotFoundError"
		case status >= 500:
			return "ProviderServerError"
		default:
			return "ProviderApiError"
		}
	}
	for _, pattern := range runtimeAuthActionPatterns {
		if pattern.MatchString(message) {
			return "AuthError"
		}
	}
	switch {
	case runtimeModelConfigurationPattern.MatchString(message):
		return "ModelConfigError"
	case runtimeTimeoutPattern.MatchString(message):
		return "TimeoutError"
	case runtimeConnectionPattern.MatchString(message):
		return "ProviderConnectionError"
	case runtimeStreamPattern.MatchString(message):
		return "ProviderStreamError"
	case runtimeRateLimitPattern.MatchString(message):
		return "RateLimitError"
	case runtimeNotFoundPattern.MatchString(message):
		return "NotFoundError"
	default:
		return "RuntimeError"
	}
}

func runtimeErrorHTTPStatus(message string) (int, bool) {
	for _, pattern := range []*regexp.Regexp{
		runtimeHTTPStatusPattern,
		runtimeHTTPPhrasePattern,
	} {
		match := pattern.FindStringSubmatch(message)
		if len(match) < 2 {
			continue
		}
		status, err := strconv.Atoi(match[1])
		if err == nil {
			return status, true
		}
	}
	return 0, false
}

func normalizeRuntimeErrorClassification(errorClass string) (string, string) {
	reasons := map[string]string{
		"InputTooLargeError":      "input_too_large",
		"RateLimitError":          "rate_limited",
		"AuthError":               "auth_failed",
		"NotFoundError":           "not_found",
		"ModelConfigError":        "model_config_error",
		"TimeoutError":            "provider_timeout",
		"ProviderConnectionError": "provider_connection_error",
		"ProviderStreamError":     "provider_stream_error",
		"ProviderServerError":     "provider_server_error",
		"ProviderApiError":        "provider_api_error",
	}
	if reason, ok := reasons[errorClass]; ok {
		return errorClass, reason
	}
	return "RuntimeError", "unclassified_runtime_error"
}

func scrubRuntimeErrorText(message string) string {
	value := runtimeBearerPattern.ReplaceAllString(message, "Bearer [REDACTED_TOKEN]")
	value = runtimeTokenPattern.ReplaceAllString(value, "[REDACTED_TOKEN]")
	value = runtimeEmailPattern.ReplaceAllString(value, "[REDACTED_EMAIL]")
	value = runtimeURLPattern.ReplaceAllStringFunc(value, redactRuntimeErrorURL)
	value = runtimeMacHomePattern.ReplaceAllString(value, "[REDACTED_PATH]")
	value = runtimeLinuxHomePattern.ReplaceAllString(value, "[REDACTED_PATH]")
	return runtimeWindowsHomePattern.ReplaceAllString(value, "[REDACTED_PATH]")
}

func redactRuntimeErrorURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		if query := strings.IndexByte(value, '?'); query >= 0 {
			return value[:query] + "?[REDACTED_QUERY]"
		}
		return value
	}
	if parsed.RawQuery != "" {
		query := strings.IndexByte(value, '?')
		if query >= 0 {
			value = value[:query] + "?[REDACTED_QUERY]"
		}
	}
	if parsed.User == nil {
		return value
	}
	password, hasPassword := parsed.User.Password()
	_ = password
	userInfo := "[REDACTED_USER]"
	if hasPassword {
		userInfo += ":[REDACTED_PASSWORD]"
	}
	at := strings.Index(value, "@")
	scheme := strings.Index(value, "://")
	if at > scheme+3 {
		return value[:scheme+3] + userInfo + value[at:]
	}
	return value
}
