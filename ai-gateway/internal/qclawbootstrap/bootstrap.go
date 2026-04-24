package qclawbootstrap

import (
	"encoding/json"
	"fmt"
)

const (
	defaultGatewayPort = 28789
	defaultTotalQuota  = int64(1_000_000_000_000)
)

type GatewayState struct {
	Port                   int
	Bind                   string
	Token                  string
	ChatCompletionsEnabled bool
}

type providerPayload struct {
	Name            string   `json:"name"`
	ProviderType    string   `json:"provider_type"`
	APIKey          string   `json:"api_key"`
	BaseURL         string   `json:"base_url"`
	TotalQuota      int64    `json:"total_quota"`
	Priority        int      `json:"priority"`
	Weight          int      `json:"weight"`
	HealthCheckURL  string   `json:"health_check_url,omitempty"`
	SupportedModels []string `json:"supported_models"`
}

type mappingPayload struct {
	ModelPattern string `json:"model_pattern"`
	ProviderID   string `json:"provider_id"`
	Priority     int    `json:"priority"`
	Weight       int    `json:"weight"`
	IsActive     bool   `json:"is_active"`
}

type mappingUpdatePayload struct {
	ModelPattern *string `json:"model_pattern,omitempty"`
	ProviderID   *string `json:"provider_id,omitempty"`
	Priority     *int    `json:"priority,omitempty"`
	Weight       *int    `json:"weight,omitempty"`
	IsActive     *bool   `json:"is_active,omitempty"`
}

func EnsureChatCompletionsEnabled(input []byte) ([]byte, GatewayState, bool, error) {
	var doc map[string]any
	if err := json.Unmarshal(input, &doc); err != nil {
		return nil, GatewayState{}, false, fmt.Errorf("parse qclaw config: %w", err)
	}

	gateway := getMap(doc, "gateway")
	auth := getMap(gateway, "auth")

	mode, _ := auth["mode"].(string)
	if mode != "token" {
		return nil, GatewayState{}, false, fmt.Errorf("qclaw gateway auth.mode must be token, got %q", mode)
	}
	token, _ := auth["token"].(string)
	if token == "" {
		return nil, GatewayState{}, false, fmt.Errorf("qclaw gateway auth.token is empty")
	}

	changed := false
	bind, _ := gateway["bind"].(string)
	if bind != "loopback" {
		gateway["bind"] = "loopback"
		bind = "loopback"
		changed = true
	}

	httpCfg := getMap(gateway, "http")
	endpoints := getMap(httpCfg, "endpoints")
	chat := getMap(endpoints, "chatCompletions")
	enabled, _ := chat["enabled"].(bool)
	if !enabled {
		chat["enabled"] = true
		enabled = true
		changed = true
	}

	port := asInt(gateway["port"])
	if port == 0 {
		port = defaultGatewayPort
		gateway["port"] = port
		changed = true
	}

	updated, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, GatewayState{}, false, fmt.Errorf("marshal qclaw config: %w", err)
	}

	return updated, GatewayState{
		Port:                   port,
		Bind:                   bind,
		Token:                  token,
		ChatCompletionsEnabled: enabled,
	}, changed, nil
}

func BuildProviderPayload(name, baseURL, apiKey, model string) providerPayload {
	return providerPayload{
		Name:            name,
		ProviderType:    "openai",
		APIKey:          apiKey,
		BaseURL:         baseURL,
		TotalQuota:      defaultTotalQuota,
		Priority:        0,
		Weight:          100,
		SupportedModels: []string{model},
	}
}

func BuildMappingPayload(modelPattern, providerID string) mappingPayload {
	return mappingPayload{
		ModelPattern: modelPattern,
		ProviderID:   providerID,
		Priority:     0,
		Weight:       100,
		IsActive:     true,
	}
}

func getMap(parent map[string]any, key string) map[string]any {
	if existing, ok := parent[key].(map[string]any); ok {
		return existing
	}
	child := map[string]any{}
	parent[key] = child
	return child
}

func asInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	default:
		return 0
	}
}
