// Package website TCB 环境动态发现与容量管理
//
// 通过 COS Service API 列出主账号下所有桶，过滤 TCB 静态托管桶，
// 从桶名解析 env_id 和 app_id，统一用主账号密钥做 COS 凭据。
// 支持多环境容量监控、超限自动切换、手动禁用。
package website

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"

	"ctl/pkg/errcode"
	"ctl/pkg/model/website"
	"ctl/pkg/resource"

	"go.uber.org/zap"
)

// TCBEnvConfig 描述一个动态发现的 TCB 环境
type TCBEnvConfig struct {
	EnvID     string
	AppID     string
	COSBucket string
	COSRegion string
}

const (
	tcbEnvCacheTTL     = 5 * time.Minute
	tcbDefaultMaxSites = 500 // 每个 TCB 环境默认最大站点数
)

var (
	tcbEnvs     []TCBEnvConfig
	tcbEnvsMu   sync.RWMutex
	tcbEnvsTime time.Time
)

// getMainAccountSecrets 读取主账号密钥
func getMainAccountSecrets() (string, string) {
	return os.Getenv("TENCENT_SECRET_ID"), os.Getenv("TENCENT_SECRET_KEY")
}

// getTCBEnvMaxSites 返回每个 TCB 环境的最大站点数
// 优先读 TCB_ENV_MAX_SITES 环境变量，默认 500
func getTCBEnvMaxSites() int {
	v := os.Getenv("TCB_ENV_MAX_SITES")
	if v == "" {
		return tcbDefaultMaxSites
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return tcbDefaultMaxSites
	}
	return n
}

// getTCBEnvCapacityMap 返回按 env_id 覆盖的容量配置
// 格式: {"env-id-1": 1000, "env-id-2": 200}
func getTCBEnvCapacityMap() map[string]int {
	raw := os.Getenv("TCB_ENV_CAPACITY_MAP")
	if raw == "" {
		return nil
	}
	var m map[string]int
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		resource.ZapLogger.Warn("parse TCB_ENV_CAPACITY_MAP failed", zap.Error(err))
		return nil
	}
	return m
}

// getDisabledTCBEnvs 返回被手动禁用的 TCB 环境 ID 列表
// 格式: "env-id-1,env-id-2"
func getDisabledTCBEnvs() map[string]bool {
	raw := os.Getenv("TCB_ENV_DISABLED")
	if raw == "" {
		return nil
	}
	result := make(map[string]bool)
	for _, id := range strings.Split(raw, ",") {
		id = strings.TrimSpace(id)
		if id != "" {
			result[id] = true
		}
	}
	return result
}

// parseTCBBucketName 从 TCB 静态托管桶名解析 env_id 和 app_id
// 桶名格式: {prefix}-static-{env_id}-{app_id}
// 例: 022a-static-xiamitcb-db-lab-d5fofz8t62c5140d-1251810746
func parseTCBBucketName(bucketName string) (envID, appID string, ok bool) {
	idx := strings.LastIndex(bucketName, "-")
	if idx == -1 {
		return "", "", false
	}
	appID = bucketName[idx+1:]
	if len(appID) < 5 {
		return "", "", false
	}
	for _, c := range appID {
		if c < '0' || c > '9' {
			return "", "", false
		}
	}

	withoutAppID := bucketName[:idx]
	staticMarker := "-static-"
	sIdx := strings.Index(withoutAppID, staticMarker)
	if sIdx == -1 {
		return "", "", false
	}
	envID = withoutAppID[sIdx+len(staticMarker):]
	if envID == "" {
		return "", "", false
	}
	return envID, appID, true
}

// discoverTCBEnvs 调 COS Service API 列出所有桶，过滤出 TCB 静态托管桶
func discoverTCBEnvs() ([]TCBEnvConfig, error) {
	secretID, secretKey := getMainAccountSecrets()
	if secretID == "" || secretKey == "" {
		return nil, fmt.Errorf("TENCENT_SECRET_ID/TENCENT_SECRET_KEY not set")
	}

	client := cos.NewClient(&cos.BaseURL{}, &http.Client{
		Transport: &cos.AuthorizationTransport{
			SecretID:  secretID,
			SecretKey: secretKey,
		},
	})

	result, _, err := client.Service.Get(context.Background())
	if err != nil {
		return nil, fmt.Errorf("list COS buckets: %w", err)
	}

	var envs []TCBEnvConfig
	for _, b := range result.Buckets {
		envID, appID, ok := parseTCBBucketName(b.Name)
		if !ok {
			continue
		}
		envs = append(envs, TCBEnvConfig{
			EnvID:     envID,
			AppID:     appID,
			COSBucket: b.Name,
			COSRegion: b.Region,
		})
	}
	return envs, nil
}

