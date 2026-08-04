package httptransport

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/routers/gorillamux"
)

type requestIDContextKey struct{}
type clientIPContextKey struct{}

// RequestID 返回当前请求的服务端 requestId。
func RequestID(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	value, _ := ctx.Value(requestIDContextKey{}).(string)
	return value
}

// RequestIDMiddleware 为每个请求生成独立 requestId。
func RequestIDMiddleware(generator requestIDGenerator) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			requestID := unavailableRequestID
			if generator != nil {
				if generated, err := generator.New(); err == nil {
					if generated = strings.TrimSpace(generated); generated != "" {
						requestID = generated
					}
				}
			}
			writer.Header().Set("X-Request-ID", requestID)
			request.Header.Set("X-Request-ID", requestID)
			ctx := context.WithValue(
				request.Context(),
				requestIDContextKey{},
				requestID,
			)
			next.ServeHTTP(writer, request.WithContext(ctx))
		})
	}
}

// RecoveryMiddleware 把未处理 panic 转为统一 500。
func RecoveryMiddleware(
	encoder *ErrorEncoder,
	logger *slog.Logger,
) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			state := &responseStateWriter{ResponseWriter: writer}
			defer func() {
				recovered := recover()
				if recovered == nil {
					return
				}
				if logger != nil {
					logger.Error(
						"HTTP handler panic",
						"request_id",
						RequestID(request.Context()),
					)
				}
				if !state.wroteHeader && encoder != nil {
					encoder.WriteCode(
						state,
						RequestID(request.Context()),
						"internal_error",
						nil,
					)
				}
			}()
			next.ServeHTTP(state, request)
		})
	}
}

type responseStateWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func (writer *responseStateWriter) WriteHeader(statusCode int) {
	if writer.wroteHeader {
		return
	}
	writer.wroteHeader = true
	writer.ResponseWriter.WriteHeader(statusCode)
}

func (writer *responseStateWriter) Write(data []byte) (int, error) {
	if !writer.wroteHeader {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.ResponseWriter.Write(data)
}

// BodyLimitMiddleware 在进入 decoder/validator 前完整执行统一小请求体上限。
func BodyLimitMiddleware(maxBytes int64, encoder *ErrorEncoder) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.Body == nil || request.Body == http.NoBody {
				next.ServeHTTP(writer, request)
				return
			}
			if maxBytes <= 0 || request.ContentLength > maxBytes {
				encoder.WriteCode(
					writer,
					RequestID(request.Context()),
					"invalid_request",
					errors.New("请求体超过上限"),
				)
				return
			}

			data, err := io.ReadAll(io.LimitReader(request.Body, maxBytes+1))
			_ = request.Body.Close()
			if err != nil || int64(len(data)) > maxBytes {
				encoder.WriteCode(
					writer,
					RequestID(request.Context()),
					"invalid_request",
					err,
				)
				return
			}
			request.Body = io.NopCloser(bytes.NewReader(data))
			request.ContentLength = int64(len(data))
			next.ServeHTTP(writer, request)
		})
	}
}

// JSONContentTypeMiddleware 只对 OpenAPI 声明 JSON requestBody 的 operation 检查媒体类型。
func JSONContentTypeMiddleware(
	spec *openapi3.T,
	encoder *ErrorEncoder,
) (Middleware, error) {
	if spec == nil {
		return nil, ErrValidatorSpecRequired
	}
	if encoder == nil {
		return nil, ErrValidatorEncoderRequired
	}
	router, err := gorillamux.NewRouter(spec)
	if err != nil {
		return nil, err
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			route, _, routeErr := router.FindRoute(request)
			if routeErr != nil ||
				route == nil ||
				route.Operation == nil ||
				route.Operation.RequestBody == nil ||
				route.Operation.RequestBody.Value == nil {
				next.ServeHTTP(writer, request)
				return
			}
			if _, expectsJSON := route.Operation.RequestBody.Value.Content["application/json"]; !expectsJSON {
				next.ServeHTTP(writer, request)
				return
			}
			if !requestHasBody(request) {
				next.ServeHTTP(writer, request)
				return
			}
			mediaType, _, parseErr := mime.ParseMediaType(
				request.Header.Get("Content-Type"),
			)
			if parseErr != nil || mediaType != "application/json" {
				encoder.WriteCode(
					writer,
					RequestID(request.Context()),
					"invalid_request",
					parseErr,
				)
				return
			}
			next.ServeHTTP(writer, request)
		})
	}, nil
}

