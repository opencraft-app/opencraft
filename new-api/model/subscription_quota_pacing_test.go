package model

import (
	"fmt"
	"math"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCalculateSubscriptionQuotaPacingCapReleasesFirstSevenDays(t *testing.T) {
	const (
		cycleStart = int64(1_800_000_000)
		day        = int64(24 * time.Hour / time.Second)
	)
	sub := &UserSubscription{
		AmountTotal:   30_000_000,
		LastResetTime: cycleStart,
		NextResetTime: cycleStart + 30*day,
	}
	plan := &SubscriptionPlan{QuotaResetPeriod: SubscriptionResetMonthly}

	result := calculateSubscriptionQuotaPacingCap(sub, plan, cycleStart, cycleStart)

	require.True(t, result.Applied)
	assert.EqualValues(t, 7_000_000, result.Cap)
	assert.Equal(t, cycleStart+7*day, result.NextReleaseAt)
}

func TestCalculateSubscriptionQuotaPacingCapUsesActualCycleDuration(t *testing.T) {
	const (
		cycleStart = int64(1_800_000_000)
		day        = int64(24 * time.Hour / time.Second)
	)
	plan := &SubscriptionPlan{QuotaResetPeriod: SubscriptionResetMonthly}

	for _, cycleDays := range []int64{28, 29, 30, 31} {
		t.Run(fmt.Sprintf("%d-days", cycleDays), func(t *testing.T) {
			sub := &UserSubscription{
				AmountTotal:   cycleDays * 1_000_000,
				LastResetTime: cycleStart,
				NextResetTime: cycleStart + cycleDays*day,
			}

			first := calculateSubscriptionQuotaPacingCap(sub, plan, cycleStart, cycleStart)
			assert.EqualValues(t, 7_000_000, first.Cap)
			assert.Equal(t, cycleStart+7*day, first.NextReleaseAt)

			final := calculateSubscriptionQuotaPacingCap(sub, plan, cycleStart+28*day, cycleStart)
			assert.Equal(t, sub.AmountTotal, final.Cap)
			assert.Zero(t, final.NextReleaseAt)
		})
	}
}

func TestCalculateSubscriptionQuotaPacingCapAdvancesAtSevenDayBoundary(t *testing.T) {
	const (
		cycleStart = int64(1_800_000_000)
		day        = int64(24 * time.Hour / time.Second)
	)
	sub := &UserSubscription{
		AmountTotal:   30_000_000,
		LastResetTime: cycleStart,
		NextResetTime: cycleStart + 30*day,
	}
	plan := &SubscriptionPlan{QuotaResetPeriod: SubscriptionResetMonthly}

	before := calculateSubscriptionQuotaPacingCap(sub, plan, cycleStart+7*day-1, cycleStart)
	atBoundary := calculateSubscriptionQuotaPacingCap(sub, plan, cycleStart+7*day, cycleStart)

	assert.EqualValues(t, 7_000_000, before.Cap)
	assert.Equal(t, cycleStart+7*day, before.NextReleaseAt)
	assert.EqualValues(t, 14_000_000, atBoundary.Cap)
	assert.Equal(t, cycleStart+14*day, atBoundary.NextReleaseAt)
}

func TestCalculateSubscriptionQuotaPacingCapReleasesShortCycleImmediately(t *testing.T) {
	const (
		cycleStart = int64(1_800_000_000)
		day        = int64(24 * time.Hour / time.Second)
	)
	sub := &UserSubscription{
		AmountTotal:   3_000_000,
		LastResetTime: cycleStart,
		NextResetTime: cycleStart + 3*day,
	}
	plan := &SubscriptionPlan{QuotaResetPeriod: SubscriptionResetMonthly}

	result := calculateSubscriptionQuotaPacingCap(sub, plan, cycleStart, cycleStart)

	require.True(t, result.Applied)
	assert.Equal(t, sub.AmountTotal, result.Cap)
	assert.Zero(t, result.NextReleaseAt)
}

func TestCalculateSubscriptionQuotaPacingCapUsesEndTimeForFinalPartialCycle(t *testing.T) {
	const (
		cycleStart = int64(1_800_000_000)
		day        = int64(24 * time.Hour / time.Second)
	)
	sub := &UserSubscription{
		AmountTotal:   13_000_000,
		LastResetTime: cycleStart,
		NextResetTime: 0,
		EndTime:       cycleStart + 13*day,
	}
	plan := &SubscriptionPlan{QuotaResetPeriod: SubscriptionResetMonthly}

	first := calculateSubscriptionQuotaPacingCap(sub, plan, cycleStart, cycleStart)
	final := calculateSubscriptionQuotaPacingCap(sub, plan, cycleStart+7*day, cycleStart)

	assert.EqualValues(t, 7_000_000, first.Cap)
	assert.Equal(t, cycleStart+7*day, first.NextReleaseAt)
	assert.Equal(t, sub.AmountTotal, final.Cap)
	assert.Zero(t, final.NextReleaseAt)
}

func TestCalculateSubscriptionQuotaPacingCapPreservesIneligibleSubscriptions(t *testing.T) {
	const (
		cycleStart = int64(1_800_000_000)
		day        = int64(24 * time.Hour / time.Second)
	)
	monthly := &SubscriptionPlan{QuotaResetPeriod: SubscriptionResetMonthly}
	nonMonthly := &SubscriptionPlan{QuotaResetPeriod: SubscriptionResetWeekly}

	tests := []struct {
		name        string
		sub         *UserSubscription
		plan        *SubscriptionPlan
		effectiveAt int64
	}{
		{
			name:        "disabled",
			sub:         &UserSubscription{AmountTotal: 30_000_000, LastResetTime: cycleStart, NextResetTime: cycleStart + 30*day},
			plan:        monthly,
			effectiveAt: 0,
		},
		{
			name:        "existing cycle",
			sub:         &UserSubscription{AmountTotal: 30_000_000, LastResetTime: cycleStart, NextResetTime: cycleStart + 30*day},
			plan:        monthly,
			effectiveAt: cycleStart + 1,
		},
		{
			name:        "unlimited",
			sub:         &UserSubscription{AmountTotal: 0, LastResetTime: cycleStart, NextResetTime: cycleStart + 30*day},
			plan:        monthly,
			effectiveAt: cycleStart,
		},
		{
			name:        "non monthly",
			sub:         &UserSubscription{AmountTotal: 30_000_000, LastResetTime: cycleStart, NextResetTime: cycleStart + 30*day},
			plan:        nonMonthly,
			effectiveAt: cycleStart,
		},
		{
			name:        "invalid timing",
			sub:         &UserSubscription{AmountTotal: 30_000_000, LastResetTime: cycleStart, NextResetTime: cycleStart, EndTime: cycleStart},
			plan:        monthly,
			effectiveAt: cycleStart,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := calculateSubscriptionQuotaPacingCap(test.sub, test.plan, cycleStart, test.effectiveAt)
			assert.False(t, result.Applied)
			assert.Equal(t, test.sub.AmountTotal, result.Cap)
			assert.Zero(t, result.NextReleaseAt)
		})
	}
}

