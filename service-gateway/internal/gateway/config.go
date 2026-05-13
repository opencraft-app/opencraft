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
	Name                  string       `yaml:"name"`
	Prefix                string       `yaml:"prefix"`
	RewritePrefix         string       `yaml:"rewrite_prefix"`
	Methods               []string     `yaml:"methods"`
	Upstream              string       `yaml:"upstream"`
	Access                Access       `yaml:"access"`
	PublicAllow           []PublicRule `yaml:"public_allow"`
	RequireRealname       bool         `yaml:"require_realname"`
	ResponseHeaderTimeout string       `yaml:"response_header_timeout"`
}

type Config struct {
	AuthServiceURL string   `yaml:"auth_service_url"`
	AllowedOrigins []string `yaml:"allowed_origins"`
	Routes         []Route  `yaml:"routes"`
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
