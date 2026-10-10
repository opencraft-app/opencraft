package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestDistributorDistinguishesUnknownModelFromUnavailableChannel(t *testing.T) {
	require.NoError(t, i18n.Init())
	previousDB := model.DB
	previousMemoryCache := common.MemoryCacheEnabled
	previousSQLitePath := common.SQLitePath
	previousIsMasterNode := common.IsMasterNode
	previousMainType := common.MainDatabaseType()
	previousLogType := common.LogDatabaseType()
	previousAutoGroups := setting.AutoGroups2JsonString()
	previousUsableGroups := setting.UserUsableGroups2JSONString()
	t.Setenv("SQL_DSN", "local")
	t.Setenv("LOG_SQL_DSN", "")
	common.SQLitePath = filepath.Join(t.TempDir(), "distributor.sqlite")
	common.IsMasterNode = false
	// InitDB initializes the private SQL column quoting used by the non-cache
	// selection path. All connection state stays inside this temporary fixture.
	require.NoError(t, model.InitDB())
	db := model.DB
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() {
		require.NoError(t, sqlDB.Close())
		model.DB = previousDB
		common.MemoryCacheEnabled = previousMemoryCache
		common.SQLitePath = previousSQLitePath
		common.IsMasterNode = previousIsMasterNode
		common.SetDatabaseTypes(previousMainType, previousLogType)
		require.NoError(t, setting.UpdateAutoGroupsByJsonString(previousAutoGroups))
		require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(previousUsableGroups))
		if previousDB != nil && previousMemoryCache {
			model.InitChannelCache()
		}
	})
	require.NoError(t, db.AutoMigrate(&model.Ability{}, &model.Channel{}))
	require.NoError(t, setting.UpdateUserUsableGroupsByJSONString(`{"default":"default","eligible":"eligible"}`))
	require.NoError(t, setting.UpdateAutoGroupsByJsonString(`["default","eligible","ineligible"]`))

	for _, channel := range []model.Channel{
		{Id: 1001, Group: "default", Models: "configured-but-disabled", Status: common.ChannelStatusManuallyDisabled},
		{Id: 1002, Group: "eligible", Models: "auto-disabled", Status: common.ChannelStatusManuallyDisabled},
		{Id: 1003, Group: "ineligible", Models: "ineligible-only", Status: common.ChannelStatusManuallyDisabled},
		{Id: 1004, Group: "eligible", Models: "auto-enabled", Status: common.ChannelStatusEnabled, Type: constant.ChannelTypeOpenAI, Key: "test-key"},
	} {
		require.NoError(t, db.Create(&channel).Error)
		require.NoError(t, channel.AddAbilities(nil))
	}
	assertResponse := func(t *testing.T, group, modelName string, wantStatus int, wantCode string) {
		t.Helper()
		body := strings.NewReader(`{"model":"` + modelName + `","messages":[{"role":"user","content":"test"}]}`)
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", body)
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(response)
		ctx.Request = req
		common.SetContextKey(ctx, constant.ContextKeyUsingGroup, group)
		Distribute()(ctx)
		require.Equal(t, wantStatus, response.Code)
		if wantStatus == http.StatusOK {
			require.False(t, ctx.IsAborted())
			require.Equal(t, 1004, common.GetContextKeyInt(ctx, constant.ContextKeyChannelId))
			return
		}
		var payload struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
		require.Equal(t, wantCode, payload.Error.Code)
		if wantStatus == http.StatusNotFound {
			// Hermes also matches error text when an SDK wrapper omits the JSON
			// body from its exception string.
			require.Contains(t, payload.Error.Message, "model_not_found")
		}
	}

	tests := []struct {
		name       string
		group      string
		model      string
		wantStatus int
		wantCode   string
	}{
		{"unknown model", "default", "anthropic/claude-sonnet-4", http.StatusNotFound, "model_not_found"},
		{"disabled channel", "default", "configured-but-disabled", http.StatusServiceUnavailable, "get_channel_failed"},
		{"auto unknown model", "auto", "anthropic/claude-sonnet-4", http.StatusNotFound, "model_not_found"},
		{"auto eligible disabled channel", "auto", "auto-disabled", http.StatusServiceUnavailable, "get_channel_failed"},
		{"auto ignores ineligible configuration", "auto", "ineligible-only", http.StatusNotFound, "model_not_found"},
		{"auto eligible enabled channel", "auto", "auto-enabled", http.StatusOK, ""},
	}
	for _, memoryCache := range []bool{true, false} {
		name := "database selection"
		if memoryCache {
			name = "memory cache selection"
		}
		t.Run(name, func(t *testing.T) {
			common.MemoryCacheEnabled = memoryCache
			model.InitChannelCache()
			for _, tt := range tests {
				t.Run(tt.name, func(t *testing.T) {
					assertResponse(t, tt.group, tt.model, tt.wantStatus, tt.wantCode)
				})
			}
			t.Run("auto without eligible groups stays retryable", func(t *testing.T) {
				require.NoError(t, setting.UpdateAutoGroupsByJsonString(`["ineligible"]`))
				t.Cleanup(func() {
					require.NoError(t, setting.UpdateAutoGroupsByJsonString(`["default","eligible","ineligible"]`))
				})
				assertResponse(t, "auto", "unknown-model", http.StatusServiceUnavailable, "get_channel_failed")
			})
		})
	}

	require.NoError(t, db.Migrator().DropTable(&model.Ability{}))
	for _, memoryCache := range []bool{true, false} {
		common.MemoryCacheEnabled = memoryCache
		t.Run("database failure stays retryable", func(t *testing.T) {
			assertResponse(t, "default", "anthropic/claude-sonnet-4", http.StatusServiceUnavailable, "get_channel_failed")
		})
	}
}
