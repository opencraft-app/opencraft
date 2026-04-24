package gateway

import (
	"net/http/httptest"
	"testing"

	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func setupContextTest() (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	return c, w
}

func TestGetUserFromContext_ReturnsUser(t *testing.T) {
	c, _ := setupContextTest()
	user := &model.User{ID: uuid.New(), Status: "active"}
	middleware.SetUserContext(c, user, &model.Subscription{ID: uuid.New()}, &model.Plan{ID: uuid.New()})

	got := middleware.GetUserFromContext(c)
	if got == nil {
		t.Fatal("expected user, got nil")
	}
	if got.ID != user.ID {
		t.Errorf("expected user ID %s, got %s", user.ID, got.ID)
	}
}

func TestGetUserFromContext_ReturnsNilWhenNotSet(t *testing.T) {
	c, _ := setupContextTest()
	got := middleware.GetUserFromContext(c)
	if got != nil {
		t.Errorf("expected nil, got %v", got)
	}
}

func TestGetSubscriptionFromContext_ReturnsSub(t *testing.T) {
	c, _ := setupContextTest()
	sub := &model.Subscription{ID: uuid.New()}
	middleware.SetUserContext(c, &model.User{ID: uuid.New()}, sub, &model.Plan{ID: uuid.New()})

	got := middleware.GetSubscriptionFromContext(c)
	if got == nil {
		t.Fatal("expected sub, got nil")
	}
	if got.ID != sub.ID {
		t.Errorf("expected sub ID %s, got %s", sub.ID, got.ID)
	}
}

func TestGetSubscriptionFromContext_ReturnsNilWhenNotSet(t *testing.T) {
	c, _ := setupContextTest()
	got := middleware.GetSubscriptionFromContext(c)
	if got != nil {
		t.Errorf("expected nil, got %v", got)
	}
}

func TestGetPlanFromContext_ReturnsPlan(t *testing.T) {
	c, _ := setupContextTest()
	plan := &model.Plan{ID: uuid.New(), Name: "pro"}
	middleware.SetUserContext(c, &model.User{ID: uuid.New()}, &model.Subscription{ID: uuid.New()}, plan)

	got := middleware.GetPlanFromContext(c)
	if got == nil {
		t.Fatal("expected plan, got nil")
	}
	if got.Name != "pro" {
		t.Errorf("expected plan name 'pro', got %s", got.Name)
	}
}

func TestGetPlanFromContext_ReturnsNilWhenNotSet(t *testing.T) {
	c, _ := setupContextTest()
	got := middleware.GetPlanFromContext(c)
	if got != nil {
		t.Errorf("expected nil, got %v", got)
	}
}

func TestSetUserContext_SetsAllKeys(t *testing.T) {
	c, _ := setupContextTest()
	user := &model.User{ID: uuid.New()}
	sub := &model.Subscription{ID: uuid.New()}
	plan := &model.Plan{ID: uuid.New()}

	middleware.SetUserContext(c, user, sub, plan)

	if v, ok := c.Get(middleware.ContextKeyUser); !ok || v.(*model.User).ID != user.ID {
		t.Error("ContextKeyUser not set correctly")
	}
	if v, ok := c.Get(middleware.ContextKeySubscription); !ok || v.(*model.Subscription).ID != sub.ID {
		t.Error("ContextKeySubscription not set correctly")
	}
	if v, ok := c.Get(middleware.ContextKeyPlan); !ok || v.(*model.Plan).ID != plan.ID {
		t.Error("ContextKeyPlan not set correctly")
	}
}
