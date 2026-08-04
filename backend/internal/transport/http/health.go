package httptransport

import (
	"context"
	"errors"
	"net/http"
)

// ReadinessCheck 返回 nil 表示实例可接收流量。
type ReadinessCheck func(context.Context) error

// NewLivenessHandler 仅证明 Go 进程和 HTTP 调度仍存活，不依赖外部系统。
func NewLivenessHandler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
		writer.WriteHeader(http.StatusOK)
		if request.Method == http.MethodGet {
			_, _ = writer.Write([]byte("ok\n"))
		}
	})
}

// NewReadinessHandler 创建不向调用方暴露底层数据库错误的就绪检查。
func NewReadinessHandler(check ReadinessCheck) (http.Handler, error) {
	if check == nil {
		return nil, errors.New("readiness check 不能为空")
	}
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if err := check(request.Context()); err != nil {
			writer.WriteHeader(http.StatusServiceUnavailable)
			if request.Method == http.MethodGet {
				_, _ = writer.Write([]byte("not ready\n"))
			}
			return
		}
		writer.WriteHeader(http.StatusOK)
		if request.Method == http.MethodGet {
			_, _ = writer.Write([]byte("ready\n"))
		}
	}), nil
}
