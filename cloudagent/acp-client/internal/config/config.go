package config

// Config 为进程级配置（可由 main 从 flag / 环境变量填充）。
type Config struct {
	ListenAddr string
	GinMode    string // debug | release | test
	ACPURL     string // 远程 ACP WebSocket 服务地址
}
