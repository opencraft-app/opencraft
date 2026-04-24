package repository

import (
	"errors"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// RuntimeConfigRepo 运行时配置数据访问接口。
type RuntimeConfigRepo interface {
	Get(key string) (*model.RuntimeConfig, error)
	Upsert(key string, value []byte) error
}

type runtimeConfigRepo struct {
	db *gorm.DB
}

// NewRuntimeConfigRepo 创建 RuntimeConfigRepo 实例。
func NewRuntimeConfigRepo(db *gorm.DB) RuntimeConfigRepo {
	return &runtimeConfigRepo{db: db}
}

// Get 根据 key 获取配置，找不到返回 nil, nil。
func (r *runtimeConfigRepo) Get(key string) (*model.RuntimeConfig, error) {
	var cfg model.RuntimeConfig
	err := r.db.Where("`key` = ?", key).First(&cfg).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &cfg, nil
}

// Upsert 插入或更新配置。
func (r *runtimeConfigRepo) Upsert(key string, value []byte) error {
	cfg := model.RuntimeConfig{
		Key:   key,
		Value: value,
	}
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
	}).Create(&cfg).Error
}
