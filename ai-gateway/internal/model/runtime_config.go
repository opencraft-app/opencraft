package model

import (
	"time"

	"gorm.io/datatypes"
)

// RuntimeConfig 运行时配置表，用于存储可热更新的系统配置。
type RuntimeConfig struct {
	Key       string         `gorm:"column:key;type:varchar(64);primaryKey" json:"key"`
	Value     datatypes.JSON `gorm:"type:json;not null" json:"value"`
	UpdatedAt time.Time      `gorm:"autoUpdateTime" json:"updated_at"`
}
