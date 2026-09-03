// Command devtunnel 是反向回调隧道的服务端，部署在 tkex 集群内。
//
// 数据流（详见 internal/devtunnel 包注释）：
//
//	jifei → 云梯(按 uin 改派 + 盖 Host) → devtunnel ingest(按 Host 分流)
//	                                          ↑ 阻塞等应答
//	DevCloud agent ── 出站长轮询 poll ────────┘ 取走 → 回放本地 trade → reply
//
// 只监听一个端口：ingest 与 agent 控制面（/_tunnel/poll、/_tunnel/reply）共用。
// 集群内由云梯经 ClusterIP 访问 ingest；集群外的 agent 经云梯 CLB 的一条 proxy
// 路由访问控制面（都是 DevCloud 出站，绕开"云梯反向连不进 DevCloud"）。
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/devtunnel"
)

func main() {
	logger := log.New(os.Stdout, "", log.LstdFlags|log.LUTC)

	addr := envOr("DEVTUNNEL_LISTEN", ":8080")
	token := strings.TrimSpace(os.Getenv("DEVTUNNEL_TOKEN"))
	if token == "" {
		logger.Printf("[devtunnel] WARNING: DEVTUNNEL_TOKEN 未设置，所有端点无鉴权 —— 仅允许本地自测")
	}

	hub := devtunnel.NewHub()
	srv := devtunnel.NewServer(hub, devtunnel.ServerOptions{
		Token:           token,
		DispatchTimeout: durationEnv(logger, "DEVTUNNEL_DISPATCH_TIMEOUT", devtunnel.DefaultDispatchTimeout),
		PollTimeout:     durationEnv(logger, "DEVTUNNEL_POLL_TIMEOUT", devtunnel.DefaultPollTimeout),
		MaxBodyBytes:    int64Env(logger, "DEVTUNNEL_MAX_BODY_BYTES", 1<<20),
		Logger:          logger,
	})

	httpServer := &http.Server{
		Addr:    addr,
		Handler: srv,
		// ReadTimeout 必须大于 poll 挂起时长，否则长轮询会被服务端提前掐断。
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      35 * time.Second,
	}

	go func() {
		logger.Printf("[devtunnel] listening on %s (auth=%v)", addr, token != "")
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("[devtunnel] server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	logger.Printf("[devtunnel] shutting down")
	hub.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func durationEnv(logger *log.Logger, key string, def time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		logger.Printf("[devtunnel] %s=%q 解析失败(%v)，用默认 %s", key, v, err, def)
		return def
	}
	return d
}

func int64Env(logger *log.Logger, key string, def int64) int64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		logger.Printf("[devtunnel] %s=%q 无效，用默认 %d", key, v, def)
		return def
	}
	return n
}
