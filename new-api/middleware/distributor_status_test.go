package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestDistributorDistinguishesUnknownModelFromUnavailableChannel(t *testing.T) {
	require.NoError(t, i18n.Init())
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.Ability{}, &model.Channel{}))
	previousDB := model.DB
	previousMemoryCache := common.MemoryCacheEnabled
	model.DB = db
	common.MemoryCacheEnabled = true
	t.Cleanup(func() {
		model.DB = previousDB
		common.MemoryCacheEnabled = previousMemoryCache
	})

	require.NoError(t, db.Create(&model.Ability{
		Group: "default", Model: "configured-but-disabled", ChannelId: 1001, Enabled: false,
	}).Error)
	model.InitChannelCache()
	assertResponse := func(t *testing.T, modelName string, wantStatus int, wantCode string) {
		t.Helper()
		body := strings.NewReader(`{"model":"` + modelName + `","messages":[{"role":"user","content":"test"}]}`)
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", body)
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(response)
		ctx.Request = req
		common.SetContextKey(ctx, constant.ContextKeyUsingGroup, "default")
		Distribute()(ctx)
		require.Equal(t, wantStatus, response.Code)
		var payload struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
		require.Equal(t, wantCode, payload.Error.Code)
	}

	for _, tt := range []struct {
		name       string
		model      string
		wantStatus int
		wantCode   string
	}{
		{"unknown model", "anthropic/claude-sonnet-4", http.StatusNotFound, "model_not_found"},
		{"disabled channel", "configured-but-disabled", http.StatusServiceUnavailable, "get_channel_failed"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			assertResponse(t, tt.model, tt.wantStatus, tt.wantCode)
		})
	}

	require.NoError(t, db.Migrator().DropTable(&model.Ability{}))
	t.Run("lookup failure stays retryable", func(t *testing.T) {
		assertResponse(t, "anthropic/claude-sonnet-4", http.StatusServiceUnavailable, "get_channel_failed")
	})
}
