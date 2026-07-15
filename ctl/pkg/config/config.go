// Package config ...
package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/BurntSushi/toml"

	"ctl/pkg/util"
)

// ServerConf 全局服务器配置
var ServerConf = &GlobalConfig{}
var LoadedConfDir string

// Init ...
func Init(confDir string) error {
	LoadedConfDir = confDir
	err := parseServerConf(confDir)
	if err != nil {
		return fmt.Errorf("parseServerConf error: %w", err)
	}

	parseAPIConf()
	parseRedisConf()
	parseMQConf()
	parseMySQLConf()
	parseAdapterConf()
	parseAllServiceRoleConf()
	parseAllServiceAccountConf()
	parseAgentChatConf()

	return nil
}

func parseAPIConf() {
	if ServerConf.APIConfig == nil {
		ServerConf.APIConfig = &APIConfig{}
	}
	if ServerConf.APIConfig.Instance == nil {
		ServerConf.APIConfig.Instance = &InstanceAPIConfig{}
	}
	if ServerConf.APIConfig.Instance.DefaultTemplateID == "" {
		ServerConf.APIConfig.Instance.DefaultTemplateID = "openclaw-default"
	}
	if strings.TrimSpace(ServerConf.APIConfig.Instance.DefaultSKUID) == "" {
		ServerConf.APIConfig.Instance.DefaultSKUID = "sku-hermes-4c8g"
	}
	if ServerConf.APIConfig.Instance.CreatePoolMaxAttempts < 0 {
		ServerConf.APIConfig.Instance.CreatePoolMaxAttempts = 0
	}
	if strings.TrimSpace(ServerConf.APIConfig.Instance.SoulTemplateDir) == "" {
		ServerConf.APIConfig.Instance.SoulTemplateDir = "/etc/ctl/souls"
	}
	if ServerConf.APIConfig.Instance.ChurnGuardEnabled == nil {
		enabled := true
		ServerConf.APIConfig.Instance.ChurnGuardEnabled = &enabled
	}
	if ServerConf.APIConfig.Instance.ChurnWindowSeconds <= 0 {
		ServerConf.APIConfig.Instance.ChurnWindowSeconds = 600
	}
	if ServerConf.APIConfig.Instance.CreateThreshold <= 0 {
		ServerConf.APIConfig.Instance.CreateThreshold = 3
	}
	if ServerConf.APIConfig.Instance.DestroyThreshold <= 0 {
		ServerConf.APIConfig.Instance.DestroyThreshold = 2
	}
	if ServerConf.APIConfig.Instance.UserAbuseGuardEnabled == nil {
		enabled := true
		ServerConf.APIConfig.Instance.UserAbuseGuardEnabled = &enabled
	}
	if ServerConf.APIConfig.Instance.UserAbuseCreateThreshold <= 0 {
		ServerConf.APIConfig.Instance.UserAbuseCreateThreshold = 10
	}
	if ServerConf.APIConfig.Instance.UserAbuseDestroyThreshold <= 0 {
		ServerConf.APIConfig.Instance.UserAbuseDestroyThreshold = 8
	}
	if ServerConf.APIConfig.Instance.UserAbuseCooldownSeconds <= 0 {
		ServerConf.APIConfig.Instance.UserAbuseCooldownSeconds = 600
	}
	if ServerConf.APIConfig.Instance.UserAbuseRefreshSeconds <= 0 {
		ServerConf.APIConfig.Instance.UserAbuseRefreshSeconds = 10
	}
	if ServerConf.APIConfig.Instance.PressureRefreshSec <= 0 {
		ServerConf.APIConfig.Instance.PressureRefreshSec = 5
	}
	if ServerConf.APIConfig.Instance.PressureTTLSec <= 0 {
		ServerConf.APIConfig.Instance.PressureTTLSec = 15
	}
	if ServerConf.APIConfig.Instance.PressureCleanRatio <= 0 || ServerConf.APIConfig.Instance.PressureCleanRatio > 1 {
		ServerConf.APIConfig.Instance.PressureCleanRatio = 0.25
	}
	if ServerConf.APIConfig.Instance.PressureMinClean <= 0 {
		ServerConf.APIConfig.Instance.PressureMinClean = 2
	}
}

