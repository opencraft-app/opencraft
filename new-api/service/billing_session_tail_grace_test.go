package service

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func seedBillingTailGraceSubscription(t *testing.T, userID int, amountTotal, amountUsed int64) *model.UserSubscription {
	t.Helper()
	plan := &model.SubscriptionPlan{
		Title:            "billing-tail-grace-plan",
		DurationUnit:     model.SubscriptionDurationMonth,
		DurationValue:    1,
		TotalAmount:      amountTotal,
		QuotaResetPeriod: model.SubscriptionResetNever,
		Enabled:          true,
	}
	require.NoError(t, model.DB.Create(plan).Error)
	model.InvalidateSubscriptionPlanCache(plan.Id)

	now := time.Now().Unix()
	sub := &model.UserSubscription{
		UserId:        userID,
		PlanId:        plan.Id,
		AmountTotal:   amountTotal,
		AmountUsed:    amountUsed,
		StartTime:     now - 60,
		EndTime:       now + 3600,
		Status:        "active",
		LastResetTime: now - 60,
	}
	require.NoError(t, model.DB.Create(sub).Error)
	return sub
}

func newTailGraceBillingContext() *gin.Context {
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	return ctx
}

func newTailGraceRelayInfo(userID, tokenID int, tokenKey, requestID string) *relaycommon.RelayInfo {
	return &relaycommon.RelayInfo{
		TokenId:         tokenID,
		TokenKey:        tokenKey,
		UserId:          userID,
		OriginModelName: "test-model",
		RequestId:       requestID,
		UserSetting: dto.UserSetting{
			BillingPreference: "subscription_only",
		},
	}
}

func TestBillingSessionTailGraceChargesOnlyRemainingQuotaWhenActualUsageExceedsIt(t *testing.T) {
	truncate(t)
	const userID, tokenID = 6201, 6201
	const tokenKey = "billing-tail-grace-overage"
	seedUser(t, userID, 0)
	seedToken(t, tokenID, userID, tokenKey, 1000)
	sub := seedBillingTailGraceSubscription(t, userID, 100, 20)

	relayInfo := newTailGraceRelayInfo(userID, tokenID, tokenKey, "billing-tail-grace-overage-request")
	session, apiErr := NewBillingSession(newTailGraceBillingContext(), relayInfo, 100)
	require.Nil(t, apiErr)
	require.NotNil(t, session)
	assert.Equal(t, 80, session.GetPreConsumedQuota())
	assert.Equal(t, 920, getTokenRemainQuota(t, tokenID))
	assert.EqualValues(t, 100, getSubscriptionUsed(t, sub.Id))

	require.NoError(t, session.Reserve(120))
	assert.Equal(t, 920, getTokenRemainQuota(t, tokenID))
	assert.EqualValues(t, 100, getSubscriptionUsed(t, sub.Id))

	require.NoError(t, session.Settle(120))
	assert.Equal(t, 920, getTokenRemainQuota(t, tokenID))
	assert.Equal(t, 80, getTokenUsedQuota(t, tokenID))
	assert.EqualValues(t, 100, getSubscriptionUsed(t, sub.Id))
	assert.Zero(t, relayInfo.SubscriptionPostDelta)
}

func TestBillingSessionForcePreConsumeRequiresFullSubscriptionQuota(t *testing.T) {
	truncate(t)
	const userID, tokenID = 6207, 6207
	const tokenKey = "billing-force-pre-consume-tail-grace"
	seedUser(t, userID, 0)
	seedToken(t, tokenID, userID, tokenKey, 1000)
	sub := seedBillingTailGraceSubscription(t, userID, 100, 20)

	relayInfo := newTailGraceRelayInfo(userID, tokenID, tokenKey, "billing-force-pre-consume-tail-grace-request")
	relayInfo.ForcePreConsume = true
	session, apiErr := NewBillingSession(newTailGraceBillingContext(), relayInfo, 100)

	assert.Nil(t, session)
	require.NotNil(t, apiErr)
	assert.Equal(t, 1000, getTokenRemainQuota(t, tokenID))
	assert.EqualValues(t, 20, getSubscriptionUsed(t, sub.Id))
}

func TestBillingSessionTailGraceRefundsUnusedRemainderAfterSettlement(t *testing.T) {
	truncate(t)
	const userID, tokenID = 6202, 6202
	const tokenKey = "billing-tail-grace-refund-delta"
	seedUser(t, userID, 0)
	seedToken(t, tokenID, userID, tokenKey, 1000)
	sub := seedBillingTailGraceSubscription(t, userID, 100, 20)

	relayInfo := newTailGraceRelayInfo(userID, tokenID, tokenKey, "billing-tail-grace-refund-delta-request")
	session, apiErr := NewBillingSession(newTailGraceBillingContext(), relayInfo, 100)
	require.Nil(t, apiErr)

	require.NoError(t, session.Settle(50))
	assert.Equal(t, 950, getTokenRemainQuota(t, tokenID))
	assert.Equal(t, 50, getTokenUsedQuota(t, tokenID))
	assert.EqualValues(t, 70, getSubscriptionUsed(t, sub.Id))
	assert.EqualValues(t, -30, relayInfo.SubscriptionPostDelta)
}

