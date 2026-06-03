package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DBPath           string
	ACPURL           string
	ACPAuthorization string
	TenantID         string
	ProjectID        string
	OwnerID          string
	ListenAddr       string
	LeaseTTL         time.Duration
	RequestTimeout   time.Duration
	WeCom            WeComConfig
}

type WeComConfig struct {
	Enabled          bool
	AccountID        string
	BotID            string
	Secret           string
	WebSocketURL     string
	AgentID          string
	TenantID         string
	ProjectID        string
	DMPolicy         string
	GroupPolicy      string
	HandlerWorkers   int
	HandlerQueueSize int
}

func LoadFromEnv() Config {
	return Config{
		DBPath:           env("CHANNELGATEWAY_DB_PATH", "channelgateway.db"),
		ACPURL:           env("CHANNELGATEWAY_ACP_URL", "ws://127.0.0.1:18094/acp"),
		ACPAuthorization: env("CHANNELGATEWAY_ACP_AUTHORIZATION", ""),
		TenantID:         env("CHANNELGATEWAY_TENANT_ID", "default"),
		ProjectID:        env("CHANNELGATEWAY_PROJECT_ID", "default"),
		OwnerID:          env("CHANNELGATEWAY_OWNER_ID", "channelgateway-"+shortHostname()),
		ListenAddr:       env("CHANNELGATEWAY_LISTEN_ADDR", ":8094"),
		LeaseTTL:         envDuration("CHANNELGATEWAY_LEASE_TTL", 90*time.Second),
		RequestTimeout:   envDuration("CHANNELGATEWAY_REQUEST_TIMEOUT", 60*time.Second),
		WeCom: WeComConfig{
			Enabled:          envBool("CHANNELGATEWAY_WECOM_ENABLED", false),
			AccountID:        env("CHANNELGATEWAY_WECOM_ACCOUNT_ID", "wecom-default"),
			BotID:            env("WECOM_BOT_ID", ""),
			Secret:           env("WECOM_SECRET", ""),
			WebSocketURL:     envAny([]string{"WECOM_WEBSOCKET_URL", "CODEBUDDY_WECOM_BOT_WS_URL"}, "wss://openws.work.weixin.qq.com"),
			AgentID:          env("CHANNELGATEWAY_AGENT_ID", "agent_default"),
			TenantID:         env("CHANNELGATEWAY_TENANT_ID", "default"),
			ProjectID:        env("CHANNELGATEWAY_PROJECT_ID", "default"),
			DMPolicy:         env("CHANNELGATEWAY_WECOM_DM_POLICY", "open"),
			GroupPolicy:      env("CHANNELGATEWAY_WECOM_GROUP_POLICY", "open"),
			HandlerWorkers:   envInt("CHANNELGATEWAY_WECOM_HANDLER_WORKERS", 4),
			HandlerQueueSize: envInt("CHANNELGATEWAY_WECOM_HANDLER_QUEUE_SIZE", 128),
		},
	}
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envAny(keys []string, fallback string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDuration(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	if d, err := time.ParseDuration(value); err == nil {
		return d
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func shortHostname() string {
	name, err := os.Hostname()
	if err != nil || strings.TrimSpace(name) == "" {
		return "local"
	}
	name = strings.TrimSpace(name)
	if len(name) > 24 {
		return name[:24]
	}
	return name
}
