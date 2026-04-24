package repository

import (
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// ModelMappingRepo 定义模型映射的数据访问接口。
type ModelMappingRepo interface {
	Create(mapping *model.ModelProviderMapping) error
	Update(mapping *model.ModelProviderMapping) error
	GetByID(id uuid.UUID) (*model.ModelProviderMapping, error)
	Delete(id uuid.UUID) error
	ListAll() ([]model.ModelProviderMapping, error)
	FindProvidersForModel(modelName string) ([]model.Provider, error)
	FindMappingsForModel(modelName string) ([]model.ModelProviderMapping, error)
	DeleteByProviderID(providerID uuid.UUID) error
}

type modelMappingRepo struct {
	db *gorm.DB
}

// NewModelMappingRepo 创建新的 ModelMappingRepo 实例。
func NewModelMappingRepo(db *gorm.DB) ModelMappingRepo {
	return &modelMappingRepo{db: db}
}

func (r *modelMappingRepo) Create(mapping *model.ModelProviderMapping) error {
	return r.db.Create(mapping).Error
}

func (r *modelMappingRepo) Update(mapping *model.ModelProviderMapping) error {
	return r.db.Save(mapping).Error
}

func (r *modelMappingRepo) GetByID(id uuid.UUID) (*model.ModelProviderMapping, error) {
	var mapping model.ModelProviderMapping
	err := r.db.Preload("Provider").Where("id = ?", id).First(&mapping).Error
	if err != nil {
		return nil, err
	}
	return &mapping, nil
}

func (r *modelMappingRepo) Delete(id uuid.UUID) error {
	return r.db.Where("id = ?", id).Delete(&model.ModelProviderMapping{}).Error
}

// ListAll 返回所有映射规则，包含关联的 Provider 信息。
func (r *modelMappingRepo) ListAll() ([]model.ModelProviderMapping, error) {
	var mappings []model.ModelProviderMapping
	err := r.db.Preload("Provider").Order("priority DESC, created_at ASC").Find(&mappings).Error
	return mappings, err
}

// FindProvidersForModel 根据模型名查找匹配的提供商列表。
// 支持精确匹配和通配符 * 匹配（转换为 SQL LIKE 的 %）。
// 返回按映射 priority DESC 排序的可用提供商，Provider.Weight 和 Priority 会被映射级别的值覆盖。
func (r *modelMappingRepo) FindProvidersForModel(modelName string) ([]model.Provider, error) {
	// 查询所有 active 映射
	var mappings []model.ModelProviderMapping
	err := r.db.Where("is_active = true").
		Order("priority DESC").
		Find(&mappings).Error
	if err != nil {
		return nil, err
	}

	// 在应用层做通配符匹配，收集匹配的映射信息（保持优先级顺序）
	type mappingInfo struct {
		ProviderID uuid.UUID
		Priority   int
		Weight     int
	}
	var matched []mappingInfo
	seen := make(map[uuid.UUID]bool)
	for _, m := range mappings {
		if matchPattern(m.ModelPattern, modelName) {
			if !seen[m.ProviderID] {
				matched = append(matched, mappingInfo{
					ProviderID: m.ProviderID,
					Priority:   m.Priority,
					Weight:     m.Weight,
				})
				seen[m.ProviderID] = true
			}
		}
	}

	if len(matched) == 0 {
		return nil, nil
	}

	// 收集 provider IDs
	providerIDs := make([]uuid.UUID, len(matched))
	for i, m := range matched {
		providerIDs[i] = m.ProviderID
	}

	// 批量查询 provider，只返回 active 且有配额的
	var providers []model.Provider
	err = r.db.Where("id IN ? AND status = ? AND used_quota < total_quota",
		providerIDs, model.ProviderStatusActive).
		Find(&providers).Error
	if err != nil {
		return nil, err
	}

	// 按原始优先级顺序排列，并用映射级别的 weight 和 priority 覆盖
	providerMap := make(map[uuid.UUID]model.Provider)
	for _, p := range providers {
		providerMap[p.ID] = p
	}

	var result []model.Provider
	for _, m := range matched {
		if p, ok := providerMap[m.ProviderID]; ok {
			p.Priority = m.Priority
			p.Weight = m.Weight
			result = append(result, p)
		}
	}

	return result, nil
}

// DeleteByProviderID 删除指定提供商的所有映射。
func (r *modelMappingRepo) DeleteByProviderID(providerID uuid.UUID) error {
	return r.db.Where("provider_id = ?", providerID).Delete(&model.ModelProviderMapping{}).Error
}

// FindMappingsForModel 根据模型名查找匹配的映射规则列表（包含策略覆盖信息）。
func (r *modelMappingRepo) FindMappingsForModel(modelName string) ([]model.ModelProviderMapping, error) {
	var mappings []model.ModelProviderMapping
	err := r.db.Where("is_active = true").
		Order("priority DESC").
		Find(&mappings).Error
	if err != nil {
		return nil, err
	}

	var matched []model.ModelProviderMapping
	for _, m := range mappings {
		if matchPattern(m.ModelPattern, modelName) {
			matched = append(matched, m)
		}
	}
	return matched, nil
}

// matchPattern 判断模型名是否匹配通配符模式（不区分大小写）。
// 支持 * 作为通配符，如 "gpt-4*" 匹配 "gpt-4o", "gpt-4-turbo" 等。
func matchPattern(pattern, name string) bool {
	pattern = strings.ToLower(pattern)
	name = strings.ToLower(name)

	// 精确匹配
	if pattern == name {
		return true
	}

	// 通配符匹配: 仅支持末尾 * 和中间 *
	if strings.Contains(pattern, "*") {
		// 将 * 替换为正则式的简单实现
		parts := strings.Split(pattern, "*")
		if len(parts) == 2 {
			// 前缀*后缀 模式
			prefix := parts[0]
			suffix := parts[1]
			return strings.HasPrefix(name, prefix) && strings.HasSuffix(name, suffix)
		}
		// 仅前缀* 模式 (最常见)
		if strings.HasSuffix(pattern, "*") {
			prefix := strings.TrimSuffix(pattern, "*")
			return strings.HasPrefix(name, prefix)
		}
	}

	return false
}
