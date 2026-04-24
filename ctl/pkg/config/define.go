// Package config ...
package config

import (
	"time"
)

// AccountAreaType 定义账号区域类型
type AccountAreaType string

const (
	// AccountAreaDomestic 国内站
	AccountAreaDomestic AccountAreaType = "0"
	// AccountAreaInternational 国际站
	AccountAreaInternational AccountAreaType = "1"
)

const (
	// DefaultPageLimit 默认分页大小
	DefaultPageLimit int64 = 20
	// MaxPageLimit 最大分页大小
	MaxPageLimit int64 = 100
)

// LogConfig ...
type LogConfig struct {
	Path           string
	Level          int
	AsyncQueueSize int `toml:"async_queue_size"`
	Bufsize        int
	Formater       string
	EnableColor    bool `toml:"enable_color"`
}

// DBConfig ...
type DBConfig struct {
	Host             string `toml:"host"`
	Port             uint   `toml:"port"`
	User             string `toml:"user"`
	Password         string `toml:"password"`
	Database         string `toml:"database"`
	RWTimeoutSeconds int    `toml:"rw_timeout_seconds"`

	RWTimeout time.Duration

	// GORM 连接池配置
	MaxIdleConns       int `toml:"MaxIdleConns"`       // 默认 10
	MaxOpenConns       int `toml:"MaxOpenConns"`       // 默认 100
	ConnMaxLifetimeSec int `toml:"ConnMaxLifetimeSec"` // 默认 3600
}

// RedisConfig ...
type RedisConfig struct {
	Host                         string
	Pass                         string
	Port                         int
	ConnectTimeoutSeconds        int `toml:"connect_timeout_seconds"`
	RWTimeoutSeconds             int `toml:"rw_timeout_seconds"`
	MQRWTimeoutSeconds           int `toml:"mq_rw_timeout_seconds"`
	PoolSize                     int `toml:"pool_size"`
	MinIdleConns                 int `toml:"min_idle_conns"`
	PoolKeepAliveIntervalSeconds int `toml:"pool_keepalive_interval_seconds"`
	PoolClientMaxIdleSeconds     int `toml:"pool_client_max_idle_seconds"`

	ConnectTimeout        time.Duration
	RWTimeout             time.Duration
	MQRWTimeout           time.Duration
	PoolKeepAliveInterval time.Duration
	PoolClientMaxIdleTime time.Duration
}

// MQConfig ...
type MQConfig struct {
	StreamKey string `toml:"stream_key"`
	GroupName string `toml:"group_name"`
	MaxLen    int    `toml:"max_len"`
}

// APIConfig ...
type APIConfig struct {
	Host            string             `toml:"host"`
	Port            int                `toml:"port"`
	PidFile         string             `toml:"pid_file"`
	ShutdownTimeout int                `toml:"shutdown_timeout"`
	EnableInnerSign bool               `toml:"enable_inner_sign"`
	Instance        *InstanceAPIConfig `toml:"instance"`
}

type InstanceAPIConfig struct {
	DefaultTemplateClassID    string   `toml:"default_template_class_id"`
	DefaultTemplateID         string   `toml:"default_template_id"`
	DefaultSKUID             string   `toml:"default_sku_id"`
	CandidateTemplateIDs      []string `toml:"candidate_template_ids"`
	CreatePoolMaxAttempts     int      `toml:"create_pool_max_attempts"`
	SoulTemplateDir           string   `toml:"soul_template_dir"`
	DefaultSoulTemplateID     string   `toml:"default_soul_template_id"`
	ChurnGuardEnabled         *bool    `toml:"churn_guard_enabled"`
	ChurnWindowSeconds        int      `toml:"churn_window_seconds"`
	CreateThreshold           int      `toml:"churn_create_threshold"`
	DestroyThreshold          int      `toml:"churn_destroy_threshold"`
	UserAbuseGuardEnabled     *bool    `toml:"user_abuse_guard_enabled"`
	UserAbuseCreateThreshold  int      `toml:"user_abuse_create_threshold"`
	UserAbuseDestroyThreshold int      `toml:"user_abuse_destroy_threshold"`
	UserAbuseCooldownSeconds  int      `toml:"user_abuse_cooldown_seconds"`
	UserAbuseRefreshSeconds   int      `toml:"user_abuse_snapshot_refresh_seconds"`
	PressureRefreshSec        int      `toml:"pressure_snapshot_refresh_seconds"`
	PressureTTLSec            int      `toml:"pressure_snapshot_ttl_seconds"`
	PressureCleanRatio        float64  `toml:"pressure_clean_ratio_threshold"`
	PressureMinClean          int      `toml:"pressure_min_clean_floor"`
}

