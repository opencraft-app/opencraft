package repository

import (
	"errors"
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type ApiKeyRepo interface {
	Create(key *model.ApiKey) error
	GetByID(id uuid.UUID) (*model.ApiKey, error)
	GetByHash(hash string) (*model.ApiKey, error)
	DeactivateByID(id uuid.UUID) error
	DeactivateAllForUser(userID uuid.UUID) error
	ListByUserID(userID uuid.UUID) ([]model.ApiKey, error)
	ListAll(offset, limit int, search string) ([]model.ApiKey, int64, error)
	ListAllWithUsers(offset, limit int, search string, status string) ([]ApiKeyWithUserRow, int64, error)
	CountActive() (int64, error)
	DB() *gorm.DB
}

type apiKeyRepo struct {
	db *gorm.DB
}

func NewApiKeyRepo(db *gorm.DB) ApiKeyRepo {
	return &apiKeyRepo{db: db}
}

func (r *apiKeyRepo) Create(key *model.ApiKey) error {
	return r.db.Create(key).Error
}

// GetByID returns an API key by its primary key.
func (r *apiKeyRepo) GetByID(id uuid.UUID) (*model.ApiKey, error) {
	var key model.ApiKey
	err := r.db.Where("id = ?", id).First(&key).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrApiKeyNotFound
		}
		return nil, err
	}
	return &key, nil
}

// GetByHash returns the active API key matching the given hash.
// Returns ErrApiKeyNotFound if no active key matches.
func (r *apiKeyRepo) GetByHash(hash string) (*model.ApiKey, error) {
	var key model.ApiKey
	err := r.db.Where("key_hash = ? AND is_active = ?", hash, true).First(&key).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrApiKeyNotFound
		}
		return nil, err
	}
	return &key, nil
}

func (r *apiKeyRepo) DeactivateByID(id uuid.UUID) error {
	return r.db.Model(&model.ApiKey{}).
		Where("id = ?", id).
		Update("is_active", false).Error
}

func (r *apiKeyRepo) DeactivateAllForUser(userID uuid.UUID) error {
	return r.db.Model(&model.ApiKey{}).
		Where("user_id = ? AND is_active = ?", userID, true).
		Update("is_active", false).Error
}

func (r *apiKeyRepo) ListByUserID(userID uuid.UUID) ([]model.ApiKey, error) {
	var keys []model.ApiKey
	if err := r.db.Where("user_id = ?", userID).Find(&keys).Error; err != nil {
		return nil, err
	}
	return keys, nil
}

// ListAll 返回分页的所有 API Key，支持按 key_prefix、name、用户信息搜索。
func (r *apiKeyRepo) ListAll(offset, limit int, search string) ([]model.ApiKey, int64, error) {
	var keys []model.ApiKey
	var total int64

	q := r.db.Model(&model.ApiKey{})
	if search != "" {
		escaped := strings.ReplaceAll(search, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `%`, `\%`)
		escaped = strings.ReplaceAll(escaped, `_`, `\_`)
		like := "%" + escaped + "%"
		q = q.Where(
			`key_prefix LIKE ? OR name LIKE ? OR user_id IN (
				SELECT id FROM users
				WHERE phone LIKE ? OR external_uid LIKE ? OR CAST(id AS CHAR) LIKE ?
			)`,
			like, like, like, like, like,
		)
	}
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if err := q.Offset(offset).Limit(limit).Order("created_at DESC").Find(&keys).Error; err != nil {
		return nil, 0, err
	}
	return keys, total, nil
}

// CountActive 返回活跃 API Key 数量
func (r *apiKeyRepo) CountActive() (int64, error) {
	var count int64
	if err := r.db.Model(&model.ApiKey{}).Where("is_active = ?", true).Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}

func (r *apiKeyRepo) DB() *gorm.DB { return r.db }

// ApiKeyWithUserRow API Key + 用户信息的扁平 JOIN 结果。
type ApiKeyWithUserRow struct {
	model.ApiKey
	UserUserID   string `gorm:"column:user_user_id"`
	UserPhone    string `gorm:"column:user_phone"`
	UserNickname string `gorm:"column:user_nickname"`
}

func (r *apiKeyRepo) ListAllWithUsers(offset, limit int, search string, status string) ([]ApiKeyWithUserRow, int64, error) {
	var results []ApiKeyWithUserRow

	q := r.db.Table("api_keys").
		Select(`api_keys.*,
			users.id as user_user_id,
			users.phone_masked as user_phone,
			users.nickname as user_nickname`).
		Joins("LEFT JOIN users ON users.id = api_keys.user_id")

	if search != "" {
		escaped := strings.ReplaceAll(search, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `%`, `\%`)
		escaped = strings.ReplaceAll(escaped, `_`, `\_`)
		like := "%" + escaped + "%"
		q = q.Where(
			`api_keys.key_prefix LIKE ? OR api_keys.name LIKE ? OR users.phone_masked LIKE ? OR users.nickname LIKE ? OR users.external_uid LIKE ? OR CAST(api_keys.user_id AS CHAR) LIKE ?`,
			like, like, like, like, like, like,
		)
	}
	if status == "active" {
		q = q.Where("api_keys.is_active = ?", true)
	} else if status == "revoked" {
		q = q.Where("api_keys.is_active = ?", false)
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if err := q.Offset(offset).Limit(limit).Order("api_keys.created_at DESC").Scan(&results).Error; err != nil {
		return nil, 0, err
	}
	return results, total, nil
}
