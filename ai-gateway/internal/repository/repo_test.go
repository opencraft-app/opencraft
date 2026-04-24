package repository

import (
	"testing"
	"time"

	"git.woa.com/wisp/mono/ai-gateway/internal/model"
	"github.com/DATA-DOG/go-sqlmock"
	"github.com/google/uuid"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

func setupMockDB(t *testing.T) (*gorm.DB, sqlmock.Sqlmock) {
	t.Helper()
	sqlDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create sqlmock: %v", err)
	}
	gormDB, err := gorm.Open(mysql.New(mysql.Config{
		Conn:                      sqlDB,
		SkipInitializeWithVersion: true,
	}), &gorm.Config{})
	if err != nil {
		t.Fatalf("failed to open gorm: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	return gormDB, mock
}

// --- SubscriptionRepo Tests ---

func TestDeductTokens_Success(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewSubscriptionRepo(db)

	subID := uuid.New()

	mock.ExpectBegin()
	mock.ExpectExec("UPDATE `subscriptions` SET").
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), subID, int64(5000), model.SubscriptionStatusActive).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	err := repo.DeductTokens(subID, 5000)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestDeductTokens_InsufficientBalance(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewSubscriptionRepo(db)

	subID := uuid.New()

	mock.ExpectBegin()
	mock.ExpectExec("UPDATE `subscriptions` SET").
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), subID, int64(6000), model.SubscriptionStatusActive).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectCommit()

	err := repo.DeductTokens(subID, 6000)
	if err != model.ErrQuotaExceeded {
		t.Fatalf("expected ErrQuotaExceeded, got %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// --- ProviderRepo Tests ---

func TestSelectBest_Found(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewProviderRepo(db)

	providerID := uuid.New()
	rows := sqlmock.NewRows([]string{"id", "name", "provider_type", "api_key", "base_url", "total_quota", "used_quota", "status", "priority"}).
		AddRow(providerID, "openai-main", "openai", "encrypted-key", "https://api.openai.com", 1000000, 500000, "active", 10)

	mock.ExpectQuery("SELECT \\* FROM `providers` WHERE").
		WithArgs("openai", model.ProviderStatusActive, 1).
		WillReturnRows(rows)

	provider, err := repo.SelectBest("openai")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if provider.ID != providerID {
		t.Errorf("expected provider ID %v, got %v", providerID, provider.ID)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestSelectBest_NoneAvailable(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewProviderRepo(db)

	rows := sqlmock.NewRows([]string{"id", "name", "provider_type", "api_key", "base_url", "total_quota", "used_quota", "status", "priority"})

	mock.ExpectQuery("SELECT \\* FROM `providers` WHERE").
		WithArgs("deepseek", model.ProviderStatusActive, 1).
		WillReturnRows(rows)

	_, err := repo.SelectBest("deepseek")
	if err != model.ErrProviderUnavailable {
		t.Fatalf("expected ErrProviderUnavailable, got %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

// --- ApiKeyRepo Tests ---

func TestGetByHash_Found(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewApiKeyRepo(db)

	keyID := uuid.New()
	userID := uuid.New()
	rows := sqlmock.NewRows([]string{"id", "user_id", "key_hash", "key_prefix", "name", "is_active"}).
		AddRow(keyID, userID, "sha256hash", "sk-xxxx", "my-key", true)

	mock.ExpectQuery("SELECT \\* FROM `api_keys` WHERE").
		WithArgs("sha256hash", true, 1).
		WillReturnRows(rows)

	key, err := repo.GetByHash("sha256hash")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if key.ID != keyID {
		t.Errorf("expected key ID %v, got %v", keyID, key.ID)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestGetByHash_NotFound(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewApiKeyRepo(db)

	rows := sqlmock.NewRows([]string{"id", "user_id", "key_hash", "key_prefix", "name", "is_active"})

	mock.ExpectQuery("SELECT \\* FROM `api_keys` WHERE").
		WithArgs("nonexistent-hash", true, 1).
		WillReturnRows(rows)

	_, err := repo.GetByHash("nonexistent-hash")
	if err != model.ErrApiKeyNotFound {
		t.Fatalf("expected ErrApiKeyNotFound, got %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestSelectBestForModel_Found(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewProviderRepo(db)

	providerID := uuid.New()
	rows := sqlmock.NewRows([]string{"id", "name", "provider_type", "api_key", "base_url", "total_quota", "used_quota", "status", "priority", "supported_models"}).
		AddRow(providerID, "deepseek-main", "deepseek", "encrypted-key", "https://api.deepseek.com", 1000000, 1000, "active", 20, `["deepseek-chat","deepseek-reasoner"]`)

	mock.ExpectQuery("SELECT \\* FROM `providers` WHERE").
		WithArgs(model.ProviderStatusActive, "deepseek-chat", 1).
		WillReturnRows(rows)

	provider, err := repo.SelectBestForModel("deepseek-chat")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if provider.ID != providerID {
		t.Errorf("expected provider ID %v, got %v", providerID, provider.ID)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestRuntimeConfigRepo_UsesKeyColumn(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewRuntimeConfigRepo(db)

	rows := sqlmock.NewRows([]string{"key", "value", "updated_at"}).
		AddRow("feature_flags", `{"enabled":true}`, time.Date(2026, 3, 24, 0, 0, 0, 0, time.UTC))

	mock.ExpectQuery("SELECT \\* FROM `runtime_configs` WHERE `key` = \\?").
		WithArgs("feature_flags", 1).
		WillReturnRows(rows)

	cfg, err := repo.Get("feature_flags")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if cfg == nil || cfg.Key != "feature_flags" {
		t.Fatalf("expected feature_flags runtime config, got %#v", cfg)
	}

	mock.ExpectBegin()
	mock.ExpectExec("INSERT INTO `runtime_configs`").
		WithArgs("feature_flags", sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()

	if err := repo.Upsert("feature_flags", []byte(`{"enabled":false}`)); err != nil {
		t.Fatalf("expected no error from Upsert, got %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestUsageRepo_DailyTrend_FillsMissingDatesWithZero(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewUsageRepo(db)

	start := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 3, 29, 0, 0, 0, 0, time.UTC)

	rows := sqlmock.NewRows([]string{"date", "total_tokens", "total_interactions"}).
		AddRow("2026-03-26", int64(120), int64(3)).
		AddRow("2026-03-28", int64(80), int64(2))

	mock.ExpectQuery("SELECT .*DATE\\(created_at\\) as date, COALESCE\\(SUM\\(total_tokens\\), 0\\) as total_tokens, COUNT\\(\\*\\) as total_interactions FROM .*usage_logs.*GROUP BY DATE\\(created_at\\).*ORDER BY date ASC").
		WithArgs(start, end).
		WillReturnRows(rows)

	result, err := repo.DailyTrend(start, end)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if len(result) != 4 {
		t.Fatalf("expected 4 daily points, got %d: %#v", len(result), result)
	}

	if result[0].Date != "2026-03-25" || result[0].TotalInteractions != 0 || result[0].TotalTokens != 0 {
		t.Fatalf("expected 2026-03-25 to be zero-filled, got %#v", result[0])
	}
	if result[1].Date != "2026-03-26" || result[1].TotalInteractions != 3 || result[1].TotalTokens != 120 {
		t.Fatalf("expected 2026-03-26 to preserve values, got %#v", result[1])
	}
	if result[2].Date != "2026-03-27" || result[2].TotalInteractions != 0 || result[2].TotalTokens != 0 {
		t.Fatalf("expected 2026-03-27 to be zero-filled, got %#v", result[2])
	}
	if result[3].Date != "2026-03-28" || result[3].TotalInteractions != 2 || result[3].TotalTokens != 80 {
		t.Fatalf("expected 2026-03-28 to preserve values, got %#v", result[3])
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestUsageRepo_ModelDailyDistribution_GroupsByDateAndModel(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewUsageRepo(db)

	start := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 3, 29, 0, 0, 0, 0, time.UTC)

	rows := sqlmock.NewRows([]string{"date", "model", "tokens", "requests"}).
		AddRow("2026-03-26", "deepseek-r1", int64(120), int64(3)).
		AddRow("2026-03-26", "gpt-4o", int64(80), int64(2)).
		AddRow("2026-03-28", "deepseek-r1", int64(20), int64(1))

	mock.ExpectQuery("SELECT .*DATE\\(created_at\\) as date, model, COALESCE\\(SUM\\(total_tokens\\), 0\\) as tokens, COUNT\\(\\*\\) as requests FROM .*usage_logs.*GROUP BY DATE\\(created_at\\), model.*ORDER BY date ASC, tokens DESC").
		WithArgs(start, end).
		WillReturnRows(rows)

	result, err := repo.ModelDailyDistribution(start, end)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	expected := []ModelDailyDistPoint{
		{Date: "2026-03-26", Model: "deepseek-r1", Tokens: 120, Requests: 3},
		{Date: "2026-03-26", Model: "gpt-4o", Tokens: 80, Requests: 2},
		{Date: "2026-03-28", Model: "deepseek-r1", Tokens: 20, Requests: 1},
	}
	if len(result) != len(expected) {
		t.Fatalf("expected %d rows, got %d: %#v", len(expected), len(result), result)
	}
	for i := range expected {
		if result[i] != expected[i] {
			t.Fatalf("row %d mismatch: expected %#v got %#v", i, expected[i], result[i])
		}
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestUsageRepo_UserDailyUsage_FillsMissingDatesWithZero(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewUsageRepo(db)

	userID := uuid.New()
	now := time.Now().UTC()
	endDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	sinceDay := endDay.AddDate(0, 0, -4)

	rows := sqlmock.NewRows([]string{"date", "total_tokens", "total_interactions"}).
		AddRow(sinceDay.AddDate(0, 0, 1).Format("2006-01-02"), int64(42), int64(1)).
		AddRow(sinceDay.AddDate(0, 0, 3).Format("2006-01-02"), int64(18), int64(4))

	mock.ExpectQuery("SELECT .*DATE\\(created_at\\) as date, COALESCE\\(SUM\\(total_tokens\\), 0\\) as total_tokens, COUNT\\(\\*\\) as total_interactions FROM .*usage_logs.*GROUP BY DATE\\(created_at\\).*ORDER BY date ASC").
		WithArgs(userID, sqlmock.AnyArg()).
		WillReturnRows(rows)

	result, err := repo.UserDailyUsage(userID, 4)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if len(result) != 4 {
		t.Fatalf("expected 4 daily points without an empty leading partial day, got %d: %#v", len(result), result)
	}

	if result[0].Date != sinceDay.AddDate(0, 0, 1).Format("2006-01-02") || result[0].TotalInteractions != 1 || result[0].TotalTokens != 42 {
		t.Fatalf("expected first returned day to preserve values, got %#v", result[0])
	}
	if result[1].Date != sinceDay.AddDate(0, 0, 2).Format("2006-01-02") || result[1].TotalInteractions != 0 || result[1].TotalTokens != 0 {
		t.Fatalf("expected middle day to be zero-filled, got %#v", result[1])
	}
	if result[2].Date != sinceDay.AddDate(0, 0, 3).Format("2006-01-02") || result[2].TotalInteractions != 4 || result[2].TotalTokens != 18 {
		t.Fatalf("expected third returned day to preserve values, got %#v", result[2])
	}
	if result[3].Date != sinceDay.AddDate(0, 0, 4).Format("2006-01-02") || result[3].TotalInteractions != 0 || result[3].TotalTokens != 0 {
		t.Fatalf("expected last day to be zero-filled, got %#v", result[3])
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestFillDailyTrendGaps_SkipsEmptyLeadingPartialStartDay(t *testing.T) {
	start := time.Date(2026, 3, 25, 12, 0, 0, 0, time.UTC)
	end := time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)

	result := fillDailyTrendGaps(start, end, []DailyTrendPoint{
		{Date: "2026-03-27", TotalTokens: 120, TotalInteractions: 3},
		{Date: "2026-04-01", TotalTokens: 80, TotalInteractions: 2},
	})

	if len(result) != 7 {
		t.Fatalf("expected 7 daily points for rolling 7d window, got %d: %#v", len(result), result)
	}
	if result[0].Date != "2026-03-26" {
		t.Fatalf("expected first bucket to start from 2026-03-26, got %#v", result[0])
	}
	if result[len(result)-1].Date != "2026-04-01" {
		t.Fatalf("expected last bucket to include 2026-04-01, got %#v", result[len(result)-1])
	}
}

func TestFillDailyTrendGaps_PreservesPartialStartDayWhenDataExists(t *testing.T) {
	start := time.Date(2026, 3, 25, 12, 0, 0, 0, time.UTC)
	end := time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)

	result := fillDailyTrendGaps(start, end, []DailyTrendPoint{
		{Date: "2026-03-25", TotalTokens: 33, TotalInteractions: 1},
		{Date: "2026-04-01", TotalTokens: 80, TotalInteractions: 2},
	})

	if len(result) != 8 {
		t.Fatalf("expected partial start day with data to be preserved, got %d: %#v", len(result), result)
	}
	if result[0].Date != "2026-03-25" || result[0].TotalTokens != 33 {
		t.Fatalf("expected first bucket to preserve partial start day data, got %#v", result[0])
	}
}

func TestUsageRepo_ListUserUsageLogs_ReturnsItemsSummaryAndPagination(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewUsageRepo(db)

	userID := uuid.New()
	start := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)

	mock.ExpectQuery("SELECT count\\(\\*\\) FROM .*usage_logs.*user_id = .*created_at >= .*created_at < .*").
		WithArgs(userID, start, end).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(2))

	mock.ExpectQuery("SELECT COALESCE\\(SUM\\(total_tokens\\), 0\\) FROM .*usage_logs.*user_id = .*created_at >= .*created_at < .*").
		WithArgs(userID, start, end).
		WillReturnRows(sqlmock.NewRows([]string{"total"}).AddRow(579))

	rows := sqlmock.NewRows([]string{
		"created_at", "model", "prompt_tokens", "completion_tokens", "total_tokens",
		"request_id", "status_code", "latency_ms", "source",
	}).
		AddRow(time.Date(2026, 3, 31, 12, 30, 0, 0, time.UTC), "gpt-4.1", 120, 80, 200, "req_1", 200, 1234, "api").
		AddRow(time.Date(2026, 3, 30, 10, 15, 0, 0, time.UTC), "gpt-4o", 200, 179, 379, "req_2", 500, 2456, "cache")

	mock.ExpectQuery("SELECT .*created_at.*model.*prompt_tokens.*completion_tokens.*total_tokens.*request_id.*status_code.*latency_ms.*source FROM .*usage_logs.*user_id = .*created_at >= .*created_at < .*ORDER BY created_at DESC LIMIT .*").
		WithArgs(userID, start, end, 20).
		WillReturnRows(rows)

	items, total, summary, err := repo.ListUserUsageLogs(userID, start, end, 0, 20)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if total != 2 {
		t.Fatalf("expected total=2, got %d", total)
	}
	if summary.TotalRequests != 2 {
		t.Fatalf("expected summary requests=2, got %d", summary.TotalRequests)
	}
	if summary.TotalTokens != 579 {
		t.Fatalf("expected summary tokens=579, got %d", summary.TotalTokens)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}
	if items[0].RequestID != "req_1" || items[0].Model != "gpt-4.1" {
		t.Fatalf("expected first item to preserve descending order, got %+v", items[0])
	}
	if items[1].StatusCode != 500 || items[1].Source != "cache" {
		t.Fatalf("expected second item to preserve technical fields, got %+v", items[1])
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestApiKeyRepo_ListAllWithUsers_SearchByUserExternalID(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewApiKeyRepo(db)

	rows := sqlmock.NewRows([]string{
		"id", "user_id", "key_hash", "key_prefix", "name", "is_active", "created_at",
		"user_user_id", "user_phone", "user_nickname",
	}).AddRow(
		uuid.New(), uuid.New(), "hash", "sk-test", "default", true, time.Now(),
		"ext-001", "138****8000", "张三",
	)

	mock.ExpectQuery("SELECT count\\(\\*\\) FROM `api_keys` LEFT JOIN users ON users.id = api_keys.user_id WHERE .*users.external_uid LIKE.*").
		WithArgs("%ext-001%", "%ext-001%", "%ext-001%", "%ext-001%", "%ext-001%", "%ext-001%").
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery("SELECT api_keys\\.\\*, users.id as user_user_id, users.phone_masked as user_phone, users.nickname as user_nickname FROM `api_keys` LEFT JOIN users ON users.id = api_keys.user_id WHERE .*users.external_uid LIKE.* ORDER BY api_keys.created_at DESC LIMIT \\?").
		WithArgs("%ext-001%", "%ext-001%", "%ext-001%", "%ext-001%", "%ext-001%", "%ext-001%", 20).
		WillReturnRows(rows)

	results, total, err := repo.ListAllWithUsers(0, 20, "ext-001", "")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if total != 1 {
		t.Fatalf("expected total=1, got %d", total)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if results[0].UserUserID != "ext-001" {
		t.Fatalf("expected external uid ext-001, got %q", results[0].UserUserID)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestApiKeyRepo_ListAllWithUsers_FilterByActiveStatus(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewApiKeyRepo(db)

	rows := sqlmock.NewRows([]string{
		"id", "user_id", "key_hash", "key_prefix", "name", "is_active", "created_at",
		"user_user_id", "user_phone", "user_nickname",
	}).AddRow(
		uuid.New(), uuid.New(), "hash", "sk-active", "default", true, time.Now(),
		"usr-active", "138****8000", "张三",
	)

	mock.ExpectQuery("SELECT count\\(\\*\\) FROM `api_keys` LEFT JOIN users ON users.id = api_keys.user_id WHERE api_keys\\.is_active = \\?").
		WithArgs(true).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery("SELECT api_keys\\.\\*, users.id as user_user_id, users.phone_masked as user_phone, users.nickname as user_nickname FROM `api_keys` LEFT JOIN users ON users.id = api_keys.user_id WHERE api_keys\\.is_active = \\? ORDER BY api_keys.created_at DESC LIMIT \\?").
		WithArgs(true, 20).
		WillReturnRows(rows)

	results, total, err := repo.ListAllWithUsers(0, 20, "", "active")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if total != 1 {
		t.Fatalf("expected total=1, got %d", total)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if !results[0].IsActive {
		t.Fatalf("expected active api key result")
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}

func TestUserRepo_ListWithActiveSubscription_FilterByStatus(t *testing.T) {
	db, mock := setupMockDB(t)
	repo := NewUserRepo(db)

	rows := sqlmock.NewRows([]string{
		"id", "external_uid", "phone_masked", "nickname", "status", "created_at", "updated_at",
		"sub_id", "sub_status", "sub_token_balance", "plan_id", "plan_name", "plan_monthly_tokens",
	}).AddRow(
		uuid.New(), "usr-active", "138****8000", "张三", "active", time.Now(), time.Now(),
		uuid.New(), "active", int64(120000), uuid.New(), "Pro", int64(1000000),
	)

	mock.ExpectQuery("SELECT count\\(\\*\\) FROM `users` LEFT JOIN subscriptions subs ON subs.user_id = users.id AND subs.status = \\? LEFT JOIN plans ON plans.id = subs.plan_id WHERE users.status = \\?").
		WithArgs(model.SubscriptionStatusActive, model.UserStatusActive).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery("SELECT users\\.\\*,\\s*subs.id as sub_id,\\s*subs.status as sub_status,\\s*subs.token_balance as sub_token_balance,\\s*plans.id as plan_id,\\s*plans.name as plan_name,\\s*plans.monthly_tokens as plan_monthly_tokens FROM `users` LEFT JOIN subscriptions subs ON subs.user_id = users.id AND subs.status = \\? LEFT JOIN plans ON plans.id = subs.plan_id WHERE users.status = \\? ORDER BY users.created_at DESC LIMIT \\?").
		WithArgs(model.SubscriptionStatusActive, model.UserStatusActive, 20).
		WillReturnRows(rows)

	results, total, err := repo.ListWithActiveSubscription(0, 20, "", model.UserStatusActive)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if total != 1 {
		t.Fatalf("expected total=1, got %d", total)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if results[0].Status != model.UserStatusActive {
		t.Fatalf("expected active user, got %q", results[0].Status)
	}
	if results[0].PlanMonthlyTokens == nil || *results[0].PlanMonthlyTokens != 1000000 {
		t.Fatalf("expected plan monthly tokens 1000000, got %#v", results[0].PlanMonthlyTokens)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unmet expectations: %v", err)
	}
}