func (c *InstanceAPIConfig) IsChurnGuardEnabled() bool {
	if c == nil || c.ChurnGuardEnabled == nil {
		return true
	}
	return *c.ChurnGuardEnabled
}

func (c *InstanceAPIConfig) IsUserAbuseGuardEnabled() bool {
	if c == nil || c.UserAbuseGuardEnabled == nil {
		return true
	}
	return *c.UserAbuseGuardEnabled
}

// MonitorConfig ...
type MonitorConfig struct {
	EnablePprof bool `toml:"enable_pprof"`
	Port        int  `toml:"port"`
}

// AdapterApiV3Config ...
type AdapterApiV3Config struct {
	ApiStaticUrl        string `toml:"api_static_url"`
	ApiDynamicUrlSuffix string `toml:"api_dynamic_url_suffix"`
}

// SandboxConfig defines sandbox adapter settings.
type SandboxConfig struct {
	BaseURL        string `toml:"baseUrl"`
	ProcessBaseURL string `toml:"processBaseUrl"`
	APIKey         string `toml:"apiKey"`
	Timeout        int    `toml:"timeout"`
	MaxRetries     int    `toml:"maxRetries"`
	RetryInterval  int    `toml:"retryInterval"`
}

// AiGatewayConfig AI-Gateway 适配器配置
type AiGatewayConfig struct {
	BaseURL              string `toml:"base_url"`              // K8s 内部地址，如 http://gateway.ai-gateway.svc.cluster.local
	AdminToken           string `toml:"admin_token"`           // 可选：admin API 的 Bearer Token
	InternalServiceToken string `toml:"internal_service_token"` // Internal API 的 Bearer Token（Plan/Subscription 联动）
	Timeout              int    `toml:"timeout"`               // 请求超时（秒），默认 10
	// 以下为技术债：等 ai-gateway 响应完善后从响应读取，届时移除这些配置
	DefaultBaseURL       string `toml:"default_base_url"`      // 临时：大模型 API Base URL
	DefaultModelID       string `toml:"default_model_id"`      // 临时：模型 ID
	DefaultCompatibility string `toml:"default_compatibility"` // 临时：兼容模式，仅支持 openai
	DefaultGatewayPort   int    `toml:"default_gateway_port"`  // openclaw gateway 本地端口，默认 18789
	DefaultProviderID    string `toml:"default_provider_id"`   // provider 标识，默认自动生成
}

// BundleConfig 套餐相关全局配置
type BundleConfig struct {
	CreditTokenRatio int64 `toml:"credit_token_ratio"` // credit → token 的转换倍率，1 credit = N token
}

// ShadowConfig shadow 服务适配器配置
type ShadowConfig struct {
	BaseURL string `toml:"base_url"` // shadow 服务内部地址
	Token   string `toml:"token"`    // 内部 API 认证 token
	Timeout int    `toml:"timeout"`  // 请求超时（秒），默认 10
}

// AdapterConfig ...
type AdapterConfig struct {
	Lightpro struct {
		AdapterApiV3Config
		UseMock                          bool `toml:"use_mock"`
		DescribeMcpServersTimeoutSeconds int  `toml:"describe_mcp_servers_timeout_seconds"`
	} `toml:"lightpro"`

	Lighthouse struct {
		AdapterApiV3Config
		TcloudUrl string `toml:"tcloud_url"`
	} `toml:"lighthouse"`

	Tcloud struct {
		InnerActionPartialHost string `toml:"tcloud_inner_action_partial_host"`
	} `toml:"tcloud"`

	Sts struct {
		Url         string
		InternalUrl string `toml:"internal_url"`
		UseMock     bool   `toml:"use_mock"`
	}

	DNSPod struct {
		Url string
	}

	Domain struct {
		InnerUrl       string `toml:"inner_url"`
		InnerIP        string `toml:"inner_ip"`
		InnerSecretId  string `toml:"inner_secret_id"`
		InnerSecretKey string `toml:"inner_secret_key"`
	}

	CloudDc struct {
		Url         string `toml:"url"`
		InternalUrl string `toml:"internal_url"`
	}

	Whitelist struct {
		Url      string `toml:"url"`
		Hostname string `toml:"hostname"`
	}

	Sandbox   *SandboxConfig   `toml:"sandbox"`
	AiGateway *AiGatewayConfig `toml:"aigateway"`
	Shadow    *ShadowConfig    `toml:"shadow"`
}

