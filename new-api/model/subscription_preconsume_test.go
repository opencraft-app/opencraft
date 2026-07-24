package model

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func seedPreConsumeSubscription(t *testing.T, userID int, amountTotal, amountUsed int64, endTime int64) *UserSubscription {
	t.Helper()
	plan := &SubscriptionPlan{
		Title:            fmt.Sprintf("pre-consume-plan-%d", userID),
		DurationUnit:     SubscriptionDurationMonth,
		DurationValue:    1,
		TotalAmount:      amountTotal,
		QuotaResetPeriod: SubscriptionResetNever,
		Enabled:          true,
	}
	require.NoError(t, DB.Create(plan).Error)
	InvalidateSubscriptionPlanCache(plan.Id)

	now := time.Now().Unix()
	sub := &UserSubscription{
		UserId:        userID,
		PlanId:        plan.Id,
		AmountTotal:   amountTotal,
		AmountUsed:    amountUsed,
		StartTime:     now - 60,
		EndTime:       endTime,
		Status:        "active",
		LastResetTime: now - 60,
	}
	require.NoError(t, DB.Create(sub).Error)
	return sub
}

func getPreConsumeSubscription(t *testing.T, id int) UserSubscription {
	t.Helper()
	var sub UserSubscription
	require.NoError(t, DB.First(&sub, id).Error)
	return sub
}

func TestPreConsumeUserSubscriptionUsesRemainingQuotaAsTailGrace(t *testing.T) {
	truncateTables(t)
	const userID = 6101
	sub := seedPreConsumeSubscription(t, userID, 100, 20, time.Now().Add(time.Hour).Unix())

	result, err := PreConsumeUserSubscription("tail-grace-request", userID, "test-model", 0, 100, true)
	require.NoError(t, err)
	assert.Equal(t, sub.Id, result.UserSubscriptionId)
	assert.EqualValues(t, 80, result.PreConsumed)
	assert.EqualValues(t, 20, result.AmountUsedBefore)
	assert.EqualValues(t, 100, result.AmountUsedAfter)

	updated := getPreConsumeSubscription(t, sub.Id)
	assert.EqualValues(t, 100, updated.AmountUsed)
}

func TestPreConsumeUserSubscriptionPrefersFullSubscriptionBeforeTailGrace(t *testing.T) {
	truncateTables(t)
	const userID = 6102
	first := seedPreConsumeSubscription(t, userID, 100, 80, time.Now().Add(time.Hour).Unix())
	second := seedPreConsumeSubscription(t, userID, 300, 100, time.Now().Add(2*time.Hour).Unix())

	result, err := PreConsumeUserSubscription("full-before-grace-request", userID, "test-model", 0, 100, true)
	require.NoError(t, err)
	assert.Equal(t, second.Id, result.UserSubscriptionId)
	assert.EqualValues(t, 100, result.PreConsumed)
	assert.EqualValues(t, 80, getPreConsumeSubscription(t, first.Id).AmountUsed)
	assert.EqualValues(t, 200, getPreConsumeSubscription(t, second.Id).AmountUsed)
}

func TestPreConsumeUserSubscriptionAllowsOnlyOneConcurrentTailGrace(t *testing.T) {
	truncateTables(t)
	const userID = 6103
	sub := seedPreConsumeSubscription(t, userID, 100, 20, time.Now().Add(time.Hour).Unix())

	var successCount atomic.Int32
	var insufficientCount atomic.Int32
	var unexpectedMu sync.Mutex
	var unexpected []error
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			_, err := PreConsumeUserSubscription(
				fmt.Sprintf("concurrent-tail-grace-%d", index),
				userID,
				"test-model",
				0,
				100,
				true,
			)
			switch {
			case err == nil:
				successCount.Add(1)
			case strings.Contains(err.Error(), "subscription quota insufficient"):
				insufficientCount.Add(1)
			default:
				unexpectedMu.Lock()
				unexpected = append(unexpected, err)
				unexpectedMu.Unlock()
			}
		}(i)
	}
	wg.Wait()

	assert.Empty(t, unexpected)
	assert.EqualValues(t, 1, successCount.Load())
	assert.EqualValues(t, 19, insufficientCount.Load())
	assert.EqualValues(t, 100, getPreConsumeSubscription(t, sub.Id).AmountUsed)
}

func TestRefundSubscriptionTailGraceRestoresRemainingQuotaIdempotently(t *testing.T) {
	truncateTables(t)
	const userID = 6104
	sub := seedPreConsumeSubscription(t, userID, 100, 20, time.Now().Add(time.Hour).Unix())

	result, err := PreConsumeUserSubscription("tail-grace-refund", userID, "test-model", 0, 100, true)
	require.NoError(t, err)
	require.EqualValues(t, 80, result.PreConsumed)

	require.NoError(t, RefundSubscriptionPreConsume("tail-grace-refund"))
	require.NoError(t, RefundSubscriptionPreConsume("tail-grace-refund"))
	assert.EqualValues(t, 20, getPreConsumeSubscription(t, sub.Id).AmountUsed)
}
