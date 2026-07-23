package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupAdminSubscriptionTest(t *testing.T) (*User, *SubscriptionPlan) {
	t.Helper()
	truncateTables(t)

	user := &User{
		Username: "admin_subscription_user",
		Status:   common.UserStatusEnabled,
	}
	require.NoError(t, DB.Create(user).Error)

	plan := &SubscriptionPlan{
		Title:         "Admin Subscription Plan",
		DurationUnit:  SubscriptionDurationMonth,
		DurationValue: 1,
		Enabled:       true,
		TotalAmount:   1000,
	}
	require.NoError(t, DB.Create(plan).Error)
	return user, plan
}

func TestAdminCreateUserSubscriptionIsIdempotent(t *testing.T) {
	user, plan := setupAdminSubscriptionTest(t)

	first, _, err := AdminCreateUserSubscription(
		user.Id,
		plan.Id,
		"package:user-1:pass-1",
		"trade:deal-1",
	)
	require.NoError(t, err)

	second, _, err := AdminCreateUserSubscription(
		user.Id,
		plan.Id,
		"package:user-1:pass-1",
		"trade:deal-1",
	)
	require.NoError(t, err)

	assert.Equal(t, first.Id, second.Id)
	assert.Equal(t, "package:user-1:pass-1", second.Name)
	require.NotNil(t, second.RequestId)
	assert.Equal(t, "trade:deal-1", *second.RequestId)

	var count int64
	require.NoError(t, DB.Model(&UserSubscription{}).
		Where("request_id = ?", "trade:deal-1").
		Count(&count).Error)
	assert.Equal(t, int64(1), count)
}

func TestAdminCreateUserSubscriptionRejectsRequestConflict(t *testing.T) {
	user, plan := setupAdminSubscriptionTest(t)

	_, _, err := AdminCreateUserSubscription(
		user.Id,
		plan.Id,
		"package:user-1:pass-1",
		"trade:deal-conflict",
	)
	require.NoError(t, err)

	_, _, err = AdminCreateUserSubscription(
		user.Id,
		plan.Id,
		"package:user-1:pass-2",
		"trade:deal-conflict",
	)
	require.ErrorIs(t, err, ErrSubscriptionRequestConflict)
}
