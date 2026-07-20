package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

type GatewayConfig struct {
	BaseURL        string
	TrafficBaseURL string
	AdminToken     string
	InternalToken  string
}

type ProviderConfig struct {
	BaseURL string
	APIKey  string
	Model   string
}

type SetConfig struct {
	ID      string
	Name    string
	BaseURL string
}

type PlanConfig struct {
	ID            string
	Name          string
	MonthlyTokens int64
	PeriodValue   int
	PeriodUnit    string
}

type Scenario string

const (
	ScenarioMixedConcurrent Scenario = "mixed_concurrent"
	ScenarioPlatformOnly    Scenario = "platform_only"
	ScenarioBYOKThenChat    Scenario = "byok_then_chat"
	ScenarioBYOKSyncOnly    Scenario = "byok_sync_only"
	ScenarioRenewalBurst    Scenario = "renewal_burst"
)

type Config struct {
	Gateway  GatewayConfig
	Provider ProviderConfig
	Sets     []SetConfig
	Plan     PlanConfig

	Profile                  string
	Scenario                 Scenario
	ChatModel                string
	RunID                    string
	UserIDPrefix             string
	Users                    int
	MaxConcurrentUsers       int
	UserArrivalInterval      time.Duration
	ChatInterval             time.Duration
	BYOKProvidersPerUser     int
	BYOKConfigInterval       time.Duration
	PlatformChannels         int
	SubscriptionApplications int
	RunDuration              time.Duration
	UserChatRequests         int
	HTTPTimeout              time.Duration
	Prepare                  bool
	DisableNewAPIProtection  bool
	Stream                   bool
}

func DefaultConfig() Config {
	return Config{
		Gateway: GatewayConfig{
			BaseURL:       "http://llmgateway:18080",
			AdminToken:    "dev-cluster-token",
			InternalToken: "dev-internal-token",
		},
		Provider: ProviderConfig{
			BaseURL: "http://mockllm:8080",
			APIKey:  "sk-mockllm-local",
			Model:   "llmgw-mock-chat",
		},
		Sets: []SetConfig{
			{ID: "set-a", Name: "local set A", BaseURL: "http://newapi-a:3000"},
			{ID: "set-b", Name: "local set B", BaseURL: "http://newapi-b:3000"},
		},
		Plan: PlanConfig{
			ID:            "load-pro",
			Name:          "LLMGateway Load Pro",
			MonthlyTokens: 100000,
			PeriodValue:   1,
			PeriodUnit:    "months",
		},
		Profile:                  "local",
		Scenario:                 ScenarioMixedConcurrent,
		ChatModel:                "auto",
		UserIDPrefix:             "load-user",
		Users:                    1000,
		UserArrivalInterval:      500 * time.Millisecond,
		ChatInterval:             3 * time.Second,
		BYOKProvidersPerUser:     2,
		BYOKConfigInterval:       time.Second,
		PlatformChannels:         4,
		SubscriptionApplications: 1,
		RunDuration:              10 * time.Minute,
		HTTPTimeout:              30 * time.Second,
		Prepare:                  true,
	}
}

