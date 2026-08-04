package httptransport

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"sync"

	"chatserver/internal/apperror"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/gorillamux"
	"github.com/google/uuid"
	nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"
)

var (
	// ErrValidatorSpecRequired 表示没有提供 OpenAPI 事实源。
	ErrValidatorSpecRequired = errors.New("OpenAPI 规格不能为空")
	// ErrValidatorEncoderRequired 表示没有提供统一错误编码器。
	ErrValidatorEncoderRequired = errors.New("HTTP 错误编码器不能为空")
	// ErrValidatorAuthRequired 表示没有提供认证 hook。
	ErrValidatorAuthRequired = errors.New("OpenAPI 认证 hook 不能为空")
	registerFormatsOnce      sync.Once
)

// Middleware 是标准 net/http middleware。
type Middleware func(http.Handler) http.Handler

// NewValidator 创建 OpenAPI 请求校验 middleware。
func NewValidator(
	spec *openapi3.T,
	encoder *ErrorEncoder,
	authentication *AuthenticationHook,
) (Middleware, error) {
	if spec == nil {
		return nil, ErrValidatorSpecRequired
	}
	if encoder == nil {
		return nil, ErrValidatorEncoderRequired
	}
	if authentication == nil {
		return nil, ErrValidatorAuthRequired
	}
	registerPlatformFormats()
	if err := spec.Validate(context.Background()); err != nil {
		return nil, err
	}

	methodRouter, err := gorillamux.NewRouter(spec)
	if err != nil {
		return nil, err
	}

	options := &nethttpmiddleware.Options{
		Options: openapi3filter.Options{
			AuthenticationFunc: authentication.Authenticate,
			MultiError:         true,
		},
		ErrorHandlerWithOpts: func(
			_ context.Context,
			err error,
			writer http.ResponseWriter,
			request *http.Request,
			opts nethttpmiddleware.ErrorHandlerOpts,
		) {
			handleValidationError(
				encoder,
				methodRouter,
				writer,
				request,
				err,
				opts,
			)
		},
		SilenceServersWarning: true,
	}

	return nethttpmiddleware.OapiRequestValidatorWithOptions(spec, options), nil
}

func registerPlatformFormats() {
	registerFormatsOnce.Do(func() {
		openapi3.DefineStringFormatValidator(
			"email",
			openapi3.NewRegexpFormatValidator(openapi3.FormatOfStringForEmail),
		)
		openapi3.DefineStringFormatValidator(
			"uuid",
			openapi3.NewCallbackValidator(func(value string) error {
				parsed, err := uuid.Parse(value)
				if err != nil {
					return err
				}
				if parsed == uuid.Nil {
					return errors.New("UUID 不能为 nil")
				}
				return nil
			}),
		)
	})
}

func handleValidationError(
	encoder *ErrorEncoder,
	methodRouter routers.Router,
	writer http.ResponseWriter,
	request *http.Request,
	err error,
	opts nethttpmiddleware.ErrorHandlerOpts,
) {
	requestID := requestIDFromRequest(request)
	if opts.MatchedRoute == nil {
		allowed := allowedMethods(methodRouter, request)
		if len(allowed) > 0 {
			writer.Header().Set("Allow", strings.Join(allowed, ", "))
			encoder.WriteCode(
				writer,
				requestID,
				"method_not_allowed",
				err,
			)
			return
		}
		encoder.WriteCode(writer, requestID, "route_not_found", err)
		return
	}

	if code := apperror.CodeOf(err); code != "" {
		if _, ok := LookupError(code); ok {
			encoder.Write(writer, requestID, err)
			return
		}
	}
	if opts.StatusCode >= http.StatusInternalServerError {
		encoder.WriteCode(writer, requestID, "internal_error", err)
		return
	}
	encoder.WriteCode(writer, requestID, "invalid_request", err)
}

func allowedMethods(router routers.Router, request *http.Request) []string {
	if router == nil || request == nil {
		return nil
	}
	candidates := []string{
		http.MethodGet,
		http.MethodHead,
		http.MethodPost,
		http.MethodPut,
		http.MethodPatch,
		http.MethodDelete,
		http.MethodOptions,
	}
	allowed := make([]string, 0, len(candidates))
	for _, method := range candidates {
		candidate := request.Clone(request.Context())
		candidate.Method = method
		if _, _, err := router.FindRoute(candidate); err == nil {
			allowed = append(allowed, method)
		}
	}
	sort.Strings(allowed)
	return allowed
}

func requestIDFromRequest(request *http.Request) string {
	if request == nil {
		return ""
	}
	return request.Header.Get("X-Request-ID")
}