func requestHasBody(request *http.Request) bool {
	if request == nil || request.Body == nil || request.Body == http.NoBody {
		return false
	}
	return request.ContentLength != 0 || len(request.TransferEncoding) > 0
}

// CORSConfig 是浏览器跨域访问的显式 allowlist。
type CORSConfig struct {
	AllowedOrigins   []string
	AllowedMethods   []string
	AllowedHeaders   []string
	AllowCredentials bool
	MaxAge           time.Duration
}

// CORSMiddleware 创建严格 allowlist CORS middleware。
func CORSMiddleware(
	config CORSConfig,
	encoder *ErrorEncoder,
) (Middleware, error) {
	if encoder == nil {
		return nil, ErrValidatorEncoderRequired
	}
	origins, _, err := normalizeCORSValues(config.AllowedOrigins, false)
	if err != nil || len(origins) == 0 {
		return nil, errors.New("CORS 必须配置显式 Origin")
	}
	methods, methodOrder, err := normalizeCORSValues(config.AllowedMethods, true)
	if err != nil || len(methods) == 0 {
		return nil, errors.New("CORS 必须配置显式 Method")
	}
	headers, headerOrder, err := normalizeCORSHeaders(config.AllowedHeaders)
	if err != nil {
		return nil, err
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			origin := request.Header.Get("Origin")
			if origin == "" {
				next.ServeHTTP(writer, request)
				return
			}
			if _, ok := origins[origin]; !ok {
				encoder.WriteCode(
					writer,
					RequestID(request.Context()),
					"permission_denied",
					nil,
				)
				return
			}

			writer.Header().Add("Vary", "Origin")
			writer.Header().Set("Access-Control-Allow-Origin", origin)
			if config.AllowCredentials {
				writer.Header().Set("Access-Control-Allow-Credentials", "true")
			}

			if request.Method != http.MethodOptions {
				if _, ok := methods[request.Method]; !ok {
					encoder.WriteCode(
						writer,
						RequestID(request.Context()),
						"permission_denied",
						nil,
					)
					return
				}
				next.ServeHTTP(writer, request)
				return
			}

			requestedMethod := strings.ToUpper(
				strings.TrimSpace(
					request.Header.Get("Access-Control-Request-Method"),
				),
			)
			if _, ok := methods[requestedMethod]; !ok {
				encoder.WriteCode(
					writer,
					RequestID(request.Context()),
					"permission_denied",
					nil,
				)
				return
			}
			if !requestedHeadersAllowed(
				request.Header.Get("Access-Control-Request-Headers"),
				headers,
			) {
				encoder.WriteCode(
					writer,
					RequestID(request.Context()),
					"permission_denied",
					nil,
				)
				return
			}

			writer.Header().Set(
				"Access-Control-Allow-Methods",
				strings.Join(methodOrder, ", "),
			)
			if len(headerOrder) > 0 {
				writer.Header().Set(
					"Access-Control-Allow-Headers",
					strings.Join(headerOrder, ", "),
				)
			}
			if config.MaxAge > 0 {
				writer.Header().Set(
					"Access-Control-Max-Age",
					strconv.FormatInt(int64(config.MaxAge/time.Second), 10),
				)
			}
			writer.WriteHeader(http.StatusNoContent)
		})
	}, nil
}

func normalizeCORSValues(
	values []string,
	uppercase bool,
) (map[string]struct{}, []string, error) {
	result := make(map[string]struct{}, len(values))
	order := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if uppercase {
			value = strings.ToUpper(value)
		}
		if value == "" || value == "*" {
			return nil, nil, errors.New("CORS 不允许空值或通配符")
		}
		if _, exists := result[value]; exists {
			continue
		}
		result[value] = struct{}{}
		order = append(order, value)
	}
	return result, order, nil
}

func normalizeCORSHeaders(
	values []string,
) (map[string]struct{}, []string, error) {
	result := make(map[string]struct{}, len(values))
	order := make([]string, 0, len(values))
	for _, value := range values {
		value = http.CanonicalHeaderKey(strings.TrimSpace(value))
		if value == "" || value == "*" {
			return nil, nil, errors.New("CORS 不允许空 Header 或通配符")
		}
		if _, exists := result[value]; exists {
			continue
		}
		result[value] = struct{}{}
		order = append(order, value)
	}
	return result, order, nil
}

