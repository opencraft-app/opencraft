package computerupdate

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"

	api "chatserver/internal/api/computerupdate"
)

const operatorFingerprintHeader = "X-Vela-Operator-Fingerprint"

type RoutesConfig struct {
	Host              string
	Origin            string
	TrustedProxyCIDRs []netip.Prefix
	RequestID         func() string
}

func NewRoutes(handler *Handler, config RoutesConfig) (http.Handler, error) {
	if handler == nil || strings.TrimSpace(config.Host) == "" ||
		strings.ContainsAny(config.Host, "\r\n/ ") ||
		strings.TrimSpace(config.Origin) == "" || len(config.TrustedProxyCIDRs) == 0 ||
		config.RequestID == nil {
		return nil, errors.New("Computer Update routes 配置无效")
	}
	for _, prefix := range config.TrustedProxyCIDRs {
		if !prefix.IsValid() {
			return nil, errors.New("Computer Update trusted proxy 无效")
		}
	}
	strict := api.NewStrictHandlerWithOptions(
		handler,
		nil,
		api.StrictHTTPServerOptions{
			RequestErrorHandlerFunc: func(writer http.ResponseWriter, request *http.Request, _ error) {
				writeRouteError(writer, request.Context(), http.StatusBadRequest, "invalid_request", "请求结构无效")
			},
			ResponseErrorHandlerFunc: func(writer http.ResponseWriter, request *http.Request, _ error) {
				writeRouteError(writer, request.Context(), http.StatusInternalServerError, "internal_error", "Computer Update 暂时不可用")
			},
		},
	)
	generated := api.Handler(strict)
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestID := strings.TrimSpace(config.RequestID())
		if requestID == "" {
			requestID = "request-id-unavailable"
		}
		ctx := WithRequestID(request.Context(), requestID)
		writer.Header().Set("X-Request-ID", requestID)
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		if request.Method == http.MethodGet &&
			(request.URL.Path == "/healthz" || request.URL.Path == "/readyz") {
			writer.Header().Set("Cache-Control", "no-store")
			writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte("ok\n"))
			return
		}
		if requestHost(request.Host) != config.Host ||
			(request.Header.Get("Origin") != "" && request.Header.Get("Origin") != config.Origin) {
			writeRouteError(writer, ctx, http.StatusForbidden, "operator_forbidden", "请求来源无效")
			return
		}
		if strings.HasPrefix(request.URL.Path, "/ops/computer-updates/") {
			if !trustedRemote(request.RemoteAddr, config.TrustedProxyCIDRs) {
				writeRouteError(writer, ctx, http.StatusForbidden, "operator_forbidden", "平台运营身份无效")
				return
			}
			fingerprint, err := DecodeOperatorFingerprint(
				request.Header.Get(operatorFingerprintHeader),
			)
			if err != nil {
				writeRouteError(writer, ctx, http.StatusForbidden, "operator_forbidden", "平台运营身份无效")
				return
			}
			ctx = WithOperatorFingerprint(ctx, fingerprint)
			request.Body = http.MaxBytesReader(writer, request.Body, 64*1024)
			if request.URL.Path == "/ops/computer-updates/" {
				serveOperationsPage(writer, request.WithContext(ctx), requestID)
				return
			}
		}
		request.Header.Del(operatorFingerprintHeader)
		generated.ServeHTTP(writer, request.WithContext(ctx))
	}), nil
}

func requestHost(value string) string {
	value = strings.TrimSpace(value)
	if host, _, err := net.SplitHostPort(value); err == nil {
		return strings.ToLower(host)
	}
	return strings.ToLower(value)
}

func trustedRemote(remote string, prefixes []netip.Prefix) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(remote))
	if err != nil {
		return false
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func writeRouteError(
	writer http.ResponseWriter,
	ctx context.Context,
	status int,
	code string,
	message string,
) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Pragma", "no-cache")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(errorEnvelope(ctx, code, message))
}
