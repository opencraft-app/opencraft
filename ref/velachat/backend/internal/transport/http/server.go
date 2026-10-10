package httptransport

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
)

// ServerConfig 是显式 http.Server 安全参数。
type ServerConfig struct {
	Address           string
	ReadHeaderTimeout time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration
	MaxHeaderBytes    int
	ShutdownTimeout   time.Duration
}

// Server 包装显式 http.Server 和 graceful shutdown 上限。
type Server struct {
	httpServer      *http.Server
	shutdownTimeout time.Duration
}

// NewServer 创建不依赖 http.DefaultServeMux 的 HTTP Server。
func NewServer(config ServerConfig, handler http.Handler) (*Server, error) {
	if strings.TrimSpace(config.Address) == "" ||
		config.ReadHeaderTimeout <= 0 ||
		config.ReadTimeout <= 0 ||
		config.WriteTimeout <= 0 ||
		config.IdleTimeout <= 0 ||
		config.MaxHeaderBytes <= 0 ||
		config.ShutdownTimeout <= 0 {
		return nil, errors.New("HTTP Server 配置无效")
	}
	if handler == nil {
		return nil, errors.New("HTTP Handler 不能为空")
	}

	mux := http.NewServeMux()
	mux.Handle("/", handler)
	return &Server{
		httpServer: &http.Server{
			Addr:              config.Address,
			Handler:           mux,
			ReadHeaderTimeout: config.ReadHeaderTimeout,
			ReadTimeout:       config.ReadTimeout,
			WriteTimeout:      config.WriteTimeout,
			IdleTimeout:       config.IdleTimeout,
			MaxHeaderBytes:    config.MaxHeaderBytes,
		},
		shutdownTimeout: config.ShutdownTimeout,
	}, nil
}

// HTTPServer 返回底层显式配置的标准库 Server。
func (s *Server) HTTPServer() *http.Server {
	if s == nil {
		return nil
	}
	return s.httpServer
}

// Shutdown 在配置的 drain 上限内优雅停止。
func (s *Server) Shutdown(ctx context.Context) error {
	if s == nil || s.httpServer == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	shutdownContext, cancel := context.WithTimeout(ctx, s.shutdownTimeout)
	defer cancel()
	return s.httpServer.Shutdown(shutdownContext)
}
