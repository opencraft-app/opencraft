package main

import (
	"flag"
	"log"
	"os"
	"path/filepath"
	"strings"

	"acp-client/internal/auth"
	"acp-client/internal/config"
	"acp-client/internal/qqbot"
	"acp-client/internal/router"
	"acp-client/internal/service"

	"github.com/gin-gonic/gin"
)

func main() {
	listen := flag.String("listen", "0.0.0.0:8765", "HTTP 监听地址（对外服务可用 0.0.0.0:端口，勿写 0.0.0.1）")
	ginMode := flag.String("gin-mode", "debug", "Gin 模式: debug | release | test")
	webDir := flag.String("web", "web", "前端静态目录：内含 index.html 与 static/（相对当前工作目录或绝对路径）")
	password := flag.String("password", "", "访问口令；非空时必须先登录。也可设环境变量 ACP_CLIENT_PASSWORD（优先级低于本参数）")
	acpURL := flag.String("acp-url", "ws://101.42.117.125:8080/acp", "远程 ACP WebSocket 服务地址。也可设环境变量 ACP_CLIENT_URL（优先级低于本参数）")
	qqConfigPath := flag.String("qq-config", "qq_bot.json", "QQ 机器人配置文件路径（JSON，可通过页面左上角 QQ 图标配置）")
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.SetPrefix("acp-client ")

	authPassword := strings.TrimSpace(*password)
	if authPassword == "" {
		authPassword = strings.TrimSpace(os.Getenv("ACP_CLIENT_PASSWORD"))
	}

	acpAddr := strings.TrimSpace(*acpURL)
	if acpAddr == "" {
		acpAddr = strings.TrimSpace(os.Getenv("ACP_CLIENT_URL"))
	}
	if acpAddr == "" {
		acpAddr = service.DefaultACPURL
	}

	cfg := config.Config{
		ListenAddr: *listen,
		GinMode:    *ginMode,
	}
	gin.SetMode(cfg.GinMode)

	webRoot, err := filepath.Abs(*webDir)
	if err != nil {
		log.Fatalf("web path: %v", err)
	}
	indexPath := filepath.Join(webRoot, "index.html")
	if st, err := os.Stat(indexPath); err != nil || st.IsDir() {
		log.Fatalf("前端入口不存在或不是文件: %s（请先确认 -web 指向含 index.html 的目录）", indexPath)
	}
	staticDir := filepath.Join(webRoot, "static")
	if st, err := os.Stat(staticDir); err != nil || !st.IsDir() {
		log.Fatalf("前端 static 目录不存在: %s", staticDir)
	}

	loginPath := filepath.Join(webRoot, "login.html")
	if authPassword != "" {
		if st, err := os.Stat(loginPath); err != nil || st.IsDir() {
			log.Fatalf("已启用访问口令，但未找到登录页: %s", loginPath)
		}
	}

	bridge := service.NewBridge()
	bridge.SetACPURL(acpAddr)
	log.Printf("acp-client 远程 ACP 服务: %s", acpAddr)
	bridge.StartDefaultAgent()
	qqService, err := qqbot.New(bridge, qqbot.NewStore(*qqConfigPath))
	if err != nil {
		log.Fatalf("QQ 机器人配置初始化失败: %v", err)
	}
	qqService.Start()

	engine := router.New(&router.Dependencies{
		WebRoot:       webRoot,
		Bridge:        bridge,
		QQBot:         qqService,
		Auth:          auth.NewGuard(authPassword),
		LoginHTMLPath: loginPath,
	})

	if err := router.Serve(cfg.ListenAddr, engine); err != nil {
		log.Fatal(err)
	}
}
