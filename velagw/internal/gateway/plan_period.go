package gateway

import (
	"context"
	"errors"
)

var ErrPlanPeriodRetired = errors.New("plan period variants are retired")

// planTarget identifies the current new-api materialization for one business Plan.
// Period fields remain on the compatibility request but no longer select a target.
type planTarget struct {
	Plan Plan
}

func defaultPlanTarget(plan Plan) planTarget {
	return planTarget{Plan: plan}
}

func (s *Service) resolvePlanTarget(_ context.Context, _ ApplySubscriptionRequest, plan Plan) (planTarget, error) {
	return defaultPlanTarget(plan), nil
}

func (s *Service) RegisterPlanPeriod(ctx context.Context, period PlanPeriod) error {
	return ErrPlanPeriodRetired
}

func (s *Service) ListPlanPeriods(ctx context.Context, planID string) ([]PlanPeriod, error) {
	if _, err := s.GetPlan(ctx, planID); err != nil {
		return nil, err
	}
	return []PlanPeriod{}, nil
}

func (s *Service) ListPlanPeriodSets(ctx context.Context, planID string) ([]SetPlanPeriod, error) {
	if _, err := s.GetPlan(ctx, planID); err != nil {
		return nil, err
	}
	return []SetPlanPeriod{}, nil
}

func (s *Service) readySetPlanTargetID(ctx context.Context, target planTarget, setID string) (int, error) {
	return s.readySetPlanID(ctx, target.Plan.ID, setID)
}
