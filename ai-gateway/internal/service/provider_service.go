package service

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"strings"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/crypto"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
)

type ProviderService struct {
	provRepo      repository.ProviderRepo
	mappingRepo   repository.ModelMappingRepo
	encryptionKey []byte
	httpClient    *http.Client
}

func NewProviderService(provRepo repository.ProviderRepo, mappingRepo repository.ModelMappingRepo, encryptionKey []byte) *ProviderService {
	return &ProviderService{
		provRepo:      provRepo,
		mappingRepo:   mappingRepo,
		encryptionKey: encryptionKey,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

type ProviderRouteMismatch struct {
	ProviderID   uuid.UUID `json:"provider_id"`
	ProviderName string    `json:"provider_name"`
	Reason       string    `json:"reason"`
	Source       string    `json:"source"`
}

type ModelResolution struct {
	Candidates []model.Provider        `json:"candidates"`
	Mismatches []ProviderRouteMismatch `json:"mismatches"`
}

// SelectProvider finds the best provider by type and decrypts its API key (兜底接口).
func (s *ProviderService) SelectProvider(providerType string) (*model.Provider, string, error) {
	provider, err := s.provRepo.SelectBest(providerType)
	if err != nil {
		return nil, "", err
	}

	decryptedKey, err := crypto.Decrypt(provider.APIKey, s.encryptionKey)
	if err != nil {
		return nil, "", fmt.Errorf("decrypt provider api key: %w", err)
	}

	return provider, decryptedKey, nil
}

// SelectProviderForModel 根据模型名选择提供商：先查映射表，再查 supported_models，最后兜底到 providerType 逻辑。
func (s *ProviderService) SelectProviderForModel(modelName string) (*model.Provider, string, error) {
	resolution, err := s.ResolveCandidatesForModel(modelName)
	if err != nil {
		return nil, "", err
	}

	provider := s.selectWeighted(resolution.Candidates)
	if provider == nil {
		return nil, "", model.ErrProviderUnavailable
	}

	decryptedKey, err := crypto.Decrypt(provider.APIKey, s.encryptionKey)
	if err == nil {
		return provider, decryptedKey, nil
	}
	return nil, "", fmt.Errorf("decrypt provider api key: %w", err)
}

// GetCandidatesForModel 返回模型的有序候选提供商列表（用于重试）。
func (s *ProviderService) GetCandidatesForModel(modelName string) ([]model.Provider, error) {
	resolution, err := s.ResolveCandidatesForModel(modelName)
	if err != nil {
		return nil, err
	}
	return resolution.Candidates, nil
}

// ResolveCandidatesForModel 解析模型对应的候选提供商及被剔除的不一致项。
// 规则：
// 1. 如果存在 model_mappings，则仅在映射命中的 provider 中做选择；
// 2. 映射命中但 supported_models 明确不包含该模型的 provider 会被剔除并记录 mismatch；
// 3. 若当前模型没有任何 mapping，则自动从 supported_models 发现支持的 provider；
// 4. 只有没有任何显式模型级配置命中时，才回退到 providerType 逻辑。
func (s *ProviderService) ResolveCandidatesForModel(modelName string) (*ModelResolution, error) {
	resolution := &ModelResolution{}

	// 1. 模型级映射存在时，仅在映射结果内做优先级/权重路由。
	if s.mappingRepo != nil {
		mappedProviders, err := s.mappingRepo.FindProvidersForModel(modelName)
		if err != nil {
			slog.Error("查询模型映射失败，继续尝试 supported_models", "model", modelName, "error", err)
		} else if len(mappedProviders) > 0 {
			resolution.Candidates, resolution.Mismatches = s.filterMappedProviders(modelName, mappedProviders)
			if len(resolution.Candidates) == 0 {
				return resolution, model.ErrProviderUnavailable
			}
			return resolution, nil
		}
	}

	// 2. 没有映射配置时，自动发现所有 supported_models 命中的 provider。
	candidates, err := s.provRepo.SelectCandidatesForModel(modelName)
	if err == nil && len(candidates) > 0 {
		resolution.Candidates = candidates
		return resolution, nil
	}

	// 3. 最后才按 provider type 兜底，避免把同类型但不支持该模型的 provider 混入显式路由。
	providerType := providerTypeFromModel(modelName)
	candidates, err = s.provRepo.SelectCandidates(providerType)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, model.ErrProviderUnavailable
	}
	resolution.Candidates = candidates
	return resolution, nil
}

// DecryptProviderKey 解密提供商 API key。
func (s *ProviderService) DecryptProviderKey(provider *model.Provider) (string, error) {
	return crypto.Decrypt(provider.APIKey, s.encryptionKey)
}

// selectWeighted 在候选列表中按 weight 加权随机选择。
// 同优先级组的提供商按 weight 加权，不同优先级优先选高优先级。
func (s *ProviderService) selectWeighted(candidates []model.Provider) *model.Provider {
	if len(candidates) == 0 {
		return nil
	}
	if len(candidates) == 1 {
		return &candidates[0]
	}

	// 取最高优先级组
	highestPriority := candidates[0].Priority
	var group []model.Provider
	for _, c := range candidates {
		if c.Priority == highestPriority {
			group = append(group, c)
		} else {
			break // 已按 priority DESC 排序
		}
	}

	if len(group) == 1 {
		return &group[0]
	}

	// 在同优先级组内按 weight 加权随机
	totalWeight := 0
	for _, p := range group {
		w := p.Weight
		if w <= 0 {
			w = 1
		}
		totalWeight += w
	}

	r := rand.Intn(totalWeight)
	for i := range group {
		w := group[i].Weight
		if w <= 0 {
			w = 1
		}
		r -= w
		if r < 0 {
			return &group[i]
		}
	}

	return &group[0]
}

// providerTypeFromModel 根据模型名推断提供商类型（兜底逻辑）。
func providerTypeFromModel(modelName string) string {
	modelName = strings.ToLower(strings.TrimSpace(modelName))
	switch {
	case strings.HasPrefix(modelName, "gpt"):
		return "openai"
	case strings.HasPrefix(modelName, "deepseek"):
		return "deepseek"
	case strings.HasPrefix(modelName, "qwen"):
		return "qwen"
	case strings.HasPrefix(modelName, "claude"):
		return "anthropic"
	default:
		return "openai"
	}
}

// GetMappingsForModel 返回模型匹配的映射规则列表（用于获取策略覆盖信息）。
func (s *ProviderService) GetMappingsForModel(modelName string) ([]model.ModelProviderMapping, error) {
	if s.mappingRepo == nil {
		return nil, nil
	}
	return s.mappingRepo.FindMappingsForModel(modelName)
}

// CheckProviderModelConsistency 在 provider 写入后检查 supported_models 与现有 mapping 是否冲突。
func (s *ProviderService) CheckProviderModelConsistency(provider *model.Provider) ([]ProviderRouteMismatch, error) {
	if s.mappingRepo == nil || provider == nil {
		return nil, nil
	}

	allMappings, err := s.mappingRepo.ListAll()
	if err != nil {
		return nil, err
	}

	var mismatches []ProviderRouteMismatch
	for _, mapping := range allMappings {
		if mapping.ProviderID != provider.ID || !mapping.IsActive {
			continue
		}
		if strings.Contains(mapping.ModelPattern, "*") {
			continue
		}
		hasSupportedModels, supportsModel := providerSupportsModel(provider, mapping.ModelPattern)
		if hasSupportedModels && !supportsModel {
			mismatches = append(mismatches, ProviderRouteMismatch{
				ProviderID:   provider.ID,
				ProviderName: provider.Name,
				Reason:       fmt.Sprintf("mapping %q is not present in supported_models", mapping.ModelPattern),
				Source:       "provider_update_consistency_check",
			})
		}
	}
	return mismatches, nil
}

// TrackUsage increments provider used_quota and checks for exhaustion atomically.
func (s *ProviderService) TrackUsage(providerID uuid.UUID, tokens int64) error {
	exhausted, err := s.provRepo.IncrementUsedQuotaAndCheckExhaustion(providerID, tokens)
	if err != nil {
		return fmt.Errorf("increment used quota: %w", err)
	}

	if exhausted {
		provider, _ := s.provRepo.GetByID(providerID)
		slog.Warn("provider exhausted",
			"provider_id", providerID,
			"name", provider.Name,
		)
	}

	return nil
}

// Create creates a new provider. API key is encrypted before storage.
func (s *ProviderService) Create(provider *model.Provider) error {
	if provider.ModelDiscoveryProtocol == "" {
		provider.ModelDiscoveryProtocol = defaultModelDiscoveryProtocol(provider.ProviderType)
	}
	if provider.APIKey != "" {
		encrypted, err := crypto.Encrypt(provider.APIKey, s.encryptionKey)
		if err != nil {
			return fmt.Errorf("encrypt provider api key: %w", err)
		}
		provider.APIKey = encrypted
	}
	if err := s.provRepo.Create(provider); err != nil {
		return err
	}
	s.logProviderConsistencyWarnings(provider)
	return nil
}

// GetByID returns a provider by ID.
func (s *ProviderService) GetByID(id uuid.UUID) (*model.Provider, error) {
	return s.provRepo.GetByID(id)
}

// List returns all providers.
func (s *ProviderService) List() ([]model.Provider, error) {
	return s.provRepo.List()
}

// CountActive returns the count of active providers.
func (s *ProviderService) CountActive() (int64, error) {
	return s.provRepo.CountActive()
}

// Update updates a provider. If API key is changed, encrypt it before storage.
func (s *ProviderService) Update(provider *model.Provider) error {
	if provider.ModelDiscoveryProtocol == "" {
		provider.ModelDiscoveryProtocol = defaultModelDiscoveryProtocol(provider.ProviderType)
	}
	if provider.APIKey != "" {
		// 检查是否已经是加密格式（base64），如果不是则加密
		if _, err := crypto.Decrypt(provider.APIKey, s.encryptionKey); err != nil {
			encrypted, encErr := crypto.Encrypt(provider.APIKey, s.encryptionKey)
			if encErr != nil {
				return fmt.Errorf("encrypt provider api key: %w", encErr)
			}
			provider.APIKey = encrypted
		}
	}
	if err := s.provRepo.Update(provider); err != nil {
		return err
	}
	s.logProviderConsistencyWarnings(provider)
	return nil
}

func (s *ProviderService) filterMappedProviders(modelName string, providers []model.Provider) ([]model.Provider, []ProviderRouteMismatch) {
	candidates := make([]model.Provider, 0, len(providers))
	mismatches := make([]ProviderRouteMismatch, 0)

	for _, provider := range providers {
		hasSupportedModels, supportsModel := providerSupportsModel(&provider, modelName)
		if hasSupportedModels && !supportsModel {
			mismatch := ProviderRouteMismatch{
				ProviderID:   provider.ID,
				ProviderName: provider.Name,
				Reason:       fmt.Sprintf("provider mapping matched model %q but supported_models does not include it", modelName),
				Source:       "mapping_vs_supported_models_mismatch",
			}
			mismatches = append(mismatches, mismatch)
			slog.Warn("模型路由配置不一致，已剔除 provider",
				"model", modelName,
				"provider_id", provider.ID,
				"provider_name", provider.Name,
				"source", mismatch.Source,
			)
			continue
		}
		candidates = append(candidates, provider)
	}

	return candidates, mismatches
}

func defaultModelDiscoveryProtocol(providerType string) string {
	switch providerType {
	case model.ProviderTypeAnthropic:
		return model.ModelDiscoveryProtocolAnthropic
	default:
		return model.ModelDiscoveryProtocolOpenAICompatible
	}
}

func (s *ProviderService) logProviderConsistencyWarnings(provider *model.Provider) {
	mismatches, err := s.CheckProviderModelConsistency(provider)
	if err != nil {
		slog.Error("provider 模型一致性检查失败", "provider_id", provider.ID, "provider_name", provider.Name, "error", err)
		return
	}
	for _, mismatch := range mismatches {
		slog.Warn("provider 模型配置存在冲突",
			"provider_id", mismatch.ProviderID,
			"provider_name", mismatch.ProviderName,
			"reason", mismatch.Reason,
			"source", mismatch.Source,
		)
	}
}

func providerSupportsModel(provider *model.Provider, modelName string) (bool, bool) {
	if provider == nil || len(provider.SupportedModels) == 0 {
		return false, false
	}

	var models []string
	if err := json.Unmarshal(provider.SupportedModels, &models); err != nil {
		return false, false
	}
	if len(models) == 0 {
		return false, false
	}

	for _, supportedModel := range models {
		if strings.EqualFold(strings.TrimSpace(supportedModel), strings.TrimSpace(modelName)) {
			return true, true
		}
	}
	return true, false
}
