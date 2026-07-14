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
	DefaultSKUID              string   `toml:"default_sku_id"`
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

	// SpecPools 实例规格 → 候选池子段（设计稿 §3.3 Q2=a 双轨）。
	//
	// 取值优先级：
	//   1. bundle.instance_spec_id 命中 SpecPools[i].SpecID → 用 SpecPools[i] 候选池
	//   2. bundle.instance_spec_id 为空（兼容期）         → fallback 到全局
	//      DefaultTemplateID + CandidateTemplateIDs
	//   3. bundle.instance_spec_id 命中 instancespec 字典但 SpecPools 缺配 → CreateInstance
	//      直接 fail（设计稿 §10 Q7=a；避免悄悄落到错规格的资金风险）
	//
	// 配置示例（server_conf.toml）：
	//   [[api.instance.spec_pools]]
	//   spec_id                = "spec-2c4g50g"
	//   default_template_id    = "pool-bj-2c4g50g-default"
	//   candidate_template_ids = ["pool-bj-2c4g50g-default", "pool-bj-2c4g50g-backup"]
	SpecPools []SpecPoolConfig `toml:"spec_pools"`
}

// SpecPoolConfig 单个实例规格对应的候选池配置（设计稿 §3.3 Q2=a）。
//
// TemplateClassID 用于隔离多规格池路由（设计稿 §13.2 R1f 池落差教训）：当同一 sandbox
// 部署里既有 2C4G50G 池又有 4C8G80G 池时，必须让两规格走**不同的 template_class**，
// 否则 sandbox `sandbox_primary` 模式会按 template_pool_bindings.priority 自主选池，
// ctl 传入的 templateID 形同虚设、用户可能跨规格漂移（资金风险）。空字符串表示
// 复用全局 InstanceAPIConfig.DefaultTemplateClassID（兼容期 / 单规格部署）。
//
// SKUID 用于隔离多规格 sku 路由（与 TemplateClassID 对称）：sandbox
// `selectTemplateSKUBindingsForAllocation` 会校验 `sku.template_class_id ==
// requested.templateClassID`，否则返 ErrSKUNotFound。当同一 sandbox 部署同时存在
// 2C4G 与 4C8G 两个 sku 时，每个 spec 必须显式声明自己的 sku_id，否则 ctl 全局
// DefaultSKUID 与某一规格不匹配会让对应链路整条建实例 fail。空字符串表示 fallback
// 到全局 InstanceAPIConfig.DefaultSKUID（兼容期 / 单 sku 部署）。
type SpecPoolConfig struct {
	SpecID               string   `toml:"spec_id"`
	TemplateClassID      string   `toml:"template_class_id"`
	SKUID                string   `toml:"sku_id"`
	DefaultTemplateID    string   `toml:"default_template_id"`
	CandidateTemplateIDs []string `toml:"candidate_template_ids"`
}

// SpecPoolFor 按 spec_id 查 per-spec 候选池配置。
//
// 返回 (cfg, true) 表示命中显式配置；返回 (zeroValue, false) 表示未命中（调用方应根据
// 设计稿 §10 Q7=a 直接 fail，而非 fallback 到全局，避免规格漂移）。
//
// specID 为空时（兼容期）返回 (zeroValue, false)，调用方应改走全局
// DefaultTemplateID + CandidateTemplateIDs（设计稿 §4.3）。
func (c *InstanceAPIConfig) SpecPoolFor(specID string) (SpecPoolConfig, bool) {
	if c == nil || specID == "" {
		return SpecPoolConfig{}, false
	}
	for _, sp := range c.SpecPools {
		if sp.SpecID == specID {
			return sp, true
		}
	}
	return SpecPoolConfig{}, false
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
	BaseURL              string `toml:"base_url"`               // K8s 内部地址，如 http://gateway.ai-gateway.svc.cluster.local
	AdminToken           string `toml:"admin_token"`            // 可选：admin API 的 Bearer Token
	InternalServiceToken string `toml:"internal_service_token"` // Internal API 的 Bearer Token（Plan/Subscription 联动）
	Timeout              int    `toml:"timeout"`                // 请求超时（秒），默认 10
	// 以下为技术债：等 ai-gateway 响应完善后从响应读取，届时移除这些配置
	DefaultBaseURL       string `toml:"default_base_url"`      // 临时：大模型 API Base URL
	DefaultModelID       string `toml:"default_model_id"`      // 临时：模型 ID
	DefaultCompatibility string `toml:"default_compatibility"` // 临时：兼容模式，仅支持 openai
	DefaultGatewayPort   int    `toml:"default_gateway_port"`  // openclaw gateway 本地端口，默认 18789
	DefaultProviderID    string `toml:"default_provider_id"`   // provider 标识，默认自动生成
}