func TestCalculateSubscriptionQuotaPacingCapActivatesAfterNextReset(t *testing.T) {
	const (
		previousCycleStart = int64(1_797_321_600)
		effectiveAt        = int64(1_800_000_000)
		day                = int64(24 * time.Hour / time.Second)
	)
	plan := &SubscriptionPlan{QuotaResetPeriod: SubscriptionResetMonthly}
	beforeReset := &UserSubscription{
		AmountTotal:   30_000_000,
		LastResetTime: previousCycleStart,
		NextResetTime: effectiveAt,
	}
	afterReset := &UserSubscription{
		AmountTotal:   30_000_000,
		LastResetTime: effectiveAt,
		NextResetTime: effectiveAt + 30*day,
	}

	before := calculateSubscriptionQuotaPacingCap(beforeReset, plan, effectiveAt-1, effectiveAt)
	after := calculateSubscriptionQuotaPacingCap(afterReset, plan, effectiveAt, effectiveAt)

	assert.False(t, before.Applied)
	assert.Equal(t, beforeReset.AmountTotal, before.Cap)
	require.True(t, after.Applied)
	assert.EqualValues(t, 7_000_000, after.Cap)
}

func TestCalculateSubscriptionQuotaPacingCapDoesNotOverflowLargeQuota(t *testing.T) {
	const (
		cycleStart = int64(1_800_000_000)
		day        = int64(24 * time.Hour / time.Second)
	)
	sub := &UserSubscription{
		AmountTotal:   math.MaxInt64,
		LastResetTime: cycleStart,
		NextResetTime: cycleStart + 31*day,
	}
	plan := &SubscriptionPlan{QuotaResetPeriod: SubscriptionResetMonthly}

	result := calculateSubscriptionQuotaPacingCap(sub, plan, cycleStart, cycleStart)
	expected := (math.MaxInt64 / 31) * 7
	expected += ((math.MaxInt64 % 31) * 7) / 31

	require.True(t, result.Applied)
	assert.Equal(t, int64(expected), result.Cap)
	assert.Greater(t, result.Cap, int64(0))
	assert.Less(t, result.Cap, sub.AmountTotal)
}

