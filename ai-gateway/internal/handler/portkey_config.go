package handler

import (
	"encoding/json"
	"log/slog"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
)

// PortkeyConfig 是发送给 Portkey Gateway 的 x-portkey-config header 结构。
type PortkeyConfig struct {
	Strategy PortkeyStrategy `json:"strategy"`
	Retry    *PortkeyRetry   `json:"retry,omitempty"`
	Targets  []PortkeyTarget `json:"targets"`
}

// PortkeyStrategy 定义路由策略。
type PortkeyStrategy struct {
	Mode          string `json:"mode"`                      // "loadbalance" | "fallback"
	OnStatusCodes []int  `json:"on_status_codes,omitempty"` // 策略触发状态码
}

// PortkeyRetry 定义重试策略。
type PortkeyRetry struct {
	Attempts      int   `json:"attempts"`
	OnStatusCodes []int `json:"on_status_codes,omitempty"`
}

// PortkeyTarget 定义单个上游 target。
type PortkeyTarget struct {
	Provider       string                 `json:"provider,omitempty"`
	APIKey         string                 `json:"api_key,omitempty"`
	CustomHost     string                 `json:"custom_host,omitempty"`
	Weight         int                    `json:"weight,omitempty"`
	OverrideParams map[string]interface{} `json:"override_params,omitempty"`
}

// MappingStrategy 存储 mapping 级别的策略覆盖信息。
type MappingStrategy struct {
	StrategyMode   *string
	RetryAttempts  *int
	OnStatusCodes  []int
	OverrideParams map[string]interface{}
}

// buildPortkeyConfig 根据候选提供商列表和路由配置构建 Portkey 配置。
// mapping 参数可为 nil，表示使用全局策略。
func buildPortkeyConfig(
	candidates []model.Provider,
	decryptedKeys map[string]string, // providerID -> decrypted key
	routingCfg service.RoutingConfig,
	mappingStrategy *MappingStrategy,
	providerSvc *service.ProviderService,
) (*PortkeyConfig, error) {
	// 确定策略：mapping 覆盖 > 全局默认
	mode := routingCfg.Strategy.Mode
	if mode == "" {
		mode = "fallback"
	}
	onStatusCodes := routingCfg.Strategy.OnStatusCodes
	retryAttempts := routingCfg.Strategy.RetryAttempts
	retryStatusCodes := routingCfg.Strategy.RetryStatusCodes

	if mappingStrategy != nil {
		if mappingStrategy.StrategyMode != nil && *mappingStrategy.StrategyMode != "" {
			mode = *mappingStrategy.StrategyMode
		}
		if mappingStrategy.RetryAttempts != nil {
			retryAttempts = *mappingStrategy.RetryAttempts
		}
		if len(mappingStrategy.OnStatusCodes) > 0 {
			onStatusCodes = mappingStrategy.OnStatusCodes
		}
	}

	if len(candidates) == 1 {
		retryAttempts = 0
		retryStatusCodes = nil
	}

	config := &PortkeyConfig{
		Strategy: PortkeyStrategy{
			Mode:          mode,
			OnStatusCodes: onStatusCodes,
		},
	}

	// 设置重试策略（仅当 retryAttempts > 0）
	if retryAttempts > 0 {
		config.Retry = &PortkeyRetry{
			Attempts:      retryAttempts,
			OnStatusCodes: retryStatusCodes,
		}
	}

	// 构建 targets
	for _, provider := range candidates {
		decryptedKey, ok := decryptedKeys[provider.ID.String()]
		if !ok {
			slog.Warn("跳过无法解密的提供商", "provider", provider.Name, "id", provider.ID)
			continue
		}

		target := PortkeyTarget{
			APIKey: decryptedKey,
			Weight: provider.Weight,
		}

		// 始终设置 provider 字段（Portkey Gateway 必需）
		target.Provider = provider.ProviderType
		if provider.BaseURL != "" {
			// 有自定义 base_url 的提供商，附加 custom_host
			target.CustomHost = provider.BaseURL
		}

		// 应用 mapping 级别的 override_params
		if mappingStrategy != nil && len(mappingStrategy.OverrideParams) > 0 {
			target.OverrideParams = mappingStrategy.OverrideParams
		}

		config.Targets = append(config.Targets, target)
	}

	return config, nil
}

// getMappingStrategy 从映射表获取指定模型的 mapping 级别策略覆盖。
func getMappingStrategy(mappings []model.ModelProviderMapping) *MappingStrategy {
	// 取第一个有策略覆盖的 mapping（它们属于同一模型模式）
	for _, m := range mappings {
		if m.StrategyMode != nil || m.RetryAttempts != nil || m.OnStatusCodes != nil || m.OverrideParams != nil {
			strategy := &MappingStrategy{
				StrategyMode:  m.StrategyMode,
				RetryAttempts: m.RetryAttempts,
			}

			if m.OnStatusCodes != nil {
				var codes []int
				if err := json.Unmarshal(m.OnStatusCodes, &codes); err == nil {
					strategy.OnStatusCodes = codes
				}
			}

			if m.OverrideParams != nil {
				var params map[string]interface{}
				if err := json.Unmarshal(m.OverrideParams, &params); err == nil {
					strategy.OverrideParams = params
				}
			}

			return strategy
		}
	}
	return nil
}
