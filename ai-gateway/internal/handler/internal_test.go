package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"git.woa.com/wisp/mono/ai-gateway/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

var internalTestEncKey = []byte("01234567890123456789012345678901")

func setupInternalTest(t *testing.T) (*gin.Engine, *InternalHandler, *adminMockUserRepo, *adminMockPlanRepo) {
	t.Helper()

	gin.SetMode(gin.TestMode)

	userRepo := &adminMockUserRepo{}
	planRepo := &adminMockPlanRepo{}
	subRepo := &adminMockSubRepo{}

	userSvc := service.NewUserService(userRepo, nil, internalTestEncKey)
	planSvc := service.NewPlanService(planRepo)
	subSvc := service.NewSubscriptionService(subRepo, planRepo, nil)

	r := gin.New()
	h := NewInternalHandler(userSvc, planSvc, subSvc)
	return r, h, userRepo, planRepo
}

func TestInternalEnsureUserCreatesUser(t *testing.T) {
	r, h, _, _ := setupInternalTest(t)
	r.POST("/api/internal/users/ensure", h.EnsureUser)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/internal/users/ensure", strings.NewReader(`{"user_id":"usr_internal_created","nickname":"Gateway User"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp internalEnsureUserResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Result != service.EnsureUserResultCreated {
		t.Fatalf("expected result %q, got %q", service.EnsureUserResultCreated, resp.Result)
	}
	if resp.UserID != "usr_internal_created" {
		t.Fatalf("expected user_id usr_internal_created, got %q", resp.UserID)
	}
}

func TestInternalEnsureUserReturnsAlreadyExistsForSameUserID(t *testing.T) {
	r, h, userRepo, _ := setupInternalTest(t)
	r.POST("/api/internal/users/ensure", h.EnsureUser)

	userRepo.users = []model.User{{
		UserID:   "usr_internal_existing",
		Nickname: "Existing User",
		Status:   model.UserStatusActive,
	}}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/internal/users/ensure", strings.NewReader(`{"user_id":"usr_internal_existing","nickname":"Ignored"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	var resp internalEnsureUserResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Result != service.EnsureUserResultAlreadyExists {
		t.Fatalf("expected result %q, got %q", service.EnsureUserResultAlreadyExists, resp.Result)
	}
	if resp.UserID != "usr_internal_existing" {
		t.Fatalf("expected user_id usr_internal_existing, got %q", resp.UserID)
	}
}

func TestInternalApplySubscriptionCreatesUserViaSharedBootstrapPath(t *testing.T) {
	r, h, userRepo, planRepo := setupInternalTest(t)
	r.POST("/api/internal/subscriptions/apply", h.ApplySubscription)

	planID := uuid.New()
	planRepo.plans = []model.Plan{{
		ID:            planID,
		Name:          "trial",
		MonthlyTokens: 1000,
		PriceCents:    0,
		IsActive:      true,
		PeriodValue:   1,
		PeriodUnit:    "months",
		CreatedAt:     time.Now(),
	}}

	body := `{"user_id":"usr_apply_bootstrap","plan_id":"` + planID.String() + `","nickname":"Apply User"}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/internal/subscriptions/apply", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body: %s", w.Code, w.Body.String())
	}

	if len(userRepo.users) != 1 {
		t.Fatalf("expected one user to be created, got %d", len(userRepo.users))
	}
	if userRepo.users[0].PhoneMasked == "" {
		t.Fatal("expected apply-subscription-created user to have bootstrap phone fields")
	}
}
