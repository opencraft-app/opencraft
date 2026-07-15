//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"

	"ctl/pkg/config"
	pctx "ctl/pkg/context"
	taskmodel "ctl/pkg/model/task"
	"ctl/pkg/resource"
	"ctl/test/testutil"
)

const testMigrationsPath = "../../migrations"

// setupTestEnv 一站式初始化 MySQL（migration）+ Redis + config 覆写 + logger。
// 返回 redis client 和一个独立的 stream key。
func setupTestEnv(t *testing.T) (*goredis.Client, string) {
	t.Helper()

	resource.ZapLogger = zap.NewNop()

	// MySQL + migration
	testutil.NewMySQLDB(t, testMigrationsPath)

	// Redis
	client := testutil.NewRedisClient(t)

	// 独立 stream key 保证测试隔离
	streamKey := fmt.Sprintf("test-stream-%d", time.Now().UnixNano())

	// 覆写 MQ config
	if config.ServerConf.MQConfig == nil {
		config.ServerConf.MQConfig = &config.MQConfig{}
	}
	config.ServerConf.MQConfig.StreamKey = streamKey
	config.ServerConf.MQConfig.GroupName = "test-group"
	config.ServerConf.MQConfig.MaxLen = 10000

	// 确保 API config 已初始化
	if config.ServerConf.APIConfig == nil {
		config.ServerConf.APIConfig = &config.APIConfig{}
	}
	if config.ServerConf.APIConfig.Instance == nil {
		config.ServerConf.APIConfig.Instance = &config.InstanceAPIConfig{}
	}
	if config.ServerConf.APIConfig.Instance.DefaultTemplateID == "" {
		config.ServerConf.APIConfig.Instance.DefaultTemplateID = "test-template"
	}

	// 确保 adapter config 已初始化
	if config.ServerConf.AdapterConfig == nil {
		config.ServerConf.AdapterConfig = &config.AdapterConfig{}
	}
	if config.ServerConf.AdapterConfig.Sandbox == nil {
		config.ServerConf.AdapterConfig.Sandbox = &config.SandboxConfig{
			BaseURL: "http://localhost:0",
		}
	}
	if config.ServerConf.AdapterConfig.LLMGateway == nil {
		config.ServerConf.AdapterConfig.LLMGateway = &config.LLMGatewayConfig{}
	}

	return client, streamKey
}

// newTestContext 创建一个测试用的 pctx.Context。
func newTestContext(t *testing.T, userID string) pctx.Context {
	t.Helper()
	return testutil.NewContext(t, userID)
}

// insertTaskEntity 向 tasks 表插入测试数据。
func insertTaskEntity(t *testing.T, entity *taskmodel.Entity) {
	t.Helper()
	err := resource.GormDB.Table(taskmodel.TableName).Create(entity).Error
	require.NoError(t, err, "insert task entity")
}

// getTaskByTaskID 根据 task_id 查询 task 记录。
func getTaskByTaskID(t *testing.T, taskID string) *taskmodel.Entity {
	t.Helper()
	var entity taskmodel.Entity
	err := resource.GormDB.Table(taskmodel.TableName).
		Where(taskmodel.ColumnTaskId+" = ?", taskID).
		First(&entity).Error
	require.NoError(t, err, "get task by task_id")
	return &entity
}

// readStreamMessages 从 Redis Stream 读取消息。
func readStreamMessages(t *testing.T, client *goredis.Client, streamKey string, count int64) []goredis.XMessage {
	t.Helper()
	msgs, err := client.XRange(context.Background(), streamKey, "-", "+").Result()
	require.NoError(t, err, "read stream messages")
	if count > 0 && int64(len(msgs)) > count {
		return msgs[:count]
	}
	return msgs
}

// streamMessageCount 返回 Redis Stream 中的消息数。
func streamMessageCount(t *testing.T, client *goredis.Client, streamKey string) int64 {
	t.Helper()
	result, err := client.XLen(context.Background(), streamKey).Result()
	require.NoError(t, err, "get stream length")
	return result
}

// drainStream 清空 stream 确保测试隔离。
func drainStream(t *testing.T, client *goredis.Client, streamKey string) {
	t.Helper()
	_ = client.Del(context.Background(), streamKey).Err()
}

// parseStreamMessageTaskID 从 stream 消息中解析 taskId。
func parseStreamMessageTaskID(t *testing.T, msg goredis.XMessage) string {
	t.Helper()
	data, ok := msg.Values["data"]
	require.True(t, ok, "message should have 'data' field")

	var taskMsg struct {
		TaskId string `json:"TaskId"`
	}
	err := json.Unmarshal([]byte(data.(string)), &taskMsg)
	require.NoError(t, err, "unmarshal task message")
	return taskMsg.TaskId
}

// int64Ptr 辅助创建 *int64。
func int64Ptr(v int64) *int64 {
	return &v
}

// timePtr 辅助创建 *time.Time。
func timePtr(v time.Time) *time.Time {
	return &v
}