func seedPacedMonthlySubscription(t *testing.T, userID int, amountTotal, amountUsed, cycleStart, cycleEnd int64) *UserSubscription {
	t.Helper()
	plan := &SubscriptionPlan{
		Title:            fmt.Sprintf("paced-monthly-plan-%d", userID),
		DurationUnit:     SubscriptionDurationMonth,
		DurationValue:    1,
		TotalAmount:      amountTotal,
		QuotaResetPeriod: SubscriptionResetMonthly,
		Enabled:          true,
	}
	require.NoError(t, DB.Create(plan).Error)
	InvalidateSubscriptionPlanCache(plan.Id)
	sub := &UserSubscription{
		UserId:        userID,
		PlanId:        plan.Id,
		AmountTotal:   amountTotal,
		AmountUsed:    amountUsed,
		StartTime:     cycleStart,
		EndTime:       cycleEnd,
		Status:        "active",
		LastResetTime: cycleStart,
		NextResetTime: cycleEnd,
	}
	require.NoError(t, DB.Create(sub).Error)
	return sub
}

func TestPreConsumeUserSubscriptionRejectsTailGraceBeforeMonthlyQuotaIsFullyReleased(t *testing.T) {
	truncateTables(t)
	now := GetDBTimestamp()
	const day = int64(24 * time.Hour / time.Second)
	sub := seedPacedMonthlySubscription(t, 6201, 3_000, 700, now, now+30*day)
	t.Setenv("SUBSCRIPTION_QUOTA_PACING_EFFECTIVE_AT", strconv.FormatInt(now, 10))

	result, err := PreConsumeUserSubscription("paced-tail-grace", sub.UserId, "test-model", 0, 100, true)

	require.Error(t, err)
	assert.Nil(t, result)
	assert.Contains(t, err.Error(), "subscription quota insufficient")
	assert.EqualValues(t, 700, getPreConsumeSubscription(t, sub.Id).AmountUsed)
}

func TestPreConsumeUserSubscriptionConsumesWithinReleasedQuota(t *testing.T) {
	truncateTables(t)
	now := GetDBTimestamp()
	const day = int64(24 * time.Hour / time.Second)
	sub := seedPacedMonthlySubscription(t, 6202, 3_000, 600, now, now+30*day)
	t.Setenv(subscriptionQuotaPacingEffectiveAtEnv, strconv.FormatInt(now, 10))

	result, err := PreConsumeUserSubscription("paced-within-cap", sub.UserId, "test-model", 0, 100, true)

	require.NoError(t, err)
	assert.Equal(t, sub.Id, result.UserSubscriptionId)
	assert.EqualValues(t, 100, result.PreConsumed)
	assert.EqualValues(t, 700, getPreConsumeSubscription(t, sub.Id).AmountUsed)
}

func TestPreConsumeUserSubscriptionPreservesIdempotencyAndRefundWithinPacingCap(t *testing.T) {
	truncateTables(t)
	now := GetDBTimestamp()
	const day = int64(24 * time.Hour / time.Second)
	sub := seedPacedMonthlySubscription(t, 6208, 3_000, 600, now, now+30*day)
	t.Setenv(subscriptionQuotaPacingEffectiveAtEnv, strconv.FormatInt(now, 10))

	first, err := PreConsumeUserSubscription("paced-idempotent-refund", sub.UserId, "test-model", 0, 100, false)
	require.NoError(t, err)
	retry, err := PreConsumeUserSubscription("paced-idempotent-refund", sub.UserId, "test-model", 0, 100, false)
	require.NoError(t, err)

	assert.Equal(t, first.UserSubscriptionId, retry.UserSubscriptionId)
	assert.Equal(t, first.PreConsumed, retry.PreConsumed)
	assert.EqualValues(t, 700, getPreConsumeSubscription(t, sub.Id).AmountUsed)
	require.NoError(t, RefundSubscriptionPreConsume("paced-idempotent-refund"))
	require.NoError(t, RefundSubscriptionPreConsume("paced-idempotent-refund"))
	assert.EqualValues(t, 600, getPreConsumeSubscription(t, sub.Id).AmountUsed)
}

