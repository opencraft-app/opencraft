package gateway

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Access string

const (
	AccessPublic        Access = "public"
	AccessAdmin         Access = "admin"
	AccessAuthenticated Access = "authenticated"
	AccessInternalOnly  Access = "internal-only"
)

type PublicRule struct {
	Method string `yaml:"method"`
	Path   string `yaml:"path"`
}

type Route struct {
	Name                   string       `yaml:"name"`
	Prefix                 string       `yaml:"prefix"`
	RewritePrefix          string       `yaml:"rewrite_prefix"`
	Methods                []string     `yaml:"methods"`
	Upstream               string       `yaml:"upstream"`
	UpstreamBearerTokenEnv string       `yaml:"upstream_bearer_token_env"`
	Access                 Access       `yaml:"access"`
	PublicAllow            []PublicRule `yaml:"public_allow"`
	OptionalAuthAllow      []PublicRule `yaml:"optional_auth_allow"`
	RequireRealname        bool         `yaml:"require_realname"`
	ResponseHeaderTimeout  string       `yaml:"response_header_timeout"`
}

type Config struct {
	AuthServiceURL string              `yaml:"auth_service_url"`
	AllowedOrigins []string            `yaml:"allowed_origins"`
	Routes         []Route             `yaml:"routes"`
	WorkerActions  WorkerActionsConfig `yaml:"worker_actions"`
}

type WorkerActionsConfig struct {
	Enabled      bool                           `yaml:"enabled"`
	Temporal     WorkerActionTemporalConfig     `yaml:"temporal"`
	RescueExport WorkerActionRescueExportConfig `yaml:"rescue_export"`
}

type WorkerActionTemporalConfig struct {
	Address    string `yaml:"address"`
	Namespace  string `yaml:"namespace"`
	TLS        *bool  `yaml:"tls"`
	ServerName string `yaml:"server_name"`
	TokenEnv   string `yaml:"token_env"`
	TaskQueue  string `yaml:"task_queue"`
	Timeout    string `yaml:"timeout"`
}

type WorkerActionRescueExportConfig struct {
	COSUploadBucket        string   `yaml:"cos_upload_bucket"`
	COSUploadRegion        string   `yaml:"cos_upload_region"`
	COSUploadKeyPrefix     string   `yaml:"cos_upload_key_prefix"`
	COSUploadURLTTLSeconds int      `yaml:"cos_upload_url_ttl_seconds"`
	RegionCandidates       []string `yaml:"region_candidates"`
}

func LoadConfigFile(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config file: %w", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("decode config file: %w", err)
	}
	return cfg, nil
}
