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

	router, err := httpapi.NewRouter(svc, httpapi.ServerConfig{
		AllowedOrigins:  cfg.AllowedOrigins,
		AdminToken:      cfg.AdminToken,
		SupportAgentIDs: cfg.SupportAgentIDs,
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
