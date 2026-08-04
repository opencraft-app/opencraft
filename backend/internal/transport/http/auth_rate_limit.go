package httptransport

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"

	"chatserver/internal/app/command"
	ratelimitport "chatserver/internal/ports/ratelimit"
)

const authRateLimitBodyBytes = 16 * 1024

type authRateBody struct {
	Email        string `json:"email"`
	RefreshToken string `json:"refreshToken"`
}

// AuthRateLimitMiddleware 对认证入口执行本地多主体原子限流。
func AuthRateLimitMiddleware(
	limiter ratelimitport.Limiter,
	encoder *ErrorEncoder,
) (Middleware, error) {
	if limiter == nil || encoder == nil {
		return nil, errors.New("认证限流配置无效")
	}
	gate, err := command.NewRateLimitGate(limiter)
	if err != nil {
		return nil, err
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(
			writer http.ResponseWriter,
			request *http.Request,
		) {
			operationClass := authOperationClass(request.URL.Path)
			if operationClass == "" {
				next.ServeHTTP(writer, request)
				return
			}
			subjects := make([]ratelimitport.Subject, 0, 2)
			if address, ok := requestClientIP(request); ok {
				if subject, err := ratelimitport.NewIPSubject(address); err == nil {
					subjects = append(subjects, subject)
				}
			}
			body := readAuthRateBody(request)
			switch operationClass {
			case "auth_register", "auth_login":
				normalized := strings.ToLower(strings.TrimSpace(body.Email))
				if normalized != "" {
					digest := sha256.Sum256([]byte("email\x00" + normalized))
					subject, err := ratelimitport.NewLoginHashSubject(
						hex.EncodeToString(digest[:]),
					)
					if err == nil {
						subjects = append(subjects, subject)
					}
				}
			case "auth_refresh":
				parts := strings.Split(body.RefreshToken, ".")
				if len(parts) == 4 && parts[0] == "rt1" {
					subject, err := ratelimitport.NewAccountSubject(parts[1])
					if err == nil {
						subjects = append(subjects, subject)
					}
				}
			}
			if len(subjects) == 0 {
				encoder.WriteCode(
					writer,
					RequestID(request.Context()),
					"internal_error",
					nil,
				)
				return
			}
			err := gate.Check(request.Context(), ratelimitport.Request{
				Subjects:       subjects,
				OperationClass: operationClass,
				Cost:           1,
			}, false)
			if err != nil {
				encoder.Write(writer, RequestID(request.Context()), err)
				return
			}
			next.ServeHTTP(writer, request)
		})
	}, nil
}

func authOperationClass(path string) string {
	switch path {
	case "/v1/auth/register":
		return "auth_register"
	case "/v1/auth/login":
		return "auth_login"
	case "/v1/auth/refresh":
		return "auth_refresh"
	case "/v1/auth/logout":
		return "auth_logout"
	case "/v1/me/im/session":
		return "human_im_session"
	default:
		return ""
	}
}

func readAuthRateBody(request *http.Request) authRateBody {
	if request == nil || request.Body == nil || request.Body == http.NoBody ||
		request.ContentLength > authRateLimitBodyBytes {
		return authRateBody{}
	}
	data, err := io.ReadAll(io.LimitReader(
		request.Body,
		authRateLimitBodyBytes+1,
	))
	request.Body = io.NopCloser(bytes.NewReader(data))
	if err != nil || len(data) > authRateLimitBodyBytes {
		return authRateBody{}
	}
	var body authRateBody
	_ = json.Unmarshal(data, &body)
	return body
}

func requestClientIP(request *http.Request) (netip.Addr, bool) {
	if request == nil {
		return netip.Addr{}, false
	}
	if address, ok := ClientIP(request.Context()); ok {
		return address, true
	}
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	address, err := netip.ParseAddr(strings.TrimSpace(host))
	return address.Unmap(), err == nil
}
