package main

import (
	"log"
	"net/http"
	"time"

	"git.woa.com/wisp/mono/trade/internal/config"
	"git.woa.com/wisp/mono/trade/internal/ctlclient"
	"git.woa.com/wisp/mono/trade/internal/httpapi"
	"git.woa.com/wisp/mono/trade/internal/store"
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

	// ctl 反向调用客户端（迭代 2 接入）
	//   - checkCreate 阶段：GetBundleByID + ListInServicePasses
	//   - createResource 阶段：CompletePass
	// 当前迭代仅初始化并预留依赖注入入口；具体调用在迭代 5 / 6 接入。
	ctlClient := ctlclient.New(cfg.CtlInternalBaseURL, cfg.InternalServiceToken)
	_ = ctlClient // 防止 unused 编译错；迭代 5 起注入到 service / handler

	router := httpapi.NewRouter(httpapi.ServerConfig{
		InternalServiceToken: cfg.InternalServiceToken,
	})

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("trade listening on %s", cfg.Addr)
	log.Fatal(server.ListenAndServe())
}
