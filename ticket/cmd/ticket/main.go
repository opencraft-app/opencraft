package main

import (
	"log"
	"net/http"
	"time"

	"git.woa.com/wisp/mono/ticket/internal/config"
	"git.woa.com/wisp/mono/ticket/internal/httpapi"
	"git.woa.com/wisp/mono/ticket/internal/service"
	"git.woa.com/wisp/mono/ticket/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	// MySQL 仅工单系统需要；纯反馈模式（只读 COS）可跳过。
	var svc *service.Service
	if cfg.MySQLDSN != "" {
		st, err := store.NewMySQLStore(cfg.MySQLDSN)
		if err != nil {
			log.Printf("warn: mysql not available, ticket system disabled: %v", err)
		} else {
			defer st.Close()
			svc = service.New(st)
		}
	} else {
		log.Printf("warn: TICKET_MYSQL_DSN not set, ticket system disabled (feedback-only mode)")
	}

	// 反馈系统 COS 客户端：凭证缺失仅记录告警，不阻断 ticket 主流程。
	var supportCos *httpapi.SupportCosClient
	supportCosClient, cosErr := httpapi.NewSupportCosClient(cfg.SupportCOS)
	if cosErr != nil {
		log.Printf("warn: support cos not configured: %v", cosErr)
	} else {
		supportCos = supportCosClient
	}

	router, err := httpapi.NewRouter(svc, httpapi.ServerConfig{
		AllowedOrigins: cfg.AllowedOrigins,
		AdminToken:     cfg.AdminToken,
		SupportAgentIDs: cfg.SupportAgentIDs,
		SupportCOS:     supportCos,
	})
	if err != nil {
		// 常见情形：AdminToken 未配置 → 拒绝启动，避免运营接口被空口令绕过。
		log.Fatalf("init http router: %v", err)
	}

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("ticket listening on %s", cfg.Addr)
	log.Fatal(server.ListenAndServe())
}
