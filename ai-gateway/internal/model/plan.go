package model

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

type Plan struct {
	ID               uuid.UUID      `gorm:"type:uuid;primaryKey" json:"id"`
	Name             string         `gorm:"type:varchar(64);not null" json:"name"`
	MonthlyTokens    int64          `gorm:"not null" json:"monthly_tokens"`
	RateLimits       datatypes.JSON `gorm:"type:json;default:'[]'" json:"rate_limits"`
	AllowedModels    datatypes.JSON `gorm:"type:json;default:'[]'" json:"allowed_models"`
	PriceCents       int            `gorm:"not null" json:"price_cents"`
	TokenMultipliers datatypes.JSON `gorm:"type:json;default:'{}'" json:"token_multipliers"`
	IsActive         bool           `gorm:"default:true;not null" json:"is_active"`
	// PeriodValue 和 PeriodUnit 定义订阅周期，例如 PeriodValue=1, PeriodUnit="months" 表示1个月
	PeriodValue int    `gorm:"not null;default:1" json:"period_value"`
	PeriodUnit  string `gorm:"type:varchar(10);not null;default:'months'" json:"period_unit"`
	CreatedAt   time.Time `gorm:"autoCreateTime" json:"created_at"`
}

func (p *Plan) BeforeCreate(tx *gorm.DB) error {
	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	return nil
}

// RateLimitRule 定义单条限流规则。
type RateLimitRule struct {
	Window      string `json:"window"`       // 窗口格式: "1m", "5h", "1d", "1w", "1M"
	MaxRequests int    `json:"max_requests"` // 窗口内最大请求数
	Label       string `json:"label"`        // 人类可读标签, 如 "每分钟", "5小时"
}

// ParseRateLimits 从 Plan 的 RateLimits JSON 字段解析出规则列表。
func (p *Plan) ParseRateLimits() ([]RateLimitRule, error) {
	if len(p.RateLimits) == 0 {
		return nil, nil
	}
	var rules []RateLimitRule
	if err := json.Unmarshal(p.RateLimits, &rules); err != nil {
		return nil, fmt.Errorf("parse rate_limits: %w", err)
	}
	return rules, nil
}

// WindowToSeconds 将窗口字符串转为秒数。
// 支持: Nm(分钟), Nh(小时), Nd(天), Nw(周), NM(月，按30天算)
func WindowToSeconds(window string) (int64, error) {
	if len(window) < 2 {
		return 0, fmt.Errorf("invalid window format: %s", window)
	}
	unit := window[len(window)-1:]
	numStr := window[:len(window)-1]
	num, err := strconv.ParseInt(numStr, 10, 64)
	if err != nil || num <= 0 {
		return 0, fmt.Errorf("invalid window number: %s", window)
	}

	switch unit {
	case "m":
		return num * 60, nil
	case "h":
		return num * 3600, nil
	case "d":
		return num * 86400, nil
	case "w":
		return num * 7 * 86400, nil
	case "M":
		return num * 30 * 86400, nil
	default:
		return 0, fmt.Errorf("unknown window unit: %s", unit)
	}
}

// AlignedWindowStart 计算当前时间所属的固定窗口起始时间（UTC Unix 秒）。
// 对齐规则：
//   - Nm / Nh → 按自然时间对齐（如 5h → 0:00-5:00, 5:00-10:00...）
//   - 1d / 24h → 每日 00:00 UTC
//   - 1w → 每周一 00:00 UTC
//   - 1M → 每月1日 00:00 UTC
func AlignedWindowStart(window string, now time.Time) (int64, error) {
	now = now.UTC()

	if len(window) < 2 {
		return 0, fmt.Errorf("invalid window format: %s", window)
	}
	unit := window[len(window)-1:]
	numStr := window[:len(window)-1]
	num, err := strconv.ParseInt(numStr, 10, 64)
	if err != nil || num <= 0 {
		return 0, fmt.Errorf("invalid window number: %s", window)
	}

	switch unit {
	case "m":
		// 按 N 分钟对齐：当天零点起算的分钟数 / N 取整
		dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		elapsed := int64(now.Sub(dayStart).Minutes())
		slot := elapsed / num
		return dayStart.Add(time.Duration(slot*num) * time.Minute).Unix(), nil

	case "h":
		// 按 N 小时对齐：当天零点起算的小时数 / N 取整
		dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		elapsed := int64(now.Sub(dayStart).Hours())
		slot := elapsed / num
		return dayStart.Add(time.Duration(slot*num) * time.Hour).Unix(), nil

	case "d":
		// 按天对齐
		dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		return dayStart.Unix(), nil

	case "w":
		// 每周一 00:00 UTC 对齐
		weekday := int(now.Weekday())
		if weekday == 0 {
			weekday = 7 // Sunday → 7
		}
		mondayOffset := weekday - 1
		monday := time.Date(now.Year(), now.Month(), now.Day()-mondayOffset, 0, 0, 0, 0, time.UTC)
		return monday.Unix(), nil

	case "M":
		// 每月1日 00:00 UTC
		monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		return monthStart.Unix(), nil

	default:
		return 0, fmt.Errorf("unknown window unit: %s", unit)
	}
}

// AlignedWindowKey 生成 Redis 限流计数器的 key。
// 格式: rate:{userID}:{window}:{aligned_start_ts}
func AlignedWindowKey(userID, window string, now time.Time) (string, error) {
	start, err := AlignedWindowStart(window, now)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("rate:%s:%s:%d", userID, window, start), nil
}

// ValidateWindowFormat 校验窗口格式是否合法。
func ValidateWindowFormat(window string) error {
	if len(window) < 2 {
		return fmt.Errorf("窗口格式无效: %s", window)
	}
	unit := window[len(window)-1:]
	numStr := window[:len(window)-1]
	num, err := strconv.ParseInt(numStr, 10, 64)
	if err != nil || num <= 0 {
		return fmt.Errorf("窗口数值无效: %s", window)
	}
	validUnits := []string{"m", "h", "d", "w", "M"}
	for _, u := range validUnits {
		if unit == u {
			return nil
		}
	}
	return fmt.Errorf("未知窗口单位: %s (支持: %s)", unit, strings.Join(validUnits, ", "))
}