func requestedHeadersAllowed(
	value string,
	allowed map[string]struct{},
) bool {
	if strings.TrimSpace(value) == "" {
		return true
	}
	for _, raw := range strings.Split(value, ",") {
		header := http.CanonicalHeaderKey(strings.TrimSpace(raw))
		if header == "" {
			return false
		}
		if _, ok := allowed[header]; !ok {
			return false
		}
	}
	return true
}

// ClientIPMiddleware 只在直接对端可信时解释 X-Forwarded-For。
func ClientIPMiddleware(trustedProxies []netip.Prefix) Middleware {
	trusted := append([]netip.Prefix(nil), trustedProxies...)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			client, ok := resolveClientIP(request, trusted)
			if !ok {
				next.ServeHTTP(writer, request)
				return
			}
			ctx := context.WithValue(
				request.Context(),
				clientIPContextKey{},
				client,
			)
			next.ServeHTTP(writer, request.WithContext(ctx))
		})
	}
}

// ClientIP 返回经过可信代理规则解析的客户端地址。
func ClientIP(ctx context.Context) (netip.Addr, bool) {
	if ctx == nil {
		return netip.Addr{}, false
	}
	value, ok := ctx.Value(clientIPContextKey{}).(netip.Addr)
	return value, ok && value.IsValid()
}

func resolveClientIP(
	request *http.Request,
	trusted []netip.Prefix,
) (netip.Addr, bool) {
	if request == nil {
		return netip.Addr{}, false
	}
	peer, ok := parseRemoteIP(request.RemoteAddr)
	if !ok {
		return netip.Addr{}, false
	}
	peer = peer.Unmap()
	if !addressTrusted(peer, trusted) {
		return peer, true
	}

	value := strings.TrimSpace(request.Header.Get("X-Forwarded-For"))
	if value == "" {
		return peer, true
	}
	parts := strings.Split(value, ",")
	current := peer
	for index := len(parts) - 1; index >= 0; index-- {
		if !addressTrusted(current, trusted) {
			return current, true
		}
		next, err := netip.ParseAddr(strings.TrimSpace(parts[index]))
		if err != nil {
			return peer, true
		}
		current = next.Unmap()
	}
	return current, true
}

func parseRemoteIP(value string) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(value)
	if err == nil {
		address, parseErr := netip.ParseAddr(host)
		return address, parseErr == nil
	}
	address, parseErr := netip.ParseAddr(value)
	return address, parseErr == nil
}

func addressTrusted(address netip.Addr, trusted []netip.Prefix) bool {
	for _, prefix := range trusted {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

// SensitiveResponseHeadersMiddleware 从 OpenAPI response 元数据识别敏感 operation。
func SensitiveResponseHeadersMiddleware(spec *openapi3.T) (Middleware, error) {
	if spec == nil {
		return nil, ErrValidatorSpecRequired
	}
	router, err := gorillamux.NewRouter(spec)
	if err != nil {
		return nil, err
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			route, _, routeErr := router.FindRoute(request)
			if routeErr == nil &&
				route != nil &&
				route.Operation != nil &&
				operationHasSensitiveResponse(route.Operation) {
				writer.Header().Set("Cache-Control", "no-store")
				writer.Header().Set("Pragma", "no-cache")
			}
			next.ServeHTTP(writer, request)
		})
	}, nil
}

func operationHasSensitiveResponse(operation *openapi3.Operation) bool {
	if operation == nil || operation.Responses == nil {
		return false
	}
	for _, responseRef := range operation.Responses.Map() {
		if responseRef == nil || responseRef.Value == nil {
			continue
		}
		for name := range responseRef.Value.Headers {
			if strings.EqualFold(name, "Cache-Control") {
				return true
			}
		}
	}
	return false
}

// RequestTimeoutMiddleware 为 Handler 传播统一 deadline/cancel。
func RequestTimeoutMiddleware(timeout time.Duration) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if timeout <= 0 {
				next.ServeHTTP(writer, request)
				return
			}
			ctx, cancel := context.WithTimeout(request.Context(), timeout)
			defer cancel()
			next.ServeHTTP(writer, request.WithContext(ctx))
		})
	}
}
