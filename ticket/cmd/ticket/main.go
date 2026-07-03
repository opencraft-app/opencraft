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

	st, err := store.NewMySQLStore(cfg.MySQLDSN)
	if err != nil {
		log.Fatalf("init mysql store: %v", err)
	}
	defer st.Close()

	svc := service.New(st)

	router, err := httpapi.NewRouter(svc, httpapi.ServerConfig{
		AllowedOrigins: cfg.AllowedOrigins,
		AdminToken:     cfg.AdminToken,
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
