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
	})

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("trade listening on %s", cfg.Addr)
	log.Fatal(server.ListenAndServe())
}
