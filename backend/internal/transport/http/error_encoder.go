package httptransport

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"chatserver/internal/api/openapi"
	"chatserver/internal/apperror"
)

const unavailableRequestID = "request-id-unavailable"

type requestIDGenerator interface {
	New() (string, error)
}

type publicDetailsProvider interface {
	PublicDetails() map[string]any
}

type retryAfterProvider interface {
	RetryAfter() time.Duration
}

type classifiedDiagnosticProvider interface {
	TATCode() string
	Retryable() bool
}

// ErrorEncoder 是所有 HTTP 错误出口共用的 ErrorEnvelope 编码器。
type ErrorEncoder struct {
	requestIDs requestIDGenerator
	logger     *slog.Logger
}

// NewErrorEncoder 创建统一错误编码器。
func NewErrorEncoder(requestIDs requestIDGenerator, loggers ...*slog.Logger) *ErrorEncoder {
	logger := slog.Default()
	if len(loggers) > 0 && loggers[0] != nil {
		logger = loggers[0]
	}
	return &ErrorEncoder{requestIDs: requestIDs, logger: logger}
}

// Write 将应用错误映射为稳定 HTTP 错误。
func (e *ErrorEncoder) Write(
	writer http.ResponseWriter,
	requestID string,
	err error,
) {
	mapping := internalErrorMapping()
	message := mapping.Message
	knownApplicationError := false

	var applicationError *apperror.Error
	if errors.As(err, &applicationError) {
		if resolved, ok := LookupError(applicationError.Code()); ok {
			mapping = resolved
			message = applicationError.Error()
			knownApplicationError = true
		}
	}

	e.writeResolved(
		writer,
		requestID,
		mapping,
		message,
		err,
		knownApplicationError,
	)
}

// WriteCode 将 transport 已分类的错误映射为稳定 HTTP 错误。
//
// cause 只用于读取显式 PublicDetails/RetryAfter，不会进入 message。
func (e *ErrorEncoder) WriteCode(
	writer http.ResponseWriter,
	requestID string,
	code string,
	cause error,
) {
	mapping, ok := LookupError(code)
	if !ok {
		mapping = internalErrorMapping()
	}
	e.writeResolved(writer, requestID, mapping, mapping.Message, cause, ok)
}

func (e *ErrorEncoder) writeResolved(
	writer http.ResponseWriter,
	requestID string,
	mapping ErrorMapping,
	message string,
	err error,
	allowMetadata bool,
) {
	requestID = e.ensureRequestID(requestID)
	e.logServerFailure(requestID, mapping, err)
	envelope := openapi.ErrorEnvelope{}
	envelope.Error.Code = mapping.Code
	envelope.Error.Message = message
	envelope.Error.RequestId = requestID

	if allowMetadata {
		if details := publicDetails(err); len(details) > 0 {
			envelope.Error.Details = &details
		}
		if supportsRetryAfter(mapping.Code) {
			if retryAfter := retryAfter(err); retryAfter > 0 {
				writer.Header().Set("Retry-After", retryAfterSeconds(retryAfter))
			}
		}
	}

	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(mapping.Status)
	_ = json.NewEncoder(writer).Encode(envelope)
}

func (e *ErrorEncoder) logServerFailure(requestID string, mapping ErrorMapping, err error) {
	if e == nil || e.logger == nil || mapping.Status < http.StatusInternalServerError {
		return
	}
	attributes := []any{
		"request_id", requestID,
		"error_code", mapping.Code,
	}
	var classified classifiedDiagnosticProvider
	if errors.As(err, &classified) {
		attributes = append(
			attributes,
			"provider_code", strings.TrimSpace(classified.TATCode()),
			"retryable", classified.Retryable(),
		)
	}
	e.logger.Error("http request failed", attributes...)
}

func (e *ErrorEncoder) ensureRequestID(requestID string) string {
	if requestID = strings.TrimSpace(requestID); requestID != "" {
		return requestID
	}
	if e != nil && e.requestIDs != nil {
		generated, err := e.requestIDs.New()
		if err == nil {
			if generated = strings.TrimSpace(generated); generated != "" {
				return generated
			}
		}
	}
	return unavailableRequestID
}

func internalErrorMapping() ErrorMapping {
	mapping, ok := LookupError("internal_error")
	if !ok {
		panic("HTTP error registry 缺少 internal_error")
	}
	return mapping
}

func publicDetails(err error) map[string]any {
	if err == nil {
		return nil
	}
	var provider publicDetailsProvider
	if !errors.As(err, &provider) {
		return nil
	}
	source := provider.PublicDetails()
	if len(source) == 0 {
		return nil
	}
	result := make(map[string]any, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func retryAfter(err error) time.Duration {
	if err == nil {
		return 0
	}
	var provider retryAfterProvider
	if !errors.As(err, &provider) {
		return 0
	}
	return provider.RetryAfter()
}

func supportsRetryAfter(code string) bool {
	return code == "rate_limited" || code == "tencent_rate_limited"
}

func retryAfterSeconds(duration time.Duration) string {
	seconds := duration / time.Second
	if duration%time.Second != 0 {
		seconds++
	}
	if seconds < 1 {
		seconds = 1
	}
	return strconv.FormatInt(int64(seconds), 10)
}