func parseServerConf(confDir string) error {
	err := parseConfFile(confDir + "/common/server_conf.toml")
	if err != nil {
		return fmt.Errorf("parse server_conf.toml error: %w", err)
	}

	err = parseConfFile(confDir + "/rewrite/server_conf_rewrite.toml")
	if err != nil {
		return fmt.Errorf("parse server_conf_rewrite.toml error: %w", err)
	}

	return nil
}

func parseConfFile(path string) error {
	_, err := toml.DecodeFile(path, ServerConf)
	if err != nil {
		return fmt.Errorf("toml.DecodeFile error: %w", err)
	}

	return nil
}

func parseRedisConf() {
	ServerConf.RedisConfig.Pass = util.DecryptString(ServerConf.RedisConfig.Pass)
	if value := strings.TrimSpace(os.Getenv("CTL_REDIS_PASS")); value != "" {
		ServerConf.RedisConfig.Pass = value
	}
	ServerConf.RedisConfig.ConnectTimeout = time.Duration(ServerConf.RedisConfig.ConnectTimeoutSeconds) * time.Second
	ServerConf.RedisConfig.RWTimeout = time.Duration(ServerConf.RedisConfig.RWTimeoutSeconds) * time.Second
	ServerConf.RedisConfig.MQRWTimeout = time.Duration(ServerConf.RedisConfig.MQRWTimeoutSeconds) * time.Second
	ServerConf.RedisConfig.PoolKeepAliveInterval = time.Duration(
		ServerConf.RedisConfig.PoolKeepAliveIntervalSeconds) * time.Second
	ServerConf.RedisConfig.PoolClientMaxIdleTime = time.Duration(
		ServerConf.RedisConfig.PoolClientMaxIdleSeconds) * time.Second
}

func parseMQConf() {
	if ServerConf.MQConfig == nil {
		ServerConf.MQConfig = &MQConfig{}
	}
	if value := strings.TrimSpace(os.Getenv("CTL_MQ_STREAM_KEY")); value != "" {
		ServerConf.MQConfig.StreamKey = value
	}
}

func parseMySQLConf() {
	ServerConf.DBConfig.Password = util.DecryptString(ServerConf.DBConfig.Password)
	if value := strings.TrimSpace(os.Getenv("CTL_DB_PASSWORD")); value != "" {
		ServerConf.DBConfig.Password = value
	}
	ServerConf.DBConfig.RWTimeout = time.Duration(ServerConf.DBConfig.RWTimeoutSeconds) * time.Second
}

