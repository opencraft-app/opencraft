package passsync

import (
	"context"
	"fmt"
	"strings"
	"time"

	aisvc "git.woa.com/wisp/mono/ai-gateway/internal/service"
	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type MySQLPassSource struct {
	db *gorm.DB
}

func NewMySQLPassSource(db *gorm.DB) *MySQLPassSource {
	return &MySQLPassSource{db: db}
}

type passRow struct {
	PassID      string    `gorm:"column:pass_id"`
	UserID      string    `gorm:"column:user_id"`
	BundleID    string    `gorm:"column:bundle_id"`
	PlanID      string    `gorm:"column:plan_id"`
	CreatedTime time.Time `gorm:"column:created_time"`
	ExpiredTime time.Time `gorm:"column:expired_time"`
}

func (s *MySQLPassSource) ListPasses(ctx context.Context, opts SyncOptions) ([]PassRecord, error) {
	query := s.db.WithContext(ctx).
		Table("pass AS p").
		Select(`
			p.pass_id AS pass_id,
			p.user_id AS user_id,
			p.bundle_id AS bundle_id,
			COALESCE(NULLIF(TRIM(b.ai_gateway_plan_id), ''), '') AS plan_id,
			COALESCE(p.created_time, p.expired_time) AS created_time,
			p.expired_time AS expired_time
		`).
		Joins("LEFT JOIN bundle AS b ON b.bundle_id = p.bundle_id").
		Where("p.deleted_time IS NULL")

	if trimmed := strings.TrimSpace(opts.UserID); trimmed != "" {
		query = query.Where("p.user_id = ?", trimmed)
	}
	query = query.Order("p.user_id ASC, p.created_time ASC, p.pass_id ASC")
	if opts.Limit > 0 {
		query = query.Limit(opts.Limit)
	}

	var rows []passRow
	if err := query.Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("query ctl passes: %w", err)
	}

	items := make([]PassRecord, 0, len(rows))
	for _, row := range rows {
		items = append(items, PassRecord{
			PassID:      strings.TrimSpace(row.PassID),
			UserID:      strings.TrimSpace(row.UserID),
			BundleID:    strings.TrimSpace(row.BundleID),
			PlanID:      strings.TrimSpace(row.PlanID),
			CreatedTime: row.CreatedTime.UTC(),
			ExpiredTime: row.ExpiredTime.UTC(),
		})
	}
	return items, nil
}

type AIUserManager struct {
	svc *aisvc.UserService
}

func NewAIUserManager(svc *aisvc.UserService) *AIUserManager {
	return &AIUserManager{svc: svc}
}

func (m *AIUserManager) EnsureUser(_ context.Context, userID string, nickname string) (*model.User, string, error) {
	return m.svc.EnsureUser(userID, nickname)
}

func (m *AIUserManager) GetByUserID(_ context.Context, userID string) (*model.User, error) {
	return m.svc.GetByUserID(userID)
}

type AIAPIKeyManager struct {
	svc *aisvc.ApiKeyService
}

func NewAIAPIKeyManager(svc *aisvc.ApiKeyService) *AIAPIKeyManager {
	return &AIAPIKeyManager{svc: svc}
}

func (m *AIAPIKeyManager) ListByUserID(_ context.Context, userID uuid.UUID) ([]model.ApiKey, error) {
	return m.svc.ListByUserID(userID)
}

func (m *AIAPIKeyManager) Generate(_ context.Context, userID uuid.UUID, name string) (*model.ApiKey, error) {
	_, key, err := m.svc.Generate(userID, name)
	return key, err
}

type AIPlanLoader struct {
	svc *aisvc.PlanService
}

func NewAIPlanLoader(svc *aisvc.PlanService) *AIPlanLoader {
	return &AIPlanLoader{svc: svc}
}

func (m *AIPlanLoader) GetByID(_ context.Context, id uuid.UUID) (*model.Plan, error) {
	return m.svc.GetByID(id)
}

type MySQLSubscriptionStore struct {
	db *gorm.DB
}

func NewMySQLSubscriptionStore(db *gorm.DB) *MySQLSubscriptionStore {
	return &MySQLSubscriptionStore{db: db}
}

func (s *MySQLSubscriptionStore) ListByUserID(ctx context.Context, userID uuid.UUID) ([]model.Subscription, error) {
	var subs []model.Subscription
	if err := s.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("period_start ASC, created_at ASC").
		Find(&subs).Error; err != nil {
		return nil, fmt.Errorf("list subscriptions by user: %w", err)
	}
	return subs, nil
}

func (s *MySQLSubscriptionStore) Create(ctx context.Context, sub *model.Subscription) error {
	if err := s.db.WithContext(ctx).Create(sub).Error; err != nil {
		return fmt.Errorf("create subscription: %w", err)
	}
	return nil
}
