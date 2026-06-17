package config

import (
	"os"
	"strings"
)

func ShadowAccountEnabled() bool {
	if raw, ok := os.LookupEnv("SHADOW_ACCOUNT_ENABLED"); ok {
		return parseBool(raw)
	}
	if ServerConf.AdapterConfig != nil && ServerConf.AdapterConfig.Shadow != nil {
		return ServerConf.AdapterConfig.Shadow.Enabled
	}
	return false
}

func ShadowBindingRequired() bool {
	if raw, ok := os.LookupEnv("SHADOW_BINDING_REQUIRED"); ok {
		return parseBool(raw)
	}
	return ShadowAccountEnabled()
}

func SiteKind() string {
	kind := strings.ToLower(strings.TrimSpace(os.Getenv("LIGHTVELA_SITE_KIND")))
	if kind == "" {
		return "cn"
	}
	return kind
}

func parseBool(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
