package repository

import (
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"gorm.io/gorm"
)

type AuditRepo interface {
	Create(log *model.AdminAuditLog) error
}

type auditRepo struct {
	db *gorm.DB
}

func NewAuditRepo(db *gorm.DB) AuditRepo {
	return &auditRepo{db: db}
}

func (r *auditRepo) Create(log *model.AdminAuditLog) error {
	return r.db.Create(log).Error
}
