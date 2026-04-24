package service

import (
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
)

func TestPlanService_CRUD(t *testing.T) {
	repo := newMockPlanRepo()
	svc := NewPlanService(repo)

	// Create
	plan := &model.Plan{
		Name:          "pro",
		MonthlyTokens: 1000000,
		PriceCents:    9900,
		IsActive:      true,
	}
	err := svc.Create(plan)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// GetByID
	got, err := svc.GetByID(plan.ID)
	if err != nil {
		t.Fatalf("get by id: %v", err)
	}
	if got.Name != "pro" {
		t.Error("wrong name")
	}

	// GetByName
	got, err = svc.GetByName("pro")
	if err != nil {
		t.Fatalf("get by name: %v", err)
	}
	if got.ID != plan.ID {
		t.Error("wrong plan")
	}

	// List
	plans, err := svc.List(true)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(plans) != 1 {
		t.Errorf("expected 1 plan, got %d", len(plans))
	}

	// Update
	plan.PriceCents = 14900
	err = svc.Update(plan)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	got, _ = svc.GetByID(plan.ID)
	if got.PriceCents != 14900 {
		t.Error("price not updated")
	}
}

func TestPlanService_NotFound(t *testing.T) {
	repo := newMockPlanRepo()
	svc := NewPlanService(repo)

	_, err := svc.GetByID(uuid.New())
	if err != model.ErrPlanNotFound {
		t.Errorf("expected ErrPlanNotFound, got %v", err)
	}
}
