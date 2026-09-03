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

// CORSRule grants additional browser origins to one method/path without
// widening the route-level or global CORS allowlist.
type CORSRule struct {
	Method         string   `yaml:"method"`
	Path           string   `yaml:"path"`
	AllowedOrigins []string `yaml:"allowed_origins"`
}

type PathPolicy string

const (
	PathPolicyAllowlist PathPolicy = "allowlist"
)

type Route struct {
	Name                   string       `yaml:"name"`
	Prefix                 string       `yaml:"prefix"`
	RewritePrefix          string       `yaml:"rewrite_prefix"`
	Methods                []string     `yaml:"methods"`
	Upstream               string       `yaml:"upstream"`
	UpstreamBearerTokenEnv string       `yaml:"upstream_bearer_token_env"`
	Access                 Access       `yaml:"access"`
	AllowedOrigins         []string     `yaml:"allowed_origins"`
	CORSAllow              []CORSRule   `yaml:"cors_allow"`
	PathPolicy             PathPolicy   `yaml:"path_policy"`
	PathAllow              []PublicRule `yaml:"path_allow"`
	PublicAllow            []PublicRule `yaml:"public_allow"`
	OptionalAuthAllow      []PublicRule `yaml:"optional_auth_allow"`
	AllowVelaInstanceKey   bool         `yaml:"allow_vela_instance_key"`
	VelaInstanceKeyAllow   []PublicRule `yaml:"vela_instance_key_allow"`
	RequireRealname        bool         `yaml:"require_realname"`
	ResponseHeaderTimeout  string       `yaml:"response_header_timeout"`
}

type Config struct {
	AuthServiceURL    string              `yaml:"auth_service_url"`
	AllowedOrigins    []string            `yaml:"allowed_origins"`
	TrustedProxyCIDRs []string            `yaml:"trusted_proxy_cidrs"`
	Routes            []Route             `yaml:"routes"`
	WorkerActions     WorkerActionsConfig `yaml:"worker_actions"`
}

type WorkerActionsConfig struct {
	Enabled      bool                           `yaml:"enabled"`
	Temporal     WorkerActionTemporalConfig     `yaml:"temporal"`
	RescueExport WorkerActionRescueExportConfig `yaml:"rescue_export"`
	HermesImport WorkerActionHermesImportConfig `yaml:"hermes_import"`
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
	TaskQueue                 string   `yaml:"task_queue"`
	COSUploadBucket           string   `yaml:"cos_upload_bucket"`
	COSUploadRegion           string   `yaml:"cos_upload_region"`
	COSUploadKeyPrefix        string   `yaml:"cos_upload_key_prefix"`
	COSUploadURLTTLSeconds    int      `yaml:"cos_upload_url_ttl_seconds"`
	ImportUploadKeyPrefix     string   `yaml:"import_upload_key_prefix"`
	ImportUploadURLTTLSeconds int      `yaml:"import_upload_url_ttl_seconds"`
	RegionCandidates          []string `yaml:"region_candidates"`
}

type WorkerActionHermesImportConfig struct {
	TaskQueue           string `yaml:"task_queue"`
	UploadKeyPrefix     string `yaml:"upload_key_prefix"`
	UploadURLTTLSeconds int    `yaml:"upload_url_ttl_seconds"`
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
