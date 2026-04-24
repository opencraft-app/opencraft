package handler

import (
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/google/uuid"
)

func TestBuildPortkeyConfig_DisablesRetryForSingleTarget(t *testing.T) {
	provider := model.Provider{
		ID:           uuid.New(),
		Name:         "provider-a",
		ProviderType: model.ProviderTypeOpenAI,
		Weight:       100,
	}

	cfg, err := buildPortkeyConfig(
		[]model.Provider{provider},
		map[string]string{provider.ID.String(): "sk-test"},
		service.RoutingConfig{
			Strategy: service.PortkeyStrategyConfig{
				Mode:             "fallback",
				OnStatusCodes:    []int{400, 500},
				RetryAttempts:    3,
				RetryStatusCodes: []int{400, 500},
			},
		},
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("buildPortkeyConfig: %v", err)
	}
	if cfg.Retry != nil {
		t.Fatalf("expected retry to be disabled for single target")
	}
}
