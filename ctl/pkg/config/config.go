// Package config ...
package config

import (
	"fmt"
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
	parseMySQLConf()
	parseAdapterConf()
	parseAllServiceRoleConf()
	parseAllServiceAccountConf()

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
	ServerConf.RedisConfig.ConnectTimeout = time.Duration(ServerConf.RedisConfig.ConnectTimeoutSeconds) * time.Second
	ServerConf.RedisConfig.RWTimeout = time.Duration(ServerConf.RedisConfig.RWTimeoutSeconds) * time.Second
	ServerConf.RedisConfig.MQRWTimeout = time.Duration(ServerConf.RedisConfig.MQRWTimeoutSeconds) * time.Second
	ServerConf.RedisConfig.PoolKeepAliveInterval = time.Duration(
		ServerConf.RedisConfig.PoolKeepAliveIntervalSeconds) * time.Second
	ServerConf.RedisConfig.PoolClientMaxIdleTime = time.Duration(
		ServerConf.RedisConfig.PoolClientMaxIdleSeconds) * time.Second
}

func parseMySQLConf() {
	ServerConf.DBConfig.Password = util.DecryptString(ServerConf.DBConfig.Password)
	ServerConf.DBConfig.RWTimeout = time.Duration(ServerConf.DBConfig.RWTimeoutSeconds) * time.Second
}

func parseAdapterConf() {
	ServerConf.AdapterConfig.Domain.InnerSecretId = util.DecryptString(ServerConf.AdapterConfig.Domain.InnerSecretId)
	ServerConf.AdapterConfig.Domain.InnerSecretKey = util.DecryptString(ServerConf.AdapterConfig.Domain.InnerSecretKey)

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

	if ServerConf.AdapterConfig.AiGateway == nil {
		ServerConf.AdapterConfig.AiGateway = &AiGatewayConfig{}
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
