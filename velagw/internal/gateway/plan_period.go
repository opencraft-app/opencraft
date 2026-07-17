package gateway

import (
	"context"
	"fmt"
	"strings"
)

// planTarget identifies the concrete new-api plan materialization for one
// business plan and one approved subscription period.
type planTarget struct {
	Plan        Plan
	PeriodValue int
	PeriodUnit  string
	IsDefault   bool
}

func defaultPlanTarget(plan Plan) planTarget {
	return planTarget{Plan: plan, PeriodValue: plan.PeriodValue, PeriodUnit: normalizePeriodUnit(plan.PeriodUnit), IsDefault: true}
}

func (s *Service) resolvePlanTarget(ctx context.Context, req ApplySubscriptionRequest, plan Plan) (planTarget, error) {
	if req.PeriodStart != nil {
		return planTarget{}, fmt.Errorf("period_start is not supported by new-api admin subscription API")
	}
	value := req.PeriodValue
	unit := normalizePeriodUnit(req.PeriodUnit)
	if value == 0 && strings.TrimSpace(req.PeriodUnit) == "" {
		return defaultPlanTarget(plan), nil
	}
	if value == 0 {
		value = plan.PeriodValue
	}
	if unit == "" {
		unit = normalizePeriodUnit(plan.PeriodUnit)
	}
	if value == plan.PeriodValue && unit == normalizePeriodUnit(plan.PeriodUnit) {
		return defaultPlanTarget(plan), nil
	}
	period, ok, err := s.store.GetPlanPeriod(ctx, plan.ID, value, unit)
	if err != nil {
		return planTarget{}, err
	}
	if !ok {
		return planTarget{}, fmt.Errorf("period variant is not configured for plan %q: %d %s", plan.ID, value, unit)
	}
	return planTarget{Plan: plan, PeriodValue: period.PeriodValue, PeriodUnit: period.PeriodUnit}, nil
}

func (s *Service) RegisterPlanPeriod(ctx context.Context, period PlanPeriod) error {
	period, err := normalizePlanPeriod(period)
	if err != nil {
		return err
	}
	plan, err := s.GetPlan(ctx, period.PlanID)
	if err != nil {
		return err
	}
	if period.PeriodValue == plan.PeriodValue && period.PeriodUnit == normalizePeriodUnit(plan.PeriodUnit) {
		return nil
	}
	if err := s.store.SavePlanPeriod(ctx, period); err != nil {
		return err
	}
	if !plan.IsActive {
		return nil
	}
	sets, err := s.store.ListSets(ctx)
	if err != nil {
		return err
	}
	for _, set := range sets {
		if set.Status != SetStatusActive {
			continue
		}
		if _, ok, err := s.store.GetSetPlanPeriod(ctx, plan.ID, period.PeriodValue, period.PeriodUnit, set.ID); err != nil {
			return err
		} else if ok {
			continue
		}
		if err := s.store.SaveSetPlanPeriod(ctx, SetPlanPeriod{
			PlanID: plan.ID, PeriodValue: period.PeriodValue, PeriodUnit: period.PeriodUnit,
			SetID: set.ID, Status: SetPlanStatusPending,
		}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) ListPlanPeriods(ctx context.Context, planID string) ([]PlanPeriod, error) {
	if _, err := s.GetPlan(ctx, planID); err != nil {
		return nil, err
	}
	return s.store.ListPlanPeriods(ctx, strings.TrimSpace(planID))
}

func (s *Service) ListPlanPeriodSets(ctx context.Context, planID string) ([]SetPlanPeriod, error) {
	if _, err := s.GetPlan(ctx, planID); err != nil {
		return nil, err
	}
	return s.store.ListSetPlanPeriods(ctx, SetPlanPeriodListOptions{PlanID: strings.TrimSpace(planID)})
}

func (s *Service) readySetPlanTargetID(ctx context.Context, target planTarget, setID string) (int, error) {
	if target.IsDefault {
		return s.readySetPlanID(ctx, target.Plan.ID, setID)
	}
	state, ok, err := s.store.GetSetPlanPeriod(ctx, target.Plan.ID, target.PeriodValue, target.PeriodUnit, setID)
	if err != nil {
		return 0, err
	}
	if !ok || state.Status != SetPlanStatusReady || state.UpstreamPlanID <= 0 {
		return 0, ErrPlanNotReady
	}
	return state.UpstreamPlanID, nil
}
