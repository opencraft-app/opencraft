package controller

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

type adminCreateSubscriptionResponse struct {
	Success bool                   `json:"success"`
	Message string                 `json:"message"`
	Data    model.UserSubscription `json:"data"`
}

func setupAdminSubscriptionControllerTest(t *testing.T) (*model.User, *model.SubscriptionPlan) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	confirmPaymentComplianceForTest(t)

	originalDB := model.DB
	originalUsingSQLite := common.UsingSQLite
	originalUsingMySQL := common.UsingMySQL
	originalUsingPostgreSQL := common.UsingPostgreSQL

	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", strings.ReplaceAll(t.Name(), "/", "_"))
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	model.DB = db
	common.UsingSQLite = true
	common.UsingMySQL = false
	common.UsingPostgreSQL = false
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.SubscriptionPlan{}, &model.UserSubscription{}))

	t.Cleanup(func() {
		model.DB = originalDB
		common.UsingSQLite = originalUsingSQLite
		common.UsingMySQL = originalUsingMySQL
		common.UsingPostgreSQL = originalUsingPostgreSQL
		sqlDB, dbErr := db.DB()
		if dbErr == nil {
			_ = sqlDB.Close()
		}
	})

	user := &model.User{Username: "controller_subscription_user", Status: common.UserStatusEnabled}
	require.NoError(t, db.Create(user).Error)
	plan := &model.SubscriptionPlan{
		Title:         "Controller Subscription Plan",
		DurationUnit:  model.SubscriptionDurationMonth,
		DurationValue: 1,
		Enabled:       true,
		TotalAmount:   2000,
	}
	require.NoError(t, db.Create(plan).Error)
	return user, plan
}

func callAdminCreateUserSubscription(
	t *testing.T,
	userID int,
	planID int,
	name string,
	requestID string,
) adminCreateSubscriptionResponse {
	t.Helper()
	body := fmt.Sprintf(
		`{"plan_id":%d,"name":%q,"request_id":%q}`,
		planID,
		name,
		requestID,
	)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = []gin.Param{{Key: "id", Value: strconv.Itoa(userID)}}
	ctx.Request = httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(body))
	ctx.Request.Header.Set("Content-Type", "application/json")

	AdminCreateUserSubscription(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var response adminCreateSubscriptionResponse
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	return response
}

func TestAdminCreateUserSubscriptionReturnsIdempotentSubscription(t *testing.T) {
	user, plan := setupAdminSubscriptionControllerTest(t)

	first := callAdminCreateUserSubscription(
		t,
		user.Id,
		plan.Id,
		"package:user-1:pass-1",
		"trade:deal-controller-1",
	)
	require.True(t, first.Success, first.Message)
	require.Positive(t, first.Data.Id)
	assert.Equal(t, "package:user-1:pass-1", first.Data.Name)

	second := callAdminCreateUserSubscription(
		t,
		user.Id,
		plan.Id,
		"package:user-1:pass-1",
		"trade:deal-controller-1",
	)
	require.True(t, second.Success, second.Message)
	assert.Equal(t, first.Data.Id, second.Data.Id)

	var count int64
	require.NoError(t, model.DB.Model(&model.UserSubscription{}).Count(&count).Error)
	assert.Equal(t, int64(1), count)
}

func TestAdminCreateUserSubscriptionKeepsLegacyPlanOnlyRequestCompatible(t *testing.T) {
	user, plan := setupAdminSubscriptionControllerTest(t)

	body := fmt.Sprintf(`{"plan_id":%d}`, plan.Id)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = []gin.Param{{Key: "id", Value: strconv.Itoa(user.Id)}}
	ctx.Request = httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(body))
	ctx.Request.Header.Set("Content-Type", "application/json")

	AdminCreateUserSubscription(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var response struct {
		Success bool `json:"success"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	require.True(t, response.Success)

	var subscriptions []model.UserSubscription
	require.NoError(t, model.DB.Find(&subscriptions).Error)
	require.Len(t, subscriptions, 1)
	assert.Nil(t, subscriptions[0].RequestId)
}