func parseAdapterConf() {
	ServerConf.AdapterConfig.Domain.InnerSecretId = util.DecryptString(ServerConf.AdapterConfig.Domain.InnerSecretId)
	ServerConf.AdapterConfig.Domain.InnerSecretKey = util.DecryptString(ServerConf.AdapterConfig.Domain.InnerSecretKey)
	if value := strings.TrimSpace(os.Getenv("CTL_DOMAIN_INNER_SECRET_ID")); value != "" {
		ServerConf.AdapterConfig.Domain.InnerSecretId = value
	}
	if value := strings.TrimSpace(os.Getenv("CTL_DOMAIN_INNER_SECRET_KEY")); value != "" {
		ServerConf.AdapterConfig.Domain.InnerSecretKey = value
	}

	if ServerConf.AdapterConfig.Sandbox == nil {
		ServerConf.AdapterConfig.Sandbox = &SandboxConfig{}
	}
	if ServerConf.AdapterConfig.Sandbox.BaseURL == "" {
		ServerConf.AdapterConfig.Sandbox.BaseURL = "https://api.e2b.app"
	}
	if ServerConf.AdapterConfig.Sandbox.ProcessBaseURL == "" {
		ServerConf.AdapterConfig.Sandbox.ProcessBaseURL = ServerConf.AdapterConfig.Sandbox.BaseURL
	}
	if ServerConf.AdapterConfig.Sandbox.Timeout <= 0 {
		ServerConf.AdapterConfig.Sandbox.Timeout = 30
	}
	if ServerConf.AdapterConfig.Sandbox.MaxRetries <= 0 {
		ServerConf.AdapterConfig.Sandbox.MaxRetries = 3
	}
	if ServerConf.AdapterConfig.Sandbox.RetryInterval <= 0 {
		ServerConf.AdapterConfig.Sandbox.RetryInterval = 1000
	}

	if ServerConf.AdapterConfig.Shadow == nil {
		ServerConf.AdapterConfig.Shadow = &ShadowConfig{}
	}
	if value := strings.TrimSpace(os.Getenv("CTL_SHADOW_TOKEN")); value != "" {
		ServerConf.AdapterConfig.Shadow.Token = value
	}
	if ServerConf.AdapterConfig.Shadow.Timeout <= 0 {
		ServerConf.AdapterConfig.Shadow.Timeout = 10
	}

	if ServerConf.AdapterConfig.AiGateway == nil {
		ServerConf.AdapterConfig.AiGateway = &AiGatewayConfig{}
	}
	if value := strings.TrimSpace(os.Getenv("CTL_AIGATEWAY_ADMIN_TOKEN")); value != "" {
		ServerConf.AdapterConfig.AiGateway.AdminToken = value
	}
	if value := strings.TrimSpace(os.Getenv("CTL_AIGATEWAY_INTERNAL_SERVICE_TOKEN")); value != "" {
		ServerConf.AdapterConfig.AiGateway.InternalServiceToken = value
	}
	if ServerConf.AdapterConfig.AiGateway.Timeout <= 0 {
		ServerConf.AdapterConfig.AiGateway.Timeout = 10
	}
	if ServerConf.AdapterConfig.AiGateway.DefaultGatewayPort <= 0 {
		ServerConf.AdapterConfig.AiGateway.DefaultGatewayPort = 18789
	}
	if ServerConf.AdapterConfig.AiGateway.DefaultCompatibility == "" {
		ServerConf.AdapterConfig.AiGateway.DefaultCompatibility = "openai"
	}

	if ServerConf.AdapterConfig.LLMGateway == nil {
		ServerConf.AdapterConfig.LLMGateway = &LLMGatewayConfig{}
	}
	if value := firstNonEmptyEnv("CTL_LLMGATEWAY_BASE_URL"); value != "" {
		ServerConf.AdapterConfig.LLMGateway.BaseURL = value
	}
	if value := firstNonEmptyEnv("CTL_LLMGATEWAY_ADMIN_TOKEN", "CTL_AIGATEWAY_ADMIN_TOKEN"); value != "" {
		ServerConf.AdapterConfig.LLMGateway.AdminToken = value
	}
	if value := firstNonEmptyEnv("CTL_LLMGATEWAY_INTERNAL_SERVICE_TOKEN", "CTL_AIGATEWAY_INTERNAL_SERVICE_TOKEN"); value != "" {
		ServerConf.AdapterConfig.LLMGateway.InternalServiceToken = value
	}
	if value := firstNonEmptyEnv("CTL_LLMGATEWAY_DEFAULT_BASE_URL"); value != "" {
		ServerConf.AdapterConfig.LLMGateway.DefaultBaseURL = value
	}
	if value := firstNonEmptyEnv("CTL_LLMGATEWAY_DEFAULT_MODEL_ID"); value != "" {
		ServerConf.AdapterConfig.LLMGateway.DefaultModelID = value
	}
	fillLLMGatewayFromLegacyAiGateway(ServerConf.AdapterConfig.LLMGateway, ServerConf.AdapterConfig.AiGateway)
	if ServerConf.AdapterConfig.LLMGateway.Timeout <= 0 {
		ServerConf.AdapterConfig.LLMGateway.Timeout = 10
	}
	if ServerConf.AdapterConfig.LLMGateway.DefaultGatewayPort <= 0 {
		ServerConf.AdapterConfig.LLMGateway.DefaultGatewayPort = 18789
	}
	if ServerConf.AdapterConfig.LLMGateway.DefaultCompatibility == "" {
		ServerConf.AdapterConfig.LLMGateway.DefaultCompatibility = "openai"
	}
}