// getTCBEnvs 返回缓存的或新发现的 TCB 环境列表
func getTCBEnvs() ([]TCBEnvConfig, error) {
	tcbEnvsMu.RLock()
	if time.Since(tcbEnvsTime) < tcbEnvCacheTTL && len(tcbEnvs) > 0 {
		out := make([]TCBEnvConfig, len(tcbEnvs))
		copy(out, tcbEnvs)
		tcbEnvsMu.RUnlock()
		return out, nil
	}
	tcbEnvsMu.RUnlock()

	tcbEnvsMu.Lock()
	defer tcbEnvsMu.Unlock()

	// double-check
	if time.Since(tcbEnvsTime) < tcbEnvCacheTTL && len(tcbEnvs) > 0 {
		out := make([]TCBEnvConfig, len(tcbEnvs))
		copy(out, tcbEnvs)
		return out, nil
	}

	envs, err := discoverTCBEnvs()
	if err != nil {
		if len(tcbEnvs) > 0 {
			resource.ZapLogger.Warn("TCB env discovery failed, using stale cache", zap.Error(err))
			out := make([]TCBEnvConfig, len(tcbEnvs))
			copy(out, tcbEnvs)
			return out, nil
		}
		return nil, err
	}

	tcbEnvs = envs
	tcbEnvsTime = time.Now()
	resource.ZapLogger.Info("discovered TCB environments", zap.Int("count", len(envs)))
	return envs, nil
}

// countSitesPerEnv 从 DB 统计每个 TCB 环境的活跃站点数
func countSitesPerEnv() map[string]int64 {
	if resource.GormDB == nil {
		return nil
	}
	var rows []struct {
		TCBEnvID string `gorm:"column:tcb_env_id"`
		Count    int64  `gorm:"column:count"`
	}
	if err := resource.GormDB.Table(website.SitesTable).
		Select("tcb_env_id, COUNT(*) AS count").
		Where("deleted_time IS NULL").
		Group("tcb_env_id").
		Scan(&rows).Error; err != nil {
		resource.ZapLogger.Warn("count sites per TCB env failed", zap.Error(err))
		return nil
	}
	result := make(map[string]int64, len(rows))
	for _, row := range rows {
		result[row.TCBEnvID] = row.Count
	}
	return result
}

// selectTCBEnv 选择一个可用的 TCB 环境
// 策略：过滤禁用和超容量的环境，从剩余环境中随机选择
func selectTCBEnv() (*TCBEnvConfig, error) {
	envs, err := getTCBEnvs()
	if err != nil {
		return nil, err
	}
	if len(envs) == 0 {
		return nil, errcode.ErrWebsiteNoAvailableEnv
	}

	disabled := getDisabledTCBEnvs()
	maxSites := getTCBEnvMaxSites()
	capacityMap := getTCBEnvCapacityMap()
	siteCounts := countSitesPerEnv()

	var available []TCBEnvConfig
	for _, env := range envs {
		envID := env.EnvID

		// 跳过被手动禁用的环境
		if disabled[envID] {
			resource.ZapLogger.Info("skipping disabled TCB env", zap.String("env_id", envID))
			continue
		}

		// 计算该环境的容量上限
		envMax := maxSites
		if capacityMap != nil {
			if custom, ok := capacityMap[envID]; ok && custom > 0 {
				envMax = custom
			}
		}

		// 统计当前站点数
		count := siteCounts[envID]

		// 容量预警
		if envMax > 0 {
			usage := float64(count) / float64(envMax)
			if usage >= 1.0 {
				resource.ZapLogger.Warn("TCB env at full capacity, skipping",
					zap.String("env_id", envID),
					zap.Int64("sites", count),
					zap.Int("max", envMax))
				continue
			}
			if usage >= 0.8 {
				resource.ZapLogger.Warn("TCB env near capacity",
					zap.String("env_id", envID),
					zap.Int64("sites", count),
					zap.Int("max", envMax),
					zap.Float64("usage", usage))
			}
		}

		available = append(available, env)
	}

	if len(available) == 0 {
		resource.ZapLogger.Error("all TCB environments at capacity or disabled",
			zap.Int("total_discovered", len(envs)),
			zap.Int("disabled_count", len(disabled)))
		return nil, errcode.ErrWebsiteNoAvailableEnv
	}

	idx := rand.Intn(len(available))
	selected := &available[idx]
	resource.ZapLogger.Info("selected TCB env",
		zap.String("env_id", selected.EnvID),
		zap.String("bucket", selected.COSBucket),
		zap.Int64("current_sites", siteCounts[selected.EnvID]))
	return selected, nil
}

// getTCBEnvByID 根据 env_id 查找环境配置
func getTCBEnvByID(envID string) *TCBEnvConfig {
	envs, err := getTCBEnvs()
	if err != nil {
		return nil
	}
	for i := range envs {
		if envs[i].EnvID == envID {
			return &envs[i]
		}
	}
	return nil
}