func LoadConfig(getenv func(string) string) Config {
	cfg := DefaultConfig()
	cfg.Gateway.BaseURL = envString(getenv, "LOAD_LLMGATEWAY_BASE_URL", cfg.Gateway.BaseURL)
	cfg.Gateway.TrafficBaseURL = envString(getenv, "LOAD_LLMGATEWAY_TRAFFIC_BASE_URL", cfg.Gateway.TrafficBaseURL)
	if cfg.Gateway.TrafficBaseURL == "" {
		cfg.Gateway.TrafficBaseURL = cfg.Gateway.BaseURL
	}
	cfg.Gateway.AdminToken = envString(getenv, "LOAD_LLMGATEWAY_ADMIN_TOKEN", cfg.Gateway.AdminToken)
	cfg.Gateway.InternalToken = envString(getenv, "LOAD_LLMGATEWAY_INTERNAL_TOKEN", cfg.Gateway.InternalToken)
	cfg.Provider.BaseURL = envString(getenv, "LOAD_PROVIDER_BASE_URL", cfg.Provider.BaseURL)
	cfg.Provider.APIKey = envString(getenv, "LOAD_PROVIDER_API_KEY", cfg.Provider.APIKey)
	cfg.Provider.Model = envString(getenv, "LOAD_PROVIDER_MODEL", cfg.Provider.Model)
	cfg.Profile = normalizeProfile(envString(getenv, "LOAD_PROFILE", cfg.Profile))
	defaultMaxConcurrentUsers := cfg.MaxConcurrentUsers
	if cfg.Profile == "cloud_prod" {
		defaultMaxConcurrentUsers = 60
	}
	cfg.MaxConcurrentUsers = envInt(getenv, "LOAD_MAX_CONCURRENT_USERS", defaultMaxConcurrentUsers)
	cfg.Scenario = normalizeScenario(envString(getenv, "LOAD_SCENARIO", string(cfg.Scenario)))
	cfg.ChatModel = envString(getenv, "LOAD_CHAT_MODEL", cfg.ChatModel)
	cfg.Plan.ID = envString(getenv, "LOAD_PLAN_ID", cfg.Plan.ID)
	cfg.Plan.Name = envString(getenv, "LOAD_PLAN_NAME", cfg.Plan.Name)
	cfg.Plan.MonthlyTokens = int64(envInt(getenv, "LOAD_PLAN_TOKENS", int(cfg.Plan.MonthlyTokens)))
	cfg.Plan.PeriodValue = envInt(getenv, "LOAD_PLAN_PERIOD_VALUE", cfg.Plan.PeriodValue)
	cfg.Plan.PeriodUnit = envString(getenv, "LOAD_PLAN_PERIOD_UNIT", cfg.Plan.PeriodUnit)
	cfg.RunID = envString(getenv, "LOAD_RUN_ID", time.Now().UTC().Format("20060102T150405"))
	cfg.UserIDPrefix = envString(getenv, "LOAD_USER_ID_PREFIX", cfg.UserIDPrefix)
	cfg.Users = envInt(getenv, "LOAD_USERS", cfg.Users)
	cfg.UserArrivalInterval = envDuration(getenv, "LOAD_USER_ARRIVAL_INTERVAL", cfg.UserArrivalInterval)
	cfg.ChatInterval = envDuration(getenv, "LOAD_CHAT_INTERVAL", cfg.ChatInterval)
	cfg.BYOKProvidersPerUser = envInt(getenv, "LOAD_BYOK_PROVIDERS_PER_USER", cfg.BYOKProvidersPerUser)
	cfg.BYOKConfigInterval = envDuration(getenv, "LOAD_BYOK_CONFIG_INTERVAL", cfg.BYOKConfigInterval)
	cfg.PlatformChannels = envInt(getenv, "LOAD_PLATFORM_CHANNELS", cfg.PlatformChannels)
	cfg.SubscriptionApplications = envInt(getenv, "LOAD_SUBSCRIPTION_APPLICATIONS", cfg.SubscriptionApplications)
	if cfg.SubscriptionApplications < 1 {
		cfg.SubscriptionApplications = 1
	}
	cfg.RunDuration = envDuration(getenv, "LOAD_RUN_DURATION", cfg.RunDuration)
	cfg.UserChatRequests = envInt(getenv, "LOAD_USER_CHAT_REQUESTS", cfg.UserChatRequests)
	cfg.HTTPTimeout = envDuration(getenv, "LOAD_HTTP_TIMEOUT", cfg.HTTPTimeout)
	cfg.Prepare = envBool(getenv, "LOAD_PREPARE", cfg.Prepare)
	cfg.DisableNewAPIProtection = envBool(getenv, "LOAD_DISABLE_NEWAPI_PROTECTION", cfg.DisableNewAPIProtection)
	cfg.Stream = envBool(getenv, "LOAD_STREAM", cfg.Stream)
	if raw := strings.TrimSpace(getenv("LOAD_SETS")); raw != "" {
		cfg.Sets = parseSets(raw)
	}
	return cfg
}

func normalizeProfile(value string) string {
	switch strings.TrimSpace(strings.ToLower(value)) {
	case "cloud_prod", "cloud-prod", "prod", "production":
		return "cloud_prod"
	case "local", "":
		return "local"
	default:
		return strings.TrimSpace(strings.ToLower(value))
	}
}

func (c Config) Validate() error {
	if c.Profile != "local" && c.Profile != "cloud_prod" {
		return fmt.Errorf("unknown load profile %q; expected local or cloud_prod", c.Profile)
	}
	if c.Profile != "cloud_prod" {
		if c.MaxConcurrentUsers < 0 {
			return fmt.Errorf("max concurrent users must be greater than or equal to zero")
		}
		return nil
	}
	if c.Prepare {
		return fmt.Errorf("cloud_prod load profile must not run prepare; prepare mutates managed new-api sets")
	}
	if c.DisableNewAPIProtection {
		return fmt.Errorf("cloud_prod load profile must not disable new-api protection")
	}
	if strings.TrimSpace(c.ChatModel) == "" || c.ChatModel == "auto" {
		return fmt.Errorf("cloud_prod load profile requires an isolated load test model, not %q", c.ChatModel)
	}
	if c.MaxConcurrentUsers <= 0 || c.MaxConcurrentUsers > 60 {
		return fmt.Errorf("cloud_prod load profile requires max concurrent users between 1 and 60")
	}
	return nil
}

func normalizeScenario(value string) Scenario {
	switch Scenario(strings.TrimSpace(value)) {
	case ScenarioPlatformOnly:
		return ScenarioPlatformOnly
	case ScenarioBYOKThenChat:
		return ScenarioBYOKThenChat
	case ScenarioBYOKSyncOnly:
		return ScenarioBYOKSyncOnly
	case ScenarioRenewalBurst:
		return ScenarioRenewalBurst
	case ScenarioMixedConcurrent, "", "mixed", "default":
		return ScenarioMixedConcurrent
	default:
		return ScenarioMixedConcurrent
	}
}

func (c Config) userID(index int) string {
	if c.RunID != "" {
		return fmt.Sprintf("%s-%s-%06d", c.UserIDPrefix, c.RunID, index)
	}
	return fmt.Sprintf("%s-%06d", c.UserIDPrefix, index)
}

func envString(getenv func(string) string, key string, fallback string) string {
	if value := strings.TrimSpace(getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envInt(getenv func(string) string, key string, fallback int) int {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDuration(getenv func(string) string, key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return fallback
	}
	if value == "0" {
		return 0
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envBool(getenv func(string) string, key string, fallback bool) bool {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func parseSets(raw string) []SetConfig {
	parts := strings.Split(raw, ",")
	sets := make([]SetConfig, 0, len(parts))
	for _, part := range parts {
		id, baseURL, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || strings.TrimSpace(id) == "" || strings.TrimSpace(baseURL) == "" {
			continue
		}
		id = strings.TrimSpace(id)
		sets = append(sets, SetConfig{ID: id, Name: id, BaseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/")})
	}
	return sets
}
