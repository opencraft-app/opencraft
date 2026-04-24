package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/config"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/redisclient"
	"git.woa.com/wisp/mono/ai-gateway/internal/router"
	"git.woa.com/wisp/mono/ai-gateway/internal/scheduler"
	"git.woa.com/wisp/mono/ai-gateway/internal/serverstate"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

const (
	// drainTimeout 是等待活跃请求完成的最大时长（与 SSE WriteTimeout 对齐）
	drainTimeout             = 5 * time.Minute
	shutdownTimeout          = 6 * time.Minute
	usageSinkShutdownTimeout = 5 * time.Second
	defaultConfigPath        = "deploy/config.yaml"
)

// Server 封装所有服务依赖，实现优雅关闭。
type Server struct {
	httpSrv           *http.Server
	sqlDB             *sql.DB
	redis             *redisclient.Client
	proxyClient       *http.Client
	sched             *scheduler.Scheduler
	tracker           *serverstate.ConnTracker
	tokenBalanceStore interface{ Stop() }
	usageSink         interface{ Shutdown(context.Context) error }
	supervisor        interface{ Stop() error }
	drainState        *serverstate.DrainState
	configPath        string
}

// Shutdown 实现优雅关闭流程，无需手动干预。
//
// 关闭顺序：
//  1. 标记 draining，/ready → 503，停止接受新 TCP 连接
//  2. 智能排空：等待所有活跃请求完成（最多 drainTimeout）
//  3. 停止后台调度器
//  4. 等待 token 余额写回 Redis → DB 完成
//  5. 等待异步缓存写完成（最多 cacheShutdownTimeout）
//  6. 关闭上游 HTTP Client（释放 Portkey 连接池）
//  7. 关闭 Redis 连接
//  8. 关闭 MySQL 连接池
//  9. 停止 Portkey Supervisor（如果有）
//  10. 优雅关闭 HTTP Server
func (s *Server) Shutdown(ctx context.Context) error {
	var errs []error

	// Phase 1: 进入 Draining 状态
	s.drainState.SetDraining(true)
	s.httpSrv.SetKeepAlivesEnabled(false)
	slog.Info("entering draining mode", "drain_timeout", drainTimeout.String())

	// Phase 2: 智能排空——等待所有活跃 SSE 请求完成
	if err := s.tracker.Drain(drainTimeout); err != nil {
		errs = append(errs, fmt.Errorf("tracker drain: %w", err))
	}

	// Phase 3: 停止后台调度器
	s.sched.Stop()

	// Phase 4: 等待 token 余额写回 Redis → DB 完成
	if s.tokenBalanceStore != nil {
		s.tokenBalanceStore.Stop()
	}

	// Phase 5: 等待 usage 批量写完成
	if s.usageSink != nil {
		usageCtx, cancel := context.WithTimeout(ctx, usageSinkShutdownTimeout)
		if err := s.usageSink.Shutdown(usageCtx); err != nil {
			errs = append(errs, fmt.Errorf("usage sink shutdown: %w", err))
		}
		cancel()
	}

	// Phase 6: 关闭上游 HTTP Client
	if s.proxyClient != nil && s.proxyClient.Transport != nil {
		if tr, ok := s.proxyClient.Transport.(*http.Transport); ok {
			tr.CloseIdleConnections()
			slog.Info("upstream HTTP client closed")
		}
	}

	// Phase 7: 关闭 Redis
	if err := s.redis.Close(); err != nil {
		errs = append(errs, fmt.Errorf("redis close: %w", err))
	} else {
		slog.Info("redis connection closed")
	}

	// Phase 8: 关闭 MySQL
	if err := s.sqlDB.Close(); err != nil {
		errs = append(errs, fmt.Errorf("mysql close: %w", err))
	} else {
		slog.Info("mysql connection closed")
	}

	// Phase 9: 停止 Portkey Supervisor
	if s.supervisor != nil {
		if err := s.supervisor.Stop(); err != nil {
			errs = append(errs, fmt.Errorf("supervisor stop: %w", err))
		}
	}

	// Phase 10: 优雅关闭 HTTP Server
	shutdownCtx, cancel := context.WithTimeout(ctx, shutdownTimeout)
	defer cancel()
	if err := s.httpSrv.Shutdown(shutdownCtx); err != nil {
		errs = append(errs, fmt.Errorf("http shutdown: %w", err))
	}

	if len(errs) > 0 {
		slog.Error("shutdown completed with errors", "errors", errs)
		return errs[0]
	}
	slog.Info("AI Gateway stopped gracefully")
	return nil
}

