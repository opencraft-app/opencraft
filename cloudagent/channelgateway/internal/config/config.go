package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	DBPath                   string
	DBDriver                 string
	EventBus                 EventBusConfig
	ACPURL                   string
	RuntimeProtocol          string
	ACPAuthorization         string
	CloudAgentSandboxBackend string
	TenantID                 string
	ProjectID                string
	OwnerID                  string
	ListenAddr               string
	LeaseTTL                 time.Duration
	RequestTimeout           time.Duration
	PromptTimeout            time.Duration
	ACPInitializeTimeout     time.Duration
	SessionIdleClose         time.Duration
	WeCom                    WeComConfig
	WeComAccounts            []WeComConfig
	parseErrors              []string
}

type WeComConfig struct {
	Enabled      bool
	AccountID    string
	BotID        string
	Secret       string
	WebSocketURL string
	AgentID      string
	TenantID     string
	ProjectID    string
	DMPolicy     string
	GroupPolicy  string
}

type EventBusConfig struct {
	Driver             string
	RedisAddr          string
	RedisPassword      string
	RedisDB            int
	RedisStreamPrefix  string
	RedisConsumerGroup string
	RedisClaimIdle     time.Duration
	RedisReadBlock     time.Duration
	PollInterval       time.Duration
	InboundWorkerCount int
}

func LoadFromEnv() Config {
	wecom := WeComConfig{
		Enabled:      envBool("CHANNELGATEWAY_WECOM_ENABLED", false),
		AccountID:    env("CHANNELGATEWAY_WECOM_ACCOUNT_ID", "wecom-default"),
		BotID:        env("WECOM_BOT_ID", ""),
		Secret:       env("WECOM_SECRET", ""),
		WebSocketURL: envAny([]string{"WECOM_WEBSOCKET_URL", "CODEBUDDY_WECOM_BOT_WS_URL"}, "wss://openws.work.weixin.qq.com"),
		AgentID:      env("CHANNELGATEWAY_AGENT_ID", "agent_default"),
		TenantID:     env("CHANNELGATEWAY_TENANT_ID", "default"),
		ProjectID:    env("CHANNELGATEWAY_PROJECT_ID", "default"),
		DMPolicy:     env("CHANNELGATEWAY_WECOM_DM_POLICY", "open"),
		GroupPolicy:  env("CHANNELGATEWAY_WECOM_GROUP_POLICY", "open"),
	}
	accounts, parseErrs := parseWeComAccountsJSON(os.Getenv("CHANNELGATEWAY_WECOM_ACCOUNTS_JSON"), wecom)
	if len(accounts) == 0 && wecom.Enabled {
		accounts = []WeComConfig{wecom}
	}
	return Config{
		DBPath:   env("CHANNELGATEWAY_DB_PATH", "channelgateway.db"),
		DBDriver: env("CHANNELGATEWAY_DB_DRIVER", ""),
		EventBus: EventBusConfig{
			Driver:             strings.ToLower(env("CHANNELGATEWAY_EVENT_BUS_DRIVER", "")),
			RedisAddr:          env("CHANNELGATEWAY_REDIS_ADDR", ""),
			RedisPassword:      env("CHANNELGATEWAY_REDIS_PASSWORD", ""),
			RedisDB:            envInt("CHANNELGATEWAY_REDIS_DB", 0),
			RedisStreamPrefix:  env("CHANNELGATEWAY_REDIS_STREAM_PREFIX", "channelgateway"),
			RedisConsumerGroup: env("CHANNELGATEWAY_REDIS_CONSUMER_GROUP", "channelgateway"),
			RedisClaimIdle:     envDuration("CHANNELGATEWAY_REDIS_CLAIM_IDLE", 30*time.Second),
			RedisReadBlock:     envDuration("CHANNELGATEWAY_REDIS_READ_BLOCK", 2*time.Second),
			PollInterval:       envDuration("CHANNELGATEWAY_EVENT_BUS_POLL_INTERVAL", time.Second),
			InboundWorkerCount: envInt("CHANNELGATEWAY_EVENT_BUS_INBOUND_WORKERS", 4),
		},
		ACPURL:                   env("CHANNELGATEWAY_ACP_URL", "ws://127.0.0.1:18094/acp"),
		RuntimeProtocol:          strings.ToLower(env("CHANNELGATEWAY_RUNTIME_PROTOCOL", "acp")),
		ACPAuthorization:         env("CHANNELGATEWAY_ACP_AUTHORIZATION", ""),
		CloudAgentSandboxBackend: strings.TrimSpace(env("CHANNELGATEWAY_CLOUDAGENT_SANDBOX_BACKEND", "")),
		TenantID:                 env("CHANNELGATEWAY_TENANT_ID", "default"),
		ProjectID:                env("CHANNELGATEWAY_PROJECT_ID", "default"),
		OwnerID:                  env("CHANNELGATEWAY_OWNER_ID", "channelgateway-"+shortHostname()),
		ListenAddr:               env("CHANNELGATEWAY_LISTEN_ADDR", ":8094"),
		LeaseTTL:                 envDuration("CHANNELGATEWAY_LEASE_TTL", 90*time.Second),
		RequestTimeout:           envDuration("CHANNELGATEWAY_REQUEST_TIMEOUT", 60*time.Second),
		PromptTimeout:            envDuration("CHANNELGATEWAY_PROMPT_TIMEOUT", 30*time.Minute),
		ACPInitializeTimeout:     envDuration("CHANNELGATEWAY_ACP_INITIALIZE_TIMEOUT", 15*time.Second),
		SessionIdleClose:         envDuration("CHANNELGATEWAY_SESSION_IDLE_CLOSE", time.Minute),
		WeCom:                    wecom,
		WeComAccounts:            accounts,
		parseErrors:              parseErrs,
	}
}