func fillLLMGatewayFromLegacyAiGateway(dst *LLMGatewayConfig, legacy *AiGatewayConfig) {
	if dst == nil || legacy == nil {
		return
	}
	if dst.BaseURL == "" {
		dst.BaseURL = legacy.BaseURL
	}
	if dst.AdminToken == "" {
		dst.AdminToken = legacy.AdminToken
	}
	if dst.InternalServiceToken == "" {
		dst.InternalServiceToken = legacy.InternalServiceToken
	}
	if dst.Timeout <= 0 {
		dst.Timeout = legacy.Timeout
	}
	if dst.DefaultBaseURL == "" {
		dst.DefaultBaseURL = legacy.DefaultBaseURL
	}
	if dst.DefaultModelID == "" {
		dst.DefaultModelID = legacy.DefaultModelID
	}
	if dst.DefaultCompatibility == "" {
		dst.DefaultCompatibility = legacy.DefaultCompatibility
	}
	if dst.DefaultGatewayPort <= 0 {
		dst.DefaultGatewayPort = legacy.DefaultGatewayPort
	}
	if dst.DefaultProviderID == "" {
		dst.DefaultProviderID = legacy.DefaultProviderID
	}
}

func firstNonEmptyEnv(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

func parseAllServiceRoleConf() {
	parseServiceRoleConf(ServerConf.ServiceRoleConfig.DnsSsl)
	parseServiceRoleConf(ServerConf.ServiceRoleConfig.Basic)
}

func parseServiceRoleConf(roleConfig *ServiceRoleConfig) {
	roleConfig.SecretId = util.DecryptString(roleConfig.SecretId)
	roleConfig.SecretKey = util.DecryptString(roleConfig.SecretKey)
}

func parseAllServiceAccountConf() {
	parseServiceAccountConf(ServerConf.ServiceAccountConfig.Lighthouse)
	parseServiceAccountConfBase(ServerConf.ServiceAccountConfig.Base)
}

func parseServiceAccountConf(accountConfig *ServiceAccountConfig) {
	accountConfig.SecretId = util.DecryptString(accountConfig.SecretId)
	accountConfig.SecretKey = util.DecryptString(accountConfig.SecretKey)
}

func parseServiceAccountConfBase(accountConfig *ServiceAccountBase) {
	accountConfig.SecretId = util.DecryptString(accountConfig.SecretId)
	accountConfig.SecretKey = util.DecryptString(accountConfig.SecretKey)
}

func parseAgentChatConf() {
	if ServerConf.AgentChat == nil {
		ServerConf.AgentChat = &AgentChatConfig{}
	}
	if strings.TrimSpace(ServerConf.AgentChat.BusinessCode) == "" {
		ServerConf.AgentChat.BusinessCode = "lightvela"
	}
	if ServerConf.AgentChat.LaunchTokenTTLSeconds <= 0 {
		ServerConf.AgentChat.LaunchTokenTTLSeconds = 300
	}
	if ServerConf.AgentChat.TimestampSkewSeconds <= 0 {
		ServerConf.AgentChat.TimestampSkewSeconds = 300
	}
	if strings.TrimSpace(ServerConf.AgentChat.SecretKey) != "" {
		ServerConf.AgentChat.SecretKey = util.DecryptString(ServerConf.AgentChat.SecretKey)
	}
	if strings.TrimSpace(ServerConf.AgentChat.LaunchTokenSecret) != "" {
		ServerConf.AgentChat.LaunchTokenSecret = util.DecryptString(ServerConf.AgentChat.LaunchTokenSecret)
	}
	applyAgentChatSecretEnv(ServerConf.AgentChat)
}

func applyAgentChatSecretEnv(cfg *AgentChatConfig) {
	if value := strings.TrimSpace(os.Getenv("AGENTCHAT_SECRET_ID")); value != "" {
		cfg.SecretID = value
	}
	if value := strings.TrimSpace(os.Getenv("AGENTCHAT_SECRET_KEY")); value != "" {
		cfg.SecretKey = value
	}
	if value := strings.TrimSpace(os.Getenv("AGENTCHAT_LAUNCH_TOKEN_SECRET")); value != "" {
		cfg.LaunchTokenSecret = value
	}
}
