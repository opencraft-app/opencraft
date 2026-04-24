package service

import (
	"encoding/json"
	"fmt"
	"log/slog"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/crypto"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
	"gorm.io/datatypes"
)

// RegistryService 处理服务注册/注销/心跳的业务逻辑。
type RegistryService struct {
	provRepo      repository.ProviderRepo
	mappingRepo   repository.ModelMappingRepo
	encryptionKey []byte
}

// NewRegistryService 创建注册中心服务。
func NewRegistryService(provRepo repository.ProviderRepo, mappingRepo repository.ModelMappingRepo, encryptionKey []byte) *RegistryService {
	return &RegistryService{
		provRepo:      provRepo,
		mappingRepo:   mappingRepo,
		encryptionKey: encryptionKey,
	}
}

// RegisterRequest 注册请求参数。
type RegisterRequest struct {
	Name            string   `json:"name" binding:"required"`
	ProviderType    string   `json:"provider_type" binding:"required"`
	BaseURL         string   `json:"base_url" binding:"required"`
	APIKey          string   `json:"api_key" binding:"required"`
	ModelsSupported []string `json:"models_supported"` // 支持的模型列表
	HealthCheckURL  string   `json:"health_check_url"`
	Weight          int      `json:"weight"`
	TotalQuota      int64    `json:"total_quota"`
}

// RegisterResponse 注册响应。
type RegisterResponse struct {
	ProviderID        uuid.UUID `json:"provider_id"`
	HeartbeatInterval int       `json:"heartbeat_interval_s"`
}

// Register 注册新的 AI 服务实例。
// 按 base_url 去重，已存在则更新。
func (s *RegistryService) Register(req *RegisterRequest) (*RegisterResponse, error) {
	// 加密 API key
	encryptedKey, err := crypto.Encrypt(req.APIKey, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("encrypt api key: %w", err)
	}

	weight := req.Weight
	if weight <= 0 {
		weight = 100
	}
	totalQuota := req.TotalQuota
	if totalQuota <= 0 {
		totalQuota = 1000000000 // 默认 10 亿 token
	}

	// 按 base_url 去重
	existing, err := s.provRepo.FindByBaseURL(req.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("find by base url: %w", err)
	}

	var provider *model.Provider
	if existing != nil {
		// 更新已有提供商
		existing.Name = req.Name
		existing.ProviderType = req.ProviderType
		existing.APIKey = encryptedKey
		existing.Weight = weight
		existing.HealthCheckURL = req.HealthCheckURL
		existing.Status = model.ProviderStatusActive
		if len(req.ModelsSupported) > 0 {
			modelsJSON, _ := json.Marshal(req.ModelsSupported)
			existing.SupportedModels = datatypes.JSON(modelsJSON)
		}
		if err := s.provRepo.Update(existing); err != nil {
			return nil, fmt.Errorf("update provider: %w", err)
		}
		if err := s.provRepo.UpdateHeartbeat(existing.ID); err != nil {
			slog.Error("更新心跳失败", "provider_id", existing.ID, "error", err)
		}
		provider = existing
	} else {
		// 创建新提供商
		provider = &model.Provider{
			Name:               req.Name,
			ProviderType:       req.ProviderType,
			APIKey:             encryptedKey,
			BaseURL:            req.BaseURL,
			TotalQuota:         totalQuota,
			Weight:             weight,
			HealthCheckURL:     req.HealthCheckURL,
			RegistrationSource: model.RegistrationSourceRegistry,
			Status:             model.ProviderStatusActive,
		}
		if len(req.ModelsSupported) > 0 {
			modelsJSON, _ := json.Marshal(req.ModelsSupported)
			provider.SupportedModels = datatypes.JSON(modelsJSON)
		} else {
			provider.SupportedModels = datatypes.JSON([]byte("[]"))
		}
		if err := s.provRepo.Create(provider); err != nil {
			return nil, fmt.Errorf("create provider: %w", err)
		}
	}

	// 自动创建 model_provider_mappings
	if len(req.ModelsSupported) > 0 {
		// 先清除旧映射
		_ = s.mappingRepo.DeleteByProviderID(provider.ID)
		for _, modelPattern := range req.ModelsSupported {
			mapping := &model.ModelProviderMapping{
				ModelPattern: modelPattern,
				ProviderID:   provider.ID,
				Priority:     0,
				IsActive:     true,
			}
			if err := s.mappingRepo.Create(mapping); err != nil {
				slog.Error("创建模型映射失败", "model", modelPattern, "provider_id", provider.ID, "error", err)
			}
		}
	}

	slog.Info("服务注册成功",
		"provider_id", provider.ID,
		"name", provider.Name,
		"base_url", provider.BaseURL,
		"models", req.ModelsSupported,
	)

	return &RegisterResponse{
		ProviderID:        provider.ID,
		HeartbeatInterval: 30,
	}, nil
}

// Heartbeat 更新提供商心跳，恢复 unhealthy → active。
func (s *RegistryService) Heartbeat(providerID uuid.UUID) error {
	provider, err := s.provRepo.GetByID(providerID)
	if err != nil {
		return fmt.Errorf("provider not found: %w", err)
	}

	// 恢复 unhealthy → active
	if provider.Status == model.ProviderStatusUnhealthy {
		if err := s.provRepo.UpdateStatus(providerID, model.ProviderStatusActive); err != nil {
			return fmt.Errorf("update status: %w", err)
		}
		slog.Info("提供商从 unhealthy 恢复为 active", "provider_id", providerID, "name", provider.Name)
	}

	return s.provRepo.UpdateHeartbeat(providerID)
}

// Deregister 注销提供商及其关联映射。
func (s *RegistryService) Deregister(providerID uuid.UUID) error {
	// 先删除关联映射
	if err := s.mappingRepo.DeleteByProviderID(providerID); err != nil {
		slog.Error("删除提供商映射失败", "provider_id", providerID, "error", err)
	}

	if err := s.provRepo.Delete(providerID); err != nil {
		return fmt.Errorf("delete provider: %w", err)
	}

	slog.Info("服务注销成功", "provider_id", providerID)
	return nil
}
