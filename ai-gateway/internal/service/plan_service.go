package service

import (
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/repository"
	"github.com/google/uuid"
)

type PlanService struct {
	planRepo repository.PlanRepo
}

func NewPlanService(planRepo repository.PlanRepo) *PlanService {
	return &PlanService{planRepo: planRepo}
}

func (s *PlanService) Create(plan *model.Plan) error {
	return s.planRepo.Create(plan)
}

func (s *PlanService) GetByID(id uuid.UUID) (*model.Plan, error) {
	return s.planRepo.GetByID(id)
}

func (s *PlanService) GetByName(name string) (*model.Plan, error) {
	return s.planRepo.GetByName(name)
}

func (s *PlanService) List(onlyActive bool) ([]model.Plan, error) {
	return s.planRepo.List(onlyActive)
}

func (s *PlanService) Update(plan *model.Plan) error {
	return s.planRepo.Update(plan)
}