// LLMGatewayConfig llmgateway/new_api 适配器配置。
//
// BaseURL 指向控制面（/api/admin 与 /api/internal）；DefaultBaseURL 指向
// OpenAI 兼容流量面，通常带 /v1。
type LLMGatewayConfig struct {
	BaseURL              string `toml:"base_url"`
	AdminToken           string `toml:"admin_token"`
	InternalServiceToken string `toml:"internal_service_token"`
	Timeout              int    `toml:"timeout"`
	DefaultBaseURL       string `toml:"default_base_url"`
	DefaultModelID       string `toml:"default_model_id"`
	DefaultCompatibility string `toml:"default_compatibility"`
	DefaultGatewayPort   int    `toml:"default_gateway_port"`
	DefaultProviderID    string `toml:"default_provider_id"`
}

// BundleConfig 套餐相关全局配置
type BundleConfig struct {
	CreditTokenRatio int64 `toml:"credit_token_ratio"` // credit → token 的转换倍率，1 credit = N token
}

// AuthCodeConfig CodeBuddy AuthCode 模式中转页鉴权 ticket 配置（v1.7.32 引入）
//
// 设计稿：.tmp/ctl-authcode-codebuddy-design.md §5 配置项设计
//
// 字段语义：
//   - TTLSeconds：ticket 在 Redis 的有效期（秒）；<=0 时 authcode.New 走 600s 兜底
type AuthCodeConfig struct {
	TTLSeconds int `toml:"ttl_seconds"` // ticket 有效期，默认 600 (10 min)
}

// ShadowConfig shadow 服务适配器配置
type ShadowConfig struct {
	BaseURL string `toml:"base_url"` // shadow 服务内部地址
	Token   string `toml:"token"`    // 内部 API 认证 token
	Timeout int    `toml:"timeout"`  // 请求超时（秒），默认 10
	Enabled bool   `toml:"enabled"`  // 是否要求用户已绑定 shadow account
}

// TradeConfig trade 服务适配器配置（billing-integration B2 新增）
//
// trade 当前提供的内部 RPC：
//   - POST /internal/trade/orders                        下单（PlaceOrder）
//   - POST /internal/trade/orders/{dealName}/pay-url     生成 / 反查支付页 URL（GeneratePayURL）
//
// 鉴权与 shadow / ai-gateway 一致，使用 Bearer Token，对应 trade 配置的
// LIGHTCLAW_INTERNAL_SERVICE_TOKEN。
type TradeConfig struct {
	BaseURL string `toml:"base_url"` // trade 服务内部地址，如 http://trade.lightclaw.svc.cluster.local
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

	Sandbox    *SandboxConfig    `toml:"sandbox"`
	AiGateway  *AiGatewayConfig  `toml:"aigateway"`
	LLMGateway *LLMGatewayConfig `toml:"llmgateway"`
	Shadow     *ShadowConfig     `toml:"shadow"`
	Trade      *TradeConfig      `toml:"trade"`
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

type AgentChatConfig struct {
	BusinessCode          string `toml:"business_code"`
	SecretID              string `toml:"secret_id"`
	SecretKey             string `toml:"secret_key"`
	LaunchTokenSecret     string `toml:"launch_token_secret"`
	LaunchTokenTTLSeconds int    `toml:"launch_token_ttl_seconds"`
	TimestampSkewSeconds  int    `toml:"timestamp_skew_seconds"`
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

		// SnapshotRetentionSeconds 是 trade-pass-destroy 销毁链路 cbs snapshot 的有效期（秒）。
		// Q7 ✅ 拍板（设计稿 .tmp/trade-pass-destroy-design.md §11-A）：
		//   - 默认 90 天（3 个月）— 由 ctl 内部 snapshotRetentionSeconds() 兜底，<=0 走默认值
		//   - 配置后由父 task 派子 task 时透传；子 task 调 sandbox.CreateSnapshot 入参 + 入 ctl snapshot 表 expire_time
		//   - 后期可能修改，写到配置文件方便不发版调
		SnapshotRetentionSeconds int `toml:"snapshot_retention_seconds"`
	} `toml:"misc"`

	GlobalQuotaConfig *GlobalQuotaConfig `toml:"global_quota"`

	Bundle    *BundleConfig    `toml:"bundle"`
	AgentChat *AgentChatConfig `toml:"agentchat"`

	// AuthCodeConfig CodeBuddy AuthCode 模式中转页鉴权 ticket 配置。
	AuthCodeConfig *AuthCodeConfig `toml:"auth_code"`
}
