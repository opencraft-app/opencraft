package repository

import (
	"fmt"
	"strings"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type UsageRepo interface {
	BatchCreate(logs []model.UsageLog) error
	Create(log *model.UsageLog) error

	// 统计方法
	SumTokensSince(since time.Time) (int64, error)
	CountRequestsSince(since time.Time) (int64, error)
	SumTokensBetween(start, end time.Time) (int64, error)
	CountRequestsBetween(start, end time.Time) (int64, error)
	SumAllConsumedTokens() (int64, error)
	SumConsumedTokensSince(since time.Time) (int64, error)
	DailyTrend(start, end time.Time) ([]DailyTrendPoint, error)
	ModelDistribution(start, end time.Time) ([]ModelDistPoint, error)
	ModelDailyDistribution(start, end time.Time) ([]ModelDailyDistPoint, error)

	// 用户/Provider 用量
	UserDailyUsage(userID uuid.UUID, days int) ([]DailyTrendPoint, error)
	UserTotalUsage(userID uuid.UUID, since time.Time) (int64, int64, error) // tokens, requests
	ListUserUsageLogs(userID uuid.UUID, start, end time.Time, offset, limit int) ([]UserUsageLogRecord, int64, UserUsageLogSummary, error)
	SubscriptionModelUsage(subscriptionID uuid.UUID) ([]ModelDistPoint, error)
	TopUsersByTokens(since time.Time, limit int) ([]UserUsagePoint, error)
	ProviderRequestCount(providerID uuid.UUID) (int64, error)
	ProviderLastUsedAt(providerID uuid.UUID) (*time.Time, error)
}

type DailyTrendPoint struct {
	Date              string `json:"date"`
	TotalTokens       int64  `json:"total_tokens"`
	TotalInteractions int64  `json:"total_interactions"`
}

type ModelDistPoint struct {
	Model    string `json:"model"`
	Tokens   int64  `json:"tokens"`
	Requests int64  `json:"requests"`
}

type ModelDailyDistPoint struct {
	Date     string  `json:"date"`
	Model    string  `json:"model"`
	Tokens   int64   `json:"tokens"`
	Requests int64   `json:"requests"`
	Share    float64 `json:"share"`
}

type UserUsagePoint struct {
	UserID            uuid.UUID `json:"user_id"`
	TotalTokens       int64     `json:"total_tokens"`
	TotalInteractions int64     `json:"total_interactions"`
	TotalRequests     int64     `json:"-"`
}

type UserUsageLogRecord struct {
	CreatedAt        time.Time `json:"created_at"`
	Model            string    `json:"model"`
	PromptTokens     int       `json:"prompt_tokens"`
	CompletionTokens int       `json:"completion_tokens"`
	TotalTokens      int       `json:"total_tokens"`
	RequestID        string    `json:"request_id"`
	StatusCode       int       `json:"status_code"`
	LatencyMs        int       `json:"latency_ms"`
	Source           string    `json:"source"`
}

type UserUsageLogSummary struct {
	TotalRequests int64 `json:"total_requests"`
	TotalTokens   int64 `json:"total_tokens"`
}

type usageRepo struct {
	db *gorm.DB
}

func NewUsageRepo(db *gorm.DB) UsageRepo {
	return &usageRepo{db: db}
}

func (r *usageRepo) Create(log *model.UsageLog) error {
	return r.db.Create(log).Error
}

func (r *usageRepo) BatchCreate(logs []model.UsageLog) error {
	if len(logs) == 0 {
		return nil
	}
	return r.db.Create(&logs).Error
}

func (r *usageRepo) SumTokensSince(since time.Time) (int64, error) {
	var total int64
	err := r.db.Model(&model.UsageLog{}).Where("created_at >= ?", since).
		Select("COALESCE(SUM(total_tokens), 0)").Scan(&total).Error
	return total, err
}

func (r *usageRepo) CountRequestsSince(since time.Time) (int64, error) {
	var count int64
	err := r.db.Model(&model.UsageLog{}).Where("created_at >= ?", since).Count(&count).Error
	return count, err
}

func (r *usageRepo) SumTokensBetween(start, end time.Time) (int64, error) {
	var total int64
	err := r.db.Model(&model.UsageLog{}).Where("created_at >= ? AND created_at < ?", start, end).
		Select("COALESCE(SUM(total_tokens), 0)").Scan(&total).Error
	return total, err
}

func (r *usageRepo) CountRequestsBetween(start, end time.Time) (int64, error) {
	var count int64
	err := r.db.Model(&model.UsageLog{}).Where("created_at >= ? AND created_at < ?", start, end).Count(&count).Error
	return count, err
}

func (r *usageRepo) SumAllConsumedTokens() (int64, error) {
	var total int64
	err := r.db.Model(&model.UsageLog{}).Select("COALESCE(SUM(total_tokens), 0)").Scan(&total).Error
	return total, err
}

func (r *usageRepo) SumConsumedTokensSince(since time.Time) (int64, error) {
	return r.SumTokensSince(since)
}

func (r *usageRepo) DailyTrend(start, end time.Time) ([]DailyTrendPoint, error) {
	var results []DailyTrendPoint
	err := r.db.Model(&model.UsageLog{}).
		Where("created_at >= ? AND created_at < ?", start, end).
		Select("DATE(created_at) as date, COALESCE(SUM(total_tokens), 0) as total_tokens, COUNT(*) as total_interactions").
		Group("DATE(created_at)").
		Order("date ASC").
		Scan(&results).Error
	if err != nil {
		return nil, err
	}
	return fillDailyTrendGaps(start, end, results), nil
}

func (r *usageRepo) ModelDistribution(start, end time.Time) ([]ModelDistPoint, error) {
	var results []ModelDistPoint
	err := r.db.Model(&model.UsageLog{}).
		Where("created_at >= ? AND created_at < ?", start, end).
		Select("model, COALESCE(SUM(total_tokens), 0) as tokens, COUNT(*) as requests").
		Group("model").
		Order("tokens DESC").
		Scan(&results).Error
	return results, err
}

func (r *usageRepo) ModelDailyDistribution(start, end time.Time) ([]ModelDailyDistPoint, error) {
	var results []ModelDailyDistPoint
	err := r.db.Model(&model.UsageLog{}).
		Where("created_at >= ? AND created_at < ?", start, end).
		Select("DATE(created_at) as date, model, COALESCE(SUM(total_tokens), 0) as tokens, COUNT(*) as requests").
		Group("DATE(created_at), model").
		Order("date ASC, tokens DESC").
		Scan(&results).Error
	return results, err
}

func (r *usageRepo) UserDailyUsage(userID uuid.UUID, days int) ([]DailyTrendPoint, error) {
	now := time.Now().UTC()
	since := now.AddDate(0, 0, -days)
	var results []DailyTrendPoint
	err := r.db.Model(&model.UsageLog{}).
		Where("user_id = ? AND created_at >= ?", userID, since).
		Select("DATE(created_at) as date, COALESCE(SUM(total_tokens), 0) as total_tokens, COUNT(*) as total_interactions").
		Group("DATE(created_at)").
		Order("date ASC").
		Scan(&results).Error
	if err != nil {
		return nil, err
	}
	return fillDailyTrendGaps(since, now, results), nil
}

func (r *usageRepo) UserTotalUsage(userID uuid.UUID, since time.Time) (int64, int64, error) {
	var tokens int64
	var requests int64
	err := r.db.Model(&model.UsageLog{}).
		Where("user_id = ? AND created_at >= ?", userID, since).
		Select("COALESCE(SUM(total_tokens), 0)").Scan(&tokens).Error
	if err != nil {
		return 0, 0, err
	}
	err = r.db.Model(&model.UsageLog{}).
		Where("user_id = ? AND created_at >= ?", userID, since).Count(&requests).Error
	return tokens, requests, err
}

func (r *usageRepo) ListUserUsageLogs(userID uuid.UUID, start, end time.Time, offset, limit int) ([]UserUsageLogRecord, int64, UserUsageLogSummary, error) {
	baseQuery := r.db.Model(&model.UsageLog{}).
		Where("user_id = ? AND created_at >= ? AND created_at < ?", userID, start, end)

	var total int64
	if err := baseQuery.Count(&total).Error; err != nil {
		return nil, 0, UserUsageLogSummary{}, err
	}

	var totalTokens int64
	if err := baseQuery.Select("COALESCE(SUM(total_tokens), 0)").Scan(&totalTokens).Error; err != nil {
		return nil, 0, UserUsageLogSummary{}, err
	}

	var items []UserUsageLogRecord
	if err := baseQuery.
		Select("created_at, model, prompt_tokens, completion_tokens, total_tokens, request_id, status_code, latency_ms, source").
		Order("created_at DESC").
		Offset(offset).
		Limit(limit).
		Scan(&items).Error; err != nil {
		return nil, 0, UserUsageLogSummary{}, err
	}

	return items, total, UserUsageLogSummary{
		TotalRequests: total,
		TotalTokens:   totalTokens,
	}, nil
}

func (r *usageRepo) SubscriptionModelUsage(subscriptionID uuid.UUID) ([]ModelDistPoint, error) {
	var results []ModelDistPoint
	err := r.db.Model(&model.UsageLog{}).
		Where("subscription_id = ?", subscriptionID).
		Select("model, COALESCE(SUM(total_tokens), 0) as tokens, COUNT(*) as requests").
		Group("model").
		Order("tokens DESC").
		Scan(&results).Error
	return results, err
}

func (r *usageRepo) TopUsersByTokens(since time.Time, limit int) ([]UserUsagePoint, error) {
	var results []UserUsagePoint
	query := r.db.Model(&model.UsageLog{}).
		Where("created_at >= ?", since).
		Select("user_id, COALESCE(SUM(total_tokens), 0) as total_tokens, COUNT(*) as total_interactions, COUNT(*) as total_requests").
		Group("user_id").
		Order("total_tokens DESC")
	if limit > 0 {
		query = query.Limit(limit)
	}
	err := query.Scan(&results).Error
	return results, err
}

func (r *usageRepo) ProviderRequestCount(providerID uuid.UUID) (int64, error) {
	var count int64
	err := r.db.Model(&model.UsageLog{}).Where("provider_id = ?", providerID).Count(&count).Error
	return count, err
}

func (r *usageRepo) ProviderLastUsedAt(providerID uuid.UUID) (*time.Time, error) {
	var log model.UsageLog
	err := r.db.Where("provider_id = ?", providerID).Order("created_at DESC").First(&log).Error
	if err != nil {
		return nil, err
	}
	return &log.CreatedAt, nil
}

func fillDailyTrendGaps(start, end time.Time, points []DailyTrendPoint) []DailyTrendPoint {
	if end.Before(start) {
		return []DailyTrendPoint{}
	}

	indexed := make(map[string]DailyTrendPoint, len(points))
	for _, point := range points {
		dateKey, err := normalizeDateKey(point.Date)
		if err != nil {
			continue
		}
		point.Date = dateKey
		indexed[dateKey] = point
	}

	startDay := time.Date(start.UTC().Year(), start.UTC().Month(), start.UTC().Day(), 0, 0, 0, 0, time.UTC)
	lastIncluded := end.Add(-time.Nanosecond).UTC()
	lastDay := time.Date(lastIncluded.Year(), lastIncluded.Month(), lastIncluded.Day(), 0, 0, 0, 0, time.UTC)
	if shouldSkipLeadingPartialStartDay(start.UTC(), startDay, lastDay, indexed) {
		startDay = startDay.AddDate(0, 0, 1)
	}
	if lastDay.Before(startDay) {
		return []DailyTrendPoint{}
	}

	filled := make([]DailyTrendPoint, 0, int(lastDay.Sub(startDay).Hours()/24)+1)
	for day := startDay; !day.After(lastDay); day = day.AddDate(0, 0, 1) {
		dateKey := day.Format("2006-01-02")
		if point, ok := indexed[dateKey]; ok {
			point.Date = dateKey
			filled = append(filled, point)
			continue
		}
		filled = append(filled, DailyTrendPoint{
			Date:              dateKey,
			TotalTokens:       0,
			TotalInteractions: 0,
		})
	}

	return filled
}

func shouldSkipLeadingPartialStartDay(start, startDay, lastDay time.Time, indexed map[string]DailyTrendPoint) bool {
	if start.Equal(startDay) {
		return false
	}
	if !lastDay.After(startDay) {
		return false
	}

	_, hasData := indexed[startDay.Format("2006-01-02")]
	return !hasData
}

func normalizeDateKey(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", fmt.Errorf("empty date value")
	}

	layouts := []string{
		"2006-01-02",
		time.RFC3339,
		"2006-01-02 15:04:05",
		"2006-01-02 15:04:05 -0700 MST",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UTC().Format("2006-01-02"), nil
		}
	}

	if len(trimmed) >= 10 {
		return trimmed[:10], nil
	}

	return "", fmt.Errorf("unsupported date format: %q", value)
}
