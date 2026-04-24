package repository

import (
	"errors"
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type UserRepo interface {
	Create(user *model.User) error
	GetByID(id uuid.UUID) (*model.User, error)
	GetByPhoneHash(phoneHash string) (*model.User, error)
	GetByUserID(userID string) (*model.User, error)
	Update(user *model.User) error
	SoftDelete(id uuid.UUID) error
	List(offset, limit int, search string, phoneHash string) ([]model.User, int64, error)
	ListWithActiveSubscription(offset, limit int, search string, status string) ([]UserWithSubRow, int64, error)
	CountAll() (int64, error)
	CountByStatus(status string) (int64, error)
	DB() *gorm.DB
}

type userRepo struct {
	db *gorm.DB
}

func NewUserRepo(db *gorm.DB) UserRepo {
	return &userRepo{db: db}
}

func (r *userRepo) Create(user *model.User) error {
	return r.db.Create(user).Error
}

func (r *userRepo) GetByID(id uuid.UUID) (*model.User, error) {
	var user model.User
	err := r.db.Where("id = ?", id).First(&user).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrUserNotFound
		}
		return nil, err
	}
	return &user, nil
}

func (r *userRepo) GetByPhoneHash(phoneHash string) (*model.User, error) {
	var user model.User
	err := r.db.Where("phone_hash = ?", phoneHash).First(&user).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrUserNotFound
		}
		return nil, err
	}
	return &user, nil
}

func (r *userRepo) GetByUserID(userID string) (*model.User, error) {
	var user model.User
	err := r.db.Where("external_uid = ?", userID).First(&user).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrUserNotFound
		}
		return nil, err
	}
	return &user, nil
}

func (r *userRepo) Update(user *model.User) error {
	return r.db.Save(user).Error
}

func (r *userRepo) SoftDelete(id uuid.UUID) error {
	result := r.db.Model(&model.User{}).Where("id = ?", id).Update("status", model.UserStatusDeleted)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return model.ErrUserNotFound
	}
	return nil
}

func (r *userRepo) List(offset, limit int, search string, phoneHash string) ([]model.User, int64, error) {
	var users []model.User
	var total int64
	q := r.db.Model(&model.User{})

	if phoneHash != "" {
		// 完整手机号搜索：按 hash 精确匹配
		q = q.Where("phone_hash = ?", phoneHash)
	} else if search != "" {
		// 转义 LIKE 通配符，防止 % 过多导致全表扫描或 _ 意外匹配单个字符
		escaped := strings.ReplaceAll(search, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `%`, `\%`)
		escaped = strings.ReplaceAll(escaped, `_`, `\_`)
		like := "%" + escaped + "%"
		q = q.Where("phone_masked LIKE ? OR external_uid LIKE ? OR nickname LIKE ?", like, like, like)
	}

	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if err := q.Offset(offset).Limit(limit).Order("created_at DESC").Find(&users).Error; err != nil {
		return nil, 0, err
	}
	return users, total, nil
}

func (r *userRepo) CountAll() (int64, error) {
	var count int64
	if err := r.db.Model(&model.User{}).Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}

func (r *userRepo) CountByStatus(status string) (int64, error) {
	var count int64
	if err := r.db.Model(&model.User{}).Where("status = ?", status).Count(&count).Error; err != nil {
		return 0, err
	}
	return count, nil
}

func (r *userRepo) DB() *gorm.DB { return r.db }

// UserWithSubRow 用户 + 活跃订阅 + 套餐的扁平结构（用于 JOIN 查询结果）。
type UserWithSubRow struct {
	model.User
	SubID             uuid.UUID `gorm:"column:sub_id"`
	SubStatus         string    `gorm:"column:sub_status"`
	SubTokenBalance   int64     `gorm:"column:sub_token_balance"`
	PlanID            uuid.UUID `gorm:"column:plan_id"`
	PlanName          string    `gorm:"column:plan_name"`
	PlanMonthlyTokens *int64    `gorm:"column:plan_monthly_tokens"`
}

func (r *userRepo) ListWithActiveSubscription(offset, limit int, search string, status string) ([]UserWithSubRow, int64, error) {
	var results []UserWithSubRow

	q := r.db.Table("users").
		Select(`users.*,
			subs.id as sub_id,
			subs.status as sub_status,
			subs.token_balance as sub_token_balance,
			plans.id as plan_id,
			plans.name as plan_name,
			plans.monthly_tokens as plan_monthly_tokens`).
		Joins("LEFT JOIN subscriptions subs ON subs.user_id = users.id AND subs.status = ?",
			model.SubscriptionStatusActive).
		Joins("LEFT JOIN plans ON plans.id = subs.plan_id")

	if search != "" {
		escaped := strings.ReplaceAll(search, `\`, `\\`)
		escaped = strings.ReplaceAll(escaped, `%`, `\%`)
		escaped = strings.ReplaceAll(escaped, `_`, `\_`)
		like := "%" + escaped + "%"
		q = q.Where("users.phone_masked LIKE ? OR users.external_uid LIKE ? OR users.nickname LIKE ?", like, like, like)
	}
	if status != "" {
		q = q.Where("users.status = ?", status)
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if err := q.Offset(offset).Limit(limit).Order("users.created_at DESC").Scan(&results).Error; err != nil {
		return nil, 0, err
	}
	return results, total, nil
}