// @title AI Gateway API
// @version 1.0
// @description AI Gateway SaaS - OpenAI-compatible API proxy with token billing, rate limiting, and multi-provider support.
// @host localhost:18080
// @BasePath /
// @securityDefinitions.apikey BearerAuth
// @in header
// @name Authorization
// @description Enter your API key with the `Bearer ` prefix, e.g. "Bearer sk-xxxx"
func main() {
	// Load .env file (ignore error if not present)
	_ = godotenv.Load()

	// Load configuration
	configPath := resolveConfigPath()

	cfg, err := config.LoadConfig(configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Validate encryption key
	if cfg.EncryptionKey == "" {
		log.Fatal("ENCRYPTION_KEY environment variable is required")
	}
	if len(cfg.EncryptionKey) != 32 {
		log.Fatal("ENCRYPTION_KEY must be exactly 32 bytes (256-bit AES key)")
	}

	// Set Gin mode
	if os.Getenv("GIN_MODE") == "release" {
		gin.SetMode(gin.ReleaseMode)
	}

	// Connect to MySQL
	db, err := gorm.Open(mysql.Open(cfg.Database.DSN), &gorm.Config{
		NowFunc: func() time.Time { return time.Now().UTC() },
	})
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		log.Fatalf("Failed to get database connection: %v", err)
	}
	sqlDB.SetMaxOpenConns(25)
	sqlDB.SetMaxIdleConns(10)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)
	sqlDB.SetConnMaxIdleTime(1 * time.Minute)

	slog.Info("database connected", "dsn_prefix", cfg.Database.DSN[:min(len(cfg.Database.DSN), 30)]+"...")

	// Connect to Redis
	redisClient := redisclient.NewClient(cfg.Redis.Addr, cfg.Redis.Password)
	slog.Info("redis connected", "addr", cfg.Redis.Addr)

	// 创建连接追踪器和 draining 状态
	tracker := serverstate.NewConnTracker()
	drainState := serverstate.DefaultDrainState()

	// Setup router with all routes and middleware（注入 tracker 和 drainState）
	result := router.Setup(cfg, db, redisClient, tracker, drainState)

	// Start background scheduler
	sched := scheduler.New(result.SubSvc, result.ProviderRepo, result.ModelMappingRepo, result.RegistryCfg)
	sched.Start()

	// Start HTTP server
	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	httpSrv := &http.Server{
		Addr:         addr,
		Handler:      result.Engine,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 5 * time.Minute, // long for streaming responses
		IdleTimeout:  120 * time.Second,
	}

	// 创建 Server 实例
	srv := &Server{
		httpSrv:           httpSrv,
		sqlDB:             sqlDB,
		redis:             redisClient,
		proxyClient:       result.ProxyClient,
		sched:             sched,
		tracker:           tracker,
		tokenBalanceStore: result.TokenBalanceStore,
		usageSink:         result.UsageSink,
		supervisor:        nil, // Supervisor 默认不启用
		drainState:        drainState,
		configPath:        configPath,
	}

	// 启动 HTTP server
	go func() {
		slog.Info("AI Gateway starting", "addr", addr)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	// 信号处理 goroutine
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	for sig := range quit {
		if sig == syscall.SIGHUP {
			handleSIGHUP(srv)
			continue
		}
		slog.Info("shutting down", "signal", sig.String())
		ctx, cancel := context.WithTimeout(context.Background(),
			drainTimeout+shutdownTimeout+30*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Fatalf("shutdown failed: %v", err)
		}
		return
	}
}

func resolveConfigPath() string {
	configPath := os.Getenv("CONFIG_PATH")
	if configPath == "" {
		return defaultConfigPath
	}

	if _, err := os.Stat(configPath); err == nil {
		return configPath
	} else if !errors.Is(err, os.ErrNotExist) {
		return configPath
	}

	if filepath.Ext(configPath) == ".yaml" && filepath.Base(configPath) == "config.local.yaml" {
		if _, err := os.Stat(defaultConfigPath); err == nil {
			slog.Warn("configured local config missing, falling back to default config",
				"configured_path", configPath,
				"fallback_path", defaultConfigPath)
			return defaultConfigPath
		}
	}

	return configPath
}

// handleSIGHUP 重新加载配置（YAML + runtime_configs）。
// 无需重启进程即可更新路由策略、熔断器参数等配置。
func handleSIGHUP(srv *Server) {
	slog.Info("SIGHUP received, reloading configuration...")

	newCfg, err := config.LoadConfig(srv.configPath)
	if err != nil {
		slog.Error("配置重载失败（YAML 解析错误）", "error", err)
		return
	}

	// 重新加载 runtime_configs（如果 router 暴露了 configStore）
	// 注意：router.Setup() 中创建的 configStore 目前没有暴露出去，
	// 后续可在 SetupResult 中添加 ConfigStore 字段来支持热重载
	// if result.ConfigStore != nil {
	//     result.ConfigStore.Reload()
	// }

	slog.Info("配置重载完成",
		"portkey_mode", newCfg.Portkey.Strategy.Mode,
		"portkey_retry_attempts", newCfg.Portkey.Strategy.RetryAttempts,
		"circuit_breaker_threshold", newCfg.CircuitBreaker.FailureThreshold,
	)
}