// TracingConfig ...
type TracingConfig struct {
	Protocol         string
	Async            bool
	GrpcEndpoint     string `toml:"grpc_endpoint"`
	HttpEndpoint     string `toml:"http_endpoint"`
	TenantId         string `toml:"tenant_id"`
	ServiceNamespace string `toml:"service_namespace"`
}

// TranslateConfig ...
type TranslateConfig struct {
	Dir string `toml:"dir"`
}

// GrayConfig ...
type GrayConfig struct {
	Enable     bool
	StartHour  int `toml:"start_hour"`
	RunSeconds int `toml:"run_seconds"`
	CpuPercent int `toml:"cpu_percent"`
}

// ServiceRoleConfig ...
type ServiceRoleConfig struct {
	RoleName                  string `toml:"role_name"`
	SecretId                  string `toml:"secret_id"`
	SecretKey                 string `toml:"secret_key"`
	CredentialDurationSeconds int64  `toml:"credential_duration_seconds"`
	CacheSeconds              int64  `toml:"cache_seconds"`
	ExpectCacheVersion        string `toml:"expect_cache_version"`
}

// ServiceAccountConfig ...
type ServiceAccountConfig struct {
	SecretId                  string `toml:"secret_id"`
	SecretKey                 string `toml:"secret_key"`
	CredentialDurationSeconds int64  `toml:"credential_duration_seconds"`
	CacheSeconds              int64  `toml:"cache_seconds"`
	ExpectCacheVersion        string `toml:"expect_cache_version"`
}

// ServiceAccountBase ...
type ServiceAccountBase struct {
	SecretId  string `toml:"secret_id"`
	SecretKey string `toml:"secret_key"`
}

// GlobalQuotaConfig ...
type GlobalQuotaConfig struct {
	ValidModifyResourceNames []string         `toml:"valid_modify_resource_names"`
	ResourceDefaultQuotas    map[string]int64 `toml:"resource_default_quotas"`
}

// GlobalConfig ...
type GlobalConfig struct {
	APIConfig *APIConfig `toml:"api"`

	BypassConfig struct {
		SpecifyNames []string `toml:"specify_names"`
	} `toml:"bypass"`

	LogConfig struct {
		API     *LogConfig `toml:"api"`
		Service *LogConfig `toml:"service"`
		Bypass  *LogConfig `toml:"bypass"`
	} `toml:"log"`

	DBConfig    *DBConfig    `toml:"db"`
	RedisConfig *RedisConfig `toml:"redis"`
	MQConfig    *MQConfig    `toml:"mq"`

	MonitorConfig struct {
		API     *MonitorConfig `toml:"api"`
		Service *MonitorConfig `toml:"service"`
		Bypass  *MonitorConfig `toml:"bypass"`
	} `toml:"monitor"`

	AdapterConfig *AdapterConfig `toml:"adapter"`

	ServiceRoleConfig struct {
		DnsSsl *ServiceRoleConfig `toml:"dns_ssl"`
		Basic  *ServiceRoleConfig `toml:"basic"`
	} `toml:"service_role"`

	ServiceAccountConfig struct {
		Lighthouse *ServiceAccountConfig `toml:"lighthouse"`
		Base       *ServiceAccountBase   `toml:"base"`
	} `toml:"service_account"`
	TranslateConfig *TranslateConfig `toml:"translate"`
	TracingConfig   *TracingConfig   `toml:"tracing"`
	GrayConfig      *GrayConfig      `toml:"gray"`

	MiscConfig struct {
		Region                 string
		ObjectIdPasswordSuffix string          `toml:"object_id_password_suffix"`
		AppsDataDir            string          `toml:"apps_data_dir"`
		BlockBypassAndService  bool            `toml:"block_bypass_and_service"`
		UseRandomMachineId     bool            `toml:"use_random_machine_id"`
		AccountArea            AccountAreaType `toml:"account_area"`
	} `toml:"misc"`

	GlobalQuotaConfig *GlobalQuotaConfig `toml:"global_quota"`

	Bundle *BundleConfig `toml:"bundle"`
}
