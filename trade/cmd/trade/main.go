package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"git.woa.com/wisp/mono/trade/internal/config"
	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi"
	"git.woa.com/wisp/mono/trade/internal/store"
	"git.woa.com/wisp/mono/trade/internal/worker"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	mysqlStore, err := store.NewMySQLStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("init mysql store: %v", err)
	}
	defer mysqlStore.Close()

	// ctl 反向调用客户端：
	//   - checkCreate 阶段（迭代 5 已落地）：GetBundleByID + ListPassesByUser
	//   - createResource 阶段（迭代 6）：CompletePass
	ctlClient := ctlclient.New(cfg.CtlInternalBaseURL, cfg.InternalServiceToken)

	router := httpapi.NewRouter(httpapi.ServerConfig{
		InternalServiceToken:    cfg.InternalServiceToken,
		JifeiComponentName:      cfg.JifeiComponentName,
		JifeiProtocolVersion:    cfg.JifeiProtocolVersion,
		JifeiOurInterfacePrefix: cfg.JifeiOurInterfacePrefix,
		// 迭代 5：checkCreate handler 业务依赖。
		OrderStore:  mysqlStore,
		BundleStore: mysqlStore,
		CTLClient:   ctlClient,
		// 迭代 6：createResource handler 抢占式幂等。
		FlowStore: mysqlStore,
		// OrderUpdater 在迭代 8 PlaceOrder 写端落地后才接线；本期允许 nil。
		// trade_order 写端尚未实现，createResource 成功后只在 ctl 侧生成 pass，
		// trade_order.resource_id 暂不回填，由 reconcile worker（迭代 7）兜底。
		OrderUpdater: nil,
	})

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// 迭代 7：trade_flow reconcile worker（Q61 兜底分支）。
	//   - 周期扫描 status='in_progress' AND created_time < NOW()-30min 的孤儿记录
	//   - Prober 本期为 nil（保守模式：仅日志告警，不自动升级状态）；
	//     迭代 8 ctl 暴露按 dealName 反查 pass 的接口后，注入真实 prober 自动升级
	//   - 优雅停机：捕获 SIGINT/SIGTERM 后 cancel ctx，worker 退出后再关 HTTP server
	reconcileWorker := worker.New(mysqlStore, worker.Config{
		// 全部走默认值（Interval=5min, StaleThreshold=30min, BatchLimit=100）
	})
	rootCtx, cancelRoot := context.WithCancel(context.Background())
	go reconcileWorker.Run(rootCtx)

	// 信号处理：SIGINT / SIGTERM → 关停 worker + http server
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		s := <-sigCh
		log.Printf("trade received signal %v, shutting down...", s)
		cancelRoot()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("http server shutdown error: %v", err)
		}
	}()

	log.Printf("trade listening on %s", cfg.Addr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen and serve: %v", err)
	}
	cancelRoot()
}