func (c Config) Validate() error {
	if len(c.parseErrors) == 0 {
		return nil
	}
	return fmt.Errorf("invalid channelgateway config: %s", strings.Join(c.parseErrors, "; "))
}

func (c Config) EnabledWeComAccounts() []WeComConfig {
	if len(c.WeComAccounts) == 0 {
		if c.WeCom.Enabled {
			return []WeComConfig{c.WeCom}
		}
		return nil
	}
	accounts := make([]WeComConfig, 0, len(c.WeComAccounts))
	for _, account := range c.WeComAccounts {
		if account.Enabled {
			accounts = append(accounts, account)
		}
	}
	return accounts
}

type weComAccountJSON struct {
	Enabled      *bool  `json:"enabled"`
	AccountID    string `json:"account_id"`
	BotID        string `json:"bot_id"`
	Secret       string `json:"secret"`
	WebSocketURL string `json:"websocket_url"`
	AgentID      string `json:"agent_id"`
	TenantID     string `json:"tenant_id"`
	ProjectID    string `json:"project_id"`
	DMPolicy     string `json:"dm_policy"`
	GroupPolicy  string `json:"group_policy"`
}

func parseWeComAccountsJSON(raw string, defaults WeComConfig) ([]WeComConfig, []string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var items []weComAccountJSON
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil, []string{"CHANNELGATEWAY_WECOM_ACCOUNTS_JSON: " + err.Error()}
	}
	accounts := make([]WeComConfig, 0, len(items))
	var errs []string
	seen := map[string]struct{}{}
	for i, item := range items {
		account := defaults
		account.Enabled = true
		if item.Enabled != nil {
			account.Enabled = *item.Enabled
		}
		if strings.TrimSpace(item.AccountID) != "" {
			account.AccountID = strings.TrimSpace(item.AccountID)
		}
		if strings.TrimSpace(item.BotID) != "" {
			account.BotID = strings.TrimSpace(item.BotID)
		}
		if strings.TrimSpace(item.Secret) != "" {
			account.Secret = strings.TrimSpace(item.Secret)
		}
		if strings.TrimSpace(item.WebSocketURL) != "" {
			account.WebSocketURL = strings.TrimSpace(item.WebSocketURL)
		}
		if strings.TrimSpace(item.AgentID) != "" {
			account.AgentID = strings.TrimSpace(item.AgentID)
		}
		if strings.TrimSpace(item.TenantID) != "" {
			account.TenantID = strings.TrimSpace(item.TenantID)
		}
		if strings.TrimSpace(item.ProjectID) != "" {
			account.ProjectID = strings.TrimSpace(item.ProjectID)
		}
		if strings.TrimSpace(item.DMPolicy) != "" {
			account.DMPolicy = strings.TrimSpace(item.DMPolicy)
		}
		if strings.TrimSpace(item.GroupPolicy) != "" {
			account.GroupPolicy = strings.TrimSpace(item.GroupPolicy)
		}
		if strings.TrimSpace(account.AccountID) == "" {
			errs = append(errs, fmt.Sprintf("CHANNELGATEWAY_WECOM_ACCOUNTS_JSON[%d].account_id is required", i))
			continue
		}
		if _, ok := seen[account.AccountID]; ok {
			errs = append(errs, fmt.Sprintf("CHANNELGATEWAY_WECOM_ACCOUNTS_JSON duplicate account_id %q", account.AccountID))
			continue
		}
		seen[account.AccountID] = struct{}{}
		accounts = append(accounts, account)
	}
	return accounts, errs
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
