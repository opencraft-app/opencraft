package model

import (
	"math/bits"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	subscriptionQuotaPacingEffectiveAtEnv = "SUBSCRIPTION_QUOTA_PACING_EFFECTIVE_AT"
	subscriptionQuotaPacingWindowSeconds  = int64(7 * 24 * time.Hour / time.Second)
)

type subscriptionQuotaPacingResult struct {
	Applied       bool
	Cap           int64
	NextReleaseAt int64
}

func subscriptionQuotaPacingEffectiveAt() int64 {
	raw := strings.TrimSpace(os.Getenv(subscriptionQuotaPacingEffectiveAtEnv))
	if raw == "" {
		return 0
	}
	effectiveAt, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || effectiveAt <= 0 {
		return 0
	}
	return effectiveAt
}

func calculateSubscriptionQuotaPacingCap(sub *UserSubscription, plan *SubscriptionPlan, now, effectiveAt int64) subscriptionQuotaPacingResult {
	result := subscriptionQuotaPacingResult{}
	if sub == nil {
		return result
	}
	result.Cap = sub.AmountTotal
	if plan == nil || effectiveAt <= 0 || sub.AmountTotal <= 0 || sub.LastResetTime < effectiveAt ||
		NormalizeResetPeriod(plan.QuotaResetPeriod) != SubscriptionResetMonthly {
		return result
	}

	cycleStart := sub.LastResetTime
	cycleEnd := sub.NextResetTime
	if cycleEnd <= cycleStart {
		cycleEnd = sub.EndTime
	}
	if cycleStart <= 0 || cycleEnd <= cycleStart {
		return result
	}

	cycleDuration := cycleEnd - cycleStart
	elapsed := int64(0)
	switch {
	case now >= cycleEnd:
		elapsed = cycleDuration - 1
	case now > cycleStart:
		elapsed = now - cycleStart
	}

	windowStart := elapsed - elapsed%subscriptionQuotaPacingWindowSeconds
	result.Applied = true
	if cycleDuration-windowStart <= subscriptionQuotaPacingWindowSeconds {
		result.Cap = sub.AmountTotal
		return result
	}

	releasedDuration := windowStart + subscriptionQuotaPacingWindowSeconds
	result.Cap = floorQuotaRatio(sub.AmountTotal, releasedDuration, cycleDuration)
	result.NextReleaseAt = cycleStart + releasedDuration
	return result
}

func floorQuotaRatio(total, numerator, denominator int64) int64 {
	if total <= 0 || numerator <= 0 || denominator <= 0 {
		return 0
	}
	if numerator >= denominator {
		return total
	}
	high, low := bits.Mul64(uint64(total), uint64(numerator))
	quotient, _ := bits.Div64(high, low, uint64(denominator))
	return int64(quotient)
}
