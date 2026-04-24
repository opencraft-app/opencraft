package repository

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type ProviderRepo interface {
	Create(provider *model.Provider) error
	GetByID(id uuid.UUID) (*model.Provider, error)
	SelectBest(providerType string) (*model.Provider, error)
	SelectBestForModel(modelName string) (*model.Provider, error)
	SelectCandidatesForModel(modelName string) ([]model.Provider, error)
	SelectCandidates(providerType string) ([]model.Provider, error)
	IncrementUsedQuota(providerID uuid.UUID, amount int64) error
	MarkExhausted(providerID uuid.UUID) error
	IncrementUsedQuotaAndCheckExhaustion(providerID uuid.UUID, amount int64) (bool, error)
	List() ([]model.Provider, error)
	Update(provider *model.Provider) error
	UpdateStatus(id uuid.UUID, status string) error
	UpdateHeartbeat(id uuid.UUID) error
	Delete(id uuid.UUID) error
	FindByBaseURL(baseURL string) (*model.Provider, error)
	ListByRegistrationSource(source string) ([]model.Provider, error)
	ListForHealthCheck(source string) ([]model.Provider, error)
	CountActive() (int64, error)
}

type providerRepo struct {
	db *gorm.DB
}

func NewProviderRepo(db *gorm.DB) ProviderRepo {
	return &providerRepo{db: db}
}

func (r *providerRepo) Create(provider *model.Provider) error {
	return r.db.Create(provider).Error
}

func (r *providerRepo) GetByID(id uuid.UUID) (*model.Provider, error) {
	var provider model.Provider
	err := r.db.Where("id = ?", id).First(&provider).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrProviderNotFound
		}
		return nil, err
	}
	return &provider, nil
}

// SelectBest finds the highest-priority active provider with available quota.
func (r *providerRepo) SelectBest(providerType string) (*model.Provider, error) {
	var provider model.Provider
	err := r.db.
		Where("provider_type = ? AND status = ? AND used_quota < total_quota", providerType, model.ProviderStatusActive).
		Order("priority DESC").
		First(&provider).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrProviderUnavailable
		}
		return nil, err
	}
	return &provider, nil
}

// SelectBestForModel 根据模型名查找支持该模型的最高优先级活跃供应商。
// MySQL 版本通过 JSON_SEARCH 在数据库层过滤模型，避免应用层遍历。
func (r *providerRepo) SelectBestForModel(modelName string) (*model.Provider, error) {
	modelLower := strings.ToLower(modelName)
	var provider model.Provider
	err := r.db.
		Where("status = ? AND used_quota < total_quota AND JSON_SEARCH(LOWER(CAST(supported_models AS CHAR)), 'one', ?) IS NOT NULL",
			model.ProviderStatusActive, modelLower).
		Order("priority DESC").
		First(&provider).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrProviderUnavailable
		}
		return nil, err
	}
	return &provider, nil
}

// SelectCandidatesForModel 根据 supported_models 返回所有支持该模型的可用供应商，按 priority DESC 排序。
func (r *providerRepo) SelectCandidatesForModel(modelName string) ([]model.Provider, error) {
	modelLower := strings.ToLower(modelName)
	var providers []model.Provider
	err := r.db.
		Where("status = ? AND used_quota < total_quota AND JSON_SEARCH(LOWER(CAST(supported_models AS CHAR)), 'one', ?) IS NOT NULL",
			model.ProviderStatusActive, modelLower).
		Order("priority DESC").
		Find(&providers).Error
	if err != nil {
		return nil, err
	}
	return providers, nil
}

// IncrementUsedQuota atomically increases the used quota for a provider.
func (r *providerRepo) IncrementUsedQuota(providerID uuid.UUID, amount int64) error {
	return r.db.Model(&model.Provider{}).
		Where("id = ?", providerID).
		Update("used_quota", gorm.Expr("used_quota + ?", amount)).Error
}

// MarkExhausted sets a provider's status to exhausted.
func (r *providerRepo) MarkExhausted(providerID uuid.UUID) error {
	return r.db.Model(&model.Provider{}).
		Where("id = ?", providerID).
		Update("status", model.ProviderStatusExhausted).Error
}