func TestPreConsumeUserSubscriptionCarriesUnusedQuotaIntoNextWindow(t *testing.T) {
	truncateTables(t)
	now := GetDBTimestamp()
	const day = int64(24 * time.Hour / time.Second)
	cycleStart := now - 8*day
	sub := seedPacedMonthlySubscription(t, 6203, 3_000, 500, cycleStart, cycleStart+30*day)
	t.Setenv(subscriptionQuotaPacingEffectiveAtEnv, strconv.FormatInt(cycleStart, 10))

	result, err := PreConsumeUserSubscription("paced-carry-forward", sub.UserId, "test-model", 0, 900, false)

	require.NoError(t, err)
	assert.EqualValues(t, 900, result.PreConsumed)
	assert.EqualValues(t, 1_400, getPreConsumeSubscription(t, sub.Id).AmountUsed)
}

func TestPreConsumeUserSubscriptionExemptsCycleStartedBeforeRollout(t *testing.T) {
	truncateTables(t)
	now := GetDBTimestamp()
	const day = int64(24 * time.Hour / time.Second)
	cycleStart := now - day
	sub := seedPacedMonthlySubscription(t, 6204, 3_000, 2_900, cycleStart, cycleStart+30*day)
	t.Setenv(subscriptionQuotaPacingEffectiveAtEnv, strconv.FormatInt(now, 10))

	result, err := PreConsumeUserSubscription("paced-existing-cycle", sub.UserId, "test-model", 0, 100, false)

	require.NoError(t, err)
	assert.EqualValues(t, 100, result.PreConsumed)
	assert.EqualValues(t, 3_000, getPreConsumeSubscription(t, sub.Id).AmountUsed)
}

func TestPreConsumeUserSubscriptionPreservesTailGraceInFinalWindow(t *testing.T) {
	truncateTables(t)
	now := GetDBTimestamp()
	const day = int64(24 * time.Hour / time.Second)
	cycleStart := now - 29*day
	sub := seedPacedMonthlySubscription(t, 6205, 3_000, 2_950, cycleStart, cycleStart+30*day)
	t.Setenv(subscriptionQuotaPacingEffectiveAtEnv, strconv.FormatInt(cycleStart, 10))

	result, err := PreConsumeUserSubscription("paced-final-tail-grace", sub.UserId, "test-model", 0, 100, true)

	require.NoError(t, err)
	assert.EqualValues(t, 50, result.PreConsumed)
	assert.EqualValues(t, 3_000, getPreConsumeSubscription(t, sub.Id).AmountUsed)
}

func TestSubscriptionSettlementRecordsActualUsageAboveCurrentPacingCap(t *testing.T) {
	truncateTables(t)
	now := GetDBTimestamp()
	const day = int64(24 * time.Hour / time.Second)
	sub := seedPacedMonthlySubscription(t, 6206, 3_000, 0, now, now+30*day)
	t.Setenv(subscriptionQuotaPacingEffectiveAtEnv, strconv.FormatInt(now, 10))

	_, err := PreConsumeUserSubscription("paced-settlement", sub.UserId, "test-model", 0, 100, false)
	require.NoError(t, err)
	require.NoError(t, PostConsumeUserSubscriptionDelta(sub.Id, 650))
	assert.EqualValues(t, 750, getPreConsumeSubscription(t, sub.Id).AmountUsed)

	result, err := PreConsumeUserSubscription("paced-after-overage", sub.UserId, "test-model", 0, 1, false)
	require.Error(t, err)
	assert.Nil(t, result)
	assert.Contains(t, err.Error(), "subscription quota insufficient")
}

func TestPreConsumeUserSubscriptionSelectsAnotherSubscriptionWhenFirstIsPacingLimited(t *testing.T) {
	truncateTables(t)
	now := GetDBTimestamp()
	const day = int64(24 * time.Hour / time.Second)
	first := seedPacedMonthlySubscription(t, 6207, 3_000, 700, now, now+30*day)
	second := seedPacedMonthlySubscription(t, 6207, 3_000, 0, now, now+31*day)
	t.Setenv(subscriptionQuotaPacingEffectiveAtEnv, strconv.FormatInt(now, 10))

	result, err := PreConsumeUserSubscription("paced-second-subscription", first.UserId, "test-model", 0, 100, false)

	require.NoError(t, err)
	assert.Equal(t, second.Id, result.UserSubscriptionId)
	assert.EqualValues(t, 700, getPreConsumeSubscription(t, first.Id).AmountUsed)
	assert.EqualValues(t, 100, getPreConsumeSubscription(t, second.Id).AmountUsed)
}
