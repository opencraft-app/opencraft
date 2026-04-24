package gateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/middleware"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// billingMockSubRepo returns the subscription set on it for GetByID calls.
type billingMockSubRepo struct {
	sub *model.Subscription
	err error
}

func (m *billingMockSubRepo) Create(sub *model.Subscription) error              { return nil }
func (m *billingMockSubRepo) GetByID(id uuid.UUID) (*model.Subscription, error) { return m.sub, m.err }
func (m *billingMockSubRepo) GetActiveByUserID(userID uuid.UUID) (*model.Subscription, error) {
	return nil, nil
}
func (m *billingMockSubRepo) DeductTokens(subID uuid.UUID, amount int64) error { return nil }
func (m *billingMockSubRepo) DeductTokensToZero(subID uuid.UUID, amount int64) (int64, error) {
	return amount, nil
}
func (m *billingMockSubRepo) RefundTokens(subID uuid.UUID, amount int64) error     { return nil }
func (m *billingMockSubRepo) SetTokenBalance(subID uuid.UUID, balance int64) error { return nil }
func (m *billingMockSubRepo) ExpireOverdue() (int64, error)                        { return 0, nil }
func (m *billingMockSubRepo) ListExpiredUserIDs() ([]uuid.UUID, error)             { return nil, nil }
func (m *billingMockSubRepo) CancelByUserID(userID uuid.UUID) error                { return nil }
func (m *billingMockSubRepo) Update(sub *model.Subscription) error                 { return nil }
func (m *billingMockSubRepo) CountActive() (int64, error)                          { return 0, nil }
func (m *billingMockSubRepo) SumActiveTokenBalance() (int64, error)                { return 0, nil }
func (m *billingMockSubRepo) DB() *gorm.DB                                         { return nil }

func setupBillingRouter(sub *model.Subscription) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()

	r.Use(func(c *gin.Context) {
		if sub != nil {
			c.Set(middleware.ContextKeySubscription, sub)
		}
		c.Next()
	})
	r.Use(middleware.BillingCheck())
	r.GET("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	return r
}

func TestBillingCheck_ValidSubscription(t *testing.T) {
	sub := &model.Subscription{
		ID:           uuid.New(),
		TokenBalance: 10000,
		PeriodEnd:    time.Now().Add(24 * time.Hour),
	}
	r := setupBillingRouter(sub)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestBillingCheck_ZeroBalance(t *testing.T) {
	sub := &model.Subscription{
		ID:           uuid.New(),
		TokenBalance: 0,
		PeriodEnd:    time.Now().Add(24 * time.Hour),
	}
	r := setupBillingRouter(sub)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", w.Code)
	}
}

func TestBillingCheck_NegativeBalance(t *testing.T) {
	sub := &model.Subscription{
		ID:           uuid.New(),
		TokenBalance: -100,
		PeriodEnd:    time.Now().Add(24 * time.Hour),
	}
	r := setupBillingRouter(sub)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", w.Code)
	}
}

func TestBillingCheck_Expired(t *testing.T) {
	sub := &model.Subscription{
		ID:           uuid.New(),
		TokenBalance: 10000,
		PeriodEnd:    time.Now().Add(-1 * time.Hour),
	}
	r := setupBillingRouter(sub)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", w.Code)
	}
}

func TestBillingCheck_NoSubscription(t *testing.T) {
	r := setupBillingRouter(nil)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", w.Code)
	}
}
