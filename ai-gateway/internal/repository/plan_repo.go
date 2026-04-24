package repository

import (
	"errors"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type PlanRepo interface {
	Create(plan *model.Plan) error
	GetByID(id uuid.UUID) (*model.Plan, error)
	GetByName(name string) (*model.Plan, error)
	List(onlyActive bool) ([]model.Plan, error)
	Update(plan *model.Plan) error
	DB() *gorm.DB
}

type planRepo struct {
	db *gorm.DB
}

func NewPlanRepo(db *gorm.DB) PlanRepo {
	return &planRepo{db: db}
}

func (r *planRepo) DB() *gorm.DB { return r.db }

func (r *planRepo) Create(plan *model.Plan) error {
	return r.db.Create(plan).Error
}

func (r *planRepo) GetByID(id uuid.UUID) (*model.Plan, error) {
	var plan model.Plan
	err := r.db.Where("id = ?", id).First(&plan).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrPlanNotFound
		}
		return nil, err
	}
	return &plan, nil
}

func (r *planRepo) GetByName(name string) (*model.Plan, error) {
	var plan model.Plan
	err := r.db.Where("name = ?", name).First(&plan).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, model.ErrPlanNotFound
		}
		return nil, err
	}
	return &plan, nil
}

func (r *planRepo) List(onlyActive bool) ([]model.Plan, error) {
	var plans []model.Plan
	q := r.db
	if onlyActive {
		q = q.Where("is_active = ?", true)
	}
	if err := q.Find(&plans).Error; err != nil {
		return nil, err
	}
	return plans, nil
}

func (r *planRepo) Update(plan *model.Plan) error {
	return r.db.Save(plan).Error
}
