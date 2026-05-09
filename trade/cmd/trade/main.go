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
	log.Printf("trade listening on %s", cfg.Addr)
	log.Fatal(server.ListenAndServe())
}