func TestBillingSessionFullSubscriptionStillChargesSettlementOverage(t *testing.T) {
	truncate(t)
	const userID, tokenID = 6206, 6206
	const tokenKey = "billing-full-subscription-overage"
	seedUser(t, userID, 0)
	seedToken(t, tokenID, userID, tokenKey, 1000)
	sub := seedBillingTailGraceSubscription(t, userID, 500, 0)

	relayInfo := newTailGraceRelayInfo(userID, tokenID, tokenKey, "billing-full-subscription-overage-request")
	session, apiErr := NewBillingSession(newTailGraceBillingContext(), relayInfo, 100)
	require.Nil(t, apiErr)
	require.Equal(t, 100, session.GetPreConsumedQuota())

	require.NoError(t, session.Settle(120))
	assert.Equal(t, 880, getTokenRemainQuota(t, tokenID))
	assert.Equal(t, 120, getTokenUsedQuota(t, tokenID))
	assert.EqualValues(t, 120, getSubscriptionUsed(t, sub.Id))
	assert.EqualValues(t, 20, relayInfo.SubscriptionPostDelta)
}

func TestBillingSessionTailGraceRefundRestoresSubscriptionAndToken(t *testing.T) {
	truncate(t)
	const userID, tokenID = 6204, 6204
	const tokenKey = "billing-tail-grace-upstream-failure"
	seedUser(t, userID, 0)
	seedToken(t, tokenID, userID, tokenKey, 1000)
	sub := seedBillingTailGraceSubscription(t, userID, 100, 20)

	ctx := newTailGraceBillingContext()
	relayInfo := newTailGraceRelayInfo(userID, tokenID, tokenKey, "billing-tail-grace-upstream-failure-request")
	session, apiErr := NewBillingSession(ctx, relayInfo, 100)
	require.Nil(t, apiErr)
	require.True(t, session.NeedsRefund())

	session.Refund(ctx)
	require.Eventually(t, func() bool {
		var currentSub model.UserSubscription
		var currentToken model.Token
		if err := model.DB.First(&currentSub, sub.Id).Error; err != nil {
			return false
		}
		if err := model.DB.First(&currentToken, tokenID).Error; err != nil {
			return false
		}
		return currentSub.AmountUsed == 20 &&
			currentToken.RemainQuota == 1000 &&
			currentToken.UsedQuota == 0
	}, 2*time.Second, 10*time.Millisecond)
}

func TestBillingSessionTailGraceRollsBackSubscriptionWhenTokenQuotaIsInsufficient(t *testing.T) {
	truncate(t)
	const userID, tokenID = 6205, 6205
	const tokenKey = "billing-tail-grace-token-insufficient"
	seedUser(t, userID, 0)
	seedToken(t, tokenID, userID, tokenKey, 50)
	sub := seedBillingTailGraceSubscription(t, userID, 100, 20)

	relayInfo := newTailGraceRelayInfo(userID, tokenID, tokenKey, "billing-tail-grace-token-insufficient-request")
	session, apiErr := NewBillingSession(newTailGraceBillingContext(), relayInfo, 100)

	assert.Nil(t, session)
	require.NotNil(t, apiErr)
	assert.EqualValues(t, 20, getSubscriptionUsed(t, sub.Id))
	assert.Equal(t, 50, getTokenRemainQuota(t, tokenID))
	assert.Equal(t, 0, getTokenUsedQuota(t, tokenID))
}

func TestBillingSessionWalletDoesNotReceiveTailGrace(t *testing.T) {
	truncate(t)
	const userID, tokenID = 6203, 6203
	const tokenKey = "billing-wallet-no-tail-grace"
	seedUser(t, userID, 80)
	seedToken(t, tokenID, userID, tokenKey, 1000)

	relayInfo := newTailGraceRelayInfo(userID, tokenID, tokenKey, "billing-wallet-no-tail-grace-request")
	relayInfo.UserSetting.BillingPreference = "wallet_only"
	session, apiErr := NewBillingSession(newTailGraceBillingContext(), relayInfo, 100)

	assert.Nil(t, session)
	require.NotNil(t, apiErr)
	assert.Equal(t, 80, getUserQuota(t, userID))
	assert.Equal(t, 1000, getTokenRemainQuota(t, tokenID))
}