// IncrementUsedQuotaAndCheckExhaustion 原子地增加 used_quota 并检查是否耗尽。
// 第一步原子增量，第二步原子检测耗尽并标记（两步之间不持有行锁，避免死锁）。
// 返回是否触发了耗尽标记（仅第一个请求返回 true，后续请求返回 false）。
// 高并发下所有请求都能正确增加 used_quota，但只有达到阈值的第一个请求会触发标记。
func (r *providerRepo) IncrementUsedQuotaAndCheckExhaustion(providerID uuid.UUID, amount int64) (bool, error) {
	// 1. 原子增量
	if err := r.db.Exec(`
		UPDATE providers
		SET used_quota = used_quota + ?
		WHERE id = ? AND status = ?
	`, amount, providerID, model.ProviderStatusActive).Error; err != nil {
		return false, fmt.Errorf("increment used quota: %w", err)
	}

	// 2. 原子耗尽检测 + 标记
	// WHERE used_quota >= total_quota AND status = active 确保幂等：
	// - 非第一个请求：used_quota < total_quota，RowsAffected = 0
	// - 非 active 状态：不匹配，RowsAffected = 0
	result := r.db.Exec(`
		UPDATE providers
		SET status = ?
		WHERE id = ? AND used_quota >= total_quota AND status = ?
	`, model.ProviderStatusExhausted, providerID, model.ProviderStatusActive)

	if result.Error != nil {
		return false, fmt.Errorf("mark exhausted: %w", result.Error)
	}
	return result.RowsAffected > 0, nil
}

func (r *providerRepo) List() ([]model.Provider, error) {
	var providers []model.Provider
	if err := r.db.Find(&providers).Error; err != nil {
		return nil, err
	}
	return providers, nil
}

func (r *providerRepo) Update(provider *model.Provider) error {
	return r.db.Save(provider).Error
}

// SelectCandidates 返回指定类型的所有可用提供商（有配额、状态 active），按 priority DESC 排序。
func (r *providerRepo) SelectCandidates(providerType string) ([]model.Provider, error) {
	var providers []model.Provider
	err := r.db.
		Where("provider_type = ? AND status = ? AND used_quota < total_quota", providerType, model.ProviderStatusActive).
		Order("priority DESC").
		Find(&providers).Error
	if err != nil {
		return nil, err
	}
	return providers, nil
}

// UpdateStatus 更新指定提供商的状态。
func (r *providerRepo) UpdateStatus(id uuid.UUID, status string) error {
	return r.db.Model(&model.Provider{}).
		Where("id = ?", id).
		Update("status", status).Error
}

// UpdateHeartbeat 更新提供商的最后心跳时间。
func (r *providerRepo) UpdateHeartbeat(id uuid.UUID) error {
	now := time.Now().UTC()
	return r.db.Model(&model.Provider{}).
		Where("id = ?", id).
		Update("last_heartbeat", now).Error
}

// Delete 删除指定提供商。
func (r *providerRepo) Delete(id uuid.UUID) error {
	return r.db.Where("id = ?", id).Delete(&model.Provider{}).Error
}

// FindByBaseURL 根据 base_url 查找提供商（用于注册去重）。
func (r *providerRepo) FindByBaseURL(baseURL string) (*model.Provider, error) {
	var provider model.Provider
	err := r.db.Where("base_url = ?", baseURL).First(&provider).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &provider, nil
}

// ListByRegistrationSource 列出指定注册来源的提供商。
func (r *providerRepo) ListByRegistrationSource(source string) ([]model.Provider, error) {
	var providers []model.Provider
	err := r.db.Where("registration_source = ?", source).Find(&providers).Error
	return providers, err
}

// ListForHealthCheck 仅查询健康检查所需的必要字段，避免拉取大字段 api_key 和 supported_models。
func (r *providerRepo) ListForHealthCheck(source string) ([]model.Provider, error) {
	var providers []model.Provider
	err := r.db.Select("id, name, provider_type, status, health_check_url, last_heartbeat, registration_source").
		Where("registration_source = ?", source).
		Find(&providers).Error
	return providers, err
}

// CountActive 返回活跃供应商数量
func (r *providerRepo) CountActive() (int64, error) {
	var count int64
	if err := r.db.Model(&model.Provider{}).Where("status = ?", model.ProviderStatusActive).Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}
